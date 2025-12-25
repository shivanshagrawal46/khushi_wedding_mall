const express = require('express');
const Product = require('../models/Product');
const { protect, adminOnly } = require('../middleware/auth');
const { get, set, del, delByPattern } = require('../config/redis');
const { upload, compressAndSaveImage, deleteOldImage } = require('../middleware/upload');

const router = express.Router();

// Redis cache keys
const CACHE_KEYS = {
  productList: (query) => `products:list:${JSON.stringify(query)}`,
  allProducts: () => 'products:all',
  categories: () => 'products:categories',
  lowStock: (threshold) => `products:lowstock:${threshold}`
};

// All routes require authentication
router.use(protect);

// @route   GET /api/products
// @desc    Get all products with Redis caching
// @access  Private
router.get('/', async (req, res) => {
  try {
    const { 
      search, 
      category, 
      active = 'true',
      page = 1, 
      limit = 50,
      sort = '-createdAt'
    } = req.query;
    
    const query = {};
    
    // Filter by active status
    if (active !== 'all') {
      query.isActive = active === 'true';
    }
    
    // Search by name/description (OPTIMIZED with text index for 500-600 products)
    if (search) {
      // Use text search for better performance with large datasets
      query.$text = { $search: search };
    }
    
    // Filter by category
    if (category) {
      query.category = category;
    }
    
    // OPTIMIZATION: Cache product list for 10 minutes (huge speed boost for 500-600 products)
    const cacheKey = CACHE_KEYS.productList({ search, category, active, page, limit, sort });
    const cacheStartTime = Date.now();
    const cached = await get(cacheKey);
    const cacheLookupTime = Date.now() - cacheStartTime;
    
    if (cached) {
      console.log(`✅ Redis cache HIT for products list (lookup: ${cacheLookupTime}ms): ${cacheKey}`);
      return res.json(cached);
    }
    
    console.log(`❌ Redis cache MISS for products list (lookup: ${cacheLookupTime}ms): ${cacheKey}`);
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Execute query with lean() for maximum speed
    // OPTIMIZATION: Build sort object (text search needs score sorting)
    const sortObj = query.$text ? { score: { $meta: 'textScore' }, ...{'-createdAt': -1} } : sort;
    
    const [products, total] = await Promise.all([
      Product.find(query)
        .sort(sortObj)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Product.countDocuments(query) // No .lean() for count
    ]);
    
    const response = {
      success: true,
      data: products,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    };
    
    // Cache for 10 minutes (600 seconds)
    const cacheSetStartTime = Date.now();
    const cacheSetResult = await set(cacheKey, response, 600);
    const cacheSetTime = Date.now() - cacheSetStartTime;
    
    if (cacheSetResult) {
      console.log(`💾 Redis cache SET for products list (${cacheSetTime}ms, TTL: 600s): ${cacheKey}`);
    } else {
      console.warn(`⚠️  Redis cache SET FAILED for products list (${cacheSetTime}ms): ${cacheKey}`);
    }
    
    res.json(response);
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   GET /api/products/low-stock
// @desc    Get products with low inventory with caching
// @access  Private
router.get('/low-stock', async (req, res) => {
  try {
    const { threshold = 10 } = req.query;
    
    // OPTIMIZATION: Cache low-stock for 5 minutes (updates frequently)
    const cacheKey = CACHE_KEYS.lowStock(threshold);
    const cached = await get(cacheKey);
    if (cached) {
      return res.json(cached);
    }
    
    const lowStockProducts = await Product.find({
      isActive: true,
      inventory: { $ne: null, $lt: parseInt(threshold), $gte: 0 }
    })
    .select('name inventory category unit price')
    .sort('inventory')
    .lean();
    
    const response = {
      success: true,
      data: lowStockProducts,
      count: lowStockProducts.length
    };
    
    // Cache for 5 minutes (300 seconds)
    await set(cacheKey, response, 300);
    
    res.json(response);
  } catch (error) {
    console.error('Get low stock products error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   GET /api/products/categories
// @desc    Get all product categories with caching
// @access  Private
router.get('/categories', async (req, res) => {
  try {
    // OPTIMIZATION: Cache categories for 1 hour
    const cached = await get(CACHE_KEYS.categories());
    if (cached) {
      return res.json(cached);
    }
    
    const categories = await Product.distinct('category', { 
      isActive: true,
      category: { $ne: null, $ne: '' }
    });
    
    const response = {
      success: true,
      data: categories.sort()
    };
    
    // Cache for 1 hour (3600 seconds)
    await set(CACHE_KEYS.categories(), response, 3600);
    
    res.json(response);
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   GET /api/products/search
// @desc    Quick search products for invoice creation
// @access  Private
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    
    if (!q || q.length < 2) {
      return res.json({ success: true, data: [] });
    }
    
    // OPTIMIZED: Use text index for search (faster for 500-600 products)
    const products = await Product.find({
      isActive: true,
      $text: { $search: q }
    })
    .select('name price unit category inventory')
    .sort({ score: { $meta: 'textScore' } })
    .limit(15)
    .lean();
    
    res.json({
      success: true,
      data: products
    });
  } catch (error) {
    console.error('Search products error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   GET /api/products/:id
// @desc    Get single product
// @access  Private
router.get('/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean();
    
    if (!product) {
      return res.status(404).json({
        success: false,
        error: 'Product not found'
      });
    }
    
    res.json({
      success: true,
      data: product
    });
  } catch (error) {
    console.error('Get product error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   POST /api/products
// @desc    Create product with optional image upload
// @access  Admin only
router.post('/', adminOnly, upload, compressAndSaveImage, async (req, res) => {
  try {
    const { name, description, price, inventory, category, unit } = req.body;
    
    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'Product name is required'
      });
    }
    
    const productData = {
      name,
      description,
      price: price || null,
      inventory: inventory || null,
      category,
      unit
    };
    
    // Add image path if image was uploaded
    if (req.imagePath) {
      productData.image = req.imagePath;
    }
    
    const product = await Product.create(productData);
    
    // Invalidate ALL product caches (including all product list variations)
    const invalidationPromises = [
      del(CACHE_KEYS.allProducts()),
      del(CACHE_KEYS.categories()),
      delByPattern('products:list:*') // Delete all product list cache variations
    ];
    
    await Promise.all(invalidationPromises);
    console.log('🗑️  Product caches invalidated after product creation');
    
    // Emit real-time event
    const io = req.app.get('io');
    if (io) {
      io.emit('product:created', { product });
    }
    
    res.status(201).json({
      success: true,
      data: product,
      message: req.imagePath ? `Product created with image (${Math.round(req.imageSize / 1024)}KB)` : 'Product created successfully'
    });
  } catch (error) {
    console.error('Create product error:', error);
    
    // Delete uploaded image if product creation failed
    if (req.imagePath) {
      await deleteOldImage(req.imagePath);
    }
    
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        error: 'Product with this name already exists'
      });
    }
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   PUT /api/products/:id
// @desc    Update product with optional image upload
// @access  Admin only
router.put('/:id', adminOnly, upload, compressAndSaveImage, async (req, res) => {
  try {
    const { name, description, price, inventory, category, unit, isActive } = req.body;
    
    // Get existing product to check for old image
    const existingProduct = await Product.findById(req.params.id).lean();
    
    if (!existingProduct) {
      // Delete uploaded image if product not found
      if (req.imagePath) {
        await deleteOldImage(req.imagePath);
      }
      return res.status(404).json({
        success: false,
        error: 'Product not found'
      });
    }
    
    const updateData = { 
      name, 
      description, 
      price: price !== undefined ? price : null,
      inventory: inventory !== undefined ? inventory : null,
      category, 
      unit,
      isActive 
    };
    
    // If new image uploaded, update image path and delete old image
    if (req.imagePath) {
      // Delete old image if exists
      if (existingProduct.image) {
        await deleteOldImage(existingProduct.image);
      }
      updateData.image = req.imagePath;
    }
    
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    ).lean();
    
    // Invalidate ALL product caches (including all product list variations)
    const invalidationPromises = [
      del(CACHE_KEYS.allProducts()),
      del(CACHE_KEYS.categories()),
      del(CACHE_KEYS.lowStock(10)),
      del(CACHE_KEYS.lowStock(15)),
      del(CACHE_KEYS.lowStock(20)),
      delByPattern('products:list:*') // Delete all product list cache variations
    ];
    
    await Promise.all(invalidationPromises);
    console.log('🗑️  Product caches invalidated after product update');
    
    // Emit real-time event
    const io = req.app.get('io');
    if (io) {
      io.emit('product:updated', { product });
    }
    
    res.json({
      success: true,
      data: product,
      message: req.imagePath ? `Product updated with new image (${Math.round(req.imageSize / 1024)}KB)` : 'Product updated successfully'
    });
  } catch (error) {
    console.error('Update product error:', error);
    
    // Delete uploaded image if update failed
    if (req.imagePath) {
      await deleteOldImage(req.imagePath);
    }
    
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   DELETE /api/products/:id
// @desc    Delete product (soft delete)
// @access  Admin only
router.delete('/:id', adminOnly, async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true }
    ).lean();
    
    if (!product) {
      return res.status(404).json({
        success: false,
        error: 'Product not found'
      });
    }
    
    // Delete product image if exists
    if (product.image) {
      await deleteOldImage(product.image);
    }
    
    // Invalidate ALL product caches (including all product list variations)
    const invalidationPromises = [
      del(CACHE_KEYS.allProducts()),
      del(CACHE_KEYS.categories()),
      delByPattern('products:list:*') // Delete all product list cache variations
    ];
    
    await Promise.all(invalidationPromises);
    console.log('🗑️  Product caches invalidated after product deletion');
    
    // Emit real-time event
    const io = req.app.get('io');
    if (io) {
      io.emit('product:deleted', { productId: product._id });
    }
    
    res.json({
      success: true,
      message: 'Product deleted successfully'
    });
  } catch (error) {
    console.error('Delete product error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   DELETE /api/products/:id/image
// @desc    Delete product image
// @access  Admin only
router.delete('/:id/image', adminOnly, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    
    if (!product) {
      return res.status(404).json({
        success: false,
        error: 'Product not found'
      });
    }
    
    if (!product.image) {
      return res.status(400).json({
        success: false,
        error: 'Product has no image to delete'
      });
    }
    
    // Delete image file
    await deleteOldImage(product.image);
    
    // Remove image from product
    product.image = undefined;
    await product.save();
    
    // Invalidate ALL product caches (including all product list variations)
    const invalidationPromises = [
      del(CACHE_KEYS.allProducts()),
      del(CACHE_KEYS.categories()),
      delByPattern('products:list:*') // Delete all product list cache variations
    ];
    
    await Promise.all(invalidationPromises);
    console.log('🗑️  Product caches invalidated after image deletion');
    
    // Emit real-time event
    const io = req.app.get('io');
    if (io) {
      io.emit('product:updated', { product: product.toObject() });
    }
    
    res.json({
      success: true,
      message: 'Product image deleted successfully',
      data: product
    });
  } catch (error) {
    console.error('Delete product image error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   PUT /api/products/:id/inventory
// @desc    Update product inventory
// @access  Admin only
router.put('/:id/inventory', adminOnly, async (req, res) => {
  try {
    const { inventory } = req.body;
    
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { inventory },
      { new: true }
    ).lean();
    
    if (!product) {
      return res.status(404).json({
        success: false,
        error: 'Product not found'
      });
    }
    
    // Invalidate ALL inventory-related caches (including product lists)
    const invalidationPromises = [
      del(CACHE_KEYS.lowStock(10)),
      del(CACHE_KEYS.lowStock(15)),
      del(CACHE_KEYS.lowStock(20)),
      delByPattern('products:list:*') // Product lists might show inventory, so invalidate them too
    ];
    
    await Promise.all(invalidationPromises);
    console.log('🗑️  Product caches invalidated after inventory update');
    
    // Emit real-time event
    const io = req.app.get('io');
    if (io) {
      io.emit('product:inventory-updated', { product });
    }
    
    res.json({
      success: true,
      data: product
    });
  } catch (error) {
    console.error('Update inventory error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

module.exports = router;

