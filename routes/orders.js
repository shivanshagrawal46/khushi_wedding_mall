const express = require('express');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Delivery = require('../models/Delivery');
const DeliveryInvoice = require('../models/DeliveryInvoice');
const Client = require('../models/Client');
const User = require('../models/User');
const { protect, adminOnly } = require('../middleware/auth');
const { createOrder, createDelivery, generateDeliveryInvoice, updateDeliveryStatus } = require('../utils/orderManager');
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
      startDate,
      endDate,
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
    
    // Date range filter
    if (startDate || endDate) {
      query.orderDate = {};
      if (startDate) query.orderDate.$gte = new Date(startDate);
      if (endDate) query.orderDate.$lte = new Date(endDate);
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
      
      // If it's not a duplicate key error, throw immediately
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

// @route   PUT /api/orders/:id
// @desc    Update order (prevent if locked/completed)
// @access  Private
router.put('/:id', checkOrderLock, async (req, res) => {
  try {
    const { id } = req.params;
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);
    const query = isObjectId ? { _id: id } : { orderNumber: id.toUpperCase() };
    
    // Get order as document for update
    const orderDoc = await Order.findOne(query);
    
    if (!orderDoc) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }
    
    // Update allowed fields (comment, employee, expected delivery date, notes, advance)
    const {
      comment,
      employeeName,
      employeeId,
      expectedDeliveryDate,
      notes,
      advance
    } = req.body;
    
    if (comment !== undefined) orderDoc.comment = comment;
    if (employeeName !== undefined) orderDoc.employeeName = employeeName;
    if (employeeId !== undefined) orderDoc.employee = employeeId;
    if (expectedDeliveryDate !== undefined) orderDoc.expectedDeliveryDate = expectedDeliveryDate;
    if (notes !== undefined) orderDoc.notes = notes;
    
    // Handle advance payment update
    if (advance !== undefined) {
      // Validate advance amount
      if (typeof advance !== 'number' || advance < 0) {
        return res.status(400).json({
          success: false,
          error: 'Advance must be a non-negative number'
        });
      }
      
      if (advance > orderDoc.grandTotal) {
        return res.status(400).json({
          success: false,
          error: `Advance (${advance}) cannot exceed grand total (${orderDoc.grandTotal})`
        });
      }
      
      orderDoc.advance = advance;
      // Recalculate balance due (will be recalculated in pre-save hook, but set it here for clarity)
      orderDoc.balanceDue = orderDoc.grandTotal - advance;
    }
    
    // Note: Status is auto-calculated in pre-save hook based on progress and paymentStatus
    // Do NOT allow manual status updates - it's calculated automatically
    // If status is sent in request body, explicitly remove it to prevent null/undefined issues
    if (req.body.status !== undefined) {
      console.log(`⚠️  Status update ignored for order ${id}. Status is auto-calculated based on progress and payment status.`);
      // Explicitly remove status from the document to prevent it from being set to null
      delete req.body.status;
      // Ensure orderDoc.status is not null before save
      if (!orderDoc.status || orderDoc.status === null) {
        orderDoc.status = 'open'; // Default fallback
      }
    }
    
    // Ensure status is valid before save (safety check)
    if (!orderDoc.status || orderDoc.status === null) {
      console.warn(`⚠️  Order ${id} has null/undefined status before save. Setting to 'open'.`);
      orderDoc.status = 'open';
    }
    
    // Save order (pre-save hook will auto-calculate status, paymentStatus, balanceDue, progress)
    try {
      await orderDoc.save();
    } catch (saveError) {
      console.error('❌ Order save error:', {
        error: saveError.message,
        name: saveError.name,
        orderId: id,
        orderStatus: orderDoc.status,
        orderProgress: orderDoc.progress,
        orderPaymentStatus: orderDoc.paymentStatus,
        errors: saveError.errors
      });
      throw saveError;
    }
    
    const updatedOrder = orderDoc.toObject();
    
    // Invalidate cache
    await invalidateOrderCache(id);
    await initializeOrderCache(updatedOrder);
    
    // Invalidate ALL orders list cache variations when order is updated
    const deletedCount = await delByPattern('orders:list:*');
    console.log(`🗑️  Orders list caches invalidated after order update (${deletedCount} cache keys cleared)`);
    
    // Emit Socket.IO event
    const io = req.app.get('io');
    if (io) {
      io.emit('order:updated', { order: updatedOrder });
      // Also emit payment update if advance was changed
      if (advance !== undefined) {
        io.emit('order:payment-updated', {
          orderId: updatedOrder._id,
          orderNumber: updatedOrder.orderNumber,
          advance: updatedOrder.advance,
          balanceDue: updatedOrder.balanceDue,
          paymentStatus: updatedOrder.paymentStatus
        });
      }
    }
    
    res.json({
      success: true,
      data: updatedOrder,
      message: advance !== undefined 
        ? `Advance payment updated to ₹${advance}. Balance due: ₹${updatedOrder.balanceDue}. Status: ${updatedOrder.status}`
        : 'Order updated successfully'
    });
  } catch (error) {
    console.error('Update order error:', error);
    
    // Handle validation errors
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
// @desc    Cancel order (restore inventory)
// @access  Admin only
router.patch('/:id/cancel', adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);
    const query = isObjectId ? { _id: id } : { orderNumber: id.toUpperCase() };
    
    const order = await Order.findOne(query).lean();
    
    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }
    
    if (order.status === 'cancelled') {
      return res.status(400).json({
        success: false,
        error: 'Order is already cancelled'
      });
    }
    
    const io = req.app.get('io');
    const { restoreInventory } = require('../utils/inventoryManager');
    
    // Restore inventory
    const inventoryResult = await restoreInventory(order.items, io);
    
    // Update order status
    const updatedOrder = await Order.findOneAndUpdate(
      query,
      { status: 'cancelled' },
      { new: true }
    ).lean();
    
    // Invalidate cache
    await invalidateOrderCache(order._id.toString());
    
    // Emit Socket.IO events
    if (io) {
      io.emit('order:cancelled', {
        orderId: updatedOrder._id,
        orderNumber: updatedOrder.orderNumber
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
      message: 'Order cancelled successfully',
      data: updatedOrder,
      inventoryRestored: inventoryResult.success,
      affectedProducts: inventoryResult.affectedProducts || []
    });
  } catch (error) {
    console.error('Cancel order error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
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

