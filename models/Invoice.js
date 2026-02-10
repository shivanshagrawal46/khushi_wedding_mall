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
    min: [0.01, 'Quantity must be greater than 0']
  },
  total: {
    type: Number,
    required: true
  }
}, { _id: false });

const invoiceSchema = new mongoose.Schema({
  invoiceNumber: {
    type: String,
    unique: true,
    index: true
  },
  // Party Details
  partyName: {
    type: String,
    required: [true, 'Party name is required'],
    trim: true,
    index: true
  },
  mobile: {
    type: String,
    required: [true, 'Mobile number is required'],
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
  orderDate: {
    type: Date,
    default: Date.now,
    index: true
  },
  deliveryDate: {
    type: Date,
    required: [true, 'Delivery date is required'],
    index: true
  },
  
  // Status
  deliveryStatus: {
    type: String,
    enum: ['pending', 'in_transit', 'delivered', 'returned', 'cancelled'],
    default: 'pending',
    index: true
  },
  paymentStatus: {
    type: String,
    enum: ['unpaid', 'partial', 'paid'],
    default: 'unpaid',
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

// Compound indexes for common queries - optimized for dashboard and reports
invoiceSchema.index({ orderDate: -1, deliveryStatus: 1 });
invoiceSchema.index({ deliveryDate: 1, deliveryStatus: 1 });
invoiceSchema.index({ paymentStatus: 1, createdAt: -1 });
invoiceSchema.index({ partyName: 1, orderDate: -1 });
invoiceSchema.index({ mobile: 1, orderDate: -1 });
invoiceSchema.index({ createdBy: 1, orderDate: -1 });

// Text index for search
invoiceSchema.index({ partyName: 'text', mobile: 'text', invoiceNumber: 'text' });

// Auto-generate invoice number
invoiceSchema.pre('save', async function(next) {
  if (this.isNew && !this.invoiceNumber) {
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    
    // Get count of invoices this month for sequential numbering
    const count = await mongoose.model('Invoice').countDocuments({
      createdAt: {
        $gte: new Date(date.getFullYear(), date.getMonth(), 1),
        $lt: new Date(date.getFullYear(), date.getMonth() + 1, 1)
      }
    });
    
    this.invoiceNumber = `KWM${year}${month}${(count + 1).toString().padStart(4, '0')}`;
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

module.exports = mongoose.model('Invoice', invoiceSchema);

