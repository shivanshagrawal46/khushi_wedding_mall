const mongoose = require('mongoose');

/**
 * Return Model
 * 
 * Tracks product returns after delivery. Professional approach:
 * - Original order stays UNCHANGED (audit trail preserved)
 * - Return is a separate document with its own number (RET26020001)
 * - Inventory is restored when return is processed
 * - Client gets a refundable credit if they overpaid
 * - Refund is tracked separately (admin records when money is actually returned)
 * 
 * Flow:
 *   Delivered Order → Create Return → Inventory Restored → Client Credit Calculated
 *   → Admin Records Refund → Money Goes Back to Client
 */

const returnItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product'
  },
  productName: {
    type: String,
    required: true,
    trim: true
  },
  narration: {
    type: String,
    trim: true,
    default: ''
  },
  price: {
    type: Number,
    required: true,
    min: 0
  },
  quantity: {
    type: Number,
    required: true,
    min: [0.01, 'Return quantity must be greater than 0']
  },
  total: {
    type: Number,
    required: true
  }
}, { _id: false });

const returnSchema = new mongoose.Schema({
  returnNumber: {
    type: String,
    unique: true,
    index: true
  },
  
  // ── Order Reference ──
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    required: true,
    index: true
  },
  orderNumber: {
    type: String,
    required: true,
    index: true
  },
  
  // ── Delivery Reference (optional — which delivery the items came from) ──
  delivery: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Delivery',
    index: true
  },
  deliveryNumber: {
    type: String,
    index: true
  },
  
  // ── Client Reference ──
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
    trim: true
  },
  
  // ── Returned Items ──
  items: [returnItemSchema],
  
  // ── Return Value ──
  returnTotal: {
    type: Number,
    required: true,
    min: 0
  },
  
  // ── Refund Tracking ──
  // refundableAmount: how much the client is owed (may be less than returnTotal if they hadn't fully paid)
  refundableAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  // refundedAmount: how much has actually been refunded so far
  refundedAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  refundStatus: {
    type: String,
    enum: ['pending', 'partial', 'refunded', 'no_refund'],
    default: 'pending',
    index: true
  },
  
  // ── Reason ──
  reason: {
    type: String,
    trim: true
  },
  
  // ── Metadata ──
  processedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  returnDate: {
    type: Date,
    default: Date.now,
    index: true
  },
  notes: {
    type: String,
    trim: true
  }
}, {
  timestamps: true
});

// Indexes
returnSchema.index({ order: 1, returnDate: -1 });
returnSchema.index({ client: 1, returnDate: -1 });
returnSchema.index({ refundStatus: 1, returnDate: -1 });
returnSchema.index({ partyName: 1, returnDate: -1 });
returnSchema.index({ partyName: 'text', mobile: 'text', returnNumber: 'text', orderNumber: 'text' });

// Auto-generate return number (RET26020001)
returnSchema.pre('save', async function(next) {
  if (this.isNew && !this.returnNumber) {
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const prefix = `RET${year}${month}`;
    
    const lastReturn = await mongoose.model('Return').findOne({
      returnNumber: { $regex: `^${prefix}` }
    })
    .select('returnNumber')
    .sort({ returnNumber: -1 })
    .lean();
    
    let nextNumber = 1;
    if (lastReturn && lastReturn.returnNumber) {
      const match = lastReturn.returnNumber.match(/(\d+)$/);
      if (match) {
        nextNumber = parseInt(match[1]) + 1;
      }
    }
    
    // Retry logic for race conditions
    let attempts = 0;
    const maxAttempts = 5;
    let returnNumber = null;
    
    while (attempts < maxAttempts && !returnNumber) {
      const candidateNumber = `${prefix}${nextNumber.toString().padStart(4, '0')}`;
      const existing = await mongoose.model('Return').findOne({
        returnNumber: candidateNumber
      }).select('_id').lean();
      
      if (!existing) {
        returnNumber = candidateNumber;
      } else {
        nextNumber++;
        attempts++;
      }
    }
    
    if (!returnNumber) {
      const timestamp = Date.now().toString().slice(-4);
      returnNumber = `${prefix}${nextNumber.toString().padStart(4, '0')}_${timestamp}`;
    }
    
    this.returnNumber = returnNumber;
  }
  
  // Calculate refund status
  if (this.refundableAmount <= 0) {
    this.refundStatus = 'no_refund';
  } else if (this.refundedAmount >= this.refundableAmount) {
    this.refundStatus = 'refunded';
  } else if (this.refundedAmount > 0) {
    this.refundStatus = 'partial';
  } else {
    this.refundStatus = 'pending';
  }
  
  next();
});

module.exports = mongoose.model('Return', returnSchema);
