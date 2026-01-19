const Order = require('../models/Order');
const Delivery = require('../models/Delivery');
const DeliveryInvoice = require('../models/DeliveryInvoice');
const Product = require('../models/Product');
const Client = require('../models/Client');
const User = require('../models/User');
const { reduceInventory, restoreInventory } = require('./inventoryManager');
const {
  initializeOrderCache,
  invalidateOrderCache,
  setOrderStatus,
  setOrderProgress,
  setOrderRemaining,
  decrementItemRemaining,
  acquireOrderLock,
  releaseOrderLock
} = require('./orderCache');

/**
 * Create new order
 */
async function createOrder(orderData, userId, io) {
  try {
    const {
      partyName,
      mobile,
      items,
      localFreight = 0,
      transportation = 0,
      gstPercent = 0,
      discount = 0,
      advance = 0,
      expectedDeliveryDate,
      employeeName,
      employeeId,
      comment, // Customization comments (not in invoice)
      notes
    } = orderData;
    
    // Calculate totals
    const subtotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const gstAmount = (subtotal * gstPercent) / 100;
    const grandTotal = subtotal + localFreight + transportation + gstAmount - discount;
    const balanceDue = grandTotal - advance;
    
    // Format items with product lookup
    const formattedItems = await Promise.all(items.map(async (item) => {
      let productId = item.product || null;
      
      // Find product by name if ID not provided
      if (!productId && item.productName) {
        const foundProduct = await Product.findOne({ 
          name: item.productName,
          isActive: true 
        }).select('_id').lean();
        
        if (foundProduct) {
          productId = foundProduct._id;
        }
      }
      
      return {
        product: productId,
        productName: item.productName,
        narration: item.narration || '', // ← Add narration field
        price: item.price,
        quantity: item.quantity,
        deliveredQuantity: 0,
        remainingQuantity: item.quantity,
        total: item.price * item.quantity
      };
    }));
    
    // Find or create client
    const client = await Client.findOneAndUpdate(
      { partyName, mobile },
      {
        partyName,
        mobile,
        $inc: { totalOrders: 1, totalSpent: grandTotal }
      },
      { upsert: true, new: true, lean: true }
    );
    
    // Create order
    const order = new Order({
      partyName,
      mobile,
      items: formattedItems,
      subtotal,
      localFreight,
      transportation,
      gstPercent,
      gstAmount,
      discount,
      grandTotal,
      advance,
      balanceDue,
      expectedDeliveryDate,
      employeeName: employeeName || null,
      employee: employeeId || userId, // Use provided employee or current user
      comment: comment || null, // Customization comments
      notes,
      client: client._id,
      createdBy: userId,
      status: 'open',
      progress: 0,
      isLocked: false
    });
    
    // Update employee stats (async, non-blocking)
    if (employeeId || userId) {
      const empId = employeeId || userId;
      User.findByIdAndUpdate(empId, {
        $inc: { 'employeeStats.totalOrders': 1 },
        'employeeStats.lastUpdated': new Date()
      }).catch(err => console.error('Error updating employee stats:', err));
    }
    
    await order.save();
    
    // Reduce inventory
    const inventoryResult = await reduceInventory(formattedItems, io);
    
    // Initialize Redis cache
    await initializeOrderCache(order);
    
    // Emit Socket.IO events
    if (io) {
      io.emit('order:created', { order: order.toObject() });
      if (inventoryResult.affectedProducts?.length > 0) {
        io.emit('order:inventory-reduced', {
          orderId: order._id,
          orderNumber: order.orderNumber,
          affectedProducts: inventoryResult.affectedProducts
        });
      }
    }
    
    return {
      success: true,
      order: order.toObject(),
      inventoryUpdated: inventoryResult.success,
      affectedProducts: inventoryResult.affectedProducts || []
    };
  } catch (error) {
    console.error('Create order error:', error);
    throw error;
  }
}

/**
 * Create delivery (supports both full and partial delivery)
 * If items not provided, delivers all remaining items (full delivery)
 */
async function createDelivery(deliveryData, orderId, userId, io) {
  try {
    // Acquire lock to prevent concurrent deliveries
    const lockAcquired = await acquireOrderLock(orderId, 30);
    if (!lockAcquired) {
      throw new Error('Order is currently being processed. Please try again.');
    }
    
    try {
      // Get order
      const order = await Order.findById(orderId).lean();
      if (!order) {
        throw new Error('Order not found');
      }
      
      const {
        items, // If not provided, deliver all remaining items (full delivery)
        deliveryDate,
        actualDeliveryDate, // When actually delivered
        localFreight = 0,
        transportation = 0,
        gstPercent = 0,
        discount = 0,
        notes,
        isFullDelivery = false // Flag to deliver all remaining items
      } = deliveryData;
      
      // Validate delivery quantities
      const deliveryItems = [];
      const orderItemsMap = new Map();
      // Create map with multiple keys for flexible matching
      order.items.forEach(item => {
        const productId = item.product?.toString();
        const productName = item.productName?.toLowerCase().trim();
        
        // Store with multiple keys for flexible lookup
        if (productId) {
          orderItemsMap.set(productId, item);
          orderItemsMap.set(productId.toString(), item);
        }
        if (productName) {
          orderItemsMap.set(productName, item);
        }
        // Also store original productName (case-sensitive) as fallback
        if (item.productName) {
          orderItemsMap.set(item.productName, item);
        }
      });
      
      // If no items provided or isFullDelivery flag, deliver all remaining items
      if (!items || items.length === 0 || isFullDelivery) {
        // Full delivery - deliver all remaining items
        for (const orderItem of order.items) {
          const remaining = orderItem.remainingQuantity || (orderItem.quantity - (orderItem.deliveredQuantity || 0));
          if (remaining > 0) {
            deliveryItems.push({
              product: orderItem.product,
              productName: orderItem.productName,
              narration: orderItem.narration || '', // ← Include narration
              price: orderItem.price,
              quantity: remaining,
              total: orderItem.price * remaining
            });
          }
        }
        
        if (deliveryItems.length === 0) {
          throw new Error('No remaining items to deliver. Order is already complete.');
        }
      } else {
        // Partial delivery - validate provided items with flexible matching
        for (const item of items) {
          // Try multiple matching strategies
          let orderItem = null;
          const productId = item.product?.toString();
          const productName = item.productName?.toLowerCase().trim();
          
          // Debug logging
          console.log('🔍 Matching delivery item:', {
            productId,
            productName: item.productName,
            normalizedName: productName
          });
          console.log('📦 Order items:', order.items.map(oi => ({
            productId: oi.product?.toString(),
            productName: oi.productName,
            normalizedName: oi.productName?.toLowerCase().trim()
          })));
          
          // Try by product ID first
          if (productId) {
            orderItem = orderItemsMap.get(productId) || orderItemsMap.get(productId.toString());
          }
          
          // Try by product name (case-insensitive)
          if (!orderItem && productName) {
            orderItem = orderItemsMap.get(productName);
          }
          
          // Try by original product name (case-sensitive fallback)
          if (!orderItem && item.productName) {
            orderItem = orderItemsMap.get(item.productName);
          }
          
          // If still not found, try exact match in order items
          if (!orderItem) {
            orderItem = order.items.find(oi => 
              (oi.product?.toString() === productId) ||
              (oi.productName?.toLowerCase().trim() === productName) ||
              (oi.productName === item.productName) ||
              (oi.productName?.trim() === item.productName?.trim())
            );
          }
          
          if (!orderItem) {
            const availableProducts = order.items.map(oi => `"${oi.productName}"`).join(', ');
            console.error('❌ Product not found:', {
              requested: item.productName,
              requestedId: productId,
              available: availableProducts
            });
            throw new Error(`Product "${item.productName || 'Unknown'}" not found in order. Available products: ${availableProducts}`);
          }
          
          const remaining = orderItem.remainingQuantity || (orderItem.quantity - (orderItem.deliveredQuantity || 0));
          
          if (item.quantity > remaining) {
            throw new Error(`Cannot deliver ${item.quantity} ${item.productName}. Only ${remaining} remaining.`);
          }
          
          deliveryItems.push({
            product: item.product || orderItem.product,
            productName: item.productName,
            narration: item.narration || orderItem.narration || '', // ← Include narration
            price: item.price || orderItem.price,
            quantity: item.quantity,
            total: (item.price || orderItem.price) * item.quantity
          });
        }
      }
      
      // Calculate delivery totals
      const subtotal = deliveryItems.reduce((sum, item) => sum + item.total, 0);
      const gstAmount = (subtotal * gstPercent) / 100;
      const grandTotal = subtotal + localFreight + transportation + gstAmount - discount;
      
      // Create delivery
      const delivery = new Delivery({
        order: orderId,
        orderNumber: order.orderNumber,
        partyName: order.partyName,
        mobile: order.mobile,
        items: deliveryItems,
        subtotal,
        localFreight,
        transportation,
        gstPercent,
        gstAmount,
        discount,
        grandTotal,
        deliveryDate,
        actualDeliveryDate: actualDeliveryDate || deliveryDate,
        expectedDeliveryDate: order.expectedDeliveryDate,
        status: 'pending',
        deliveredBy: userId,
        notes
      });
      
      await delivery.save();
      
      // Update order with delivered quantities
      const orderUpdate = await Order.findById(orderId);
      orderUpdate.items.forEach(item => {
        const deliveryItem = deliveryItems.find(di => 
          (di.product?.toString() || di.productName) === (item.product?.toString() || item.productName)
        );
        if (deliveryItem) {
          item.deliveredQuantity = (item.deliveredQuantity || 0) + deliveryItem.quantity;
          item.remainingQuantity = item.quantity - item.deliveredQuantity;
        }
      });
      
      orderUpdate.totalDeliveries = (orderUpdate.totalDeliveries || 0) + 1;
      
      // Update actual delivery date if this is the final delivery
      if (orderUpdate.progress === 100 && !orderUpdate.actualDeliveryDate) {
        orderUpdate.actualDeliveryDate = actualDeliveryDate || deliveryDate;
        
        // Calculate delivery performance for order
        if (orderUpdate.expectedDeliveryDate) {
          const diffDays = Math.floor((orderUpdate.actualDeliveryDate - orderUpdate.expectedDeliveryDate) / (1000 * 60 * 60 * 24));
          if (diffDays < 0) {
            orderUpdate.deliveryPerformance = 'early';
          } else if (diffDays === 0) {
            orderUpdate.deliveryPerformance = 'on_time';
          } else {
            orderUpdate.deliveryPerformance = 'late';
          }
        }
      }
      
      await orderUpdate.save();
      
      // Update employee delivery stats (async, non-blocking)
      if (orderUpdate.employee) {
        const deliveryPerf = delivery.deliveryPerformance;
        const updateFields = { 'employeeStats.lastUpdated': new Date() };
        if (deliveryPerf === 'on_time') {
          updateFields.$inc = { 'employeeStats.onTimeDeliveries': 1, 'employeeStats.totalDeliveries': 1 };
        } else if (deliveryPerf === 'early') {
          updateFields.$inc = { 'employeeStats.earlyDeliveries': 1, 'employeeStats.totalDeliveries': 1 };
        } else if (deliveryPerf === 'late') {
          updateFields.$inc = { 'employeeStats.lateDeliveries': 1, 'employeeStats.totalDeliveries': 1 };
        } else {
          updateFields.$inc = { 'employeeStats.totalDeliveries': 1 };
        }
        User.findByIdAndUpdate(orderUpdate.employee, updateFields)
          .catch(err => console.error('Error updating employee delivery stats:', err));
      }
      
      // Update client stats (async, non-blocking)
      if (orderUpdate.client) {
        Client.findByIdAndUpdate(orderUpdate.client, {
          $inc: { 
            completedOrders: orderUpdate.status === 'completed' ? 1 : 0,
            openOrders: orderUpdate.status === 'open' ? 1 : (orderUpdate.status === 'completed' ? -1 : 0)
          }
        }).catch(err => console.error('Error updating client stats:', err));
      }
      
      // Update Redis cache
      await invalidateOrderCache(orderId);
      await initializeOrderCache(orderUpdate);
      
      // Emit Socket.IO events
      if (io) {
        io.emit('delivery:created', { delivery: delivery.toObject(), order: orderUpdate.toObject() });
        io.emit('order:updated', { order: orderUpdate.toObject() });
      }
      
      return {
        success: true,
        delivery: delivery.toObject(),
        order: orderUpdate.toObject()
      };
    } finally {
      // Always release lock
      await releaseOrderLock(orderId);
    }
  } catch (error) {
    console.error('Create delivery error:', error);
    throw error;
  }
}

/**
 * Generate invoice for delivery (auto-generates if not provided)
 * If invoiceData not provided, creates invoice with delivery totals
 */
async function generateDeliveryInvoice(deliveryId, invoiceData, userId, io) {
  try {
    const delivery = await Delivery.findById(deliveryId).lean();
    if (!delivery) {
      throw new Error('Delivery not found');
    }
    
    if (delivery.invoiceGenerated) {
      throw new Error('Invoice already generated for this delivery');
    }
    
    // Auto-generate invoice if invoiceData not provided
    if (!invoiceData) {
      invoiceData = {
        advance: 0,
        notes: `Invoice for delivery ${delivery.deliveryNumber}`
      };
    }
    
    const {
      advance = 0,
      notes
    } = invoiceData || {};
    
    // Get order for client reference
    const order = await Order.findById(delivery.order).lean();
    
    // Create invoice
    const invoice = new DeliveryInvoice({
      delivery: deliveryId,
      deliveryNumber: delivery.deliveryNumber,
      order: delivery.order,
      orderNumber: delivery.orderNumber,
      partyName: delivery.partyName,
      mobile: delivery.mobile,
      client: order?.client,
      items: delivery.items,
      subtotal: delivery.subtotal,
      localFreight: delivery.localFreight,
      transportation: delivery.transportation,
      gstPercent: delivery.gstPercent,
      gstAmount: delivery.gstAmount,
      discount: delivery.discount,
      grandTotal: delivery.grandTotal,
      advance,
      balanceDue: delivery.grandTotal - advance,
      invoiceDate: new Date(),
      deliveryDate: delivery.deliveryDate,
      deliveryStatus: delivery.status || 'pending', // Sync delivery status
      createdBy: userId,
      notes
    });
    
    await invoice.save();
    
    // Update delivery with invoice reference
    await Delivery.findByIdAndUpdate(deliveryId, {
      invoice: invoice._id,
      invoiceGenerated: true
    });
    
    // Update order payment if advance provided
    if (advance > 0 && order) {
      const orderUpdate = await Order.findById(order._id);
      orderUpdate.advance = (orderUpdate.advance || 0) + advance;
      orderUpdate.balanceDue = orderUpdate.grandTotal - orderUpdate.advance;
      await orderUpdate.save();
      
      // Update cache
      await invalidateOrderCache(order._id);
      await initializeOrderCache(orderUpdate);
    }
    
    // Emit Socket.IO events
    if (io) {
      io.emit('invoice:generated', { invoice: invoice.toObject(), delivery: delivery });
      if (advance > 0) {
        io.emit('order:payment-updated', { order: order });
      }
    }
    
    return {
      success: true,
      invoice: invoice.toObject()
    };
  } catch (error) {
    console.error('Generate invoice error:', error);
    throw error;
  }
}

/**
 * Update delivery status
 */
async function updateDeliveryStatus(deliveryId, status, userId, io) {
  try {
    const DeliveryInvoice = require('../models/DeliveryInvoice');
    
    const delivery = await Delivery.findByIdAndUpdate(
      deliveryId,
      { status },
      { new: true }
    ).lean();
    
    if (!delivery) {
      throw new Error('Delivery not found');
    }
    
    // Update invoice delivery status if invoice exists
    if (delivery.invoice) {
      await DeliveryInvoice.findByIdAndUpdate(
        delivery.invoice,
        { deliveryStatus: status },
        { new: true }
      );
      console.log(`📄 Updated invoice ${delivery.invoice} delivery status to ${status}`);
    }
    
    // Emit Socket.IO events
    if (io) {
      io.emit('delivery:status-updated', {
        deliveryId: delivery._id,
        deliveryNumber: delivery.deliveryNumber,
        status: delivery.status
      });
      
      // Also emit invoice update if invoice exists
      if (delivery.invoice) {
        io.emit('invoice:delivery-status-updated', {
          invoiceId: delivery.invoice,
          deliveryId: delivery._id,
          deliveryStatus: status
        });
      }
    }
    
    return {
      success: true,
      delivery
    };
  } catch (error) {
    console.error('Update delivery status error:', error);
    throw error;
  }
}

module.exports = {
  createOrder,
  createDelivery,
  generateDeliveryInvoice,
  updateDeliveryStatus
};

