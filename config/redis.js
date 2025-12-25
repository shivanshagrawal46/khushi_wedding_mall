const { createClient } = require('redis');

let redisClient = null;

const connectRedis = async () => {
  // Check if Redis is disabled via environment variable
  if (process.env.REDIS_ENABLED === 'false') {
    console.log('ℹ️  Redis is disabled via REDIS_ENABLED=false');
    return null;
  }

  try {
    redisClient = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      socket: {
        connectTimeout: 5000, // 5 second timeout
        reconnectStrategy: (retries) => {
          // Stop reconnecting after 3 attempts (was 10)
          if (retries > 3) {
            console.warn('⚠️  Redis: Stopping reconnection attempts after 3 tries');
            console.warn('⚠️  Continuing without Redis cache (some features may be slower)');
            redisClient = null; // Clear client reference
            return false; // Stop reconnecting
          }
          return Math.min(retries * 200, 2000); // Faster backoff
        }
      }
    });

    redisClient.on('error', (err) => {
      // Only log first few errors to avoid spam
      if (!redisClient._errorLogged) {
        console.error('❌ Redis Client Error:', err.message);
        redisClient._errorLogged = true;
      }
    });

    redisClient.on('connect', () => {
      console.log('🔌 Redis: Connecting...');
      redisClient._errorLogged = false; // Reset error flag on reconnect
    });

    redisClient.on('ready', () => {
      console.log('✅ Redis: Connected and ready');
      redisClient._errorLogged = false;
    });

    redisClient.on('reconnecting', () => {
      // Suppress reconnecting messages after first attempt
      if (!redisClient._reconnectLogged) {
        console.log('🔄 Redis: Attempting to reconnect...');
        redisClient._reconnectLogged = true;
      }
    });

    // Set connection timeout
    const connectPromise = redisClient.connect();
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Redis connection timeout')), 5000);
    });

    await Promise.race([connectPromise, timeoutPromise]);
    return redisClient;
  } catch (error) {
    console.warn('⚠️  Redis connection failed:', error.message);
    console.warn('⚠️  Continuing without Redis cache (some features may be slower)');
    console.warn('💡 To disable Redis warnings, set REDIS_ENABLED=false in .env');
    redisClient = null;
    return null;
  }
};

const getRedisClient = () => {
  return redisClient;
};

// Helper functions for common operations
const redisHelpers = {
  // Get cached value
  async get(key) {
    if (!redisClient) return null;
    try {
      const value = await redisClient.get(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      console.error(`Redis GET error for key ${key}:`, error);
      return null;
    }
  },

  // Set cached value with optional TTL (time to live in seconds)
  async set(key, value, ttl = null) {
    if (!redisClient) return false;
    try {
      const stringValue = JSON.stringify(value);
      if (ttl) {
        await redisClient.setEx(key, ttl, stringValue);
      } else {
        await redisClient.set(key, stringValue);
      }
      return true;
    } catch (error) {
      console.error(`Redis SET error for key ${key}:`, error);
      return false;
    }
  },

  // Delete cached value
  async del(key) {
    if (!redisClient) return false;
    try {
      await redisClient.del(key);
      return true;
    } catch (error) {
      console.error(`Redis DEL error for key ${key}:`, error);
      return false;
    }
  },

  // Increment counter
  async incr(key, by = 1) {
    if (!redisClient) return null;
    try {
      return await redisClient.incrBy(key, by);
    } catch (error) {
      console.error(`Redis INCR error for key ${key}:`, error);
      return null;
    }
  },

  // Decrement counter
  async decr(key, by = 1) {
    if (!redisClient) return null;
    try {
      return await redisClient.decrBy(key, by);
    } catch (error) {
      console.error(`Redis DECR error for key ${key}:`, error);
      return null;
    }
  },

  // Set lock (for preventing concurrent operations)
  // Returns true if Redis not available (allows operation to proceed without locking)
  async setLock(key, ttl = 30) {
    if (!redisClient) {
      // Redis not available - allow operation (no locking protection)
      return true;
    }
    try {
      const result = await redisClient.setNX(key, '1');
      if (result) {
        await redisClient.expire(key, ttl);
      }
      return result;
    } catch (error) {
      console.error(`Redis LOCK error for key ${key}:`, error);
      // On error, allow operation to proceed (fail open)
      return true;
    }
  },

  // Release lock
  // Always succeeds if Redis not available
  async releaseLock(key) {
    if (!redisClient) {
      // Redis not available - no lock to release
      return true;
    }
    try {
      await redisClient.del(key);
      return true;
    } catch (error) {
      console.error(`Redis UNLOCK error for key ${key}:`, error);
      // Always return true on release (don't fail if unlock fails)
      return true;
    }
  },

  // Get multiple keys
  async mGet(keys) {
    if (!redisClient || !keys.length) return [];
    try {
      const values = await redisClient.mGet(keys);
      return values.map(v => v ? JSON.parse(v) : null);
    } catch (error) {
      console.error('Redis MGET error:', error);
      return [];
    }
  },

  // Delete multiple keys
  async mDel(keys) {
    if (!redisClient || !keys.length) return false;
    try {
      await redisClient.del(keys);
      return true;
    } catch (error) {
      console.error('Redis MDEL error:', error);
      return false;
    }
  }
};

module.exports = {
  connectRedis,
  getRedisClient,
  ...redisHelpers
};

