const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Product name is required'],
    trim: true,
    index: true
  },
  description: {
    type: String,
    trim: true
  },
  price: {
    type: Number,
    min: 0,
    default: null
  },
  inventory: {
    type: Number,
    min: 0,
    default: null
  },
  category: {
    type: String,
    trim: true,
    index: true
  },
  unit: {
    type: String,
    trim: true,
    default: 'piece'
  },
  image: {
    type: String,
    trim: true
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true
  }
}, {
  timestamps: true
});

// Text index for fast search (optimized for 500-600 products)
productSchema.index({ name: 'text', description: 'text', category: 'text' });

// Compound indexes for common queries (OPTIMIZED FOR SCALE)
productSchema.index({ isActive: 1, category: 1 });
productSchema.index({ name: 1, isActive: 1 });
productSchema.index({ isActive: 1, inventory: 1 }); // For low-stock queries (CRITICAL)
productSchema.index({ inventory: 1, category: 1, isActive: 1 }); // For inventory filtering by category
productSchema.index({ isActive: 1, name: 1, inventory: 1 }); // For search with inventory
productSchema.index({ category: 1, isActive: 1, price: 1 }); // For category filtering with price
productSchema.index({ isActive: 1, updatedAt: -1 }); // For recently updated products

module.exports = mongoose.model('Product', productSchema);

