const express = require('express');
const Client = require('../models/Client');
const Invoice = require('../models/Invoice');
const Order = require('../models/Order');
const Payment = require('../models/Payment');
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

module.exports = router;

