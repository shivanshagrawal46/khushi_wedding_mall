const mongoose = require('mongoose');

const invoiceItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product'
  },
  productName: {
    type: String,
    required: true,
    trim: true
  },
  price: {
    type: Number,
    required: true,
    min: 0
  },
  quantity: {
    type: Number,
    required: true,
    min: 1
  },
  total: {
    type: Number,
    required: true
  }
}, { _id: false });

const deliveryInvoiceSchema = new mongoose.Schema({
  invoiceNumber: {
    type: String,
    unique: true,
    index: true
  },
  delivery: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Delivery',
    required: true,
    index: true
  },
  deliveryNumber: {
    type: String,
    required: true,
    index: true
  },
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
  // Party Details (denormalized for fast access)
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
  client: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    index: true
  },
  // Invoice Items
  items: [invoiceItemSchema],
  
  // Pricing
  subtotal: {
    type: Number,
    required: true,
    min: 0
  },
  localFreight: {
    type: Number,
    default: 0,
    min: 0
  },
  transportation: {
    type: Number,
    default: 0,
    min: 0
  },
  gstPercent: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  gstAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  discount: {
    type: Number,
    default: 0,
    min: 0
  },
  grandTotal: {
    type: Number,
    required: true,
    min: 0
  },
  advance: {
    type: Number,
    default: 0,
    min: 0
  },
  balanceDue: {
    type: Number,
    required: true
  },
  
  // Dates
  invoiceDate: {
    type: Date,
    default: Date.now,
    index: true
  },
  deliveryDate: {
    type: Date,
    required: true,
    index: true
  },
  
  // Payment Status
  paymentStatus: {
    type: String,
    enum: ['unpaid', 'partial', 'paid'],
    default: 'unpaid',
    index: true
  },
  
  // Delivery Status (synced from delivery)
  deliveryStatus: {
    type: String,
    enum: ['pending', 'in_transit', 'delivered', 'returned'],
    default: 'pending',
    index: true
  },
  
  // Metadata
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  notes: {
    type: String,
    trim: true
  }
}, {
  timestamps: true
});

// Indexes for optimized queries
deliveryInvoiceSchema.index({ order: 1, invoiceDate: -1 });
deliveryInvoiceSchema.index({ delivery: 1 });
deliveryInvoiceSchema.index({ invoiceDate: -1, paymentStatus: 1 });
deliveryInvoiceSchema.index({ deliveryStatus: 1, invoiceDate: -1 });
deliveryInvoiceSchema.index({ paymentStatus: 1, deliveryStatus: 1 });
deliveryInvoiceSchema.index({ partyName: 1, invoiceDate: -1 });
deliveryInvoiceSchema.index({ mobile: 1, invoiceDate: -1 });

// Text index for search
deliveryInvoiceSchema.index({ partyName: 'text', mobile: 'text', invoiceNumber: 'text' });

// Auto-generate invoice number with race condition handling
deliveryInvoiceSchema.pre('save', async function(next) {
  if (this.isNew && !this.invoiceNumber) {
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const prefix = `INV${year}${month}`;
    
    // Find the highest existing invoice number for this month
    // This handles deleted invoices and gaps in the sequence
    const lastInvoice = await mongoose.model('DeliveryInvoice').findOne({
      invoiceNumber: { $regex: `^${prefix}` }
    })
    .select('invoiceNumber')
    .sort({ invoiceNumber: -1 })
    .lean();
    
    let nextNumber = 1;
    if (lastInvoice && lastInvoice.invoiceNumber) {
      // Extract the number part and increment
      const match = lastInvoice.invoiceNumber.match(/(\d+)$/);
      if (match) {
        nextNumber = parseInt(match[1]) + 1;
      }
    }
    
    // Retry logic to handle race conditions (up to 5 attempts)
    let attempts = 0;
    const maxAttempts = 5;
    let invoiceNumber = null;
    
    while (attempts < maxAttempts && !invoiceNumber) {
      // Generate candidate number
      const candidateNumber = `${prefix}${nextNumber.toString().padStart(4, '0')}`;
      
      // Check if this number already exists (atomic check)
      const existing = await mongoose.model('DeliveryInvoice').findOne({ 
        invoiceNumber: candidateNumber 
      }).select('_id').lean();
      
      if (!existing) {
        invoiceNumber = candidateNumber;
      } else {
        // Number already exists, try next number
        nextNumber++;
        attempts++;
        console.log(`⚠️  Invoice number collision detected: ${candidateNumber}. Retry attempt ${attempts}/${maxAttempts}`);
        
        if (attempts >= maxAttempts) {
          // Fallback: Add timestamp suffix to ensure uniqueness
          const timestamp = Date.now().toString().slice(-4);
          invoiceNumber = `${prefix}${nextNumber.toString().padStart(4, '0')}_${timestamp}`;
          console.log(`🔄 Using timestamped invoice number as fallback: ${invoiceNumber}`);
        }
      }
    }
    
    this.invoiceNumber = invoiceNumber;
  }
  
  // Calculate payment status
  if (this.advance >= this.grandTotal) {
    this.paymentStatus = 'paid';
  } else if (this.advance > 0) {
    this.paymentStatus = 'partial';
  } else {
    this.paymentStatus = 'unpaid';
  }
  
  next();
});

module.exports = mongoose.model('DeliveryInvoice', deliveryInvoiceSchema);


