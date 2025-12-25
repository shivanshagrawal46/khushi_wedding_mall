const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: [true, 'Username is required'],
    unique: true,
    trim: true,
    lowercase: true,
    index: true
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: 6,
    select: false
  },
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true
  },
  role: {
    type: String,
    enum: ['admin', 'employee'],
    default: 'employee',
    index: true
  },
  phone: {
    type: String,
    trim: true
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  
  // Employee statistics (cached, updated via aggregation)
  employeeStats: {
    totalOrders: {
      type: Number,
      default: 0
    },
    onTimeDeliveries: {
      type: Number,
      default: 0
    },
    earlyDeliveries: {
      type: Number,
      default: 0
    },
    lateDeliveries: {
      type: Number,
      default: 0
    },
    totalDeliveries: {
      type: Number,
      default: 0
    },
    lastUpdated: {
      type: Date,
      default: Date.now
    }
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Compound index for faster queries
userSchema.index({ role: 1, isActive: 1 });
userSchema.index({ username: 1, isActive: 1 });

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Remove sensitive fields from JSON
userSchema.methods.toJSON = function() {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

module.exports = mongoose.model('User', userSchema);

