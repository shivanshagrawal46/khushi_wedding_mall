const express = require('express');
const Invoice = require('../models/Invoice');
const DeliveryInvoice = require('../models/DeliveryInvoice');
const Client = require('../models/Client');
const Product = require('../models/Product');
const Payment = require('../models/Payment');
const { protect, adminOnly } = require('../middleware/auth');
const { 
  reduceInventory, 
  restoreInventory, 
  adjustInventory 
} = require('../utils/inventoryManager');

const router = express.Router();

// All routes require authentication
router.use(protect);

// @route   GET /api/invoices
// @desc    Get all invoices with filtering
// @access  Private
router.get('/', async (req, res) => {
  try {
    const {
      search,
      deliveryStatus,
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
        { invoiceNumber: searchRegex }
      ];
    }
    
    // Filter by delivery status
    if (deliveryStatus) {
      query.deliveryStatus = deliveryStatus;
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
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Execute optimized query with lean()
    const [invoices, total] = await Promise.all([
      Invoice.find(query)
        .select('invoiceNumber partyName mobile grandTotal balanceDue orderDate deliveryDate deliveryStatus paymentStatus')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Invoice.countDocuments(query)
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
    console.error('Get invoices error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   GET /api/invoices/stats
// @desc    Get invoice statistics for dashboard
// @access  Private
router.get('/stats', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    
    // Run all stats queries in parallel for speed
    const [
      totalInvoices,
      pendingDeliveries,
      unpaidInvoices,
      todayDeliveries,
      monthlyStats
    ] = await Promise.all([
      Invoice.countDocuments(),
      Invoice.countDocuments({ deliveryStatus: 'pending' }),
      Invoice.countDocuments({ paymentStatus: { $in: ['unpaid', 'partial'] } }),
      Invoice.countDocuments({
        deliveryDate: {
          $gte: today,
          $lt: new Date(today.getTime() + 24 * 60 * 60 * 1000)
        }
      }),
      Invoice.aggregate([
        { $match: { orderDate: { $gte: thisMonth } } },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: '$grandTotal' },
            totalAdvance: { $sum: '$advance' },
            count: { $sum: 1 }
          }
        }
      ])
    ]);
    
    res.json({
      success: true,
      data: {
        totalInvoices,
        pendingDeliveries,
        unpaidInvoices,
        todayDeliveries,
        monthlyRevenue: monthlyStats[0]?.totalRevenue || 0,
        monthlyAdvance: monthlyStats[0]?.totalAdvance || 0,
        monthlyInvoices: monthlyStats[0]?.count || 0
      }
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   GET /api/invoices/upcoming-deliveries
// @desc    Get upcoming deliveries
// @access  Private
router.get('/upcoming-deliveries', async (req, res) => {
  try {
    const { days = 7 } = req.query;
    
    const startDate = new Date();
    startDate.setHours(0, 0, 0, 0);
    
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + parseInt(days));
    
    const deliveries = await Invoice.find({
      deliveryDate: { $gte: startDate, $lte: endDate },
      deliveryStatus: { $in: ['pending', 'in_transit'] }
    })
    .select('invoiceNumber partyName mobile deliveryDate deliveryStatus grandTotal balanceDue')
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

// @route   GET /api/invoices/:id
// @desc    Get single invoice (supports both ObjectId and Invoice Number)
//         Supports both old Invoice model and new DeliveryInvoice model
// @access  Private
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if id is a valid MongoDB ObjectId (24 hex characters)
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);
    
    let invoice = null;
    let invoiceType = null;
    
    if (isObjectId) {
      // Try DeliveryInvoice first (new system)
      invoice = await DeliveryInvoice.findById(id)
        .populate('createdBy', 'name username')
        .populate('delivery', 'deliveryNumber deliveryDate status')
        .populate('order', 'orderNumber orderDate status')
        .lean();
      
      if (invoice) {
        invoiceType = 'delivery';
      } else {
        // Fallback to old Invoice model
        invoice = await Invoice.findById(id)
          .populate('createdBy', 'name username')
          .lean();
        if (invoice) {
          invoiceType = 'legacy';
        }
      }
    } else {
      // Search by invoice number
      const invoiceNumber = id.toUpperCase();
      
      // Try DeliveryInvoice first (new system)
      invoice = await DeliveryInvoice.findOne({ invoiceNumber })
        .populate('createdBy', 'name username')
        .populate('delivery', 'deliveryNumber deliveryDate status')
        .populate('order', 'orderNumber orderDate status')
        .lean();
      
      if (invoice) {
        invoiceType = 'delivery';
      } else {
        // Fallback to old Invoice model
        invoice = await Invoice.findOne({ invoiceNumber })
          .populate('createdBy', 'name username')
          .lean();
        if (invoice) {
          invoiceType = 'legacy';
        }
      }
    }
    
    if (!invoice) {
      return res.status(404).json({
        success: false,
        error: 'Invoice not found'
      });
    }
    
    res.json({
      success: true,
      data: invoice,
      invoiceType // 'delivery' or 'legacy' - helps frontend know which type
    });
  } catch (error) {
    console.error('Get invoice error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   POST /api/invoices
// @desc    Create invoice
// @access  Private
router.post('/', async (req, res) => {
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
      deliveryDate,
      orderDate,
      notes
    } = req.body;
    
    // Validation
    if (!partyName || !mobile || !items || items.length === 0 || !deliveryDate) {
      return res.status(400).json({
        success: false,
        error: 'Party name, mobile, items, and delivery date are required'
      });
    }
    
    // Calculate totals
    const subtotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const gstAmount = (subtotal * gstPercent) / 100;
    const grandTotal = subtotal + localFreight + transportation + gstAmount - discount;
    const balanceDue = grandTotal - advance;
    
    // Format items with total and find product IDs if not provided
    const formattedItems = await Promise.all(items.map(async (item) => {
      let productId = item.product || null;
      
      // If product ID is not provided, try to find by product name
      if (!productId && item.productName) {
        const foundProduct = await Product.findOne({ 
          name: item.productName,
          isActive: true 
        }).select('_id').lean();
        
        if (foundProduct) {
          productId = foundProduct._id;
          console.log(`📦 Found product by name: "${item.productName}" → ${productId}`);
        } else {
          console.warn(`⚠️ Product not found by name: "${item.productName}" - inventory will not be tracked`);
        }
      }
      
      return {
        product: productId,
        productName: item.productName,
        price: item.price,
        quantity: item.quantity,
        total: item.price * item.quantity
      };
    }));
    
    // Find or create client - do this in parallel with invoice creation
    const clientPromise = Client.findOneAndUpdate(
      { partyName, mobile },
      {
        partyName,
        mobile,
        $inc: { totalOrders: 1, totalSpent: grandTotal }
      },
      { upsert: true, new: true, lean: true }
    );
    
    // Create invoice
    const invoice = new Invoice({
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
      orderDate: orderDate || Date.now(),
      deliveryDate,
      notes,
      createdBy: req.user._id
    });
    
    // Execute both operations
    const [savedInvoice, client] = await Promise.all([
      invoice.save(),
      clientPromise
    ]);
    
    // Update invoice with client reference
    savedInvoice.client = client._id;
    await savedInvoice.save();
    
    // Get Socket.IO instance
    const io = req.app.get('io');
    
    // Reduce inventory for invoice items
    console.log(`📦 Attempting to reduce inventory for ${formattedItems.length} items`);
    const inventoryResult = await reduceInventory(formattedItems, io);
    
    if (!inventoryResult.success) {
      console.error('❌ Inventory reduction failed:', inventoryResult.error);
    } else {
      const itemsWithProducts = formattedItems.filter(item => item.product).length;
      const itemsWithoutProducts = formattedItems.length - itemsWithProducts;
      
      if (itemsWithoutProducts > 0) {
        console.warn(`⚠️ ${itemsWithoutProducts} items without product IDs - inventory not tracked for these`);
      }
      
      if (inventoryResult.affectedProducts.length > 0) {
        console.log(`✅ Inventory reduced for ${inventoryResult.affectedProducts.length} products:`);
        inventoryResult.affectedProducts.forEach(p => {
          console.log(`   - ${p.name}: ${p.oldInventory} → ${p.newInventory} (reduced by ${p.quantityReduced})`);
        });
        
        // Emit inventory changes summary
        if (io) {
          io.emit('invoice:inventory-reduced', {
            invoiceId: savedInvoice._id,
            invoiceNumber: savedInvoice.invoiceNumber,
            affectedProducts: inventoryResult.affectedProducts
          });
        }
      } else {
        console.warn(`⚠️ No inventory was reduced. Check if products have inventory tracking enabled.`);
      }
    }
    
    // Emit real-time event for invoice creation
    if (io) {
      io.emit('invoice:created', { invoice: savedInvoice });
    }
    
    res.status(201).json({
      success: true,
      data: savedInvoice,
      inventoryUpdated: inventoryResult.success,
      affectedProducts: inventoryResult.affectedProducts || []
    });
  } catch (error) {
    console.error('Create invoice error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   PUT /api/invoices/:id
// @desc    Update invoice (supports both ObjectId and Invoice Number)
// @access  Private
router.put('/:id', async (req, res) => {
  try {
    const {
      partyName,
      mobile,
      items,
      localFreight,
      transportation,
      gstPercent,
      discount,
      advance,
      deliveryDate,
      deliveryStatus,
      notes
    } = req.body;
    
    const { id } = req.params;
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);
    const query = isObjectId ? { _id: id } : { invoiceNumber: id.toUpperCase() };
    
    // Get invoice as document (needed for .save())
    const invoice = await Invoice.findOne(query);
    
    if (!invoice) {
      return res.status(404).json({
        success: false,
        error: 'Invoice not found'
      });
    }
    
    // Store old items for inventory adjustment (convert to plain object for comparison)
    const oldItems = JSON.parse(JSON.stringify(invoice.items));
    
    // Get Socket.IO instance
    const io = req.app.get('io');
    
    // Recalculate if items changed
    if (items) {
      const subtotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
      const gst = gstPercent !== undefined ? gstPercent : invoice.gstPercent;
      const freight = localFreight !== undefined ? localFreight : invoice.localFreight;
      const transport = transportation !== undefined ? transportation : invoice.transportation;
      const disc = discount !== undefined ? discount : invoice.discount;
      const adv = advance !== undefined ? advance : invoice.advance;
      
      const gstAmount = (subtotal * gst) / 100;
      const grandTotal = subtotal + freight + transport + gstAmount - disc;
      const balanceDue = grandTotal - adv;
      
      invoice.items = items.map(item => ({
        product: item.product || null,
        productName: item.productName,
        price: item.price,
        quantity: item.quantity,
        total: item.price * item.quantity
      }));
      invoice.subtotal = subtotal;
      invoice.gstAmount = gstAmount;
      invoice.grandTotal = grandTotal;
      invoice.balanceDue = balanceDue;
    }
    
    // Update fields
    if (partyName) invoice.partyName = partyName;
    if (mobile) invoice.mobile = mobile;
    if (localFreight !== undefined) invoice.localFreight = localFreight;
    if (transportation !== undefined) invoice.transportation = transportation;
    if (gstPercent !== undefined) invoice.gstPercent = gstPercent;
    if (discount !== undefined) invoice.discount = discount;
    if (advance !== undefined) {
      invoice.advance = advance;
      invoice.balanceDue = invoice.grandTotal - advance;
    }
    if (deliveryDate) invoice.deliveryDate = deliveryDate;
    if (deliveryStatus) invoice.deliveryStatus = deliveryStatus;
    if (notes !== undefined) invoice.notes = notes;
    
    await invoice.save();
    
    // Convert to plain object for response (lean-like performance)
    const updatedInvoiceData = invoice.toObject();
    
    // Adjust inventory if items were changed
    let inventoryResult = { success: true, affectedProducts: [] };
    if (items) {
      inventoryResult = await adjustInventory(oldItems, updatedInvoiceData.items, io);
      
      if (!inventoryResult.success) {
        console.error('Inventory adjustment failed:', inventoryResult.error);
      } else if (inventoryResult.affectedProducts.length > 0) {
        console.log(`✅ Inventory adjusted for ${inventoryResult.affectedProducts.length} products`);
        
        // Emit inventory changes summary
        if (io) {
          io.emit('invoice:inventory-adjusted', {
            invoiceId: updatedInvoiceData._id,
            invoiceNumber: updatedInvoiceData.invoiceNumber,
            affectedProducts: inventoryResult.affectedProducts
          });
        }
      }
    }
    
    // Emit real-time event
    if (io) {
      io.emit('invoice:updated', { invoice: updatedInvoiceData });
    }
    
    res.json({
      success: true,
      data: updatedInvoiceData,
      inventoryAdjusted: items ? inventoryResult.success : false,
      affectedProducts: inventoryResult.affectedProducts || []
    });
  } catch (error) {
    console.error('Update invoice error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   PATCH /api/invoices/:id/delivery-status
// @desc    Update delivery status only (supports both ObjectId and Invoice Number)
// @access  Private
router.patch('/:id/delivery-status', async (req, res) => {
  try {
    const { deliveryStatus } = req.body;
    
    if (!deliveryStatus) {
      return res.status(400).json({
        success: false,
        error: 'Delivery status is required'
      });
    }
    
    const { id } = req.params;
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);
    const query = isObjectId ? { _id: id } : { invoiceNumber: id.toUpperCase() };
    
    const invoice = await Invoice.findOneAndUpdate(
      query,
      { deliveryStatus },
      { new: true }
    ).lean();
    
    if (!invoice) {
      return res.status(404).json({
        success: false,
        error: 'Invoice not found'
      });
    }
    
    // Emit real-time event
    const io = req.app.get('io');
    if (io) {
      io.emit('invoice:delivery-status-updated', { 
        invoiceId: invoice._id,
        invoiceNumber: invoice.invoiceNumber,
        deliveryStatus: invoice.deliveryStatus 
      });
    }
    
    res.json({
      success: true,
      data: invoice
    });
  } catch (error) {
    console.error('Update delivery status error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   PATCH /api/invoices/:id/payment
// @desc    Record payment for invoice (creates payment history entry)
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
    
    if (amount === undefined || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Valid payment amount is required'
      });
    }
    
    const { id } = req.params;
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);
    const query = isObjectId ? { _id: id } : { invoiceNumber: id.toUpperCase() };
    
    // Get invoice as document (needed for .save())
    const invoice = await Invoice.findOne(query);
    
    if (!invoice) {
      return res.status(404).json({
        success: false,
        error: 'Invoice not found'
      });
    }
    
    // Check if payment exceeds balance due
    if (amount > invoice.balanceDue) {
      return res.status(400).json({
        success: false,
        error: `Payment amount (${amount}) exceeds balance due (${invoice.balanceDue})`
      });
    }
    
    // Get client
    const client = await Client.findById(invoice.client);
    
    // Create payment record
    const payment = new Payment({
      amount,
      paymentDate: paymentDate || new Date(),
      paymentMethod,
      transactionReference,
      client: invoice.client,
      partyName: invoice.partyName,
      mobile: invoice.mobile,
      invoice: invoice._id,
      invoiceNumber: invoice.invoiceNumber,
      paymentType: 'invoice_payment',
      isAllocated: true,
      allocatedAmount: amount,
      remainingAmount: 0,
      recordedBy: req.user._id,
      notes,
      recordedFrom: 'invoice_page'
    });
    
    await payment.save();
    
    // Update invoice
    invoice.advance += amount;
    invoice.balanceDue = invoice.grandTotal - invoice.advance;
    
    // Auto-update payment status
    if (invoice.advance >= invoice.grandTotal) {
      invoice.paymentStatus = 'paid';
    } else if (invoice.advance > 0) {
      invoice.paymentStatus = 'partial';
    }
    
    await invoice.save();
    
    // Update client stats
    if (client) {
      client.totalPaid = (client.totalPaid || 0) + amount;
      client.lastPaymentAmount = amount;
      client.lastPaymentDate = payment.paymentDate;
      client.lastPaymentMethod = paymentMethod;
      await client.save();
    }
    
    // Convert to plain object for response (lean-like performance)
    const invoiceData = invoice.toObject();
    
    // Emit real-time event
    const io = req.app.get('io');
    if (io) {
      io.emit('invoice:payment-recorded', { 
        invoiceId: invoiceData._id,
        invoiceNumber: invoiceData.invoiceNumber,
        advance: invoiceData.advance,
        balanceDue: invoiceData.balanceDue,
        paymentStatus: invoiceData.paymentStatus
      });
      
      io.emit('payment:recorded', {
        payment: payment.toObject(),
        invoice: invoiceData,
        client: client ? client.toObject() : null
      });
    }
    
    res.json({
      success: true,
      data: {
        invoice: invoiceData,
        payment: payment.toObject()
      },
      message: `Payment of ₹${amount} recorded successfully. Balance due: ₹${invoiceData.balanceDue}`
    });
  } catch (error) {
    console.error('Record payment error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Server error'
    });
  }
});

// @route   GET /api/invoices/:id/payments
// @desc    Get all payments for an invoice
// @access  Private
router.get('/:id/payments', async (req, res) => {
  try {
    const { id } = req.params;
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);
    const query = isObjectId ? { _id: id } : { invoiceNumber: id.toUpperCase() };
    
    const invoice = await Invoice.findOne(query).select('_id').lean();
    
    if (!invoice) {
      return res.status(404).json({
        success: false,
        error: 'Invoice not found'
      });
    }
    
    const payments = await Payment.find({ invoice: invoice._id })
      .select('paymentNumber amount paymentDate paymentMethod paymentType transactionReference notes')
      .sort('-paymentDate')
      .populate('recordedBy', 'name username')
      .lean();
    
    res.json({
      success: true,
      data: payments
    });
  } catch (error) {
    console.error('Get invoice payments error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   DELETE /api/invoices/:id
// @desc    Delete invoice permanently (supports both ObjectId and Invoice Number)
// @access  Admin only
router.delete('/:id', adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);
    const query = isObjectId ? { _id: id } : { invoiceNumber: id.toUpperCase() };
    
    // Use lean() for better performance (we only need data, not document methods)
    const invoice = await Invoice.findOne(query).lean();
    
    if (!invoice) {
      return res.status(404).json({
        success: false,
        error: 'Invoice not found'
      });
    }
    
    // Store invoice data for client update and socket event
    const invoiceData = {
      invoiceId: invoice._id,
      invoiceNumber: invoice.invoiceNumber,
      client: invoice.client,
      grandTotal: invoice.grandTotal
    };
    
    // Get Socket.IO instance
    const io = req.app.get('io');
    
    // Update client statistics if client exists
    if (invoice.client) {
      await Client.findByIdAndUpdate(
        invoice.client,
        {
          $inc: { 
            totalOrders: -1, 
            totalSpent: -invoice.grandTotal 
          }
        }
      );
    }
    
    // Delete the invoice (DO NOT restore inventory on deletion)
    await Invoice.findByIdAndDelete(invoice._id);
    
    console.log(`🗑️ Invoice ${invoiceData.invoiceNumber} deleted permanently (inventory NOT restored)`);
    
    // Emit real-time event
    if (io) {
      io.emit('invoice:deleted', { 
        invoiceId: invoiceData.invoiceId,
        invoiceNumber: invoiceData.invoiceNumber
      });
    }
    
    res.json({
      success: true,
      message: 'Invoice deleted successfully',
      data: {
        invoiceNumber: invoiceData.invoiceNumber
      }
    });
  } catch (error) {
    console.error('Delete invoice error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @route   PATCH /api/invoices/:id/cancel
// @desc    Cancel invoice (mark as cancelled without deleting)
// @access  Admin only
router.patch('/:id/cancel', adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);
    const query = isObjectId ? { _id: id } : { invoiceNumber: id.toUpperCase() };
    
    // Get invoice first to access items (use lean() to get plain object)
    const invoice = await Invoice.findOne(query).lean();
    
    if (!invoice) {
      return res.status(404).json({
        success: false,
        error: 'Invoice not found'
      });
    }
    
    // Log invoice items for debugging
    console.log(`📋 Invoice ${invoice.invoiceNumber || invoice._id} has ${invoice.items?.length || 0} items`);
    if (invoice.items && invoice.items.length > 0) {
      invoice.items.forEach((item, index) => {
        console.log(`   Item ${index + 1}: ${item.productName} - Product ID: ${item.product || 'MISSING'} - Qty: ${item.quantity}`);
      });
    }
    
    // Get Socket.IO instance
    const io = req.app.get('io');
    
    // Restore inventory for invoice items (if not already cancelled)
    let inventoryResult = { success: true, affectedProducts: [] };
    if (invoice.deliveryStatus !== 'cancelled') {
      console.log(`🔄 Cancelling invoice ${invoice.invoiceNumber || invoice._id} - restoring inventory...`);
      inventoryResult = await restoreInventory(invoice.items, io);
      
      if (!inventoryResult.success) {
        console.error('❌ Inventory restoration failed:', inventoryResult.error);
      } else {
        const itemsWithProducts = invoice.items.filter(item => item.product?._id || item.product).length;
        const itemsWithoutProducts = invoice.items.length - itemsWithProducts;
        
        if (itemsWithoutProducts > 0) {
          console.warn(`⚠️ ${itemsWithoutProducts} items without product IDs - inventory not restored for these`);
        }
        
        if (inventoryResult.affectedProducts.length > 0) {
          // Emit inventory changes summary
          if (io) {
            io.emit('invoice:inventory-restored', {
              invoiceId: invoice._id,
              invoiceNumber: invoice.invoiceNumber,
              affectedProducts: inventoryResult.affectedProducts
            });
          }
        } else {
          console.warn(`⚠️ No inventory was restored for cancelled invoice. Check invoice items have product references.`);
        }
      }
    } else {
      console.log(`ℹ️ Invoice ${invoice.invoiceNumber || invoice._id} is already cancelled - skipping inventory restoration`);
    }
    
    // Update invoice status to cancelled (need to use findOneAndUpdate since we used lean())
    const updatedInvoice = await Invoice.findOneAndUpdate(
      query,
      { deliveryStatus: 'cancelled' },
      { new: true }
    ).lean();
    
    // Emit real-time event
    if (io) {
      io.emit('invoice:cancelled', { 
        invoiceId: updatedInvoice._id,
        invoiceNumber: updatedInvoice.invoiceNumber
      });
    }
    
    res.json({
      success: true,
      message: 'Invoice cancelled successfully',
      data: updatedInvoice,
      inventoryRestored: inventoryResult.success,
      affectedProducts: inventoryResult.affectedProducts || []
    });
  } catch (error) {
    console.error('Cancel invoice error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

module.exports = router;

