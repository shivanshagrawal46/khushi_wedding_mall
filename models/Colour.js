const mongoose = require('mongoose');

/**
 * Colour Model
 * Admin defines colours and their prices.
 * Used for Parda (curtain) products where each colour has a different price.
 */
const colourSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Colour name is required'],
    trim: true,
    unique: true,
    index: true
  },
  price: {
    type: Number,
    required: [true, 'Colour price is required'],
    min: 0
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true
  }
}, {
  timestamps: true
});

colourSchema.index({ isActive: 1, name: 1 });

module.exports = mongoose.model('Colour', colourSchema);
