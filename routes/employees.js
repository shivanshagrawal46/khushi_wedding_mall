const express = require('express');
const User = require('../models/User');
const { protect, adminOnly } = require('../middleware/auth');

const router = express.Router();

// All routes require admin access
router.use(protect);
router.use(adminOnly);

// @route   GET /api/employees
// @desc    Get all employees
// @access  Admin only
router.get('/', async (req, res) => {
  try {
    const { active = 'true', page = 1, limit = 50 } = req.query;
    
    const query = { role: 'employee' };
    
    if (active !== 'all') {
      query.isActive = active === 'true';
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const [employees, total] = await Promise.all([
      User.find(query)
        .select('-password')
        .sort('-createdAt')
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      User.countDocuments(query)
    ]);
    
    res.json({
      success: true,
      data: employees,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get employees error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   GET /api/employees/:id
// @desc    Get single employee
// @access  Admin only
router.get('/:id', async (req, res) => {
  try {
    const employee = await User.findOne({
      _id: req.params.id,
      role: 'employee'
    }).select('-password').lean();
    
    if (!employee) {
      return res.status(404).json({
        success: false,
        error: 'Employee not found'
      });
    }
    
    res.json({
      success: true,
      data: employee
    });
  } catch (error) {
    console.error('Get employee error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   POST /api/employees
// @desc    Create employee
// @access  Admin only
router.post('/', async (req, res) => {
  try {
    const { username, password, name, phone } = req.body;
    
    if (!username || !password || !name) {
      return res.status(400).json({
        success: false,
        error: 'Username, password, and name are required'
      });
    }
    
    // Check if username exists
    const existingUser = await User.findOne({ username: username.toLowerCase() });
    
    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: 'Username already exists'
      });
    }
    
    const employee = await User.create({
      username,
      password,
      name,
      phone,
      role: 'employee'
    });
    
    // Emit real-time event
    const io = req.app.get('io');
    if (io) {
      io.emit('employee:created', { 
        employee: {
          id: employee._id,
          username: employee.username,
          name: employee.name,
          phone: employee.phone,
          role: employee.role,
          isActive: employee.isActive
        }
      });
    }
    
    res.status(201).json({
      success: true,
      data: {
        id: employee._id,
        username: employee.username,
        name: employee.name,
        phone: employee.phone,
        role: employee.role,
        isActive: employee.isActive
      }
    });
  } catch (error) {
    console.error('Create employee error:', error);
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        error: 'Username already exists'
      });
    }
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   PUT /api/employees/:id
// @desc    Update employee
// @access  Admin only
router.put('/:id', async (req, res) => {
  try {
    const { name, phone, isActive } = req.body;
    
    const employee = await User.findOneAndUpdate(
      { _id: req.params.id, role: 'employee' },
      { name, phone, isActive },
      { new: true, runValidators: true }
    ).select('-password').lean();
    
    if (!employee) {
      return res.status(404).json({
        success: false,
        error: 'Employee not found'
      });
    }
    
    // Emit real-time event
    const io = req.app.get('io');
    if (io) {
      io.emit('employee:updated', { employee });
    }
    
    res.json({
      success: true,
      data: employee
    });
  } catch (error) {
    console.error('Update employee error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   PUT /api/employees/:id/reset-password
// @desc    Reset employee password
// @access  Admin only
router.put('/:id/reset-password', async (req, res) => {
  try {
    const { newPassword } = req.body;
    
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 6 characters'
      });
    }
    
    const employee = await User.findOne({
      _id: req.params.id,
      role: 'employee'
    });
    
    if (!employee) {
      return res.status(404).json({
        success: false,
        error: 'Employee not found'
      });
    }
    
    employee.password = newPassword;
    await employee.save();
    
    res.json({
      success: true,
      message: 'Password reset successfully'
    });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   DELETE /api/employees/:id
// @desc    Deactivate employee
// @access  Admin only
router.delete('/:id', async (req, res) => {
  try {
    const employee = await User.findOneAndUpdate(
      { _id: req.params.id, role: 'employee' },
      { isActive: false },
      { new: true }
    ).select('-password').lean();
    
    if (!employee) {
      return res.status(404).json({
        success: false,
        error: 'Employee not found'
      });
    }
    
    // Emit real-time event
    const io = req.app.get('io');
    if (io) {
      io.emit('employee:deactivated', { employeeId: employee._id });
    }
    
    res.json({
      success: true,
      message: 'Employee deactivated successfully'
    });
  } catch (error) {
    console.error('Delete employee error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

module.exports = router;

