const express = require('express');
const Colour = require('../models/Colour');
const { protect, adminOnly } = require('../middleware/auth');

const router = express.Router();

router.use(protect);

// @route   GET /api/colours
// @desc    Get all colours (for Flutter dropdown in Parda order creation)
// @access  Private
router.get('/', async (req, res) => {
  try {
    const { active = 'true' } = req.query;
    const query = active !== 'all' ? { isActive: active === 'true' } : {};
    
    const colours = await Colour.find(query)
      .sort('name')
      .lean();
    
    res.json({ success: true, data: colours });
  } catch (error) {
    console.error('Get colours error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// @route   POST /api/colours
// @desc    Create a new colour with price
// @access  Admin only
router.post('/', adminOnly, async (req, res) => {
  try {
    const { name, price } = req.body;
    
    if (!name) {
      return res.status(400).json({ success: false, error: 'Colour name is required' });
    }
    if (price === undefined || price < 0) {
      return res.status(400).json({ success: false, error: 'Valid price is required' });
    }
    
    const colour = await Colour.create({ name, price });
    
    const io = req.app.get('io');
    if (io) io.emit('colour:created', { colour });
    
    res.status(201).json({ success: true, data: colour });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, error: 'Colour with this name already exists' });
    }
    console.error('Create colour error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// @route   PUT /api/colours/:id
// @desc    Update colour name/price
// @access  Admin only
router.put('/:id', adminOnly, async (req, res) => {
  try {
    const { name, price, isActive } = req.body;
    
    const colour = await Colour.findByIdAndUpdate(
      req.params.id,
      { name, price, isActive },
      { new: true, runValidators: true }
    ).lean();
    
    if (!colour) {
      return res.status(404).json({ success: false, error: 'Colour not found' });
    }
    
    const io = req.app.get('io');
    if (io) io.emit('colour:updated', { colour });
    
    res.json({ success: true, data: colour });
  } catch (error) {
    console.error('Update colour error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// @route   DELETE /api/colours/:id
// @desc    Soft delete colour
// @access  Admin only
router.delete('/:id', adminOnly, async (req, res) => {
  try {
    const colour = await Colour.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true }
    ).lean();
    
    if (!colour) {
      return res.status(404).json({ success: false, error: 'Colour not found' });
    }
    
    const io = req.app.get('io');
    if (io) io.emit('colour:deleted', { colourId: colour._id });
    
    res.json({ success: true, message: 'Colour deleted' });
  } catch (error) {
    console.error('Delete colour error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;
