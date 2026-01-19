const express = require('express');
const Category = require('../models/Category');
const Product = require('../models/Product');
const { protect, adminOnly } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(protect);

// @route   GET /api/categories
// @desc    Get all categories (with optional filters)
// @access  Private
router.get('/', async (req, res) => {
  try {
    const {
      search,
      isActive,
      page = 1,
      limit = 100,
      sort = 'displayOrder'
    } = req.query;
    
    const query = {};
    
    // Filter by active status
    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }
    
    // Text search
    if (search) {
      const searchRegex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.name = searchRegex;
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const [categories, total] = await Promise.all([
      Category.find(query)
        .select('name description isActive displayOrder productCount createdAt')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Category.countDocuments(query)
    ]);
    
    res.json({
      success: true,
      data: categories,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   GET /api/categories/active
// @desc    Get all active categories (for dropdown in add product)
// @access  Private
router.get('/active', async (req, res) => {
  try {
    const categories = await Category.find({ isActive: true })
      .select('name description displayOrder')
      .sort('displayOrder name')
      .lean();
    
    res.json({
      success: true,
      data: categories
    });
  } catch (error) {
    console.error('Get active categories error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   GET /api/categories/:id
// @desc    Get single category
// @access  Private
router.get('/:id', async (req, res) => {
  try {
    const category = await Category.findById(req.params.id)
      .populate('createdBy', 'name username')
      .lean();
    
    if (!category) {
      return res.status(404).json({
        success: false,
        error: 'Category not found'
      });
    }
    
    // Get sample products in this category
    const products = await Product.find({ category: category._id })
      .select('name price stock isFastSale')
      .limit(10)
      .lean();
    
    res.json({
      success: true,
      data: {
        category,
        sampleProducts: products
      }
    });
  } catch (error) {
    console.error('Get category error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   POST /api/categories
// @desc    Create new category (Admin only)
// @access  Admin
router.post('/', adminOnly, async (req, res) => {
  try {
    const { name, description, isActive = true, displayOrder = 0 } = req.body;
    
    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'Category name is required'
      });
    }
    
    // Check if category exists
    const existingCategory = await Category.findOne({ 
      name: { $regex: new RegExp(`^${name}$`, 'i') } 
    });
    
    if (existingCategory) {
      return res.status(400).json({
        success: false,
        error: 'Category with this name already exists'
      });
    }
    
    const category = await Category.create({
      name,
      description,
      isActive,
      displayOrder,
      createdBy: req.user._id
    });
    
    // Emit real-time event
    const io = req.app.get('io');
    if (io) {
      io.emit('category:created', { category });
    }
    
    res.status(201).json({
      success: true,
      data: category,
      message: `Category "${name}" created successfully`
    });
  } catch (error) {
    console.error('Create category error:', error);
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        error: 'Category already exists'
      });
    }
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   PUT /api/categories/:id
// @desc    Update category (Admin only)
// @access  Admin
router.put('/:id', adminOnly, async (req, res) => {
  try {
    const { name, description, isActive, displayOrder } = req.body;
    
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (isActive !== undefined) updateData.isActive = isActive;
    if (displayOrder !== undefined) updateData.displayOrder = displayOrder;
    
    const category = await Category.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    ).lean();
    
    if (!category) {
      return res.status(404).json({
        success: false,
        error: 'Category not found'
      });
    }
    
    // Emit real-time event
    const io = req.app.get('io');
    if (io) {
      io.emit('category:updated', { category });
    }
    
    res.json({
      success: true,
      data: category,
      message: `Category "${category.name}" updated successfully`
    });
  } catch (error) {
    console.error('Update category error:', error);
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        error: 'Category name already exists'
      });
    }
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   DELETE /api/categories/:id
// @desc    Delete category (Admin only) - Only if no products exist
// @access  Admin
router.delete('/:id', adminOnly, async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);
    
    if (!category) {
      return res.status(404).json({
        success: false,
        error: 'Category not found'
      });
    }
    
    // Check if any products exist in this category
    const productCount = await Product.countDocuments({ category: category._id });
    
    if (productCount > 0) {
      return res.status(400).json({
        success: false,
        error: `Cannot delete category. ${productCount} product(s) are using this category. Please reassign or delete those products first.`
      });
    }
    
    await Category.findByIdAndDelete(req.params.id);
    
    // Emit real-time event
    const io = req.app.get('io');
    if (io) {
      io.emit('category:deleted', { categoryId: req.params.id });
    }
    
    res.json({
      success: true,
      message: `Category "${category.name}" deleted successfully`
    });
  } catch (error) {
    console.error('Delete category error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   GET /api/categories/:id/products
// @desc    Get all products in a category
// @access  Private
router.get('/:id/products', async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const [products, total] = await Promise.all([
      Product.find({ category: req.params.id })
        .select('name price stock isFastSale isActive')
        .sort('-createdAt')
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Product.countDocuments({ category: req.params.id })
    ]);
    
    res.json({
      success: true,
      data: products,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get category products error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

module.exports = router;
