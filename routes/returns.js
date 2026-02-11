const express = require('express');
const mongoose = require('mongoose');
const Return = require('../models/Return');
const Order = require('../models/Order');
const Delivery = require('../models/Delivery');
const Client = require('../models/Client');
const Payment = require('../models/Payment');
const { protect, adminOnly } = require('../middleware/auth');
const { restoreInventory } = require('../utils/inventoryManager');
const { invalidateOrderCache, initializeOrderCache } = require('../utils/orderCache');
const { del, delByPattern } = require('../config/redis');

const router = express.Router();

// All routes require authentication
router.use(protect);

// ============================================================================
// CREATE RETURN — The core operation
// ============================================================================

// @route   POST /api/returns
// @desc    Create a return for delivered items. This is an atomic operation that:
//          1. Validates returned quantities don't exceed delivered quantities
//          2. Restores inventory for returned products
//          3. Updates the order (reduces deliveredQty, recalculates progress/status)
//          4. Calculates refundable amount if client overpaid
//          5. Updates client financial summary
//
//          The original order's grandTotal stays unchanged (audit trail).
//          Returns are tracked separately.
// @access  Private
router.post('/', async (req, res) => {
  try {
    const {
      orderId,
      items,       // [{ product, productName, quantity, price }]
      reason,
      deliveryId,  // Optional: which delivery items came from
      notes
    } = req.body;
    
    // ── VALIDATE INPUT ──
    if (!orderId) {
      return res.status(400).json({ success: false, error: 'orderId is required' });
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'items array is required with at least one item' });
    }
    
    // ── GET ORDER ──
    const orderDoc = await Order.findById(orderId);
    if (!orderDoc) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    
    // Can't return from cancelled orders
    if (orderDoc.status === 'cancelled') {
      return res.status(400).json({ success: false, error: 'Cannot return items from a cancelled order' });
    }
    
    // Can't return from orders with no deliveries
    if (orderDoc.progress === 0) {
      return res.status(400).json({ success: false, error: 'No items have been delivered. Nothing to return.' });
    }
    
    const io = req.app.get('io');
    
    // ── BUILD RETURN ITEMS + VALIDATE QUANTITIES ──
    const returnItems = [];
    const orderItemsMap = new Map();
    
    // Build lookup map for order items
    orderDoc.items.forEach((item, index) => {
      const key = item.product?.toString() || item.productName?.toLowerCase().trim();
      orderItemsMap.set(key, { item, index });
      if (item.productName) {
        orderItemsMap.set(item.productName.toLowerCase().trim(), { item, index });
      }
    });
    
    for (const returnItem of items) {
      if (!returnItem.quantity || returnItem.quantity <= 0) {
        return res.status(400).json({
          success: false,
          error: `Invalid return quantity for "${returnItem.productName || 'Unknown'}". Must be greater than 0.`
        });
      }
      
      // Find the item in the order
      const itemKey = returnItem.product?.toString() || returnItem.productName?.toLowerCase().trim();
      const match = orderItemsMap.get(itemKey)
        || (returnItem.productName ? orderItemsMap.get(returnItem.productName.toLowerCase().trim()) : null);
      
      if (!match) {
        return res.status(400).json({
          success: false,
          error: `Product "${returnItem.productName || returnItem.product}" not found in order ${orderDoc.orderNumber}`
        });
      }
      
      const orderItem = match.item;
      const delivered = orderItem.deliveredQuantity || 0;
      
      // Can't return more than what was delivered
      if (returnItem.quantity > delivered) {
        return res.status(400).json({
          success: false,
          error: `Cannot return ${returnItem.quantity} of "${orderItem.productName}". Only ${delivered} delivered.`
        });
      }
      
      const price = returnItem.price || orderItem.price;
      
      returnItems.push({
        product: orderItem.product,
        productName: orderItem.productName,
        narration: orderItem.narration || '',
        price: price,
        quantity: returnItem.quantity,
        total: price * returnItem.quantity,
        _orderItemIndex: match.index // internal: for updating order
      });
    }
    
    const returnTotal = returnItems.reduce((sum, item) => sum + item.total, 0);
    
    // ── STEP 1: RESTORE INVENTORY (atomic) ──
    const inventoryResult = await restoreInventory(
      returnItems.map(item => ({
        product: item.product,
        productName: item.productName,
        quantity: item.quantity
      })),
      io
    );
    
    // ── STEP 2: UPDATE ORDER ──
    // Reduce deliveredQuantity for each returned item
    for (const returnItem of returnItems) {
      const orderItem = orderDoc.items[returnItem._orderItemIndex];
      orderItem.deliveredQuantity = Math.max(0, (orderItem.deliveredQuantity || 0) - returnItem.quantity);
      orderItem.remainingQuantity = orderItem.quantity - orderItem.deliveredQuantity;
    }
    
    // Update return tracking on order
    orderDoc.returnedAmount = (orderDoc.returnedAmount || 0) + returnTotal;
    orderDoc.totalReturns = (orderDoc.totalReturns || 0) + 1;
    
    // Unlock order if it was locked (returns reopen it)
    if (orderDoc.isLocked) {
      orderDoc.isLocked = false;
    }
    
    // Save order (pre-save hook recalculates: progress, status, paymentStatus, balanceDue)
    await orderDoc.save();
    
    // ── STEP 3: CALCULATE REFUNDABLE AMOUNT ──
    // Fast orders: NO refund tracking (counter sales, no client to refund)
    // Regular orders: calculate based on how much client overpaid
    const isFastOrder = orderDoc.isFastOrder === true;
    const effectiveTotal = orderDoc.grandTotal - orderDoc.returnedAmount;
    let refundableAmount = 0;
    
    if (!isFastOrder && orderDoc.advance > effectiveTotal) {
      // Regular order: client paid more than what they're keeping → refund due
      refundableAmount = orderDoc.advance - effectiveTotal;
    }
    
    // ── STEP 4: CREATE RETURN DOCUMENT ──
    const cleanItems = returnItems.map(({ _orderItemIndex, ...rest }) => rest);
    
    // Get delivery info if provided
    let deliveryNumber = null;
    if (deliveryId) {
      const delivery = await Delivery.findById(deliveryId).select('deliveryNumber').lean();
      if (delivery) deliveryNumber = delivery.deliveryNumber;
    }
    
    const returnDoc = new Return({
      order: orderDoc._id,
      orderNumber: orderDoc.orderNumber,
      delivery: deliveryId || null,
      deliveryNumber: deliveryNumber,
      client: orderDoc.client || null,
      partyName: orderDoc.partyName,
      mobile: orderDoc.mobile,
      items: cleanItems,
      returnTotal,
      refundableAmount: isFastOrder ? 0 : refundableAmount,
      refundedAmount: 0,
      reason: reason || (isFastOrder ? 'Fast order return' : null),
      processedBy: req.user._id,
      notes: notes || null
    });
    
    await returnDoc.save();
    
    // ═══════════════════════════════════════════════════════════════════════
    // STEP 5: FAST ORDER CLEANUP
    // Fast orders are counter sales — no need to keep returned items around.
    //   • If ALL items returned → delete the entire fast order
    //   • If SOME items returned → remove those items, recalculate totals
    // The Return document (saved above) preserves the audit trail.
    // ═══════════════════════════════════════════════════════════════════════
    let fastOrderDeleted = false;
    let fastOrderItemsRemoved = 0;
    
    if (isFastOrder) {
      // Check if ALL items have been fully returned (deliveredQuantity === 0 for every item)
      const allReturned = orderDoc.items.every(item => (item.deliveredQuantity || 0) === 0);
      
      if (allReturned) {
        // ── ALL ITEMS RETURNED → DELETE the fast order entirely ──
        await Order.findByIdAndDelete(orderDoc._id);
        fastOrderDeleted = true;
        
        // Clean up cache
        await invalidateOrderCache(orderDoc._id.toString());
        await delByPattern('orders:list:*');
        
        if (io) {
          io.emit('return:created', { returnDoc: returnDoc.toObject(), order: null });
          io.emit('order:deleted', {
            orderId: orderDoc._id,
            orderNumber: orderDoc.orderNumber,
            reason: 'All items returned (fast order)'
          });
          
          if (inventoryResult.affectedProducts?.length > 0) {
            io.emit('order:inventory-restored', {
              orderId: orderDoc._id,
              orderNumber: orderDoc.orderNumber,
              affectedProducts: inventoryResult.affectedProducts,
              reason: 'return'
            });
          }
        }
        
        console.log(`🗑️  Fast order ${orderDoc.orderNumber} deleted — all items returned via ${returnDoc.returnNumber}`);
        
        return res.status(201).json({
          success: true,
          message: `Return ${returnDoc.returnNumber} processed. All items returned — fast order ${orderDoc.orderNumber} deleted.`,
          data: {
            return: returnDoc.toObject(),
            order: null,
            fastOrderDeleted: true,
            fastOrderItemsRemoved: orderDoc.items.length,
            inventoryRestored: inventoryResult.affectedProducts || [],
            refundableAmount: 0
          }
        });
      } else {
        // ── PARTIAL RETURN → Remove fully returned items, adjust the rest ──
        const keptItems = [];
        let removedCount = 0;
        
        for (const item of orderDoc.items) {
          if ((item.deliveredQuantity || 0) > 0) {
            // Item still has delivered quantity — keep it
            // Sync quantity to match what's still delivered (fast order = no pending delivery)
            item.quantity = item.deliveredQuantity;
            item.remainingQuantity = 0;
            item.total = item.price * item.quantity;
            keptItems.push(item);
          } else {
            // Fully returned → remove from order
            removedCount++;
          }
        }
        
        fastOrderItemsRemoved = removedCount;
        
        // Update order with only kept items
        orderDoc.items = keptItems;
        
        // Recalculate all totals from scratch (clean slate for kept items)
        const newSubtotal = keptItems.reduce((sum, item) => sum + item.total, 0);
        orderDoc.subtotal = newSubtotal;
        const gstAmount = (newSubtotal * (orderDoc.gstPercent || 0)) / 100;
        orderDoc.gstAmount = gstAmount;
        orderDoc.grandTotal = newSubtotal + (orderDoc.localFreight || 0) + (orderDoc.transportation || 0) + gstAmount - (orderDoc.discount || 0);
        
        // Reset return tracking — order now reflects only what's kept
        // The Return document preserves the full audit trail
        orderDoc.returnedAmount = 0;
        orderDoc.advance = orderDoc.grandTotal; // Fast order = fully paid for what's kept
        orderDoc.balanceDue = 0;
        
        // Save (pre-save hook recalculates progress, status, paymentStatus)
        await orderDoc.save();
        
        if (removedCount > 0) {
          console.log(`✂️  Fast order ${orderDoc.orderNumber}: ${removedCount} items removed, ${keptItems.length} items remaining (₹${orderDoc.grandTotal})`);
        }
      }
    }
    
    // ── STEP 6: UPDATE CLIENT (skip for fast orders — no client exists) ──
    if (!isFastOrder && orderDoc.client) {
      try {
        const clientUpdate = {
          $inc: {
            totalReturns: 1,
            totalReturnValue: returnTotal
          }
        };
        
        if (refundableAmount > 0) {
          clientUpdate.$inc.refundableBalance = refundableAmount;
        }
        
        await Client.findByIdAndUpdate(orderDoc.client, clientUpdate);
      } catch (clientErr) {
        console.error('⚠️ Error updating client on return:', clientErr.message);
      }
    }
    
    // ── STEP 7: INVALIDATE CACHES ──
    if (!fastOrderDeleted) {
      // Only if order wasn't already deleted in step 5
      await invalidateOrderCache(orderDoc._id.toString());
      await initializeOrderCache(orderDoc.toObject());
    }
    await delByPattern('orders:list:*');
    
    // ── STEP 8: EMIT SOCKET.IO EVENTS ──
    if (io && !fastOrderDeleted) {
      // Fast order delete events were already emitted in step 5
      io.emit('return:created', {
        returnDoc: returnDoc.toObject(),
        order: orderDoc.toObject()
      });
      
      io.emit('order:updated', { order: orderDoc.toObject() });
      
      if (inventoryResult.affectedProducts?.length > 0) {
        io.emit('order:inventory-restored', {
          orderId: orderDoc._id,
          orderNumber: orderDoc.orderNumber,
          affectedProducts: inventoryResult.affectedProducts,
          reason: 'return'
        });
      }
      
      if (refundableAmount > 0) {
        io.emit('client:refund-due', {
          clientId: orderDoc.client,
          partyName: orderDoc.partyName,
          refundableAmount,
          returnNumber: returnDoc.returnNumber
        });
      }
    }
    
    console.log(`✅ Return ${returnDoc.returnNumber} processed: ${cleanItems.length} items, ₹${returnTotal} value${isFastOrder ? ` (fast order: ${fastOrderItemsRemoved} items removed)` : `, ₹${refundableAmount} refundable`}`);
    
    res.status(201).json({
      success: true,
      message: isFastOrder
        ? `Return ${returnDoc.returnNumber} processed. ${cleanItems.length} items returned (₹${returnTotal}).${fastOrderItemsRemoved > 0 ? ` ${fastOrderItemsRemoved} items removed from fast order.` : ''}`
        : `Return ${returnDoc.returnNumber} processed. ${cleanItems.length} items returned (₹${returnTotal}).${refundableAmount > 0 ? ` Client is owed ₹${refundableAmount} refund.` : ''}`,
      data: {
        return: returnDoc.toObject(),
        order: fastOrderDeleted ? null : {
          _id: orderDoc._id,
          orderNumber: orderDoc.orderNumber,
          grandTotal: orderDoc.grandTotal,
          returnedAmount: orderDoc.returnedAmount,
          effectiveTotal: isFastOrder ? orderDoc.grandTotal : effectiveTotal,
          advance: orderDoc.advance,
          balanceDue: orderDoc.balanceDue,
          status: orderDoc.status,
          paymentStatus: orderDoc.paymentStatus,
          progress: orderDoc.progress,
          itemCount: orderDoc.items?.length || 0
        },
        fastOrderDeleted,
        fastOrderItemsRemoved: isFastOrder ? fastOrderItemsRemoved : 0,
        inventoryRestored: inventoryResult.affectedProducts || [],
        refundableAmount: isFastOrder ? 0 : refundableAmount
      }
    });
  } catch (error) {
    console.error('Create return error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Server error'
    });
  }
});

// ============================================================================
// LIST RETURNS
// ============================================================================

// @route   GET /api/returns
// @desc    Get all returns with pagination, search, filtering
// @access  Private
router.get('/', async (req, res) => {
  try {
    const {
      search,
      refundStatus,
      startDate,
      endDate,
      page = 1,
      limit = 50,
      sort = '-returnDate'
    } = req.query;
    
    const query = {};
    
    if (search) {
      const searchRegex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [
        { partyName: searchRegex },
        { mobile: searchRegex },
        { returnNumber: searchRegex },
        { orderNumber: searchRegex }
      ];
    }
    
    if (refundStatus) {
      query.refundStatus = refundStatus;
    }
    
    if (startDate || endDate) {
      query.returnDate = {};
      if (startDate) query.returnDate.$gte = new Date(startDate);
      if (endDate) query.returnDate.$lte = new Date(endDate);
    }
    
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;
    
    const [returns, total] = await Promise.all([
      Return.find(query)
        .select('returnNumber orderNumber partyName mobile returnTotal refundableAmount refundedAmount refundStatus returnDate reason items processedBy')
        .populate('processedBy', 'name username')
        .sort(sort)
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Return.countDocuments(query)
    ]);
    
    res.json({
      success: true,
      data: returns,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    console.error('Get returns error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// @route   GET /api/returns/:id
// @desc    Get single return with full details
// @access  Private
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);
    const query = isObjectId ? { _id: id } : { returnNumber: id.toUpperCase() };
    
    const returnDoc = await Return.findOne(query)
      .populate('processedBy', 'name username')
      .populate('order', 'orderNumber grandTotal returnedAmount advance balanceDue status paymentStatus')
      .populate('client', 'partyName mobile refundableBalance')
      .lean();
    
    if (!returnDoc) {
      return res.status(404).json({ success: false, error: 'Return not found' });
    }
    
    // Get refund payments for this return
    const refundPayments = await Payment.find({ returnRef: returnDoc._id })
      .select('paymentNumber amount paymentDate paymentMethod notes')
      .sort('-paymentDate')
      .lean();
    
    res.json({
      success: true,
      data: {
        ...returnDoc,
        refundPayments
      }
    });
  } catch (error) {
    console.error('Get return error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ============================================================================
// RECORD REFUND — When admin actually gives money back to client
// ============================================================================

// @route   PATCH /api/returns/:id/refund
// @desc    Record a refund payment for a return. Creates a Payment record
//          and updates the return's refunded amount and client's balances.
//          Can be called multiple times for partial refunds.
// @access  Private
router.patch('/:id/refund', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      amount,
      paymentMethod = 'cash',
      paymentDate,
      transactionReference,
      notes
    } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, error: 'Refund amount must be greater than 0' });
    }
    
    // Find the return
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);
    const query = isObjectId ? { _id: id } : { returnNumber: id.toUpperCase() };
    const returnDoc = await Return.findOne(query);
    
    if (!returnDoc) {
      return res.status(404).json({ success: false, error: 'Return not found' });
    }
    
    // Validate refund amount
    const remainingRefundable = returnDoc.refundableAmount - returnDoc.refundedAmount;
    
    if (remainingRefundable <= 0) {
      return res.status(400).json({
        success: false,
        error: 'No refund is pending for this return. Already fully refunded or no refund was due.'
      });
    }
    
    if (amount > remainingRefundable) {
      return res.status(400).json({
        success: false,
        error: `Refund amount (₹${amount}) exceeds remaining refundable amount (₹${remainingRefundable})`
      });
    }
    
    // ── CREATE REFUND PAYMENT RECORD ──
    const payment = new Payment({
      amount,
      paymentDate: paymentDate || new Date(),
      paymentMethod,
      transactionReference,
      client: returnDoc.client,
      partyName: returnDoc.partyName,
      mobile: returnDoc.mobile,
      order: returnDoc.order,
      orderNumber: returnDoc.orderNumber,
      returnRef: returnDoc._id,
      returnNumber: returnDoc.returnNumber,
      paymentType: 'return_refund',
      isAllocated: true,
      allocatedAmount: amount,
      remainingAmount: 0,
      recordedBy: req.user._id,
      notes: notes || `Refund for return ${returnDoc.returnNumber}`,
      recordedFrom: 'system'
    });
    
    await payment.save();
    
    // ── UPDATE RETURN ──
    returnDoc.refundedAmount = (returnDoc.refundedAmount || 0) + amount;
    await returnDoc.save(); // pre-save hook updates refundStatus
    
    // ── UPDATE CLIENT ──
    if (returnDoc.client) {
      try {
        await Client.findByIdAndUpdate(returnDoc.client, {
          $inc: {
            refundableBalance: -amount, // Reduce what we owe them
            totalPaid: -amount           // Reduce total paid (money went back)
          }
        });
      } catch (clientErr) {
        console.error('⚠️ Error updating client on refund:', clientErr.message);
      }
    }
    
    // ── EMIT EVENTS ──
    const io = req.app.get('io');
    if (io) {
      io.emit('return:refunded', {
        returnId: returnDoc._id,
        returnNumber: returnDoc.returnNumber,
        amount,
        refundStatus: returnDoc.refundStatus,
        paymentNumber: payment.paymentNumber
      });
      
      io.emit('payment:recorded', {
        payment: payment.toObject(),
        type: 'return_refund'
      });
    }
    
    res.json({
      success: true,
      message: `Refund of ₹${amount} recorded for ${returnDoc.returnNumber}. ${returnDoc.refundStatus === 'refunded' ? 'Fully refunded.' : `Remaining: ₹${returnDoc.refundableAmount - returnDoc.refundedAmount}`}`,
      data: {
        return: returnDoc.toObject(),
        payment: payment.toObject()
      }
    });
  } catch (error) {
    console.error('Record refund error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Server error'
    });
  }
});

module.exports = router;
