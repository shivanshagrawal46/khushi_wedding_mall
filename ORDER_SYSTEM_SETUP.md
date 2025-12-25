# 🚀 Order System - Quick Setup Guide

## Installation Steps

### 1. Install Redis (Required for optimal performance)

#### Windows
```bash
# Download from: https://github.com/microsoftarchive/redis/releases
# Or use WSL
wsl
sudo apt-get install redis-server
```

#### Linux
```bash
sudo apt-get update
sudo apt-get install redis-server
sudo systemctl start redis
sudo systemctl enable redis
```

#### Mac
```bash
brew install redis
brew services start redis
```

### 2. Install Node Dependencies
```bash
npm install
```

This will install:
- `redis` - Redis client
- All existing dependencies

### 3. Update .env File
```env
# MongoDB
MONGODB_URI=mongodb://localhost:27017/khushi_wedding_mall

# Redis (optional but recommended)
REDIS_URL=redis://localhost:6379

# Server
PORT=3002
HOST=0.0.0.0
NETWORK_IP=192.168.1.10

# JWT
JWT_SECRET=your_secret_key_here
JWT_EXPIRES_IN=7d

# Environment
NODE_ENV=development
```

### 4. Start Services

#### Terminal 1: Start Redis
```bash
redis-server
```

#### Terminal 2: Start MongoDB
```bash
mongod
```

#### Terminal 3: Start Node Server
```bash
npm run dev
```

---

## ✅ Verification

### Check Redis Connection
You should see in server console:
```
✅ Redis: Connected and ready
```

### Check Server
You should see:
```
╔═══════════════════════════════════════════════════════════╗
║   🎪 Khushi Wedding Mall CRM Server                       ║
║   ─────────────────────────────────────────────────────   ║
║   Server running on: http://localhost:3002              ║
║   Network access: http://192.168.1.10:3002              ║
║   Environment: development                               ║
║   Socket.IO: ✅ Enabled (Real-time Updates)               ║
╚═══════════════════════════════════════════════════════════╝
```

---

## 🧪 Test the System

### 1. Create an Order
```bash
POST http://192.168.1.10:3002/api/orders
Authorization: Bearer <token>
Content-Type: application/json

{
  "partyName": "Test Customer",
  "mobile": "9999999999",
  "items": [
    {
      "product": "product-id-1",
      "productName": "Chairs",
      "price": 50,
      "quantity": 25
    },
    {
      "product": "product-id-2",
      "productName": "Carpets",
      "price": 200,
      "quantity": 32
    }
  ],
  "expectedDeliveryDate": "2024-12-25",
  "localFreight": 500,
  "gstPercent": 18
}
```

### 2. Create Partial Delivery (10 chairs on Dec 23)
```bash
POST http://192.168.1.10:3002/api/orders/{order-id}/deliveries
Authorization: Bearer <token>
Content-Type: application/json

{
  "items": [
    {
      "product": "product-id-1",
      "productName": "Chairs",
      "price": 50,
      "quantity": 10
    }
  ],
  "deliveryDate": "2024-12-23"
}
```

### 3. Generate Invoice for Delivery
```bash
POST http://192.168.1.10:3002/api/orders/deliveries/{delivery-id}/invoice
Authorization: Bearer <token>
Content-Type: application/json

{
  "advance": 1000
}
```

### 4. Check Remaining Quantities (from Redis)
```bash
GET http://192.168.1.10:3002/api/orders/{order-id}/remaining
Authorization: Bearer <token>
```

### 5. Check Order Progress (from Redis)
```bash
GET http://192.168.1.10:3002/api/orders/{order-id}/progress
Authorization: Bearer <token>
```

---

## 📊 What's Different from Invoice System?

### Old System (Invoice)
- ❌ Single delivery per invoice
- ❌ No partial delivery tracking
- ❌ No remaining quantity tracking
- ❌ No Redis caching

### New System (Order)
- ✅ Multiple deliveries per order
- ✅ Partial delivery tracking
- ✅ Remaining quantities in Redis
- ✅ Per-delivery invoicing
- ✅ Real-time progress tracking
- ✅ Optimized with Redis cache
- ✅ Fast API responses

---

## 🎯 Key Workflow

1. **Create Order** → Inventory reduced, Redis cache initialized
2. **Create Delivery (Partial)** → Order updated, quantities tracked
3. **Generate Invoice** → Invoice created for that delivery
4. **Repeat Steps 2-3** → Until all items delivered
5. **Order Complete** → Status auto-updates to "completed"

---

## 🔍 Monitoring

### Check Redis Keys
```bash
redis-cli
> KEYS order:*
> KEYS dashboard:*
> GET order:{orderId}:remaining
```

### Check Order Status
```bash
GET http://192.168.1.10:3002/api/orders/{order-id}
```

### Check Dashboard Stats
```bash
GET http://192.168.1.10:3002/api/orders/stats
```

---

## 🚨 Troubleshooting

### Redis Not Connecting
- Check if Redis is running: `redis-cli ping` (should return PONG)
- Check REDIS_URL in .env
- System will continue without Redis (slower but functional)

### Order Not Found
- Check order ID format (MongoDB ObjectId or orderNumber)
- Verify order exists in database

### Delivery Quantity Error
- Check remaining quantities: `GET /api/orders/:id/remaining`
- Ensure delivery quantity <= remaining quantity

### Cache Not Updating
- Cache invalidates automatically on updates
- Manual refresh: Delete Redis keys or restart server

---

## 📚 Documentation

- **ORDER_SYSTEM_ARCHITECTURE.md** - Complete architecture details
- **API_DOCUMENTATION.md** - Full API reference (update needed)
- **INVENTORY_SYSTEM.md** - Inventory management details

---

## 🎉 You're Ready!

The system is now ready for production use. All APIs are optimized, cached, and real-time enabled.

**Next Steps:**
1. Test with your frontend
2. Monitor Redis memory usage
3. Adjust cache TTLs if needed
4. Scale Redis if handling high traffic

**Happy coding!** 🚀


