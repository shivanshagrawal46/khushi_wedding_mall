const mongoose = require('mongoose');

const clientSchema = new mongoose.Schema({
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
  address: {
    type: String,
    trim: true
  },
  email: {
    type: String,
    trim: true,
    lowercase: true
  },
  notes: {
    type: String,
    trim: true
  },
  totalOrders: {
    type: Number,
    default: 0
  },
  completedOrders: {
    type: Number,
    default: 0
  },
  openOrders: {
    type: Number,
    default: 0
  },
  totalSpent: {
    type: Number,
    default: 0
  },
  totalPaid: {
    type: Number,
    default: 0
  },
  totalDue: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Text index for autocomplete search - critical for fast suggestions
clientSchema.index({ partyName: 'text', mobile: 'text' });

// Compound index for unique client identification
clientSchema.index({ partyName: 1, mobile: 1 }, { unique: true });

// Index for sorting by recent activity
clientSchema.index({ updatedAt: -1 });
clientSchema.index({ totalOrders: -1 });

// Static method for autocomplete search - optimized for speed
clientSchema.statics.autocomplete = async function(query, limit = 10) {
  if (!query || query.length < 2) return [];
  
  const regex = new RegExp('^' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  
  return this.find({
    $or: [
      { partyName: regex },
      { mobile: regex }
    ]
  })
  .select('partyName mobile address')
  .limit(limit)
  .lean()
  .exec();
};

module.exports = mongoose.model('Client', clientSchema);

