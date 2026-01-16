const Payment = require('../models/Payment');
const Order = require('../models/Order');
const Invoice = require('../models/Invoice');
const Client = require('../models/Client');

/**
 * Record a payment for a specific order
 * Creates a payment record and updates order advance
 */
async function recordOrderPayment(orderId, paymentData, userId, io) {
  try {
    const { amount, paymentDate, paymentMethod, transactionReference, notes, recordedFrom = 'order_page' } = paymentData;
    
    // Validate amount
    if (!amount || amount <= 0) {
      throw new Error('Payment amount must be positive');
    }
    
    // Get order
    const order = await Order.findById(orderId);
    if (!order) {
      throw new Error('Order not found');
    }
    
    // Check if payment exceeds balance due
    if (amount > order.balanceDue) {
      throw new Error(`Payment amount (${amount}) exceeds balance due (${order.balanceDue})`);
    }
    
    // Get client
    const client = await Client.findById(order.client);
    if (!client) {
      throw new Error('Client not found for this order');
    }
    
    // Create payment record
    const payment = new Payment({
      amount,
      paymentDate: paymentDate || new Date(),
      paymentMethod: paymentMethod || 'cash',
      transactionReference,
      client: client._id,
      partyName: order.partyName,
      mobile: order.mobile,
      order: order._id,
      orderNumber: order.orderNumber,
      paymentType: 'order_payment',
      isAllocated: true,
      allocatedAmount: amount,
      remainingAmount: 0,
      allocations: [{
        order: order._id,
        orderNumber: order.orderNumber,
        amount,
        allocatedAt: new Date()
      }],
      recordedBy: userId,
      notes,
      recordedFrom
    });
    
    await payment.save();
    
    // Update order advance
    order.advance = (order.advance || 0) + amount;
    order.balanceDue = order.grandTotal - order.advance;
    await order.save();
    
    // Update client stats
    client.totalPaid = (client.totalPaid || 0) + amount;
    client.totalDue = (client.totalDue || 0) - amount;
    client.lastPaymentAmount = amount;
    client.lastPaymentDate = payment.paymentDate;
    client.lastPaymentMethod = paymentMethod;
    await client.save();
    
    // Emit real-time events
    if (io) {
      io.emit('payment:recorded', {
        payment: payment.toObject(),
        order: order.toObject(),
        client: client.toObject()
      });
      
      io.emit('order:payment-updated', {
        orderId: order._id,
        orderNumber: order.orderNumber,
        advance: order.advance,
        balanceDue: order.balanceDue,
        paymentStatus: order.paymentStatus
      });
    }
    
    return {
      success: true,
      payment: payment.toObject(),
      order: order.toObject()
    };
  } catch (error) {
    console.error('Record order payment error:', error);
    throw error;
  }
}

/**
 * Record an advance payment (not linked to any specific order)
 * This can be used later to pay for future orders
 */
async function recordAdvancePayment(clientId, paymentData, userId, io) {
  try {
    const { amount, paymentDate, paymentMethod, transactionReference, notes } = paymentData;
    
    // Validate amount
    if (!amount || amount <= 0) {
      throw new Error('Payment amount must be positive');
    }
    
    // Get client
    const client = await Client.findById(clientId);
    if (!client) {
      throw new Error('Client not found');
    }
    
    // Create payment record
    const payment = new Payment({
      amount,
      paymentDate: paymentDate || new Date(),
      paymentMethod: paymentMethod || 'cash',
      transactionReference,
      client: client._id,
      partyName: client.partyName,
      mobile: client.mobile,
      paymentType: 'advance_payment',
      isAllocated: false,
      allocatedAmount: 0,
      remainingAmount: amount,
      allocations: [],
      recordedBy: userId,
      notes,
      recordedFrom: 'client_page'
    });
    
    await payment.save();
    
    // Update client advance balance
    client.advanceBalance = (client.advanceBalance || 0) + amount;
    client.totalPaid = (client.totalPaid || 0) + amount;
    client.lastPaymentAmount = amount;
    client.lastPaymentDate = payment.paymentDate;
    client.lastPaymentMethod = paymentMethod;
    await client.save();
    
    // Emit real-time events
    if (io) {
      io.emit('payment:recorded', {
        payment: payment.toObject(),
        client: client.toObject()
      });
      
      io.emit('client:advance-updated', {
        clientId: client._id,
        advanceBalance: client.advanceBalance
      });
    }
    
    return {
      success: true,
      payment: payment.toObject(),
      client: client.toObject()
    };
  } catch (error) {
    console.error('Record advance payment error:', error);
    throw error;
  }
}

/**
 * Record payment from client page - allocates payment across multiple orders
 * Supports both payment against specific orders and general payment that gets auto-allocated
 */
async function recordClientPayment(clientId, paymentData, userId, io) {
  try {
    const {
      amount,
      paymentDate,
      paymentMethod,
      transactionReference,
      notes,
      orderAllocations, // Optional: array of { orderId, amount } for specific allocation
      autoAllocate = true // If true, auto-allocate to orders with balance due
    } = paymentData;
    
    // Validate amount
    if (!amount || amount <= 0) {
      throw new Error('Payment amount must be positive');
    }
    
    // Get client
    const client = await Client.findById(clientId);
    if (!client) {
      throw new Error('Client not found');
    }
    
    let remainingPayment = amount;
    const allocations = [];
    const updatedOrders = [];
    
    // If specific order allocations provided, use them
    if (orderAllocations && orderAllocations.length > 0) {
      // Validate total allocation doesn't exceed payment amount
      const totalAllocated = orderAllocations.reduce((sum, alloc) => sum + alloc.amount, 0);
      if (totalAllocated > amount) {
        throw new Error('Total allocation exceeds payment amount');
      }
      
      // Process each allocation
      for (const alloc of orderAllocations) {
        const order = await Order.findById(alloc.orderId);
        if (!order) {
          throw new Error(`Order ${alloc.orderId} not found`);
        }
        
        if (alloc.amount > order.balanceDue) {
          throw new Error(`Allocation for order ${order.orderNumber} (${alloc.amount}) exceeds balance due (${order.balanceDue})`);
        }
        
        // Update order
        order.advance = (order.advance || 0) + alloc.amount;
        order.balanceDue = order.grandTotal - order.advance;
        await order.save();
        
        allocations.push({
          order: order._id,
          orderNumber: order.orderNumber,
          amount: alloc.amount,
          allocatedAt: new Date()
        });
        
        updatedOrders.push(order);
        remainingPayment -= alloc.amount;
      }
    } else if (autoAllocate) {
      // Auto-allocate to orders with balance due (oldest first)
      const ordersWithDue = await Order.find({
        client: clientId,
        balanceDue: { $gt: 0 },
        status: { $ne: 'cancelled' }
      }).sort('orderDate'); // Pay oldest orders first
      
      for (const order of ordersWithDue) {
        if (remainingPayment <= 0) break;
        
        const paymentAmount = Math.min(remainingPayment, order.balanceDue);
        
        // Update order
        order.advance = (order.advance || 0) + paymentAmount;
        order.balanceDue = order.grandTotal - order.advance;
        await order.save();
        
        allocations.push({
          order: order._id,
          orderNumber: order.orderNumber,
          amount: paymentAmount,
          allocatedAt: new Date()
        });
        
        updatedOrders.push(order);
        remainingPayment -= paymentAmount;
      }
    }
    
    // Determine payment type
    let paymentType;
    if (allocations.length === 0) {
      paymentType = 'advance_payment'; // No orders to allocate, treat as advance
    } else if (remainingPayment > 0) {
      paymentType = 'order_payment'; // Partially allocated, rest is advance
    } else {
      paymentType = 'order_payment'; // Fully allocated to orders
    }
    
    // Create payment record
    const payment = new Payment({
      amount,
      paymentDate: paymentDate || new Date(),
      paymentMethod: paymentMethod || 'cash',
      transactionReference,
      client: client._id,
      partyName: client.partyName,
      mobile: client.mobile,
      paymentType,
      isAllocated: allocations.length > 0,
      allocatedAmount: amount - remainingPayment,
      remainingAmount: remainingPayment,
      allocations,
      recordedBy: userId,
      notes,
      recordedFrom: 'client_page'
    });
    
    await payment.save();
    
    // Update client stats
    client.totalPaid = (client.totalPaid || 0) + amount;
    client.totalDue = (client.totalDue || 0) - (amount - remainingPayment); // Reduce by allocated amount
    client.advanceBalance = (client.advanceBalance || 0) + remainingPayment; // Add unallocated as advance
    client.lastPaymentAmount = amount;
    client.lastPaymentDate = payment.paymentDate;
    client.lastPaymentMethod = paymentMethod;
    await client.save();
    
    // Emit real-time events
    if (io) {
      io.emit('payment:recorded', {
        payment: payment.toObject(),
        client: client.toObject(),
        updatedOrders: updatedOrders.map(o => o.toObject())
      });
      
      // Emit event for each updated order
      for (const order of updatedOrders) {
        io.emit('order:payment-updated', {
          orderId: order._id,
          orderNumber: order.orderNumber,
          advance: order.advance,
          balanceDue: order.balanceDue,
          paymentStatus: order.paymentStatus
        });
      }
      
      if (remainingPayment > 0) {
        io.emit('client:advance-updated', {
          clientId: client._id,
          advanceBalance: client.advanceBalance
        });
      }
    }
    
    return {
      success: true,
      payment: payment.toObject(),
      client: client.toObject(),
      updatedOrders: updatedOrders.map(o => o.toObject()),
      allocated: amount - remainingPayment,
      remainingAsAdvance: remainingPayment
    };
  } catch (error) {
    console.error('Record client payment error:', error);
    throw error;
  }
}

/**
 * Use advance balance to pay for an order
 */
async function useAdvanceForOrder(orderId, amount, userId, io) {
  try {
    // Get order
    const order = await Order.findById(orderId);
    if (!order) {
      throw new Error('Order not found');
    }
    
    // Get client
    const client = await Client.findById(order.client);
    if (!client) {
      throw new Error('Client not found');
    }
    
    // Check if client has enough advance balance
    if (amount > client.advanceBalance) {
      throw new Error(`Insufficient advance balance. Available: ${client.advanceBalance}, Requested: ${amount}`);
    }
    
    // Check if amount exceeds order balance due
    if (amount > order.balanceDue) {
      throw new Error(`Amount (${amount}) exceeds order balance due (${order.balanceDue})`);
    }
    
    // Update order
    order.advance = (order.advance || 0) + amount;
    order.balanceDue = order.grandTotal - order.advance;
    await order.save();
    
    // Update client
    client.advanceBalance = client.advanceBalance - amount;
    client.totalDue = (client.totalDue || 0) - amount;
    await client.save();
    
    // Emit real-time events
    if (io) {
      io.emit('order:advance-applied', {
        orderId: order._id,
        orderNumber: order.orderNumber,
        amount,
        newBalance: order.balanceDue,
        clientAdvanceBalance: client.advanceBalance
      });
      
      io.emit('order:payment-updated', {
        orderId: order._id,
        orderNumber: order.orderNumber,
        advance: order.advance,
        balanceDue: order.balanceDue,
        paymentStatus: order.paymentStatus
      });
    }
    
    return {
      success: true,
      order: order.toObject(),
      client: client.toObject(),
      appliedAmount: amount
    };
  } catch (error) {
    console.error('Use advance for order error:', error);
    throw error;
  }
}

/**
 * Get payment history for a client
 */
async function getClientPaymentHistory(clientId, options = {}) {
  try {
    const {
      page = 1,
      limit = 50,
      paymentType, // Filter by payment type
      startDate,
      endDate
    } = options;
    
    const query = { client: clientId };
    
    if (paymentType) {
      query.paymentType = paymentType;
    }
    
    if (startDate || endDate) {
      query.paymentDate = {};
      if (startDate) query.paymentDate.$gte = new Date(startDate);
      if (endDate) query.paymentDate.$lte = new Date(endDate);
    }
    
    const skip = (page - 1) * limit;
    
    const [payments, total] = await Promise.all([
      Payment.find(query)
        .sort('-paymentDate')
        .skip(skip)
        .limit(limit)
        .populate('order', 'orderNumber grandTotal')
        .populate('invoice', 'invoiceNumber grandTotal')
        .populate('recordedBy', 'name username')
        .lean(),
      Payment.countDocuments(query)
    ]);
    
    return {
      success: true,
      payments,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    };
  } catch (error) {
    console.error('Get payment history error:', error);
    throw error;
  }
}

/**
 * Get detailed financial summary for a client
 */
async function getClientFinancialSummary(clientId) {
  try {
    const client = await Client.findById(clientId);
    if (!client) {
      throw new Error('Client not found');
    }
    
    // Get all orders
    const orders = await Order.find({ client: clientId })
      .select('orderNumber grandTotal advance balanceDue status paymentStatus orderDate')
      .sort('-orderDate')
      .lean();
    
    // Get payment summary
    const paymentSummary = await Payment.aggregate([
      { $match: { client: require('mongoose').Types.ObjectId(clientId) } },
      {
        $group: {
          _id: '$paymentType',
          totalAmount: { $sum: '$amount' },
          count: { $sum: 1 }
        }
      }
    ]);
    
    // Get unallocated advances
    const unallocatedAdvances = await Payment.getUnallocatedAdvances(clientId);
    
    // Calculate totals
    const totalOrderValue = orders.reduce((sum, o) => sum + o.grandTotal, 0);
    const totalPaid = orders.reduce((sum, o) => sum + (o.advance || 0), 0);
    const totalDue = orders.reduce((sum, o) => sum + o.balanceDue, 0);
    
    const openOrders = orders.filter(o => ['open', 'in_progress', 'partial_delivered'].includes(o.status));
    const completedOrders = orders.filter(o => o.status === 'completed');
    
    return {
      success: true,
      summary: {
        client: {
          id: client._id,
          partyName: client.partyName,
          mobile: client.mobile,
          address: client.address
        },
        orders: {
          total: orders.length,
          open: openOrders.length,
          completed: completedOrders.length,
          totalValue: totalOrderValue,
          totalPaid,
          totalDue
        },
        payments: {
          byType: paymentSummary.reduce((acc, item) => {
            acc[item._id] = {
              total: item.totalAmount,
              count: item.count
            };
            return acc;
          }, {}),
          advanceBalance: client.advanceBalance || 0,
          unallocatedAdvances: unallocatedAdvances.length,
          lastPayment: client.lastPaymentDate ? {
            amount: client.lastPaymentAmount,
            date: client.lastPaymentDate,
            method: client.lastPaymentMethod
          } : null
        },
        netDue: totalDue - (client.advanceBalance || 0)
      }
    };
  } catch (error) {
    console.error('Get financial summary error:', error);
    throw error;
  }
}

module.exports = {
  recordOrderPayment,
  recordAdvancePayment,
  recordClientPayment,
  useAdvanceForOrder,
  getClientPaymentHistory,
  getClientFinancialSummary
};
