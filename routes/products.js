const express = require('express');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const Category = require('../models/Category');
const { protect, adminOnly } = require('../middleware/auth');
const { get, set, del, delByPattern } = require('../config/redis');
const { upload, compressAndSaveImage, deleteOldImage } = require('../middleware/upload');

const router = express.Router();

// ============================================================================
// CACHE KEYS — Centralized cache key management
// ============================================================================
const CACHE_KEYS = {
  // NEW: Single-key catalog (replaces hundreds of per-query keys)
  catalog: () => 'products:catalog',
  catalogVersion: () => 'products:catalog:version',
  // Legacy: Per-query keys (kept for admin panel pagination)
  productList: (query) => `products:list:${JSON.stringify(query)}`,
  categories: () => 'products:categories',
  lowStock: (threshold) => `products:lowstock:${threshold}`
};

// ============================================================================
// CATALOG INVALIDATION — Called by every CRUD operation
// Invalidates Redis catalog + emits Socket.IO event to all Flutter apps
// ============================================================================
async function invalidateCatalog(io, eventType, productData) {
  const newVersion = Date.now();
  
  // Invalidate ALL product-related caches in one batch
  await Promise.all([
    del(CACHE_KEYS.catalog()),
    del(CACHE_KEYS.categories()),
    delByPattern('products:list:*'),
    delByPattern('products:lowstock:*'),
    // Set new version (so Flutter knows to re-fetch)
    set(CACHE_KEYS.catalogVersion(), newVersion, 1800)
  ]);
  
  // Emit catalog update event to ALL connected Flutter apps
  // Flutter listens for this and updates its local Hive/SQLite cache instantly
  if (io) {
    io.emit('catalog:updated', {
      type: eventType, // 'product_created', 'product_updated', 'product_deleted', 'inventory_updated'
      product: productData ? {
        _id: productData._id,
        name: productData.name,
        price: productData.price,
        unit: productData.unit,
        category: productData.category,
        categoryName: productData.categoryName,
        isFastSale: productData.isFastSale,
        isActive: productData.isActive,
        image: productData.image || null
      } : null,
      version: newVersion,
      timestamp: new Date().toISOString()
    });
  }
  
  console.log(`🔄 Catalog invalidated (v${newVersion}) — ${eventType}`);
  return newVersion;
}

// All routes require authentication
router.use(protect);

// ============================================================================
// CATALOG ENDPOINTS — Optimized for 6000+ products, Flutter local caching
// ============================================================================

// @route   GET /api/products/catalog
// @desc    Full product catalog — ALL active products in ONE response
//          Designed for Flutter to fetch once and cache locally in Hive/SQLite
//          ~1MB for 6000 products, ~200KB gzipped over network (size of one photo)
//          Cached in Redis as ONE key (not hundreds of per-query keys)
// @access  Private
router.get('/catalog', async (req, res) => {
  try {
    const { version } = req.query;
    
    // ─── FAST VERSION CHECK ───
    // If Flutter sends its current version, check if catalog has changed
    // This saves bandwidth — returns 50 bytes instead of 1MB when nothing changed
    const currentVersion = await get(CACHE_KEYS.catalogVersion());
    
    if (version && currentVersion && version.toString() === currentVersion.toString()) {
      return res.json({
        success: true,
        modified: false,
        version: currentVersion,
        message: 'Catalog is up to date'
      });
    }
    
    // ─── TRY REDIS CACHE (single key, ~1MB) ───
    const cached = await get(CACHE_KEYS.catalog());
    if (cached) {
      return res.json({
        success: true,
        data: cached.data,
        version: currentVersion || cached.version,
        total: cached.total
      });
    }
    
    // ─── CACHE MISS — Fetch from MongoDB ───
    // Select ONLY fields Flutter needs for order creation + search
    // No description, no timestamps — keep it lightweight
    const products = await Product.find({ isActive: true })
      .select('name price unit category categoryName isFastSale image')
      .sort('name')
      .lean();
    
    // ─── BATCH CATEGORY POPULATION (fix N+1 problem) ───
    // Old code: 50 products × 1 category query each = 50 DB calls
    // New code: 1 batch query for all categories = 1 DB call
    const productsNeedingCategory = products.filter(
      p => p.category && mongoose.Types.ObjectId.isValid(p.category) && !p.categoryName
    );
    
    if (productsNeedingCategory.length > 0) {
      const uniqueCategoryIds = [...new Set(productsNeedingCategory.map(p => p.category.toString()))];
      const categories = await Category.find({ _id: { $in: uniqueCategoryIds } })
        .select('name')
        .lean();
      const categoryMap = new Map(categories.map(c => [c._id.toString(), c.name]));
      
      products.forEach(p => {
        if (p.category && categoryMap.has(p.category.toString())) {
          p.categoryName = categoryMap.get(p.category.toString());
        }
      });
    }
    
    // Also handle legacy products where category is a plain string (not ObjectId)
    products.forEach(p => {
      if (p.category && !p.categoryName && typeof p.category === 'string' && !mongoose.Types.ObjectId.isValid(p.category)) {
        p.categoryName = p.category;
      }
    });
    
    const catalogVersion = currentVersion || Date.now();
    const catalogData = {
      data: products,
      version: catalogVersion,
      total: products.length
    };
    
    // Cache for 30 minutes (1800 seconds) — ONE key for entire catalog
    await Promise.all([
      set(CACHE_KEYS.catalog(), catalogData, 1800),
      set(CACHE_KEYS.catalogVersion(), catalogVersion, 1800)
    ]);
    
    console.log(`💾 Catalog cached: ${products.length} products (v${catalogVersion})`);
    
    res.json({
      success: true,
      data: products,
      version: catalogVersion,
      total: products.length
    });
  } catch (error) {
    console.error('Get catalog error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// @route   GET /api/products/catalog/version
// @desc    Check catalog version — ultra lightweight (~100 bytes response)
//          Flutter calls this periodically to know if it needs to re-fetch
//          Also called on app resume / reconnect
// @access  Private
router.get('/catalog/version', async (req, res) => {
  try {
    let version = await get(CACHE_KEYS.catalogVersion());
    
    if (!version) {
      // Fallback: derive version from latest product update timestamp
      const latest = await Product.findOne({ isActive: true })
        .sort('-updatedAt')
        .select('updatedAt')
        .lean();
      
      version = latest ? new Date(latest.updatedAt).getTime() : Date.now();
      await set(CACHE_KEYS.catalogVersion(), version, 1800);
    }
    
    // Also return total count (useful for Flutter to detect if products were deleted)
    const total = await Product.countDocuments({ isActive: true });
    
    res.json({
      success: true,
      version,
      total
    });
  } catch (error) {
    console.error('Get catalog version error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================================
// PRODUCT LIST — Paginated, for admin panel / web dashboard
// ============================================================================

// @route   GET /api/products
// @desc    Get products with pagination, search, filtering (admin panel)
//          For Flutter order creation, use /catalog instead
// @access  Private
router.get('/', async (req, res) => {
  try {
    const { 
      search, 
      category, 
      isFastSale,
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
    
    // ─── FIXED SEARCH: Regex for partial matching ───
    // OLD: $text search (only matches full words — "cha" doesn't find "chair")
    // NEW: Regex search (partial matching — "cha" finds "chair", "chandelier", etc.)
    if (search) {
      const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { name: { $regex: escapedSearch, $options: 'i' } },
        { categoryName: { $regex: escapedSearch, $options: 'i' } },
        { description: { $regex: escapedSearch, $options: 'i' } }
      ];
    }
    
    // Filter by category
    if (category) {
      query.category = category;
    }
    
    // Filter by fast sale
    if (isFastSale !== undefined) {
      query.isFastSale = isFastSale === 'true';
    }
    
    // Try cache (kept for admin panel performance)
    const cacheKey = CACHE_KEYS.productList({ search, category, isFastSale, active, page, limit, sort });
    const cached = await get(cacheKey);
    
    if (cached) {
      return res.json(cached);
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const [products, total] = await Promise.all([
      Product.find(query)
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Product.countDocuments(query)
    ]);
    
    // ─── FIXED N+1: Batch category population instead of per-product loop ───
    // OLD: for each product → separate Category.findById() → N queries
    // NEW: collect all IDs → single Category.find({ $in: [...] }) → 1 query
    const productsNeedingCategory = products.filter(
      p => p.category && mongoose.Types.ObjectId.isValid(p.category) && !p.categoryName
    );
    
    if (productsNeedingCategory.length > 0) {
      const uniqueCategoryIds = [...new Set(productsNeedingCategory.map(p => p.category.toString()))];
      const categories = await Category.find({ _id: { $in: uniqueCategoryIds } })
        .select('name')
        .lean();
      const categoryMap = new Map(categories.map(c => [c._id.toString(), c.name]));
      
      products.forEach(p => {
        if (p.category && categoryMap.has(p.category.toString())) {
          const catName = categoryMap.get(p.category.toString());
          p.category = { _id: p.category, name: catName };
          p.categoryName = catName;
        }
      });
    }
    
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
    
    // Cache for 10 minutes
    await set(cacheKey, response, 600);
    
    res.json(response);
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// @route   GET /api/products/low-stock
// @desc    Get products with low inventory (cached)
// @access  Private
router.get('/low-stock', async (req, res) => {
  try {
    const { threshold = 10 } = req.query;
    
    const cacheKey = CACHE_KEYS.lowStock(threshold);
    const cached = await get(cacheKey);
    if (cached) {
      return res.json(cached);
    }
    
    const lowStockProducts = await Product.find({
      isActive: true,
      inventory: { $ne: null, $lt: parseInt(threshold), $gte: 0 }
    })
    .select('name inventory category categoryName unit price')
    .sort('inventory')
    .lean();
    
    const response = {
      success: true,
      data: lowStockProducts,
      count: lowStockProducts.length
    };
    
    // Cache for 5 minutes
    await set(cacheKey, response, 300);
    
    res.json(response);
  } catch (error) {
    console.error('Get low stock products error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// @route   GET /api/products/categories
// @desc    Get all product categories (cached 1 hour)
// @access  Private
router.get('/categories', async (req, res) => {
  try {
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
    
    await set(CACHE_KEYS.categories(), response, 3600);
    
    res.json(response);
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// @route   GET /api/products/search
// @desc    Quick product search — supports partial matching ("cha" → "Chair")
//          Used by admin panel / web. Flutter uses local search on cached catalog.
// @access  Private
router.get('/search', async (req, res) => {
  try {
    const { q, category, limit: resultLimit = 20 } = req.query;
    
    if (!q || q.length < 1) {
      return res.json({ success: true, data: [] });
    }
    
    // ─── FIXED: Regex for partial matching ───
    // OLD: $text search (only full words)
    // NEW: Regex (partial matching, works from first character)
    const escapedQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const searchQuery = {
      isActive: true,
      $or: [
        { name: { $regex: escapedQ, $options: 'i' } },
        { categoryName: { $regex: escapedQ, $options: 'i' } }
      ]
    };
    
    // Optional category filter
    if (category) {
      searchQuery.category = category;
    }
    
    const products = await Product.find(searchQuery)
      .select('name price unit category categoryName inventory image isFastSale')
      .sort('name')
      .limit(parseInt(resultLimit))
      .lean();
    
    res.json({
      success: true,
      data: products,
      count: products.length
    });
  } catch (error) {
    console.error('Search products error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// @route   GET /api/products/:id
// @desc    Get single product by ID
// @access  Private
router.get('/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean();
    
    if (!product) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }
    
    res.json({ success: true, data: product });
  } catch (error) {
    console.error('Get product error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================================
// CRUD OPERATIONS — All invalidate catalog + emit Socket.IO events
// ============================================================================

// @route   POST /api/products
// @desc    Create product with optional image upload
// @access  Admin only
router.post('/', adminOnly, upload, compressAndSaveImage, async (req, res) => {
  try {
    const { name, description, price, inventory, category, unit, isFastSale } = req.body;
    
    if (!name) {
      return res.status(400).json({ success: false, error: 'Product name is required' });
    }
    
    const productData = {
      name,
      description,
      price: price || null,
      inventory: inventory || null,
      category: category || null,
      unit,
      isFastSale: isFastSale === true || isFastSale === 'true'
    };
    
    // Denormalize category name
    if (category) {
      const categoryDoc = await Category.findById(category);
      if (categoryDoc) {
        productData.categoryName = categoryDoc.name;
      }
    }
    
    // Add image if uploaded
    if (req.imagePath) {
      productData.image = req.imagePath;
    }
    
    const product = await Product.create(productData);
    
    // Update category product count
    if (category) {
      await Category.findByIdAndUpdate(category, { $inc: { productCount: 1 } });
    }
    
    // Invalidate catalog + notify all Flutter apps
    const io = req.app.get('io');
    await invalidateCatalog(io, 'product_created', product);
    
    // Also emit legacy event for backward compatibility
    if (io) {
      io.emit('product:created', { product });
    }
    
    res.status(201).json({
      success: true,
      data: product,
      message: req.imagePath
        ? `Product created with image (${Math.round(req.imageSize / 1024)}KB)`
        : 'Product created successfully'
    });
  } catch (error) {
    console.error('Create product error:', error);
    
    if (req.imagePath) {
      await deleteOldImage(req.imagePath);
    }
    
    if (error.code === 11000) {
      return res.status(400).json({ success: false, error: 'Product with this name already exists' });
    }
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// @route   PUT /api/products/:id
// @desc    Update product with optional image upload
// @access  Admin only
router.put('/:id', adminOnly, upload, compressAndSaveImage, async (req, res) => {
  try {
    const { name, description, price, inventory, category, unit, isActive, isFastSale } = req.body;
    
    const existingProduct = await Product.findById(req.params.id).lean();
    
    if (!existingProduct) {
      if (req.imagePath) await deleteOldImage(req.imagePath);
      return res.status(404).json({ success: false, error: 'Product not found' });
    }
    
    // Build update — only include fields that were actually sent
    // This prevents overwriting existing values with undefined/null when fields are missing
    const updateData = {};
    
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    
    // Price: explicitly handle null (disable price) vs number
    if (price !== undefined) {
      updateData.price = price === null || price === '' || price === 'null' ? null : Number(price);
    }
    
    // Inventory: explicitly handle null (disable tracking) vs number
    if (inventory !== undefined) {
      updateData.inventory = inventory === null || inventory === '' || inventory === 'null' ? null : Number(inventory);
    }
    
    if (unit !== undefined) updateData.unit = unit;
    
    // Boolean fields — handle string "true"/"false" from multipart form-data
    if (isActive !== undefined) {
      updateData.isActive = isActive === true || isActive === 'true';
    }
    if (isFastSale !== undefined) {
      updateData.isFastSale = isFastSale === true || isFastSale === 'true';
    }
    
    // Category
    if (category !== undefined) {
      updateData.category = category || null;
    }
    
    // Handle category change — update categoryName and counts
    if (category && category !== existingProduct.category?.toString()) {
      try {
        const categoryDoc = await Category.findById(category);
        if (categoryDoc) {
          updateData.categoryName = categoryDoc.name;
          await Category.findByIdAndUpdate(category, { $inc: { productCount: 1 } });
          if (existingProduct.category) {
            await Category.findByIdAndUpdate(existingProduct.category, { $inc: { productCount: -1 } });
          }
        }
      } catch (catErr) {
        console.warn('⚠️ Category update error (non-fatal):', catErr.message);
      }
    }
    
    // Handle image update
    if (req.imagePath) {
      if (existingProduct.image) await deleteOldImage(existingProduct.image);
      updateData.image = req.imagePath;
    }
    
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    ).lean();
    
    if (!product) {
      return res.status(404).json({ success: false, error: 'Product not found after update' });
    }
    
    // Invalidate catalog + notify all Flutter apps
    const io = req.app.get('io');
    await invalidateCatalog(io, 'product_updated', product);
    
    if (io) {
      io.emit('product:updated', { product });
    }
    
    res.json({
      success: true,
      data: product,
      message: req.imagePath
        ? `Product updated with new image (${Math.round(req.imageSize / 1024)}KB)`
        : 'Product updated successfully'
    });
  } catch (error) {
    console.error('Update product error:', error);
    if (req.imagePath) await deleteOldImage(req.imagePath);
    
    // Return actual error message for debugging
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ success: false, error: messages.join(', ') });
    }
    if (error.name === 'CastError') {
      return res.status(400).json({ success: false, error: `Invalid value for field "${error.path}": ${error.value}` });
    }
    
    res.status(500).json({ success: false, error: error.message || 'Server error' });
  }
});

// @route   DELETE /api/products/:id
// @desc    Soft delete product (sets isActive=false)
// @access  Admin only
router.delete('/:id', adminOnly, async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true }
    ).lean();
    
    if (!product) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }
    
    // Delete product image
    if (product.image) {
      await deleteOldImage(product.image);
    }
    
    // Invalidate catalog + notify all Flutter apps
    const io = req.app.get('io');
    await invalidateCatalog(io, 'product_deleted', product);
    
    if (io) {
      io.emit('product:deleted', { productId: product._id });
    }
    
    res.json({ success: true, message: 'Product deleted successfully' });
  } catch (error) {
    console.error('Delete product error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// @route   DELETE /api/products/:id/image
// @desc    Delete product image only
// @access  Admin only
router.delete('/:id/image', adminOnly, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    
    if (!product) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }
    
    if (!product.image) {
      return res.status(400).json({ success: false, error: 'Product has no image to delete' });
    }
    
    await deleteOldImage(product.image);
    product.image = undefined;
    await product.save();
    
    // Invalidate catalog + notify all Flutter apps
    const io = req.app.get('io');
    await invalidateCatalog(io, 'product_updated', product.toObject());
    
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
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// @route   PUT /api/products/:id/inventory
// @desc    Update product inventory (admin manual adjustment)
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
      return res.status(404).json({ success: false, error: 'Product not found' });
    }
    
    // Invalidate catalog + notify all Flutter apps
    const io = req.app.get('io');
    await invalidateCatalog(io, 'inventory_updated', product);
    
    if (io) {
      io.emit('product:inventory-updated', { product });
    }
    
    res.json({ success: true, data: product });
  } catch (error) {
    console.error('Update inventory error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;
