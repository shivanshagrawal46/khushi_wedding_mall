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
  },
  // Advance payment tracking (payments made without specific orders)
  advanceBalance: {
    type: Number,
    default: 0,
    min: 0
  },
  // Refundable balance (money owed TO the client due to returns)
  refundableBalance: {
    type: Number,
    default: 0,
    min: 0
  },
  totalReturns: {
    type: Number,
    default: 0
  },
  totalReturnValue: {
    type: Number,
    default: 0
  },
  // Last payment tracking
  lastPaymentAmount: {
    type: Number,
    default: 0
  },
  lastPaymentDate: {
    type: Date
  },
  lastPaymentMethod: {
    type: String,
    enum: ['cash', 'card', 'upi', 'bank_transfer', 'cheque', 'other', null],
    default: null
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

// Instance method to calculate financial summary
clientSchema.methods.getFinancialSummary = async function() {
  const Order = require('./Order');
  const Payment = require('./Payment');
  
  // Get all orders for this client
  const orders = await Order.find({ client: this._id })
    .select('orderNumber grandTotal advance balanceDue status paymentStatus')
    .lean();
  
  // Get all payments for this client
  const payments = await Payment.find({ client: this._id })
    .select('amount paymentDate paymentType orderNumber')
    .sort('-paymentDate')
    .lean();
  
  // Calculate totals
  const totalOrderValue = orders.reduce((sum, order) => sum + (order.grandTotal || 0), 0);
  const totalPaid = orders.reduce((sum, order) => sum + (order.advance || 0), 0);
  const totalDue = orders.reduce((sum, order) => sum + (order.balanceDue || 0), 0);
  
  // Get advance payments (unallocated)
  const advancePayments = payments.filter(p => p.paymentType === 'advance_payment');
  const totalAdvance = advancePayments.reduce((sum, p) => sum + p.amount, 0);
  
  return {
    totalOrders: orders.length,
    openOrders: orders.filter(o => ['open', 'in_progress', 'partial_delivered'].includes(o.status)).length,
    completedOrders: orders.filter(o => o.status === 'completed').length,
    totalOrderValue,
    totalPaid,
    totalDue,
    advanceBalance: this.advanceBalance || 0,
    netDue: totalDue - (this.advanceBalance || 0), // Net amount after considering advance
    lastPayment: payments.length > 0 ? {
      amount: payments[0].amount,
      date: payments[0].paymentDate,
      type: payments[0].paymentType
    } : null
  };
};

module.exports = mongoose.model('Client', clientSchema);

