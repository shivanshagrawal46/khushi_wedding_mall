const express = require('express');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Delivery = require('../models/Delivery');
const DeliveryInvoice = require('../models/DeliveryInvoice');
const Client = require('../models/Client');
const User = require('../models/User');
const Product = require('../models/Product');
const { protect, adminOnly } = require('../middleware/auth');
const { createOrder, createDelivery, generateDeliveryInvoice, updateDeliveryStatus } = require('../utils/orderManager');
const { adjustInventory } = require('../utils/inventoryManager');
const {
  getOrderStatus,
  getOrderProgress,
  getOrderRemaining,
  getCachedOrder,
  getDashboardCounters,
  getTodayDeliveries,
  invalidateOrderCache,
  initializeOrderCache
} = require('../utils/orderCache');
const { getRedisClient, get, set, del, delByPattern } = require('../config/redis');
const { recordOrderPayment } = require('../utils/paymentManager');

const router = express.Router();

// Redis cache keys for orders list
const ORDER_CACHE_KEYS = {
  orderList: (query) => `orders:list:${JSON.stringify(query)}`
};

// Middleware to check if order is locked
const checkOrderLock = async (req, res, next) => {
  try {
    const { id } = req.params;
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);
    const query = isObjectId ? { _id: id } : { orderNumber: id.toUpperCase() };
    
    const order = await Order.findOne(query).select('isLocked status').lean();
    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }
    
    if (order.isLocked || order.status === 'completed') {
      return res.status(403).json({
        success: false,
        error: 'Order is completed and locked. Cannot be modified.'
      });
    }
    
    req.order = order;
    next();
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
};

// All routes require authentication
router.use(protect);

// @route   GET /api/orders
// @desc    Get all orders with filtering (optimized with lean())
// @access  Private
router.get('/', async (req, res) => {
  try {
    const {
      search,
      status,
      paymentStatus,
      date,       // Single date: ?date=2026-02-01 → all orders on Feb 1
      startDate,  // Range start: ?startDate=2026-02-02
      endDate,    // Range end:   ?endDate=2026-02-10
      isFastOrder,
      page = 1,
      limit = 50,
      sort = '-orderDate'
    } = req.query;
    
    const query = {};
    
    // Text search
    if (search) {
      const searchRegex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [
        { partyName: searchRegex },
        { mobile: searchRegex },
        { orderNumber: searchRegex }
      ];
    }
    
    // Filter by status
    if (status) {
      query.status = status;
    }
    
    // Filter by payment status
    if (paymentStatus) {
      query.paymentStatus = paymentStatus;
    }
    
    // Filter by fast order
    if (isFastOrder !== undefined) {
      query.isFastOrder = isFastOrder === 'true';
    }
    
    // Date filter — single day or range
    if (date) {
      // Single date: all orders on that specific day (00:00:00 to 23:59:59)
      const dayStart = new Date(date);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(date);
      dayEnd.setHours(23, 59, 59, 999);
      query.orderDate = { $gte: dayStart, $lte: dayEnd };
    } else if (startDate || endDate) {
      // Date range
      query.orderDate = {};
      if (startDate) {
        const rangeStart = new Date(startDate);
        rangeStart.setHours(0, 0, 0, 0);
        query.orderDate.$gte = rangeStart;
      }
      if (endDate) {
        const rangeEnd = new Date(endDate);
        rangeEnd.setHours(23, 59, 59, 999);
        query.orderDate.$lte = rangeEnd;
      }
    }
    
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;
    
    // OPTIMIZATION: Cache first 5 pages only (most frequently accessed)
    const shouldCache = pageNum <= 5;
    const cacheKey = ORDER_CACHE_KEYS.orderList({ search, status, paymentStatus, startDate, endDate, page: pageNum, limit: limitNum, sort });
    
    // Try to get from cache if page <= 5
    if (shouldCache) {
      const cacheStartTime = Date.now();
      const cached = await get(cacheKey);
      const cacheLookupTime = Date.now() - cacheStartTime;
      
      if (cached) {
        console.log(`✅ Redis cache HIT for orders list (lookup: ${cacheLookupTime}ms): ${cacheKey}`);
        return res.json(cached);
      }
      console.log(`❌ Redis cache MISS for orders list (lookup: ${cacheLookupTime}ms): ${cacheKey}`);
    }
    
    // Execute optimized query with lean()
    const [orders, total] = await Promise.all([
      Order.find(query)
        .select('orderNumber partyName mobile grandTotal balanceDue orderDate expectedDeliveryDate status paymentStatus progress totalDeliveries employeeName comment isLocked')
        .sort(sort)
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Order.countDocuments(query)
    ]);
    
    const response = {
      success: true,
      data: orders,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    };
    
    // Cache response if page <= 5 (5 minutes TTL)
    if (shouldCache) {
      const cacheSetStartTime = Date.now();
      const cacheSetResult = await set(cacheKey, response, 300); // 5 minutes cache
      const cacheSetTime = Date.now() - cacheSetStartTime;
      
      if (cacheSetResult) {
        console.log(`💾 Redis cache SET for orders list (${cacheSetTime}ms, TTL: 300s): ${cacheKey}`);
      } else {
        console.warn(`⚠️  Redis cache SET FAILED for orders list (${cacheSetTime}ms): ${cacheKey}`);
      }
    }
    
    res.json(response);
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   GET /api/orders/stats
// @desc    Get order statistics for dashboard (cached in Redis)
// @access  Private
router.get('/stats', async (req, res) => {
  try {
    // Try to get from Redis cache first
    let stats = await getDashboardCounters();
    
    if (!stats) {
      // Calculate stats if not in cache
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      
      // OPTIMIZED: Single aggregation instead of 6 separate queries (80% faster)
      const statsResult = await Order.aggregate([
        {
          $facet: {
            total: [{ $count: 'count' }],
            open: [{ $match: { status: 'open' } }, { $count: 'count' }],
            inProgress: [{ $match: { status: { $in: ['in_progress', 'partial_delivered'] } } }, { $count: 'count' }],
            completed: [{ $match: { status: 'completed' } }, { $count: 'count' }],
            unpaid: [{ $match: { paymentStatus: { $in: ['unpaid', 'partial'] } } }, { $count: 'count' }],
            monthly: [
              { $match: { orderDate: { $gte: thisMonth } } },
              {
                $group: {
                  _id: null,
                  totalRevenue: { $sum: '$grandTotal' },
                  totalAdvance: { $sum: '$advance' },
                  count: { $sum: 1 }
                }
              }
            ]
          }
        }
      ]);
      
      const result = statsResult[0];
      stats = {
        totalOrders: result.total[0]?.count || 0,
        openOrders: result.open[0]?.count || 0,
        inProgressOrders: result.inProgress[0]?.count || 0,
        completedOrders: result.completed[0]?.count || 0,
        unpaidOrders: result.unpaid[0]?.count || 0,
        monthlyRevenue: result.monthly[0]?.totalRevenue || 0,
        monthlyAdvance: result.monthly[0]?.totalAdvance || 0,
        monthlyOrders: result.monthly[0]?.count || 0
      };
      
      // Cache for 5 minutes
      const { setDashboardCounters } = require('../utils/orderCache');
      await setDashboardCounters(stats, 300);
    }
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   GET /api/orders/upcoming-deliveries
// @desc    Get upcoming deliveries (optimized with lean())
// @access  Private
router.get('/upcoming-deliveries', async (req, res) => {
  try {
    const { days = 7 } = req.query;
    
    const startDate = new Date();
    startDate.setHours(0, 0, 0, 0);
    
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + parseInt(days));
    
    const deliveries = await Delivery.find({
      deliveryDate: { $gte: startDate, $lte: endDate },
      status: { $in: ['pending', 'in_transit'] }
    })
    .select('deliveryNumber orderNumber partyName mobile deliveryDate status grandTotal')
    .sort('deliveryDate')
    .lean();
    
    res.json({
      success: true,
      data: deliveries
    });
  } catch (error) {
    console.error('Get upcoming deliveries error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   GET /api/orders/by-delivery-date
// @desc    Get orders grouped by expected delivery date (excludes fully delivered/completed orders)
//          Uses expectedDeliveryDate from order, not delivery dates
// @access  Private
router.get('/by-delivery-date', async (req, res) => {
  try {
    const { 
      days = 30,
      status // Optional: filter by specific status
    } = req.query;
    
    // Calculate date range from today
    const dateStart = new Date();
    dateStart.setHours(0, 0, 0, 0);
    
    const dateEnd = new Date(dateStart);
    dateEnd.setDate(dateEnd.getDate() + parseInt(days));
    
    // OPTIMIZED: Get orders based on expectedDeliveryDate
    // Excludes fully delivered/completed orders
    const orders = await Order.find({
      expectedDeliveryDate: { 
        $gte: dateStart, 
        $lte: dateEnd 
      },
      status: { 
        $nin: ['delivered', 'completed', 'cancelled'] // Exclude fully delivered orders
      },
      ...(status ? { status: status } : {}) // Optional status filter
    })
    .select('orderNumber partyName mobile orderDate expectedDeliveryDate status progress paymentStatus grandTotal balanceDue advance employeeName comment totalDeliveries')
    .sort('expectedDeliveryDate')
    .lean();
    
    // Group orders by expected delivery date
    const groupedByDate = {};
    orders.forEach(order => {
      if (!order.expectedDeliveryDate) return; // Skip orders without expected delivery date
      
      const deliveryDateStr = new Date(order.expectedDeliveryDate).toISOString().split('T')[0]; // YYYY-MM-DD
      
      if (!groupedByDate[deliveryDateStr]) {
        groupedByDate[deliveryDateStr] = [];
      }
      
      groupedByDate[deliveryDateStr].push({
        orderNumber: order.orderNumber,
        partyName: order.partyName,
        mobile: order.mobile,
        orderDate: order.orderDate,
        expectedDeliveryDate: order.expectedDeliveryDate,
        status: order.status,
        progress: order.progress,
        paymentStatus: order.paymentStatus,
        grandTotal: order.grandTotal,
        balanceDue: order.balanceDue,
        advance: order.advance,
        employeeName: order.employeeName,
        comment: order.comment,
        totalDeliveries: order.totalDeliveries
      });
    });
    
    // Convert to array format sorted by date
    const groupedArray = Object.keys(groupedByDate)
      .sort()
      .map(date => ({
        expectedDeliveryDate: date,
        orders: groupedByDate[date],
        orderCount: groupedByDate[date].length
      }));
    
    res.json({
      success: true,
      data: groupedArray,
      summary: {
        totalOrders: orders.length,
        dateRange: {
          start: dateStart,
          end: dateEnd
        },
        groupedByDate: groupedArray.length
      }
    });
  } catch (error) {
    console.error('Get orders by delivery date error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Server error'
    });
  }
});

// @route   GET /api/orders/cancelled
// @desc    Get all cancelled orders with pagination and search
// @access  Private
router.get('/cancelled', async (req, res) => {
  try {
    const {
      search,
      startDate,
      endDate,
      page = 1,
      limit = 50,
      sort = '-cancelledAt' // Most recently cancelled first
    } = req.query;
    
    const query = { status: 'cancelled' };
    
    if (search) {
      const searchRegex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [
        { partyName: searchRegex },
        { mobile: searchRegex },
        { orderNumber: searchRegex }
      ];
    }
    
    if (startDate || endDate) {
      query.orderDate = {};
      if (startDate) query.orderDate.$gte = new Date(startDate);
      if (endDate) query.orderDate.$lte = new Date(endDate);
    }
    
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;
    
    const [orders, total] = await Promise.all([
      Order.find(query)
        .select('orderNumber partyName mobile grandTotal advance balanceDue orderDate expectedDeliveryDate status paymentStatus progress employeeName cancelledAt cancelReason updatedAt')
        .sort(sort)
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Order.countDocuments(query)
    ]);
    
    res.json({
      success: true,
      data: orders,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    console.error('Get cancelled orders error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// @route   GET /api/orders/:id
// @desc    Get single order with details (optimized with lean())
// @access  Private
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);
    const query = isObjectId ? { _id: id } : { orderNumber: id.toUpperCase() };
    
    // Try cache first
    let order = null;
    if (isObjectId) {
      order = await getCachedOrder(id);
    }
    
    if (!order) {
      order = await Order.findOne(query)
        .populate('createdBy', 'name username')
        .populate('employee', 'name username')
        .select('+comment') // Include comment field
        .lean();
      
      if (!order) {
        return res.status(404).json({
          success: false,
          error: 'Order not found'
        });
      }
      
      // Cache the order
      if (isObjectId) {
        await initializeOrderCache(order);
      }
    }
    
    res.json({
      success: true,
      data: order
    });
  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   GET /api/orders/:id/remaining
// @desc    Get remaining quantities for order (from Redis cache)
// @access  Private
router.get('/:id/remaining', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Try Redis cache first
    let remaining = await getOrderRemaining(id);
    
    if (!remaining) {
      // Get from database and cache
      const order = await Order.findById(id).select('items').lean();
      if (!order) {
        return res.status(404).json({
          success: false,
          error: 'Order not found'
        });
      }
      
      remaining = {};
      order.items.forEach(item => {
        const itemId = item.product?.toString() || item.productName;
        remaining[itemId] = {
          productId: item.product?.toString(),
          productName: item.productName,
          total: item.quantity,
          delivered: item.deliveredQuantity || 0,
          remaining: item.remainingQuantity || (item.quantity - (item.deliveredQuantity || 0))
        };
      });
      
      const { setOrderRemaining } = require('../utils/orderCache');
      await setOrderRemaining(id, remaining, 3600);
    }
    
    res.json({
      success: true,
      data: remaining
    });
  } catch (error) {
    console.error('Get remaining quantities error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   GET /api/orders/:id/progress
// @desc    Get order progress (from Redis cache)
// @access  Private
router.get('/:id/progress', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Try Redis cache first
    let progress = await getOrderProgress(id);
    let status = await getOrderStatus(id);
    
    if (progress === null || status === null) {
      // Get from database
      const order = await Order.findById(id).select('status progress items').lean();
      if (!order) {
        return res.status(404).json({
          success: false,
          error: 'Order not found'
        });
      }
      
      progress = order.progress || 0;
      status = order.status;
      
      // Cache values
      const { setOrderProgress, setOrderStatus } = require('../utils/orderCache');
      await Promise.all([
        setOrderProgress(id, progress, 3600),
        setOrderStatus(id, status, 3600)
      ]);
    }
    
    res.json({
      success: true,
      data: {
        progress,
        status
      }
    });
  } catch (error) {
    console.error('Get order progress error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   POST /api/orders
// @desc    Create new order
// @access  Private
router.post('/', async (req, res) => {
  const maxRetries = 3;
  let lastError = null;
  
  // Deduplication: if offlineId is provided, check if order already exists
  if (req.body.offlineId) {
    const existing = await Order.findOne({ offlineId: req.body.offlineId })
      .populate('createdBy', 'name username')
      .lean();
    if (existing) {
      return res.status(200).json({
        success: true,
        order: existing,
        duplicate: true,
        message: 'Order already exists (matched by offlineId)'
      });
    }
  }
  
  // Retry logic to handle race conditions in order number generation
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const io = req.app.get('io');
      const result = await createOrder(req.body, req.user._id, io);
      
      // Invalidate ALL orders list cache variations when new order is created
      const deletedCount = await delByPattern('orders:list:*');
      console.log(`🗑️  Orders list caches invalidated after order creation (${deletedCount} cache keys cleared)`);
      
      return res.status(201).json({
        success: true,
        ...result
      });
    } catch (error) {
      lastError = error;
      
      // Check if it's a duplicate key error (code 11000)
      if (error.code === 11000 && error.keyPattern && error.keyPattern.orderNumber) {
        console.warn(`⚠️  Duplicate order number detected on attempt ${attempt}/${maxRetries}. Retrying...`);
        
        if (attempt < maxRetries) {
          // Wait a brief moment before retrying (exponential backoff)
          await new Promise(resolve => setTimeout(resolve, 50 * attempt));
          continue; // Retry
        } else {
          // Max retries reached
          console.error(`❌ Failed to create order after ${maxRetries} attempts due to order number collision`);
          return res.status(500).json({
            success: false,
            error: 'Failed to generate unique order number. Please try again.'
          });
        }
      }
      
      // Insufficient inventory error — return 400 with clear details
      if (error.statusCode === 400 || error.insufficientItem) {
        return res.status(400).json({
          success: false,
          error: error.message || 'Inventory validation failed',
          insufficientItem: error.insufficientItem || null
        });
      }
      
      // Other errors — return 500
      console.error('Create order error:', error);
      return res.status(500).json({
        success: false,
        error: error.message || 'Server error'
      });
    }
  }
  
  // This should never be reached, but just in case
  console.error('Create order error after retries:', lastError);
  res.status(500).json({
    success: false,
    error: lastError?.message || 'Server error'
  });
});

// ============================================================================
// OFFLINE SYNC — Bulk order sync for offline-created orders
// ============================================================================

// @route   POST /api/orders/sync
// @desc    Sync offline-created orders to the server. Handles:
//          - Deduplication via offlineId (same offlineId = same order, won't create duplicates)
//          - Multiple orders in one request (batch processing)
//          - Independent processing (one failure doesn't block others)
//          - Inventory validation at sync time (real-time stock check)
//
//          Flutter Flow:
//          1. User creates order offline → Flutter generates UUID as offlineId
//          2. Order saved in local Hive/SQLite with status "pending_sync"
//          3. When network available → Flutter calls POST /api/orders/sync with all pending orders
//          4. Backend processes each, returns results per order
//          5. Flutter marks successful ones as "synced", retries failed ones later
//
// @access  Private
router.post('/sync', async (req, res) => {
  try {
    const { orders } = req.body;
    
    if (!orders || !Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Request body must contain an "orders" array with at least one order'
      });
    }
    
    // Limit batch size to prevent abuse
    if (orders.length > 50) {
      return res.status(400).json({
        success: false,
        error: 'Maximum 50 orders per sync request'
      });
    }
    
    const io = req.app.get('io');
    const userId = req.user._id;
    const results = [];
    let createdCount = 0;
    let duplicateCount = 0;
    let failedCount = 0;
    
    // Process each order independently
    for (const orderData of orders) {
      const { offlineId } = orderData;
      
      // ── VALIDATE: offlineId is required for sync ──
      if (!offlineId) {
        results.push({
          offlineId: null,
          status: 'failed',
          error: 'offlineId is required for sync. Generate a UUID on the device.'
        });
        failedCount++;
        continue;
      }
      
      // ── VALIDATE: Basic required fields ──
      if (!orderData.partyName || !orderData.mobile || !orderData.items || orderData.items.length === 0) {
        results.push({
          offlineId,
          status: 'failed',
          error: 'Missing required fields: partyName, mobile, and items are required'
        });
        failedCount++;
        continue;
      }
      
      try {
        // ── DEDUPLICATION CHECK ──
        // If an order with this offlineId already exists, return it (idempotent)
        const existingOrder = await Order.findOne({ offlineId })
          .select('_id orderNumber offlineId partyName mobile grandTotal status createdAt')
          .lean();
        
        if (existingOrder) {
          results.push({
            offlineId,
            status: 'duplicate',
            message: 'Order already synced',
            order: existingOrder
          });
          duplicateCount++;
          continue;
        }
        
        // ── CREATE ORDER ──
        // Uses the same createOrder() function as the normal endpoint
        // Inventory validation happens here (atomic, real-time stock check)
        const result = await createOrder(orderData, userId, io);
        
        results.push({
          offlineId,
          status: 'created',
          order: {
            _id: result.order._id,
            orderNumber: result.order.orderNumber,
            offlineId: result.order.offlineId,
            partyName: result.order.partyName,
            mobile: result.order.mobile,
            grandTotal: result.order.grandTotal,
            balanceDue: result.order.balanceDue,
            status: result.order.status,
            paymentStatus: result.order.paymentStatus,
            createdAt: result.order.createdAt
          },
          inventoryAffected: result.affectedProducts?.length || 0
        });
        createdCount++;
        
      } catch (orderError) {
        // ── ORDER FAILED ──
        // Could be: insufficient stock, validation error, duplicate key, etc.
        // This order fails but others continue processing
        
        let errorMessage = orderError.message || 'Failed to create order';
        let errorDetails = null;
        
        // Duplicate key error (order number collision — retry)
        if (orderError.code === 11000) {
          // Check if it's an offlineId duplicate (shouldn't happen, but just in case)
          if (orderError.keyPattern && orderError.keyPattern.offlineId) {
            // Race condition: another sync request just created this order
            const justCreated = await Order.findOne({ offlineId })
              .select('_id orderNumber offlineId partyName mobile grandTotal status')
              .lean();
            
            if (justCreated) {
              results.push({
                offlineId,
                status: 'duplicate',
                message: 'Order synced by concurrent request',
                order: justCreated
              });
              duplicateCount++;
              continue;
            }
          }
          errorMessage = 'Order number collision. Will retry on next sync.';
        }
        
        // Insufficient stock error
        if (orderError.insufficientItem) {
          errorDetails = orderError.insufficientItem;
        }
        
        results.push({
          offlineId,
          status: 'failed',
          error: errorMessage,
          details: errorDetails
        });
        failedCount++;
        
        console.error(`❌ Sync failed for offlineId ${offlineId}:`, errorMessage);
      }
    }
    
    // Invalidate order list cache if any orders were created
    if (createdCount > 0) {
      const deletedCacheKeys = await delByPattern('orders:list:*');
      console.log(`🔄 Sync complete: ${createdCount} created, ${duplicateCount} duplicates, ${failedCount} failed (${deletedCacheKeys} cache keys cleared)`);
    }
    
    res.status(createdCount > 0 ? 201 : 200).json({
      success: true,
      results,
      summary: {
        total: orders.length,
        created: createdCount,
        duplicates: duplicateCount,
        failed: failedCount
      }
    });
  } catch (error) {
    console.error('Sync orders error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Server error during sync'
    });
  }
});

// ============================================================================
// FAST ORDER — POS counter sale (no client, instantly completed)
// ============================================================================

// @route   POST /api/orders/fast
// @desc    Create a fast/counter order. Minimal input, instant completion.
//          - No client record created (partyName defaults to "Fast Order")
//          - Order is instantly marked as delivered + paid
//          - Inventory is reduced immediately
//          - No delivery or payment tracking
//          - Returns still work (inventory restoration only, no refund)
//
//          Request body:
//          {
//            items: [{ productName, product?, price, quantity, narration? }],
//            partyName?: "Walk-in Customer",  // optional, defaults to "Fast Order"
//            discount?: 0,
//            notes?: "Counter sale"
//          }
// @access  Private
router.post('/fast', async (req, res) => {
  try {
    const {
      items,
      partyName = 'Fast Order',
      discount = 0,
      notes
    } = req.body;
    
    // ── VALIDATE ──
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'items array is required' });
    }
    
    // ── FORMAT ITEMS ──
    const formattedItems = [];
    for (const item of items) {
      if (!item.productName && !item.product) {
        return res.status(400).json({ success: false, error: 'Each item needs a productName or product ID' });
      }
      if (!item.quantity || item.quantity <= 0) {
        return res.status(400).json({ success: false, error: `Invalid quantity for "${item.productName || 'Unknown'}"` });
      }
      if (item.price === undefined || item.price < 0) {
        return res.status(400).json({ success: false, error: `Invalid price for "${item.productName || 'Unknown'}"` });
      }
      
      // Resolve product ID
      let productId = item.product || null;
      if (!productId && item.productName) {
        const found = await Product.findOne({
          name: { $regex: `^${item.productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
          isActive: true
        }).select('_id').lean();
        if (found) productId = found._id;
      }
      
      const total = item.price * item.quantity;
      formattedItems.push({
        product: productId,
        productName: item.productName,
        narration: item.narration || '',
        price: item.price,
        quantity: item.quantity,
        deliveredQuantity: item.quantity,   // ← instantly delivered
        remainingQuantity: 0,               // ← nothing remaining
        total
      });
    }
    
    // ── CALCULATE TOTALS ──
    const subtotal = formattedItems.reduce((sum, item) => sum + item.total, 0);
    const grandTotal = subtotal - discount;
    
    // ── REDUCE INVENTORY (atomic) ──
    const io = req.app.get('io');
    const { reduceInventory } = require('../utils/inventoryManager');
    
    const inventoryResult = await reduceInventory(formattedItems, io);
    if (!inventoryResult.success) {
      return res.status(400).json({
        success: false,
        error: inventoryResult.error || 'Inventory validation failed',
        insufficientItem: inventoryResult.insufficientItem || null
      });
    }
    
    // ── CREATE ORDER (already completed) ──
    const order = new Order({
      partyName,
      mobile: '0000000000',  // Placeholder — not tracked for fast orders
      items: formattedItems,
      subtotal,
      grandTotal,
      discount,
      advance: grandTotal,    // Fully paid
      balanceDue: 0,          // Nothing owed
      status: 'completed',
      paymentStatus: 'paid',
      progress: 100,
      isFastOrder: true,
      isLocked: false,        // Keep unlocked so returns work
      createdBy: req.user._id,
      employee: req.user._id,
      employeeName: req.user.name,
      notes: notes || 'Fast Order',
      orderDate: new Date()
      // No client, no expectedDeliveryDate, no localFreight/transportation/gst
    });
    
    try {
      await order.save();
    } catch (saveError) {
      // Rollback inventory if save fails
      const { restoreInventory } = require('../utils/inventoryManager');
      await restoreInventory(formattedItems, io);
      throw saveError;
    }
    
    // ── CACHE + EVENTS ──
    await initializeOrderCache(order.toObject());
    await delByPattern('orders:list:*');
    
    if (io) {
      io.emit('order:created', { order: order.toObject(), isFastOrder: true });
    }
    
    console.log(`⚡ Fast Order ${order.orderNumber}: ${formattedItems.length} items, ₹${grandTotal}`);
    
    res.status(201).json({
      success: true,
      message: `Fast Order ${order.orderNumber} created (₹${grandTotal})`,
      data: order.toObject()
    });
  } catch (error) {
    console.error('Fast order error:', error);
    
    if (error.code === 11000) {
      return res.status(500).json({ success: false, error: 'Order number collision. Please try again.' });
    }
    
    res.status(500).json({
      success: false,
      error: error.message || 'Server error'
    });
  }
});

// @route   PUT /api/orders/:id
// @desc    Update order — supports editing items (add/remove/change products),
//          pricing, metadata, and advance payments.
//          Locked/completed orders cannot be modified.
//          Items with partial deliveries cannot be removed or reduced below delivered qty.
// @access  Private
router.put('/:id', checkOrderLock, async (req, res) => {
  try {
    const { id } = req.params;
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);
    const query = isObjectId ? { _id: id } : { orderNumber: id.toUpperCase() };
    
    const orderDoc = await Order.findOne(query);
    
    if (!orderDoc) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }
    
    const io = req.app.get('io');
    
    // Extract all editable fields from request body
    const {
      items,               // Array of products (full replacement)
      localFreight,        // Pricing fields
      transportation,
      gstPercent,
      discount,
      comment,             // Metadata fields
      employeeName,
      employeeId,
      expectedDeliveryDate,
      notes,
      advance              // Payment
    } = req.body;
    
    let itemsChanged = false;
    let inventoryAffected = [];
    
    // ═══════════════════════════════════════════════════════════════════════
    // STEP 1: Handle items update (add, remove, change products)
    // ═══════════════════════════════════════════════════════════════════════
    if (items !== undefined && Array.isArray(items) && items.length > 0) {
      const oldItems = orderDoc.items;
      
      // Build lookup map for old items (by product ID or product name)
      const oldItemsByKey = new Map();
      oldItems.forEach(item => {
        const key = item.product?.toString() || item.productName?.toLowerCase().trim();
        oldItemsByKey.set(key, item.toObject());
        // Also add by productName for flexible matching
        if (item.productName) {
          oldItemsByKey.set(item.productName.toLowerCase().trim(), item.toObject());
        }
      });
      
      // Process new items
      const newFormattedItems = [];
      const newItemKeys = new Set();
      
      for (const item of items) {
        if (!item.productName && !item.product) {
          return res.status(400).json({
            success: false,
            error: 'Each item must have a productName or product ID'
          });
        }
        
        if (!item.quantity || item.quantity <= 0) {
          return res.status(400).json({
            success: false,
            error: `Invalid quantity for "${item.productName || 'Unknown'}". Must be greater than 0.`
          });
        }
        
        if (item.price === undefined || item.price < 0) {
          return res.status(400).json({
            success: false,
            error: `Invalid price for "${item.productName || 'Unknown'}".`
          });
        }
        
        // Resolve product ID if not provided
        let productId = item.product || null;
        if (!productId && item.productName) {
          const foundProduct = await Product.findOne({
            name: { $regex: `^${item.productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
            isActive: true
          }).select('_id').lean();
          if (foundProduct) productId = foundProduct._id;
        }
        
        // Build matching key
        const itemKey = productId?.toString() || item.productName?.toLowerCase().trim();
        newItemKeys.add(itemKey);
        // Also track by name
        if (item.productName) {
          newItemKeys.add(item.productName.toLowerCase().trim());
        }
        
        // Check if this item existed in the old order
        const oldItem = oldItemsByKey.get(itemKey)
          || (item.productName ? oldItemsByKey.get(item.productName.toLowerCase().trim()) : null);
        
        if (oldItem) {
          // ── EXISTING ITEM: validate delivered quantity constraint ──
          const deliveredQty = oldItem.deliveredQuantity || 0;
          
          if (item.quantity < deliveredQty) {
            return res.status(400).json({
              success: false,
              error: `Cannot reduce "${item.productName}" quantity to ${item.quantity}. Already delivered: ${deliveredQty}. Minimum allowed: ${deliveredQty}.`
            });
          }
          
          newFormattedItems.push({
            product: productId || oldItem.product,
            productName: item.productName || oldItem.productName,
            narration: item.narration !== undefined ? item.narration : (oldItem.narration || ''),
            price: item.price,
            quantity: item.quantity,
            deliveredQuantity: deliveredQty,
            remainingQuantity: item.quantity - deliveredQty,
            total: item.price * item.quantity
          });
        } else {
          // ── NEW ITEM: add with zero delivered ──
          newFormattedItems.push({
            product: productId,
            productName: item.productName,
            narration: item.narration || '',
            price: item.price,
            quantity: item.quantity,
            deliveredQuantity: 0,
            remainingQuantity: item.quantity,
            total: item.price * item.quantity
          });
        }
      }
      
      // ── CHECK: Can't remove items that have partial deliveries ──
      for (const oldItem of oldItems) {
        const oldKey = oldItem.product?.toString() || oldItem.productName?.toLowerCase().trim();
        const oldNameKey = oldItem.productName?.toLowerCase().trim();
        
        const isKept = newItemKeys.has(oldKey) || (oldNameKey && newItemKeys.has(oldNameKey));
        
        if (!isKept && (oldItem.deliveredQuantity || 0) > 0) {
          return res.status(400).json({
            success: false,
            error: `Cannot remove "${oldItem.productName}" from order — ${oldItem.deliveredQuantity} units already delivered. Reduce quantity instead.`
          });
        }
      }
      
      // ── ATOMIC INVENTORY ADJUSTMENT ──
      // Compares old quantities vs new quantities, adjusts inventory with $inc + $gte guard
      const inventoryResult = await adjustInventory(
        oldItems.map(i => ({ product: i.product, quantity: i.quantity })),
        newFormattedItems.map(i => ({ product: i.product, quantity: i.quantity })),
        io
      );
      
      if (!inventoryResult.success) {
        return res.status(400).json({
          success: false,
          error: inventoryResult.error || 'Inventory adjustment failed. Check stock availability.'
        });
      }
      
      inventoryAffected = inventoryResult.affectedProducts || [];
      
      // ── APPLY ITEM CHANGES ──
      orderDoc.items = newFormattedItems;
      itemsChanged = true;
      
      // Recalculate subtotal from new items
      const newSubtotal = newFormattedItems.reduce((sum, item) => sum + item.total, 0);
      orderDoc.subtotal = newSubtotal;
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // STEP 2: Handle pricing field updates
    // ═══════════════════════════════════════════════════════════════════════
    if (localFreight !== undefined) orderDoc.localFreight = localFreight;
    if (transportation !== undefined) orderDoc.transportation = transportation;
    if (gstPercent !== undefined) orderDoc.gstPercent = gstPercent;
    if (discount !== undefined) orderDoc.discount = discount;
    
    // Recalculate totals if items or pricing changed
    if (itemsChanged || localFreight !== undefined || transportation !== undefined || gstPercent !== undefined || discount !== undefined) {
      const gstAmount = (orderDoc.subtotal * orderDoc.gstPercent) / 100;
      orderDoc.gstAmount = gstAmount;
      orderDoc.grandTotal = orderDoc.subtotal + (orderDoc.localFreight || 0) + (orderDoc.transportation || 0) + gstAmount - (orderDoc.discount || 0);
      orderDoc.balanceDue = orderDoc.grandTotal - (orderDoc.advance || 0);
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // STEP 3: Handle metadata field updates
    // ═══════════════════════════════════════════════════════════════════════
    if (comment !== undefined) orderDoc.comment = comment;
    if (employeeName !== undefined) orderDoc.employeeName = employeeName;
    if (employeeId !== undefined) orderDoc.employee = employeeId;
    if (expectedDeliveryDate !== undefined) orderDoc.expectedDeliveryDate = expectedDeliveryDate;
    if (notes !== undefined) orderDoc.notes = notes;
    
    // ═══════════════════════════════════════════════════════════════════════
    // STEP 4: Handle advance payment update (AFTER totals are recalculated)
    // ═══════════════════════════════════════════════════════════════════════
    if (advance !== undefined) {
      if (typeof advance !== 'number' || advance < 0) {
        return res.status(400).json({
          success: false,
          error: 'Advance must be a non-negative number'
        });
      }
      
      if (advance > orderDoc.grandTotal) {
        return res.status(400).json({
          success: false,
          error: `Advance (₹${advance}) cannot exceed grand total (₹${orderDoc.grandTotal})`
        });
      }
      
      orderDoc.advance = advance;
      orderDoc.balanceDue = orderDoc.grandTotal - advance;
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // STEP 5: Status safety checks (auto-calculated by pre-save hook)
    // ═══════════════════════════════════════════════════════════════════════
    if (req.body.status !== undefined) {
      console.log(`⚠️  Status update ignored for order ${id}. Status is auto-calculated.`);
      delete req.body.status;
      if (!orderDoc.status || orderDoc.status === null) {
        orderDoc.status = 'open';
      }
    }
    
    if (!orderDoc.status || orderDoc.status === null) {
      orderDoc.status = 'open';
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // STEP 6: Save (pre-save hook auto-calculates status, progress, paymentStatus)
    // ═══════════════════════════════════════════════════════════════════════
    try {
      await orderDoc.save();
    } catch (saveError) {
      console.error('❌ Order save error:', {
        error: saveError.message,
        orderId: id,
        orderStatus: orderDoc.status,
        errors: saveError.errors
      });
      throw saveError;
    }
    
    const updatedOrder = orderDoc.toObject();
    
    // ═══════════════════════════════════════════════════════════════════════
    // STEP 7: Invalidate cache + emit events
    // ═══════════════════════════════════════════════════════════════════════
    await invalidateOrderCache(isObjectId ? id : updatedOrder._id.toString());
    await initializeOrderCache(updatedOrder);
    
    const deletedCount = await delByPattern('orders:list:*');
    console.log(`🗑️  Orders list caches invalidated after order update (${deletedCount} keys cleared)`);
    
    if (io) {
      io.emit('order:updated', { order: updatedOrder });
      
      if (advance !== undefined) {
        io.emit('order:payment-updated', {
          orderId: updatedOrder._id,
          orderNumber: updatedOrder.orderNumber,
          advance: updatedOrder.advance,
          balanceDue: updatedOrder.balanceDue,
          paymentStatus: updatedOrder.paymentStatus
        });
      }
      
      if (itemsChanged) {
        io.emit('order:items-updated', {
          orderId: updatedOrder._id,
          orderNumber: updatedOrder.orderNumber,
          itemCount: updatedOrder.items.length,
          grandTotal: updatedOrder.grandTotal,
          inventoryAffected: inventoryAffected.length
        });
      }
    }
    
    // Build response message
    let message = 'Order updated successfully';
    if (itemsChanged && advance !== undefined) {
      message = `Items updated (${updatedOrder.items.length} products, ₹${updatedOrder.grandTotal} total). Advance: ₹${advance}. Balance: ₹${updatedOrder.balanceDue}`;
    } else if (itemsChanged) {
      message = `Items updated: ${updatedOrder.items.length} products, subtotal ₹${updatedOrder.subtotal}, grand total ₹${updatedOrder.grandTotal}`;
    } else if (advance !== undefined) {
      message = `Advance updated to ₹${advance}. Balance due: ₹${updatedOrder.balanceDue}. Status: ${updatedOrder.status}`;
    }
    
    res.json({
      success: true,
      data: updatedOrder,
      message,
      inventoryAffected: inventoryAffected.length > 0 ? inventoryAffected : undefined
    });
  } catch (error) {
    console.error('Update order error:', error);
    
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => err.message).join(', ');
      return res.status(400).json({
        success: false,
        error: `Validation error: ${errors}`
      });
    }
    
    res.status(500).json({
      success: false,
      error: error.message || 'Server error'
    });
  }
});

// @route   PATCH /api/orders/:id/payment
// @desc    Record payment for an order (creates payment history entry)
// @access  Private
router.patch('/:id/payment', async (req, res) => {
  try {
    const {
      amount,
      paymentDate,
      paymentMethod = 'cash',
      transactionReference,
      notes
    } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Valid payment amount is required'
      });
    }
    
    const { id } = req.params;
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);
    
    let orderId;
    if (isObjectId) {
      orderId = id;
    } else {
      // Find order by order number
      const order = await Order.findOne({ orderNumber: id.toUpperCase() }).select('_id').lean();
      if (!order) {
        return res.status(404).json({
          success: false,
          error: 'Order not found'
        });
      }
      orderId = order._id;
    }
    
    const io = req.app.get('io');
    
    const result = await recordOrderPayment(
      orderId,
      {
        amount,
        paymentDate,
        paymentMethod,
        transactionReference,
        notes,
        recordedFrom: 'order_page'
      },
      req.user._id,
      io
    );
    
    res.json({
      success: true,
      data: result,
      message: `Payment of ₹${amount} recorded successfully. Balance due: ₹${result.order.balanceDue}`
    });
  } catch (error) {
    console.error('Record payment error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Server error'
    });
  }
});

// @route   GET /api/orders/:id/payments
// @desc    Get all payments for an order
// @access  Private
router.get('/:id/payments', async (req, res) => {
  try {
    const { id } = req.params;
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);
    
    let orderId;
    if (isObjectId) {
      orderId = id;
    } else {
      // Find order by order number
      const order = await Order.findOne({ orderNumber: id.toUpperCase() }).select('_id').lean();
      if (!order) {
        return res.status(404).json({
          success: false,
          error: 'Order not found'
        });
      }
      orderId = order._id;
    }
    
    const Payment = require('../models/Payment');
    const payments = await Payment.find({ order: orderId })
      .select('paymentNumber amount paymentDate paymentMethod paymentType transactionReference notes')
      .sort('-paymentDate')
      .populate('recordedBy', 'name username')
      .lean();
    
    res.json({
      success: true,
      data: payments
    });
  } catch (error) {
    console.error('Get order payments error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   GET /api/orders/:id/deliveries
// @desc    Get all deliveries for an order (optimized with lean())
// @access  Private
router.get('/:id/deliveries', async (req, res) => {
  try {
    const { id } = req.params;
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);
    const query = isObjectId ? { order: id } : { orderNumber: id.toUpperCase() };
    
    const deliveries = await Delivery.find(query)
      .select('deliveryNumber deliveryDate actualDeliveryDate expectedDeliveryDate deliveryPerformance status grandTotal invoiceGenerated items invoice')
      .sort('-deliveryDate')
      .lean();
    
    res.json({
      success: true,
      data: deliveries
    });
  } catch (error) {
    console.error('Get deliveries error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   GET /api/orders/:id/history
// @desc    Get complete order history (deliveries + invoices) - ULTRA OPTIMIZED with aggregation
// @access  Private
router.get('/:id/history', async (req, res) => {
  try {
    const { id } = req.params;
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);
    // Fix: Use new mongoose.Types.ObjectId() or just pass string (Mongoose handles conversion in aggregation)
    const matchCondition = isObjectId ? { _id: new mongoose.Types.ObjectId(id) } : { orderNumber: id.toUpperCase() };
    
    // ULTRA OPTIMIZATION: Single aggregation with $lookup (60% faster than 3 separate queries)
    const result = await Order.aggregate([
      { $match: matchCondition },
      {
        $lookup: {
          from: 'deliveries',
          localField: '_id',
          foreignField: 'order',
          as: 'deliveries',
          pipeline: [
            {
              $lookup: {
                from: 'deliveryinvoices',
                localField: 'invoice',
                foreignField: '_id',
                as: 'invoiceData'
              }
            },
            { $sort: { deliveryDate: 1 } },
            {
              $project: {
                deliveryNumber: 1,
                deliveryDate: 1,
                actualDeliveryDate: 1,
                expectedDeliveryDate: 1,
                deliveryPerformance: 1,
                status: 1,
                grandTotal: 1,
                invoiceGenerated: 1,
                items: 1,
                invoice: { $arrayElemAt: ['$invoiceData', 0] }
              }
            }
          ]
        }
      },
      {
        $project: {
          orderNumber: 1,
          partyName: 1,
          mobile: 1,
          orderDate: 1,
          status: 1,
          progress: 1,
          grandTotal: 1,
          balanceDue: 1,
          items: 1,
          comment: 1,
          employeeName: 1,
          deliveries: 1
        }
      }
    ]);
    
    if (!result || result.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }
    
    const order = result[0];
    
    // Format history
    const history = order.deliveries.map(delivery => ({
      delivery: {
        deliveryNumber: delivery.deliveryNumber,
        deliveryDate: delivery.deliveryDate,
        actualDeliveryDate: delivery.actualDeliveryDate,
        expectedDeliveryDate: delivery.expectedDeliveryDate,
        deliveryPerformance: delivery.deliveryPerformance,
        status: delivery.status,
        grandTotal: delivery.grandTotal,
        items: delivery.items
      },
      invoice: delivery.invoice ? {
        invoiceNumber: delivery.invoice.invoiceNumber,
        invoiceDate: delivery.invoice.invoiceDate,
        grandTotal: delivery.invoice.grandTotal,
        advance: delivery.invoice.advance,
        balanceDue: delivery.invoice.balanceDue,
        paymentStatus: delivery.invoice.paymentStatus,
        items: delivery.invoice.items
      } : null,
      invoiceGenerated: delivery.invoiceGenerated
    }));
    
    res.json({
      success: true,
      data: {
        order: {
          orderNumber: order.orderNumber,
          partyName: order.partyName,
          mobile: order.mobile,
          orderDate: order.orderDate,
          status: order.status,
          progress: order.progress,
          grandTotal: order.grandTotal,
          balanceDue: order.balanceDue,
          items: order.items,
          comment: order.comment, // Customization comments (NOT in invoice)
          employeeName: order.employeeName
        },
        history: history,
        summary: {
          totalDeliveries: order.deliveries.length,
          totalInvoices: order.deliveries.filter(d => d.invoiceGenerated).length,
          totalDelivered: order.items.reduce((sum, item) => sum + (item.deliveredQuantity || 0), 0),
          totalRemaining: order.items.reduce((sum, item) => sum + (item.remainingQuantity || 0), 0)
        }
      }
    });
  } catch (error) {
    console.error('Get order history error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   GET /api/orders/:id/invoices
// @desc    Get all invoices for an order (all delivery invoices)
// @access  Private
router.get('/:id/invoices', async (req, res) => {
  try {
    const { id } = req.params;
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);
    const orderQuery = isObjectId ? { _id: id } : { orderNumber: id.toUpperCase() };
    
    // Get order to find order ID
    const order = await Order.findOne(orderQuery).select('_id orderNumber').lean();
    
    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }
    
    // Get all invoices for this order
    const invoices = await DeliveryInvoice.find({ order: order._id })
      .select('invoiceNumber invoiceDate deliveryDate deliveryNumber grandTotal advance balanceDue paymentStatus items')
      .sort('invoiceDate')
      .lean();
    
    res.json({
      success: true,
      data: {
        orderNumber: order.orderNumber,
        invoices: invoices,
        totalInvoices: invoices.length,
        totalAmount: invoices.reduce((sum, inv) => sum + inv.grandTotal, 0),
        totalPaid: invoices.reduce((sum, inv) => sum + inv.advance, 0),
        totalDue: invoices.reduce((sum, inv) => sum + inv.balanceDue, 0)
      }
    });
  } catch (error) {
    console.error('Get order invoices error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   GET /api/orders/:id/returns
// @desc    Get all returns for a specific order
// @access  Private
router.get('/:id/returns', async (req, res) => {
  try {
    const { id } = req.params;
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);
    const orderQuery = isObjectId ? { _id: id } : { orderNumber: id.toUpperCase() };
    
    const order = await Order.findOne(orderQuery).select('_id orderNumber grandTotal returnedAmount advance balanceDue').lean();
    
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    
    const Return = require('../models/Return');
    const returns = await Return.find({ order: order._id })
      .select('returnNumber returnTotal refundableAmount refundedAmount refundStatus returnDate reason items processedBy')
      .populate('processedBy', 'name username')
      .sort('-returnDate')
      .lean();
    
    const effectiveTotal = order.grandTotal - (order.returnedAmount || 0);
    
    res.json({
      success: true,
      data: {
        orderNumber: order.orderNumber,
        grandTotal: order.grandTotal,
        returnedAmount: order.returnedAmount || 0,
        effectiveTotal,
        advance: order.advance,
        balanceDue: order.balanceDue,
        returns,
        totalReturns: returns.length,
        totalReturnValue: returns.reduce((sum, r) => sum + r.returnTotal, 0),
        totalRefundable: returns.reduce((sum, r) => sum + r.refundableAmount, 0),
        totalRefunded: returns.reduce((sum, r) => sum + r.refundedAmount, 0)
      }
    });
  } catch (error) {
    console.error('Get order returns error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// @route   POST /api/orders/:id/deliveries
// @desc    Create partial delivery for order
// @access  Private
router.post('/:id/deliveries', checkOrderLock, async (req, res) => {
  try {
    const { id } = req.params;
    const io = req.app.get('io');
    
    const result = await createDelivery(req.body, id, req.user._id, io);
    
    // Invalidate ALL orders list cache variations when delivery is created (order status/progress may change)
    const deletedCount = await delByPattern('orders:list:*');
    console.log(`🗑️  Orders list caches invalidated after delivery creation (${deletedCount} cache keys cleared)`);
    
    res.status(201).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Create delivery error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Server error'
    });
  }
});

// @route   PATCH /api/orders/deliveries/:deliveryId/status
// @desc    Update delivery status
// @access  Private
router.patch('/deliveries/:deliveryId/status', async (req, res) => {
  try {
    const { deliveryId } = req.params;
    const { status } = req.body;
    
    if (!status) {
      return res.status(400).json({
        success: false,
        error: 'Status is required'
      });
    }
    
    const io = req.app.get('io');
    const result = await updateDeliveryStatus(deliveryId, status, req.user._id, io);
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Update delivery status error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Server error'
    });
  }
});

// @route   POST /api/orders/deliveries/:deliveryId/invoice
// @desc    Generate invoice for delivery
// @access  Private
router.post('/deliveries/:deliveryId/invoice', async (req, res) => {
  try {
    const { deliveryId } = req.params;
    const io = req.app.get('io');
    
    const result = await generateDeliveryInvoice(deliveryId, req.body, req.user._id, io);
    
    // Log the response for debugging
    console.log('📄 Invoice Generation Response:', {
      success: result.success,
      invoiceId: result.invoice?._id,
      invoiceNumber: result.invoice?.invoiceNumber,
      deliveryId: deliveryId
    });
    
    // Return structured response with clear invoice ID location
    res.status(201).json({
      success: true,
      message: `Invoice ${result.invoice?.invoiceNumber} generated successfully`,
      invoice: {
        _id: result.invoice._id,
        id: result.invoice._id.toString(), // String version for convenience
        invoiceNumber: result.invoice.invoiceNumber,
        grandTotal: result.invoice.grandTotal,
        advance: result.invoice.advance,
        balanceDue: result.invoice.balanceDue,
        paymentStatus: result.invoice.paymentStatus,
        deliveryId: result.invoice.delivery,
        orderId: result.invoice.order,
        orderNumber: result.invoice.orderNumber,
        deliveryNumber: result.invoice.deliveryNumber,
        ...result.invoice
      },
      // Also include at root level for backward compatibility
      invoiceId: result.invoice._id.toString(),
      invoiceNumber: result.invoice.invoiceNumber
    });
  } catch (error) {
    console.error('Generate invoice error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Server error'
    });
  }
});

// @route   PATCH /api/orders/:id/cancel
// @desc    Cancel order — restores ONLY undelivered inventory back to products.
//          Orders with ANY deliveries cannot be cancelled (use refund flow instead).
//          Updates client stats and invalidates all caches.
// @access  Private
router.patch('/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body; // Optional cancellation reason
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);
    const query = isObjectId ? { _id: id } : { orderNumber: id.toUpperCase() };
    
    const order = await Order.findOne(query).lean();
    
    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }
    
    // Already cancelled
    if (order.status === 'cancelled') {
      return res.status(400).json({
        success: false,
        error: 'Order is already cancelled'
      });
    }
    
    // Completed/locked orders cannot be cancelled
    if (order.status === 'completed' || order.isLocked) {
      return res.status(400).json({
        success: false,
        error: 'Completed orders cannot be cancelled'
      });
    }
    
    // Check if any deliveries exist — if items are delivered, can't cancel
    const deliveryCount = await Delivery.countDocuments({ order: order._id });
    if (deliveryCount > 0) {
      return res.status(400).json({
        success: false,
        error: `Cannot cancel — ${deliveryCount} delivery(s) already made for this order. Only undelivered orders can be cancelled.`
      });
    }
    
    const io = req.app.get('io');
    const { restoreInventory } = require('../utils/inventoryManager');
    
    // Restore inventory for ALL items (since nothing was delivered, restore full quantities)
    const inventoryResult = await restoreInventory(order.items, io);
    
    // Update order status to cancelled
    const updatedOrder = await Order.findOneAndUpdate(
      query,
      {
        status: 'cancelled',
        cancelReason: reason || null,
        cancelledAt: new Date()
      },
      { new: true }
    ).lean();
    
    // Update client stats
    if (order.client) {
      try {
        await Client.findByIdAndUpdate(order.client, {
          $inc: {
            totalOrders: -1,
            openOrders: -1,
            totalSpent: -(order.grandTotal || 0),
            totalDue: -(order.balanceDue || 0)
          }
        });
      } catch (clientErr) {
        console.error('⚠️ Error updating client stats on cancel:', clientErr.message);
      }
    }
    
    // Invalidate all caches
    await invalidateOrderCache(order._id.toString());
    const deletedCacheKeys = await delByPattern('orders:list:*');
    console.log(`🗑️ Order ${order.orderNumber} cancelled — ${deletedCacheKeys} cache keys cleared`);
    
    // Emit Socket.IO events
    if (io) {
      io.emit('order:cancelled', {
        orderId: updatedOrder._id,
        orderNumber: updatedOrder.orderNumber,
        reason: reason || null
      });
      
      if (inventoryResult.affectedProducts?.length > 0) {
        io.emit('order:inventory-restored', {
          orderId: updatedOrder._id,
          orderNumber: updatedOrder.orderNumber,
          affectedProducts: inventoryResult.affectedProducts
        });
      }
    }
    
    res.json({
      success: true,
      message: `Order ${updatedOrder.orderNumber} cancelled. Inventory restored for ${inventoryResult.affectedProducts?.length || 0} products.`,
      data: updatedOrder,
      inventoryRestored: inventoryResult.success,
      affectedProducts: inventoryResult.affectedProducts || []
    });
  } catch (error) {
    console.error('Cancel order error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Server error'
    });
  }
});

// @route   DELETE /api/orders/:id
// @desc    Delete order and all related data (deliveries, invoices) - Admin only
// @access  Admin only
router.delete('/:id', adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);
    const query = isObjectId ? { _id: id } : { orderNumber: id.toUpperCase() };
    
    // Get order with all details
    const order = await Order.findOne(query).lean();
    
    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }
    
    // Admin can delete any order (including completed/locked ones)
    // No restrictions - admin has full control
    
    const io = req.app.get('io');
    const { restoreInventory } = require('../utils/inventoryManager');
    const User = require('../models/User');
    const Client = require('../models/Client');
    
    // Step 1: Find all deliveries for this order
    const deliveries = await Delivery.find({ order: order._id }).select('_id invoice deliveryPerformance').lean();
    const deliveryIds = deliveries.map(d => d._id);
    const invoiceIds = deliveries.filter(d => d.invoice).map(d => d.invoice);
    
    // Step 1.5: Get delivery performance stats BEFORE deletion (for employee stats update)
    let deliveryPerformanceStats = {};
    if (deliveryIds.length > 0) {
      const stats = await Delivery.aggregate([
        { $match: { _id: { $in: deliveryIds } } },
        {
          $group: {
            _id: '$deliveryPerformance',
            count: { $sum: 1 }
          }
        }
      ]);
      
      stats.forEach(stat => {
        deliveryPerformanceStats[stat._id] = stat.count || 0;
      });
    }
    
    // Step 2: Delete all delivery invoices
    let deletedInvoicesCount = 0;
    if (invoiceIds.length > 0) {
      const invoiceResult = await DeliveryInvoice.deleteMany({ _id: { $in: invoiceIds } });
      deletedInvoicesCount = invoiceResult.deletedCount;
      console.log(`🗑️  Deleted ${deletedInvoicesCount} delivery invoice(s) for order ${order.orderNumber}`);
    }
    
    // Step 3: Delete all deliveries
    let deletedDeliveriesCount = 0;
    if (deliveryIds.length > 0) {
      const deliveryResult = await Delivery.deleteMany({ _id: { $in: deliveryIds } });
      deletedDeliveriesCount = deliveryResult.deletedCount;
      console.log(`🗑️  Deleted ${deletedDeliveriesCount} delivery(ies) for order ${order.orderNumber}`);
    }
    
    // Step 4: DO NOT restore inventory when deleting order
    // Inventory should remain as-is (products were already delivered/used)
    // Only restore inventory when cancelling orders, not deleting them
    
    // Step 5: Update client stats (decrease totalOrders and totalSpent)
    if (order.client) {
      try {
        await Client.findByIdAndUpdate(order.client, {
          $inc: {
            totalOrders: -1,
            totalSpent: -order.grandTotal
          }
        });
        console.log(`📊 Updated client stats for order ${order.orderNumber}`);
      } catch (clientError) {
        console.error('⚠️  Error updating client stats:', clientError);
      }
    }
    
    // Step 6: Update employee stats (decrease totalOrders and delivery counts)
    if (order.employee) {
      try {
        const updateFields = {
          $inc: {
            'employeeStats.totalOrders': -1,
            'employeeStats.totalDeliveries': -deletedDeliveriesCount
          }
        };
        
        // Subtract delivery performance counts (using stats collected before deletion)
        if (deliveryPerformanceStats.on_time) {
          updateFields.$inc['employeeStats.onTimeDeliveries'] = -deliveryPerformanceStats.on_time;
        }
        if (deliveryPerformanceStats.early) {
          updateFields.$inc['employeeStats.earlyDeliveries'] = -deliveryPerformanceStats.early;
        }
        if (deliveryPerformanceStats.late) {
          updateFields.$inc['employeeStats.lateDeliveries'] = -deliveryPerformanceStats.late;
        }
        
        await User.findByIdAndUpdate(order.employee, updateFields);
        console.log(`👤 Updated employee stats for order ${order.orderNumber}`);
      } catch (employeeError) {
        console.error('⚠️  Error updating employee stats:', employeeError);
      }
    }
    
    // Step 7: Delete the order
    await Order.deleteOne(query);
    console.log(`✅ Deleted order ${order.orderNumber}`);
    
    // Step 8: Invalidate Redis cache
    await invalidateOrderCache(order._id.toString());
    
    // Step 9: Emit Socket.IO events
    if (io) {
      io.emit('order:deleted', {
        orderId: order._id,
        orderNumber: order.orderNumber,
        deletedDeliveries: deletedDeliveriesCount,
        deletedInvoices: deletedInvoicesCount
      });
    }
    
    // Invalidate ALL orders list cache variations when order is deleted
    const deletedCount = await delByPattern('orders:list:*');
    console.log(`🗑️  Orders list caches invalidated after order deletion (${deletedCount} cache keys cleared)`);
    
    res.json({
      success: true,
      message: `Order ${order.orderNumber} and all related data deleted successfully`,
      data: {
        orderNumber: order.orderNumber,
        deletedDeliveries: deletedDeliveriesCount,
        deletedInvoices: deletedInvoicesCount
      }
    });
  } catch (error) {
    console.error('Delete order error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Server error'
    });
  }
});

module.exports = router;

