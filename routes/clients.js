const express = require('express');
const mongoose = require('mongoose');
const Client = require('../models/Client');
const Invoice = require('../models/Invoice');
const Order = require('../models/Order');
const Payment = require('../models/Payment');
const Delivery = require('../models/Delivery');
const Return = require('../models/Return');
const { protect } = require('../middleware/auth');
const {
  recordClientPayment,
  recordAdvancePayment,
  useAdvanceForOrder,
  getClientPaymentHistory,
  getClientFinancialSummary
} = require('../utils/paymentManager');

const router = express.Router();

// All routes require authentication
router.use(protect);

// @route   GET /api/clients/autocomplete
// @desc    Autocomplete search for clients - OPTIMIZED FOR SPEED
// @access  Private
router.get('/autocomplete', async (req, res) => {
  try {
    const { q } = req.query;
    
    if (!q || q.length < 2) {
      return res.json({ success: true, data: [] });
    }
    
    // Use the optimized static method
    const clients = await Client.autocomplete(q, 10);
    
    res.json({
      success: true,
      data: clients
    });
  } catch (error) {
    console.error('Autocomplete error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   GET /api/clients
// @desc    Get all clients with pagination
// @access  Private
router.get('/', async (req, res) => {
  try {
    const {
      search,
      page = 1,
      limit = 50,
      sort = '-updatedAt'
    } = req.query;
    
    const query = {};
    
    if (search) {
      const searchRegex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [
        { partyName: searchRegex },
        { mobile: searchRegex }
      ];
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const [clients, total] = await Promise.all([
      Client.find(query)
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Client.countDocuments(query)
    ]);
    
    res.json({
      success: true,
      data: clients,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get clients error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   GET /api/clients/:id
// @desc    Get single client with complete order history and financial summary
// @access  Private
router.get('/:id', async (req, res) => {
  try {
    const client = await Client.findById(req.params.id).lean();
    
    if (!client) {
      return res.status(404).json({
        success: false,
        error: 'Client not found'
      });
    }
    
    // Get ALL orders for this client (not just recent)
    const orders = await Order.find({
      client: client._id
    })
    .select('orderNumber grandTotal advance balanceDue orderDate expectedDeliveryDate status paymentStatus progress employeeName')
    .sort('-orderDate')
    .lean();
    
    // Get ALL invoices for this client
    const invoices = await Invoice.find({
      client: client._id
    })
    .select('invoiceNumber grandTotal advance balanceDue orderDate deliveryDate deliveryStatus paymentStatus')
    .sort('-orderDate')
    .lean();
    
    // Get recent payment history (last 10 payments)
    const recentPayments = await Payment.find({
      client: client._id
    })
    .select('paymentNumber amount paymentDate paymentMethod paymentType orderNumber transactionReference notes')
    .sort('-paymentDate')
    .limit(10)
    .populate('recordedBy', 'name username')
    .lean();
    
    // Calculate financial summary
    const totalOrderValue = orders.reduce((sum, o) => sum + o.grandTotal, 0);
    const totalPaid = orders.reduce((sum, o) => sum + (o.advance || 0), 0);
    const totalDue = orders.reduce((sum, o) => sum + o.balanceDue, 0);
    const netDue = totalDue - (client.advanceBalance || 0);
    
    const openOrders = orders.filter(o => ['open', 'in_progress', 'partial_delivered'].includes(o.status));
    const completedOrders = orders.filter(o => o.status === 'completed');
    
    res.json({
      success: true,
      data: {
        client: {
          ...client,
          financialSummary: {
            totalOrders: orders.length,
            openOrders: openOrders.length,
            completedOrders: completedOrders.length,
            totalOrderValue,
            totalPaid,
            totalDue,
            advanceBalance: client.advanceBalance || 0,
            netDue,
            lastPayment: client.lastPaymentDate ? {
              amount: client.lastPaymentAmount,
              date: client.lastPaymentDate,
              method: client.lastPaymentMethod
            } : null
          }
        },
        orders, // All orders with payment status
        invoices, // All invoices
        recentPayments // Recent payment history
      }
    });
  } catch (error) {
    console.error('Get client error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   POST /api/clients
// @desc    Create client
// @access  Private
router.post('/', async (req, res) => {
  try {
    const { partyName, mobile, address, email, notes } = req.body;
    
    if (!partyName || !mobile) {
      return res.status(400).json({
        success: false,
        error: 'Party name and mobile are required'
      });
    }
    
    // Check if client exists
    const existingClient = await Client.findOne({ partyName, mobile });
    
    if (existingClient) {
      return res.status(400).json({
        success: false,
        error: 'Client with this name and mobile already exists'
      });
    }
    
    const client = await Client.create({
      partyName,
      mobile,
      address,
      email,
      notes
    });
    
    // Emit real-time event
    const io = req.app.get('io');
    if (io) {
      io.emit('client:created', { client });
    }
    
    res.status(201).json({
      success: true,
      data: client
    });
  } catch (error) {
    console.error('Create client error:', error);
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        error: 'Client already exists'
      });
    }
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   PUT /api/clients/:id
// @desc    Update client
// @access  Private
router.put('/:id', async (req, res) => {
  try {
    const { partyName, mobile, address, email, notes } = req.body;
    
    const client = await Client.findByIdAndUpdate(
      req.params.id,
      { partyName, mobile, address, email, notes },
      { new: true, runValidators: true }
    ).lean();
    
    if (!client) {
      return res.status(404).json({
        success: false,
        error: 'Client not found'
      });
    }
    
    // Emit real-time event
    const io = req.app.get('io');
    if (io) {
      io.emit('client:updated', { client });
    }
    
    res.json({
      success: true,
      data: client
    });
  } catch (error) {
    console.error('Update client error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   GET /api/clients/:id/invoices
// @desc    Get all invoices for a client
// @access  Private
router.get('/:id/invoices', async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const [invoices, total] = await Promise.all([
      Invoice.find({ client: req.params.id })
        .select('invoiceNumber grandTotal balanceDue orderDate deliveryDate deliveryStatus paymentStatus')
        .sort('-orderDate')
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Invoice.countDocuments({ client: req.params.id })
    ]);
    
    res.json({
      success: true,
      data: invoices,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get client invoices error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   GET /api/clients/:id/orders
// @desc    Get all orders for a client
// @access  Private
router.get('/:id/orders', async (req, res) => {
  try {
    const { page = 1, limit = 20, status, paymentStatus } = req.query;
    
    const query = { client: req.params.id };
    
    if (status) {
      query.status = status;
    }
    
    if (paymentStatus) {
      query.paymentStatus = paymentStatus;
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const [orders, total] = await Promise.all([
      Order.find(query)
        .select('orderNumber grandTotal advance balanceDue orderDate expectedDeliveryDate status paymentStatus progress totalDeliveries employeeName')
        .sort('-orderDate')
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Order.countDocuments(query)
    ]);
    
    res.json({
      success: true,
      data: orders,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get client orders error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   POST /api/clients/:id/payments
// @desc    Record payment for a client (with auto-allocation to orders)
// @access  Private
router.post('/:id/payments', async (req, res) => {
  try {
    const {
      amount,
      paymentDate,
      paymentMethod = 'cash',
      transactionReference,
      notes,
      orderAllocations, // Optional: [{ orderId, amount }]
      autoAllocate = true
    } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Valid payment amount is required'
      });
    }
    
    const io = req.app.get('io');
    
    const result = await recordClientPayment(
      req.params.id,
      {
        amount,
        paymentDate,
        paymentMethod,
        transactionReference,
        notes,
        orderAllocations,
        autoAllocate
      },
      req.user._id,
      io
    );
    
    res.status(201).json({
      success: true,
      data: result,
      message: result.remainingAsAdvance > 0
        ? `Payment recorded. ₹${result.allocated} allocated to orders, ₹${result.remainingAsAdvance} added to advance balance.`
        : `Payment of ₹${amount} recorded and allocated to orders.`
    });
  } catch (error) {
    console.error('Record client payment error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Server error'
    });
  }
});

// @route   POST /api/clients/:id/advance-payment
// @desc    Record advance payment (not linked to any order)
// @access  Private
router.post('/:id/advance-payment', async (req, res) => {
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
    
    const io = req.app.get('io');
    
    const result = await recordAdvancePayment(
      req.params.id,
      {
        amount,
        paymentDate,
        paymentMethod,
        transactionReference,
        notes
      },
      req.user._id,
      io
    );
    
    res.status(201).json({
      success: true,
      data: result,
      message: `Advance payment of ₹${amount} recorded successfully.`
    });
  } catch (error) {
    console.error('Record advance payment error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Server error'
    });
  }
});

// @route   GET /api/clients/:id/payments
// @desc    Get payment history for a client
// @access  Private
router.get('/:id/payments', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      paymentType,
      startDate,
      endDate
    } = req.query;
    
    const result = await getClientPaymentHistory(req.params.id, {
      page: parseInt(page),
      limit: parseInt(limit),
      paymentType,
      startDate,
      endDate
    });
    
    res.json({
      success: true,
      data: result.payments,
      pagination: result.pagination
    });
  } catch (error) {
    console.error('Get payment history error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Server error'
    });
  }
});

// @route   GET /api/clients/:id/financial-summary
// @desc    Get detailed financial summary for a client
// @access  Private
router.get('/:id/financial-summary', async (req, res) => {
  try {
    const result = await getClientFinancialSummary(req.params.id);
    
    res.json(result);
  } catch (error) {
    console.error('Get financial summary error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Server error'
    });
  }
});

// @route   POST /api/clients/:id/use-advance
// @desc    Use advance balance to pay for an order
// @access  Private
router.post('/:id/use-advance', async (req, res) => {
  try {
    const { orderId, amount } = req.body;
    
    if (!orderId || !amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Valid order ID and amount are required'
      });
    }
    
    const io = req.app.get('io');
    
    const result = await useAdvanceForOrder(
      orderId,
      amount,
      req.user._id,
      io
    );
    
    res.json({
      success: true,
      data: result,
      message: `₹${amount} from advance balance applied to order ${result.order.orderNumber}.`
    });
  } catch (error) {
    console.error('Use advance error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Server error'
    });
  }
});

// ============================================================================
// CLIENT LEDGER — Full chronological activity log with running balance
// ============================================================================

// @route   GET /api/clients/:id/ledger
// @desc    Get a proper accounting ledger for a client between two dates.
//          Shows ALL activities in chronological order:
//          - Orders placed (debit — client owes more)
//          - Payments received (credit — client paid)
//          - Deliveries made (info entry — no financial impact)
//          - Returns processed (credit — client owes less)
//          - Refunds given (debit — money went back to client)
//
//          Includes opening balance (what client owed before the start date)
//          and closing balance (what client owes at end of the period).
//
//          Usage:
//            GET /api/clients/:id/ledger?startDate=2026-02-01&endDate=2026-02-28
//            GET /api/clients/:id/ledger?startDate=2026-01-01 (from date to now)
// @access  Private
router.get('/:id/ledger', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    if (!startDate) {
      return res.status(400).json({
        success: false,
        error: 'startDate is required (format: YYYY-MM-DD)'
      });
    }
    
    const client = await Client.findById(req.params.id)
      .select('partyName mobile address advanceBalance refundableBalance')
      .lean();
    
    if (!client) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }
    
    const clientId = new mongoose.Types.ObjectId(req.params.id);
    
    // Date range
    const rangeStart = new Date(startDate);
    rangeStart.setHours(0, 0, 0, 0);
    
    const rangeEnd = endDate ? new Date(endDate) : new Date();
    rangeEnd.setHours(23, 59, 59, 999);
    
    // ═══════════════════════════════════════════════════════════════════
    // OPENING BALANCE — What client owed BEFORE the start date
    // Sum of all orders - payments - returns before startDate
    // ═══════════════════════════════════════════════════════════════════
    const [ordersBefore, paymentsBefore, returnsBefore] = await Promise.all([
      Order.aggregate([
        { $match: { client: clientId, orderDate: { $lt: rangeStart }, status: { $ne: 'cancelled' } } },
        { $group: { _id: null, total: { $sum: '$grandTotal' } } }
      ]),
      Payment.aggregate([
        { $match: { client: clientId, paymentDate: { $lt: rangeStart }, paymentType: { $ne: 'return_refund' } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      Return.aggregate([
        { $match: { client: clientId, returnDate: { $lt: rangeStart } } },
        { $group: { _id: null, total: { $sum: '$returnTotal' } } }
      ])
    ]);
    
    // Refunds before range (money given back to client, reduces what they "owe" further)
    const refundsBefore = await Payment.aggregate([
      { $match: { client: clientId, paymentDate: { $lt: rangeStart }, paymentType: 'return_refund' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    
    const openingBalance =
      (ordersBefore[0]?.total || 0)
      - (paymentsBefore[0]?.total || 0)
      - (returnsBefore[0]?.total || 0)
      - (refundsBefore[0]?.total || 0);
    
    // ═══════════════════════════════════════════════════════════════════
    // FETCH ALL ENTRIES IN DATE RANGE
    // ═══════════════════════════════════════════════════════════════════
    
    // Get order IDs for this client (needed for deliveries lookup)
    const clientOrderIds = await Order.find({ client: clientId })
      .select('_id')
      .lean()
      .then(orders => orders.map(o => o._id));
    
    const [orders, payments, deliveries, returns] = await Promise.all([
      // Orders placed in range — include FULL item details + all charges (Tally-style)
      Order.find({
        client: clientId,
        orderDate: { $gte: rangeStart, $lte: rangeEnd },
        status: { $ne: 'cancelled' }
      })
      .select('orderNumber grandTotal subtotal localFreight transportation gstPercent gstAmount discount orderDate status paymentStatus items employeeName')
      .sort('orderDate')
      .lean(),
      
      // Payments in range (includes both regular and refund payments)
      Payment.find({
        client: clientId,
        paymentDate: { $gte: rangeStart, $lte: rangeEnd }
      })
      .select('paymentNumber amount paymentDate paymentMethod paymentType orderNumber returnNumber transactionReference notes')
      .populate('recordedBy', 'name')
      .sort('paymentDate')
      .lean(),
      
      // Deliveries in range — include FULL item details + charges (Tally-style)
      Delivery.find({
        order: { $in: clientOrderIds },
        deliveryDate: { $gte: rangeStart, $lte: rangeEnd }
      })
      .select('deliveryNumber orderNumber deliveryDate grandTotal subtotal localFreight transportation gstPercent gstAmount discount status items')
      .sort('deliveryDate')
      .lean(),
      
      // Returns in range — include FULL item details
      Return.find({
        client: clientId,
        returnDate: { $gte: rangeStart, $lte: rangeEnd }
      })
      .select('returnNumber orderNumber returnTotal returnDate reason refundableAmount refundedAmount refundStatus items')
      .sort('returnDate')
      .lean()
    ]);
    
    // ═══════════════════════════════════════════════════════════════════
    // BUILD LEDGER ENTRIES — Tally-style with full item details
    // Each entry includes items array, charges breakdown, and totals
    // ═══════════════════════════════════════════════════════════════════
    const entries = [];
    
    // Helper: format item lines (Tally-style: "ProductName  Qty Pcs. @ Rate = Total")
    function formatItems(items) {
      if (!items || items.length === 0) return [];
      return items.map(item => ({
        productName: item.productName,
        narration: item.narration || '',
        quantity: item.quantity,
        price: item.price,
        total: item.total || (item.price * item.quantity),
        // Parda-specific fields (only if present)
        ...(item.width !== undefined && item.width !== null && { width: item.width }),
        ...(item.height !== undefined && item.height !== null && { height: item.height }),
        ...(item.chunnut !== undefined && item.chunnut !== null && { chunnut: item.chunnut }),
        ...(item.colour && { colour: item.colour }),
        ...(item.colourPrice !== undefined && item.colourPrice !== null && { colourPrice: item.colourPrice }),
        // Delivery tracking (only for order items)
        ...(item.deliveredQuantity !== undefined && {
          deliveredQuantity: item.deliveredQuantity,
          remainingQuantity: item.remainingQuantity
        })
      }));
    }
    
    // Helper: build charges breakdown (Tally-style: "+ Freight & Forwarding = 10,000")
    function formatCharges(doc) {
      const charges = [];
      if (doc.localFreight > 0) charges.push({ label: 'Local Freight', amount: doc.localFreight });
      if (doc.transportation > 0) charges.push({ label: 'Freight & Forwarding', amount: doc.transportation });
      if (doc.gstPercent > 0) charges.push({ label: `GST ${doc.gstPercent}%`, amount: doc.gstAmount || 0 });
      if (doc.discount > 0) charges.push({ label: 'Discount', amount: -doc.discount }); // negative = deduction
      return charges;
    }
    
    // Orders → DEBIT (client owes more) — with FULL item details like Tally "Sale" entry
    for (const order of orders) {
      const totalQty = order.items?.reduce((sum, i) => sum + i.quantity, 0) || 0;
      
      entries.push({
        date: order.orderDate,
        type: 'order',
        voucherType: 'Sale',
        refNumber: order.orderNumber,
        description: `Sales`,
        debit: order.grandTotal,
        credit: 0,
        // ── Tally-style item details ──
        items: formatItems(order.items),
        charges: formatCharges(order),
        totalQuantity: Math.round(totalQty * 100) / 100,
        subtotal: order.subtotal,
        details: {
          orderNumber: order.orderNumber,
          grandTotal: order.grandTotal,
          subtotal: order.subtotal,
          localFreight: order.localFreight || 0,
          transportation: order.transportation || 0,
          gstPercent: order.gstPercent || 0,
          gstAmount: order.gstAmount || 0,
          discount: order.discount || 0,
          status: order.status,
          paymentStatus: order.paymentStatus,
          employeeName: order.employeeName,
          itemCount: order.items?.length || 0
        }
      });
    }
    
    // Payments → CREDIT (client paid) — Tally "Rcpt" entry
    for (const payment of payments) {
      if (payment.paymentType === 'return_refund') {
        // Refund given back to client
        entries.push({
          date: payment.paymentDate,
          type: 'refund',
          voucherType: 'Rcpt',
          refNumber: payment.paymentNumber,
          description: `${payment.paymentMethod === 'cash' ? 'Cash' : payment.paymentMethod === 'upi' ? 'UPI' : payment.paymentMethod === 'bank_transfer' ? 'Bank Transfer' : payment.paymentMethod === 'cheque' ? 'Cheque' : payment.paymentMethod === 'card' ? 'Card' : payment.paymentMethod || 'Cash'}`,
          debit: 0,
          credit: payment.amount,
          items: [],
          charges: [],
          details: {
            paymentNumber: payment.paymentNumber,
            amount: payment.amount,
            method: payment.paymentMethod,
            returnNumber: payment.returnNumber,
            reference: payment.transactionReference,
            recordedBy: payment.recordedBy?.name,
            notes: payment.notes
          }
        });
      } else {
        // Regular payment — client paid us
        entries.push({
          date: payment.paymentDate,
          type: 'payment',
          voucherType: 'Rcpt',
          refNumber: payment.paymentNumber,
          description: `${payment.paymentMethod === 'cash' ? 'Cash' : payment.paymentMethod === 'upi' ? 'UPI' : payment.paymentMethod === 'bank_transfer' ? 'Bank Transfer' : payment.paymentMethod === 'cheque' ? 'Cheque' : payment.paymentMethod === 'card' ? 'Card' : payment.paymentMethod || 'Cash'}${payment.transactionReference ? ' (' + payment.transactionReference + ')' : ''}`,
          debit: 0,
          credit: payment.amount,
          items: [],
          charges: [],
          details: {
            paymentNumber: payment.paymentNumber,
            amount: payment.amount,
            method: payment.paymentMethod,
            paymentType: payment.paymentType,
            orderNumber: payment.orderNumber,
            reference: payment.transactionReference,
            recordedBy: payment.recordedBy?.name,
            notes: payment.notes
          }
        });
      }
    }
    
    // Deliveries → INFO entry (no financial impact) — with FULL item details
    for (const delivery of deliveries) {
      const totalQty = delivery.items?.reduce((sum, i) => sum + i.quantity, 0) || 0;
      
      entries.push({
        date: delivery.deliveryDate,
        type: 'delivery',
        voucherType: 'Delivery',
        refNumber: delivery.deliveryNumber,
        description: `Delivery for ${delivery.orderNumber}`,
        debit: 0,
        credit: 0,
        // ── Full item details — what was actually delivered ──
        items: formatItems(delivery.items),
        charges: formatCharges(delivery),
        totalQuantity: Math.round(totalQty * 100) / 100,
        subtotal: delivery.subtotal || 0,
        details: {
          deliveryNumber: delivery.deliveryNumber,
          orderNumber: delivery.orderNumber,
          grandTotal: delivery.grandTotal,
          subtotal: delivery.subtotal || 0,
          localFreight: delivery.localFreight || 0,
          transportation: delivery.transportation || 0,
          gstPercent: delivery.gstPercent || 0,
          gstAmount: delivery.gstAmount || 0,
          discount: delivery.discount || 0,
          status: delivery.status,
          itemCount: delivery.items?.length || 0
        }
      });
    }
    
    // Returns → CREDIT (client owes less) — with FULL item details
    for (const ret of returns) {
      const totalQty = ret.items?.reduce((sum, i) => sum + i.quantity, 0) || 0;
      
      entries.push({
        date: ret.returnDate,
        type: 'return',
        voucherType: 'Return',
        refNumber: ret.returnNumber,
        description: `Return for ${ret.orderNumber}${ret.reason ? ' — ' + ret.reason : ''}`,
        debit: 0,
        credit: ret.returnTotal,
        // ── Full item details — what was returned ──
        items: formatItems(ret.items),
        charges: [],
        totalQuantity: Math.round(totalQty * 100) / 100,
        subtotal: ret.returnTotal,
        details: {
          returnNumber: ret.returnNumber,
          orderNumber: ret.orderNumber,
          returnTotal: ret.returnTotal,
          reason: ret.reason,
          refundableAmount: ret.refundableAmount,
          refundedAmount: ret.refundedAmount,
          refundStatus: ret.refundStatus,
          itemCount: ret.items?.length || 0
        }
      });
    }
    
    // ═══════════════════════════════════════════════════════════════════
    // SORT BY DATE + CALCULATE RUNNING BALANCE (with Cr/Dr like Tally)
    // Positive balance = Dr (client owes us)
    // Negative balance = Cr (we owe client / client overpaid)
    // ═══════════════════════════════════════════════════════════════════
    entries.sort((a, b) => new Date(a.date) - new Date(b.date));
    
    let runningBalance = openingBalance;
    for (const entry of entries) {
      runningBalance = runningBalance + entry.debit - entry.credit;
      const rounded = Math.round(runningBalance * 100) / 100;
      entry.balance = rounded;
      // Tally-style: "74,228.00 Dr" or "50,000.00 Cr"
      entry.balanceType = rounded > 0 ? 'Dr' : rounded < 0 ? 'Cr' : '';
      entry.balanceDisplay = `${Math.abs(rounded).toFixed(2)} ${entry.balanceType}`.trim();
    }
    
    const closingBalance = Math.round(runningBalance * 100) / 100;
    
    // ═══════════════════════════════════════════════════════════════════
    // SUMMARY + RESPONSE
    // ═══════════════════════════════════════════════════════════════════
    const totalDebit = entries.reduce((sum, e) => sum + e.debit, 0);
    const totalCredit = entries.reduce((sum, e) => sum + e.credit, 0);
    
    res.json({
      success: true,
      data: {
        client: {
          _id: client._id,
          partyName: client.partyName,
          mobile: client.mobile,
          address: client.address
        },
        period: {
          startDate: rangeStart,
          endDate: rangeEnd
        },
        openingBalance: Math.round(openingBalance * 100) / 100,
        openingBalanceType: openingBalance > 0 ? 'Dr' : openingBalance < 0 ? 'Cr' : '',
        openingBalanceDisplay: `${Math.abs(Math.round(openingBalance * 100) / 100).toFixed(2)} ${openingBalance > 0 ? 'Dr' : openingBalance < 0 ? 'Cr' : ''}`.trim(),
        closingBalance,
        closingBalanceType: closingBalance > 0 ? 'Dr' : closingBalance < 0 ? 'Cr' : '',
        closingBalanceDisplay: `${Math.abs(closingBalance).toFixed(2)} ${closingBalance > 0 ? 'Dr' : closingBalance < 0 ? 'Cr' : ''}`.trim(),
        summary: {
          totalDebit: Math.round(totalDebit * 100) / 100,
          totalCredit: Math.round(totalCredit * 100) / 100,
          totalOrders: orders.length,
          totalPayments: payments.filter(p => p.paymentType !== 'return_refund').length,
          totalDeliveries: deliveries.length,
          totalReturns: returns.length,
          totalRefunds: payments.filter(p => p.paymentType === 'return_refund').length,
          entries: entries.length
        },
        entries
      }
    });
  } catch (error) {
    console.error('Get client ledger error:', error);
    res.status(500).json({ success: false, error: error.message || 'Server error' });
  }
});

module.exports = router;

