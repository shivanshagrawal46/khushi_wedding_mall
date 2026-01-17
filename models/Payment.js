const mongoose = require('mongoose');

/**
 * Payment Model
 * Tracks all payment transactions for clients
 * Supports both order-specific payments and advance payments (without orders)
 */
const paymentSchema = new mongoose.Schema({
  // Payment Details
  paymentNumber: {
    type: String,
    unique: true,
    index: true
  },
  amount: {
    type: Number,
    required: [true, 'Payment amount is required'],
    min: [0.01, 'Payment amount must be positive']
  },
  paymentDate: {
    type: Date,
    default: Date.now,
    required: true,
    index: true
  },
  paymentMethod: {
    type: String,
    enum: ['cash', 'card', 'upi', 'bank_transfer', 'cheque', 'other'],
    default: 'cash'
  },
  transactionReference: {
    type: String,
    trim: true // For UPI reference, cheque number, etc.
  },
  
  // Client Reference
  client: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: true,
    index: true
  },
  partyName: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  mobile: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  
  // Order Reference (null for advance payments)
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    index: true
  },
  orderNumber: {
    type: String,
    trim: true,
    index: true
  },
  
  // Invoice Reference (if payment is for an invoice)
  invoice: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice',
    index: true
  },
  invoiceNumber: {
    type: String,
    trim: true,
    index: true
  },
  
  // Payment Type
  paymentType: {
    type: String,
    enum: ['order_payment', 'invoice_payment', 'advance_payment', 'adjustment'],
    required: true,
    index: true,
    default: 'order_payment'
  },
  
  // Allocation tracking (for payments that get distributed across multiple orders)
  isAllocated: {
    type: Boolean,
    default: false
  },
  allocatedAmount: {
    type: Number,
    default: 0
  },
  remainingAmount: {
    type: Number,
    default: function() {
      return this.amount;
    }
  },
  allocations: [{
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order'
    },
    orderNumber: String,
    amount: Number,
    allocatedAt: {
      type: Date,
      default: Date.now
    }
  }],
  
  // Metadata
  recordedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  notes: {
    type: String,
    trim: true
  },
  
  // For tracking payment source
  recordedFrom: {
    type: String,
    enum: ['order_page', 'client_page', 'invoice_page', 'bulk_payment', 'system'],
    default: 'order_page'
  }
}, {
  timestamps: true
});

// Compound indexes for common queries
paymentSchema.index({ client: 1, paymentDate: -1 });
paymentSchema.index({ order: 1, paymentDate: -1 });
paymentSchema.index({ paymentType: 1, paymentDate: -1 });
paymentSchema.index({ client: 1, paymentType: 1, paymentDate: -1 });
paymentSchema.index({ partyName: 1, paymentDate: -1 });
paymentSchema.index({ paymentDate: -1, createdAt: -1 });

// Text index for search
paymentSchema.index({ 
  partyName: 'text', 
  mobile: 'text', 
  paymentNumber: 'text',
  orderNumber: 'text',
  invoiceNumber: 'text',
  transactionReference: 'text'
});

// Auto-generate payment number
paymentSchema.pre('save', async function(next) {
  if (this.isNew && !this.paymentNumber) {
    const date = new Date(this.paymentDate);
    const year = date.getFullYear().toString().slice(-2);
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const prefix = `PAY${year}${month}`;
    
    // Find the highest existing payment number for this month
    // This handles deleted payments and gaps in the sequence
    const lastPayment = await mongoose.model('Payment').findOne({
      paymentNumber: { $regex: `^${prefix}` }
    })
    .select('paymentNumber')
    .sort({ paymentNumber: -1 })
    .lean();
    
    let nextNumber = 1;
    if (lastPayment && lastPayment.paymentNumber) {
      // Extract the number part and increment
      const match = lastPayment.paymentNumber.match(/(\d+)$/);
      if (match) {
        nextNumber = parseInt(match[1]) + 1;
      }
    }
    
    // Retry logic to handle race conditions (up to 5 attempts)
    let attempts = 0;
    const maxAttempts = 5;
    let paymentNumber = null;
    
    while (attempts < maxAttempts && !paymentNumber) {
      // Generate candidate number
      const candidateNumber = `${prefix}${nextNumber.toString().padStart(4, '0')}`;
      
      // Check if this number already exists (atomic check)
      const existing = await mongoose.model('Payment').findOne({ 
        paymentNumber: candidateNumber 
      }).select('_id').lean();
      
      if (!existing) {
        paymentNumber = candidateNumber;
      } else {
        // Number already exists, try next number
        nextNumber++;
        attempts++;
        console.log(`⚠️  Payment number collision detected: ${candidateNumber}. Retry attempt ${attempts}/${maxAttempts}`);
        
        if (attempts >= maxAttempts) {
          // Fallback: Add timestamp suffix to ensure uniqueness
          const timestamp = Date.now().toString().slice(-4);
          paymentNumber = `${prefix}${nextNumber.toString().padStart(4, '0')}_${timestamp}`;
          console.log(`🔄 Using timestamped payment number as fallback: ${paymentNumber}`);
        }
      }
    }
    
    this.paymentNumber = paymentNumber;
  }
  
  // Calculate remaining amount
  this.remainingAmount = this.amount - this.allocatedAmount;
  this.isAllocated = this.allocatedAmount > 0;
  
  next();
});

// Static method to get client payment summary
paymentSchema.statics.getClientPaymentSummary = async function(clientId) {
  const summary = await this.aggregate([
    { $match: { client: mongoose.Types.ObjectId(clientId) } },
    {
      $group: {
        _id: '$paymentType',
        totalAmount: { $sum: '$amount' },
        count: { $sum: 1 }
      }
    }
  ]);
  
  return summary.reduce((acc, item) => {
    acc[item._id] = {
      total: item.totalAmount,
      count: item.count
    };
    return acc;
  }, {});
};

// Static method to get unallocated advance payments for a client
paymentSchema.statics.getUnallocatedAdvances = async function(clientId) {
  return this.find({
    client: clientId,
    paymentType: 'advance_payment',
    $expr: { $gt: ['$remainingAmount', 0] }
  })
  .sort('paymentDate')
  .lean();
};

module.exports = mongoose.model('Payment', paymentSchema);
