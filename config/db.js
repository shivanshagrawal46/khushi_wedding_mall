const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    // OPTIMIZED CONNECTION OPTIONS FOR HIGH PERFORMANCE
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      maxPoolSize: 100,        // Increased for high concurrency (was 50)
      minPoolSize: 20,         // Increased for better connection reuse (was 10)
      maxIdleTimeMS: 30000,    // Close idle connections after 30s
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 10000,
      family: 4,               // Use IPv4 (faster DNS resolution)
      // Performance optimizations
      autoIndex: process.env.NODE_ENV !== 'production', // Disable in prod
      bufferCommands: false,   // Fail fast if not connected
      compressors: 'zlib'      // Enable compression for large data transfer
    });

    console.log(`MongoDB Connected: ${conn.connection.host}`);
    
    // Set readConcern and writeConcern for better performance
    mongoose.set('strictQuery', true);
    
    // Disable debug in production (performance impact)
    if (process.env.NODE_ENV === 'development') {
      mongoose.set('debug', true);
    }

    return conn;
  } catch (error) {
    console.error(`MongoDB Connection Error: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;

