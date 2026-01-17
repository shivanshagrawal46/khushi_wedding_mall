const mongoose = require('mongoose');

const deliveryItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
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

const deliverySchema = new mongoose.Schema({
  deliveryNumber: {
    type: String,
    unique: true,
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
    trim: true
  },
  // Delivery Items
  items: [deliveryItemSchema],
  
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
  
  // Delivery Date
  deliveryDate: {
    type: Date,
    required: true,
    index: true
  },
  actualDeliveryDate: {
    type: Date,
    index: true
  },
  expectedDeliveryDate: {
    type: Date,
    index: true
  },
  
  // Delivery Performance
  deliveryPerformance: {
    type: String,
    enum: ['on_time', 'early', 'late', null],
    default: null,
    index: true
  },
  
  // Status
  status: {
    type: String,
    enum: ['pending', 'in_transit', 'delivered', 'returned'],
    default: 'pending',
    index: true
  },
  
  // Invoice reference
  invoice: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DeliveryInvoice',
    index: true
  },
  invoiceGenerated: {
    type: Boolean,
    default: false
  },
  
  // Metadata
  deliveredBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
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
deliverySchema.index({ order: 1, deliveryDate: -1 });
deliverySchema.index({ deliveryDate: 1, status: 1 });
deliverySchema.index({ orderNumber: 1, deliveryDate: -1 });
deliverySchema.index({ status: 1, createdAt: -1 });
deliverySchema.index({ deliveryPerformance: 1, deliveryDate: -1 });
deliverySchema.index({ deliveredBy: 1, deliveryDate: -1 });

// Auto-generate delivery number with race condition handling
deliverySchema.pre('save', async function(next) {
  if (this.isNew && !this.deliveryNumber) {
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const prefix = `DEL${year}${month}`;
    
    // Find the highest existing delivery number for this month
    // This handles deleted deliveries and gaps in the sequence
    const lastDelivery = await mongoose.model('Delivery').findOne({
      deliveryNumber: { $regex: `^${prefix}` }
    })
    .select('deliveryNumber')
    .sort({ deliveryNumber: -1 })
    .lean();
    
    let nextNumber = 1;
    if (lastDelivery && lastDelivery.deliveryNumber) {
      // Extract the number part and increment
      const match = lastDelivery.deliveryNumber.match(/(\d+)$/);
      if (match) {
        nextNumber = parseInt(match[1]) + 1;
      }
    }
    
    // Retry logic to handle race conditions (up to 5 attempts)
    let attempts = 0;
    const maxAttempts = 5;
    let deliveryNumber = null;
    
    while (attempts < maxAttempts && !deliveryNumber) {
      // Generate candidate number
      const candidateNumber = `${prefix}${nextNumber.toString().padStart(4, '0')}`;
      
      // Check if this number already exists (atomic check)
      const existing = await mongoose.model('Delivery').findOne({ 
        deliveryNumber: candidateNumber 
      }).select('_id').lean();
      
      if (!existing) {
        deliveryNumber = candidateNumber;
      } else {
        // Number already exists, try next number
        nextNumber++;
        attempts++;
        console.log(`⚠️  Delivery number collision detected: ${candidateNumber}. Retry attempt ${attempts}/${maxAttempts}`);
        
        if (attempts >= maxAttempts) {
          // Fallback: Add timestamp suffix to ensure uniqueness
          const timestamp = Date.now().toString().slice(-4);
          deliveryNumber = `${prefix}${nextNumber.toString().padStart(4, '0')}_${timestamp}`;
          console.log(`🔄 Using timestamped delivery number as fallback: ${deliveryNumber}`);
        }
      }
    }
    
    this.deliveryNumber = deliveryNumber;
  }
  
  // Calculate delivery performance if dates exist
  if (this.actualDeliveryDate && this.expectedDeliveryDate) {
    const diffDays = Math.floor((this.actualDeliveryDate - this.expectedDeliveryDate) / (1000 * 60 * 60 * 24));
    if (diffDays < 0) {
      this.deliveryPerformance = 'early';
    } else if (diffDays === 0) {
      this.deliveryPerformance = 'on_time';
    } else {
      this.deliveryPerformance = 'late';
    }
  }
  
  next();
});

module.exports = mongoose.model('Delivery', deliverySchema);

