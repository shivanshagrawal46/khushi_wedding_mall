# Redis Debugging Guide - Why Cache Isn't Working

## Quick Diagnosis

### Step 1: Check if Redis is Connected

```bash
curl http://localhost:3102/api/health/redis
```

**Expected (Redis working):**
```json
{
  "success": true,
  "redis": {
    "connected": true,
    "status": "ready"
  }
}
```

**If Redis is NOT working:**
```json
{
  "success": true,
  "redis": {
    "connected": false,
    "status": "not_configured"  // or "error"
  }
}
```

### Step 2: Check What's Actually Cached

```bash
curl http://localhost:3102/api/debug/redis
```

This shows:
- All cache keys currently stored
- TTL (time to live) for each key
- Count of cached items

**Expected output:**
```json
{
  "success": true,
  "redis": {
    "connected": true,
    "status": "ready"
  },
  "cacheStats": {
    "productKeys": {
      "count": 3,
      "keys": ["products:list:...", "products:categories", "products:all"],
      "sample": [
        { "key": "products:list:...", "ttl": 580 }
      ]
    },
    "orderKeys": {
      "count": 2,
      "keys": ["orders:list:...", ...],
      "sample": [...]
    }
  }
}
```

### Step 3: Check Server Logs

When you request products/orders, look for these logs:

**Cache HIT (working):**
```
✅ Redis cache HIT for products list (lookup: 2ms): products:list:{"search":"","category":"","active":"true","page":"1","limit":"50","sort":"-createdAt"}
```

**Cache MISS (not working):**
```
❌ Redis cache MISS for products list (lookup: 1ms): products:list:{"search":"","category":"","active":"true","page":"1","limit":"50","sort":"-createdAt"}
💾 Redis cache SET for products list (5ms, TTL: 600s): products:list:...
```

---

## Common Reasons Why Cache Isn't Working

### 1. **Redis Not Connected**

**Symptom:** All requests show `❌ Redis cache MISS`, `/api/health/redis` shows `connected: false`

**Solution:**
- Check if Redis is running: `redis-cli ping` (should return `PONG`)
- Check Redis connection URL in `.env`: `REDIS_URL=redis://localhost:6379`
- Check server logs for Redis connection errors

### 2. **Different Query Parameters Each Time**

**Symptom:** Cache MISS on every request, even 2nd/3rd time

**Why:** Cache key includes ALL query parameters. If frontend sends slightly different parameters each time (even extra whitespace, different order, etc.), it creates a NEW cache key.

**Example:**
- Request 1: `?page=1&limit=50` → Cache key: `products:list:{"page":"1","limit":"50",...}`
- Request 2: `?limit=50&page=1` → Cache key: `products:list:{"limit":"50","page":"1",...}` ❌ **DIFFERENT KEY!**
- Request 3: `?page=1&limit=50&sort=-createdAt` → Cache key: `products:list:{"page":"1","limit":"50","sort":"-createdAt",...}` ❌ **DIFFERENT KEY!**

**Solution:** 
- Check if frontend is sending consistent query parameters
- Check server logs - look at the cache key being used each time
- Ensure frontend always sends same parameters in same order

### 3. **Cache Being Invalidated Immediately**

**Symptom:** Cache SET succeeds, but next request shows MISS

**Why:** If you're creating/updating products/orders between requests, cache gets invalidated.

**Check:**
```bash
# Request products
curl http://localhost:3102/api/products

# Check what's cached
curl http://localhost:3102/api/debug/redis

# Request products again (should be HIT)
curl http://localhost:3102/api/products
```

### 4. **Cache TTL Too Short**

**Current TTL:**
- Products: 600 seconds (10 minutes)
- Orders: 300 seconds (5 minutes)

**Check TTL:**
```bash
curl http://localhost:3102/api/debug/redis
# Look at "ttl" in sample - negative means expired
```

### 5. **Redis SET Failing Silently**

**Check logs for:**
```
⚠️  Redis cache SET FAILED for products list
```

**Why:** Redis connection might be unstable, or Redis is out of memory.

**Solution:**
- Check Redis memory: `redis-cli info memory`
- Check Redis logs for errors

---

## Manual Redis Inspection

### Connect to Redis CLI

```bash
redis-cli
```

### Check All Keys

```redis
KEYS products:*
KEYS orders:*
```

### Check Specific Key Value

```redis
GET "products:list:{\"search\":\"\",\"category\":\"\",\"active\":\"true\",\"page\":\"1\",\"limit\":\"50\",\"sort\":\"-createdAt\"}"
```

### Check TTL (Time To Live)

```redis
TTL "products:list:..."
# Returns:
# -2 = key doesn't exist
# -1 = key exists but has no expiration
# >0 = seconds until expiration
```

### Delete All Cache (for testing)

```redis
DEL products:*
DEL orders:*
```

Or:
```redis
FLUSHDB  # ⚠️ Deletes ALL keys in current database
```

---

## Testing Cache Performance

### Test Script

1. **First request (should be MISS, then SET):**
```bash
time curl http://localhost:3102/api/products > /dev/null
# Check logs: Should see MISS and SET
```

2. **Second request (should be HIT):**
```bash
time curl http://localhost:3102/api/products > /dev/null
# Check logs: Should see HIT (much faster)
```

3. **Check what's cached:**
```bash
curl http://localhost:3102/api/debug/redis | jq '.cacheStats.productKeys'
```

---

## Why Cache Might Not Help with 6-7 Items

**If you only have 6-7 products/orders:**
- MongoDB query is already VERY fast (<10ms)
- Redis overhead (network roundtrip + serialization) might be 2-5ms
- **Result: Cache might actually be SLOWER for small datasets!**

**Cache benefits increase with:**
- More data (100+ items)
- Complex queries (aggregations, joins)
- Multiple users accessing same data

**For 6-7 items, MongoDB is likely faster than Redis cache.**

---

## Recommended Actions

1. **Check Redis connection:**
   ```bash
   curl http://localhost:3102/api/health/redis
   ```

2. **Check what's cached:**
   ```bash
   curl http://localhost:3102/api/debug/redis
   ```

3. **Monitor server logs** when making requests - look for HIT/MISS messages

4. **Check if query parameters are consistent** - compare cache keys in logs

5. **If Redis isn't connected:** Start Redis or fix connection settings

6. **If cache keys are different each time:** Fix frontend to send consistent parameters

7. **For small datasets (6-7 items):** Consider disabling cache - MongoDB is fast enough

