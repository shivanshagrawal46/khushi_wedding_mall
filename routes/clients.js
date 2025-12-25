const express = require('express');
const Client = require('../models/Client');
const Invoice = require('../models/Invoice');
const { protect } = require('../middleware/auth');

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
// @desc    Get single client with order history
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
    
    // Get recent invoices for this client
    const recentInvoices = await Invoice.find({
      client: client._id
    })
    .select('invoiceNumber grandTotal orderDate deliveryStatus paymentStatus')
    .sort('-orderDate')
    .limit(10)
    .lean();
    
    res.json({
      success: true,
      data: {
        ...client,
        recentInvoices
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

module.exports = router;

