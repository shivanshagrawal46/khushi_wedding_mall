require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/db');
const { connectRedis, getStatus } = require('./config/redis');

// Route imports
const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/products');
const employeeRoutes = require('./routes/employees');
const invoiceRoutes = require('./routes/invoices');
const orderRoutes = require('./routes/orders');
const clientRoutes = require('./routes/clients');
const analyticsRoutes = require('./routes/analytics');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3102;

// Connect to MongoDB
connectDB();

// Connect to Redis (non-blocking, optional)
// System works fine without Redis, just slower
if (process.env.REDIS_ENABLED !== 'false') {
  connectRedis().catch(() => {
    // Error already logged in connectRedis
  });
} else {
  console.log('ℹ️  Redis disabled via environment variable');
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);
  
  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
});

// Make io accessible in routes
app.set('io', io);

// Security middleware
app.use(helmet());

// Compression for faster response
app.use(compression());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 1000 requests per windowMs
  message: {
    success: false,
    error: 'Too many requests, please try again later'
  }
});
app.use('/api/', limiter);

// Stricter rate limit for auth routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // 20 login attempts per 15 minutes
  message: {
    success: false,
    error: 'Too many login attempts, please try again later'
  }
});
app.use('/api/auth/login', authLimiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files (uploaded images)
app.use('/uploads', express.static('uploads'));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/categories', require('./routes/categories'));
app.use('/api/products', productRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/analytics', analyticsRoutes);

// Health check route
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Redis status route
app.get('/api/health/redis', async (req, res) => {
  const redisStatus = await getStatus();
  res.json({
    success: true,
    redis: redisStatus,
    timestamp: new Date().toISOString()
  });
});

// Redis debug route (to check what's cached)
app.get('/api/debug/redis', async (req, res) => {
  try {
    const { getAllKeys, getTTL, getStatus } = require('./config/redis');
    
    const status = await getStatus();
    
    if (!status.connected) {
      return res.json({
        success: false,
        message: 'Redis not connected',
        status
      });
    }
    
    // Get all product cache keys
    const productKeys = await getAllKeys('products:*');
    const orderKeys = await getAllKeys('orders:*');
    
    // Get TTL for first few keys as examples
    const productKeyDetails = await Promise.all(
      productKeys.slice(0, 5).map(async (key) => ({
        key,
        ttl: await getTTL(key)
      }))
    );
    
    const orderKeyDetails = await Promise.all(
      orderKeys.slice(0, 5).map(async (key) => ({
        key,
        ttl: await getTTL(key)
      }))
    );
    
    res.json({
      success: true,
      redis: status,
      cacheStats: {
        productKeys: {
          count: productKeys.length,
          keys: productKeys,
          sample: productKeyDetails
        },
        orderKeys: {
          count: orderKeys.length,
          keys: orderKeys,
          sample: orderKeyDetails
        },
        totalKeys: productKeys.length + orderKeys.length
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Root route
app.get('/', (req, res) => {
  res.json({
    message: 'Khushi Wedding Mall CRM API',
    version: '1.0.0',
    status: 'running',
      endpoints: {
        auth: '/api/auth',
        products: '/api/products',
        employees: '/api/employees',
        invoices: '/api/invoices',
        orders: '/api/orders',
        clients: '/api/clients',
        analytics: '/api/analytics',
        health: '/api/health'
      }
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    path: req.path
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  
  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map(e => e.message);
    return res.status(400).json({
      success: false,
      error: messages.join(', ')
    });
  }
  
  // Mongoose duplicate key error
  if (err.code === 11000) {
    return res.status(400).json({
      success: false,
      error: 'Duplicate field value entered'
    });
  }
  
  // Mongoose cast error (invalid ObjectId)
  if (err.name === 'CastError') {
    return res.status(400).json({
      success: false,
      error: 'Invalid ID format'
    });
  }
  
  res.status(err.statusCode || 500).json({
    success: false,
    error: err.message || 'Server Error'
  });
});

// Get local network IP address
const os = require('os');
function getLocalIP() {
  // Use configured IP or auto-detect
  if (process.env.NETWORK_IP) {
    return process.env.NETWORK_IP;
  }
  
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal (loopback) and non-IPv4 addresses
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const localIP = process.env.NETWORK_IP || '192.168.1.10'; // Use configured IP or default to 192.168.1.10

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

module.exports = app;
