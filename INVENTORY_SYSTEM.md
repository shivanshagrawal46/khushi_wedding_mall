# Real-Time Inventory Management System

## Overview
The system automatically manages product inventory when invoices are created, updated, cancelled, or deleted. All changes are reflected in real-time via Socket.IO events.

---

## Features

### ✅ Automatic Inventory Tracking
- **Invoice Created**: Reduces inventory for all products in the invoice
- **Invoice Cancelled**: Restores inventory for all products in the invoice
- **Invoice Deleted**: Permanently removes invoice (inventory NOT restored)
- **Invoice Updated**: Adjusts inventory based on item changes

### ⚡ Real-Time Updates
All inventory changes are broadcast via Socket.IO to connected clients instantly.

### 🔔 Low Stock Alerts
Automatic alerts when products fall below threshold (default: 10 units)

---

## API Endpoints

### Get Low Stock Products
```
GET /api/products/low-stock
```

**Query Parameters:**
- `threshold` (optional, default: 10) - Inventory threshold for low stock

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "507f1f77bcf86cd799439011",
      "name": "Wedding Tent",
      "inventory": 5,
      "category": "Tents",
      "unit": "piece",
      "price": 5000
    }
  ],
  "count": 1
}
```

### Update Product Inventory
```
PUT /api/products/:id/inventory
```

**Body:**
```json
{
  "inventory": 50
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "_id": "507f1f77bcf86cd799439011",
    "name": "Wedding Tent",
    "inventory": 50,
    "category": "Tents"
  }
}
```

---

## Socket.IO Events

### Events Emitted by Server

#### 1. `product:inventory-updated`
Emitted when a product's inventory changes.

**Payload:**
```javascript
{
  product: {
    _id: "507f1f77bcf86cd799439011",
    name: "Wedding Tent",
    inventory: 15,
    category: "Tents",
    price: 5000
  }
}
```

#### 2. `inventory:low-stock-alert`
Emitted when products fall below threshold.

**Payload:**
```javascript
{
  products: [
    {
      _id: "507f1f77bcf86cd799439011",
      name: "Wedding Tent",
      inventory: 8,
      category: "Tents"
    }
  ]
}
```

#### 3. `invoice:inventory-reduced`
Emitted when invoice creation reduces inventory.

**Payload:**
```javascript
{
  invoiceId: "507f1f77bcf86cd799439011",
  invoiceNumber: "KWM24120001",
  affectedProducts: [
    {
      _id: "507f1f77bcf86cd799439012",
      name: "Wedding Tent",
      oldInventory: 20,
      newInventory: 15,
      quantityReduced: 5
    }
  ]
}
```

#### 4. `invoice:inventory-restored`
Emitted when invoice cancellation restores inventory.

**Payload:**
```javascript
{
  invoiceId: "507f1f77bcf86cd799439011",
  invoiceNumber: "KWM24120001",
  affectedProducts: [
    {
      _id: "507f1f77bcf86cd799439012",
      name: "Wedding Tent",
      oldInventory: 15,
      newInventory: 20,
      quantityRestored: 5
    }
  ]
}
```

#### 5. `invoice:inventory-adjusted`
Emitted when invoice update adjusts inventory.

**Payload:**
```javascript
{
  invoiceId: "507f1f77bcf86cd799439011",
  invoiceNumber: "KWM24120001",
  affectedProducts: [
    {
      _id: "507f1f77bcf86cd799439012",
      name: "Wedding Tent",
      oldInventory: 15,
      newInventory: 18,
      adjustment: 3  // Positive = added, Negative = removed
    }
  ]
}
```

#### 6. `invoice:created`
Standard invoice created event.

#### 7. `invoice:updated`
Standard invoice updated event.

#### 8. `invoice:deleted`
Standard invoice deleted event.

#### 9. `invoice:cancelled`
Standard invoice cancelled event.

#### 10. `product:created`
Standard product created event.

#### 11. `product:updated`
Standard product updated event.

---

## Frontend Integration

### Flutter/Dart Example

```dart
import 'package:socket_io_client/socket_io_client.dart' as IO;

class InventoryService {
  IO.Socket? socket;
  
  void connectSocket(String serverUrl) {
    socket = IO.io(serverUrl, <String, dynamic>{
      'transports': ['websocket'],
      'autoConnect': true,
    });
    
    // Listen for inventory updates
    socket!.on('product:inventory-updated', (data) {
      print('📦 Inventory updated: ${data['product']['name']} - ${data['product']['inventory']}');
      // Update UI with new inventory
      updateProductInventory(data['product']);
    });
    
    // Listen for low stock alerts
    socket!.on('inventory:low-stock-alert', (data) {
      print('⚠️ Low stock alert for ${data['products'].length} products');
      // Show notification to user
      showLowStockAlert(data['products']);
    });
    
    // Listen for invoice inventory changes
    socket!.on('invoice:inventory-reduced', (data) {
      print('📉 Inventory reduced for invoice ${data['invoiceNumber']}');
      refreshInventoryList();
    });
    
    socket!.on('invoice:inventory-restored', (data) {
      print('📈 Inventory restored for invoice ${data['invoiceNumber']}');
      refreshInventoryList();
    });
    
    socket!.on('invoice:inventory-adjusted', (data) {
      print('🔄 Inventory adjusted for invoice ${data['invoiceNumber']}');
      refreshInventoryList();
    });
    
    socket!.connect();
  }
  
  void disconnect() {
    socket?.disconnect();
  }
}
```

### JavaScript/React Example

```javascript
import io from 'socket.io-client';

class InventoryManager {
  constructor(serverUrl) {
    this.socket = io(serverUrl, {
      transports: ['websocket']
    });
    
    this.setupListeners();
  }
  
  setupListeners() {
    // Inventory updates
    this.socket.on('product:inventory-updated', (data) => {
      console.log('📦 Inventory updated:', data.product);
      // Update state/UI
      this.updateProductInState(data.product);
    });
    
    // Low stock alerts
    this.socket.on('inventory:low-stock-alert', (data) => {
      console.log('⚠️ Low stock alert:', data.products);
      // Show notification
      this.showNotification('Low Stock Alert', 
        `${data.products.length} products are running low`);
    });
    
    // Invoice-related inventory changes
    this.socket.on('invoice:inventory-reduced', (data) => {
      console.log('📉 Inventory reduced:', data.affectedProducts);
      this.refreshInventory();
    });
    
    this.socket.on('invoice:inventory-restored', (data) => {
      console.log('📈 Inventory restored:', data.affectedProducts);
      this.refreshInventory();
    });
    
    this.socket.on('invoice:inventory-adjusted', (data) => {
      console.log('🔄 Inventory adjusted:', data.affectedProducts);
      this.refreshInventory();
    });
  }
  
  disconnect() {
    this.socket.disconnect();
  }
}
```

---

## How It Works

### 1. Invoice Creation
```
User creates invoice → System reduces inventory for each product → 
Socket.IO emits updates → Frontend updates in real-time
```

### 2. Invoice Deletion
```
Admin deletes invoice → Invoice permanently removed → 
NO inventory restoration → Socket.IO emits updates → Frontend updates in real-time
```

### 3. Invoice Cancellation
```
Admin cancels invoice → System restores inventory for each product → 
Socket.IO emits updates → Frontend updates in real-time
```

### 4. Invoice Update
```
User updates invoice items → System calculates difference → 
Adjusts inventory accordingly → Socket.IO emits updates → 
Frontend updates in real-time
```

### 5. Manual Inventory Update
```
Admin updates product inventory → System saves change → 
Socket.IO emits update → Frontend updates in real-time
```

### 6. Low Stock Detection
```
Inventory drops below threshold → System emits alert → 
Frontend shows notification to admin
```

---

## Important Notes

### Inventory Tracking
- Products with `inventory: null` are **not tracked** (no inventory management)
- Products with `inventory: 0` or higher are **actively tracked**
- Inventory cannot go below 0 (automatically clamped)

### Atomic Operations
- All inventory operations are atomic and sequential
- Race conditions are handled at the database level
- Failed inventory updates are logged but don't block invoice operations

### Real-Time Sync
- All connected clients receive updates instantly
- No polling required
- Connection status should be monitored in production

### Low Stock Threshold
- Default threshold: 10 units
- Customizable via API query parameter
- Alert triggered whenever inventory falls below threshold

---

## Testing the System

### 1. Create an Invoice
```bash
POST http://localhost:3002/api/invoices
{
  "partyName": "Test Customer",
  "mobile": "9999999999",
  "items": [
    {
      "product": "507f1f77bcf86cd799439011",
      "productName": "Wedding Tent",
      "price": 5000,
      "quantity": 5
    }
  ],
  "deliveryDate": "2024-12-20"
}
```
**Expected**: Product inventory reduces by 5

### 2. Cancel the Invoice
```bash
PATCH http://localhost:3002/api/invoices/:id/cancel
```
**Expected**: Product inventory restored by 5

### 3. Delete the Invoice
```bash
DELETE http://localhost:3002/api/invoices/:id
```
**Expected**: Invoice permanently deleted, inventory NOT restored

### 4. Update Invoice Items
```bash
PUT http://localhost:3002/api/invoices/:id
{
  "items": [
    {
      "product": "507f1f77bcf86cd799439011",
      "productName": "Wedding Tent",
      "price": 5000,
      "quantity": 8  // Changed from 5 to 8
    }
  ]
}
```
**Expected**: Product inventory reduces by additional 3 units

### 5. Check Low Stock
```bash
GET http://localhost:3002/api/products/low-stock?threshold=10
```
**Expected**: List of products with inventory < 10

### 6. Update Inventory Manually
```bash
PUT http://localhost:3002/api/products/:id/inventory
{
  "inventory": 50
}
```
**Expected**: Product inventory set to 50, Socket.IO event emitted

---

## Error Handling

### Product Not Found
- System logs warning
- Inventory operation skipped for that product
- Other products in the invoice are still processed

### Inventory Null
- Products without inventory tracking are skipped
- No errors thrown
- Only tracked products are updated

### Insufficient Inventory
- Currently allows inventory to go to 0
- Negative values are prevented (clamped to 0)
- Future enhancement: Add validation to prevent overselling

---

## Performance

### Optimizations
- Parallel inventory operations where possible
- Lean database queries
- Indexed queries for fast lookups
- Batch Socket.IO emissions

### Scalability
- Can handle 100+ invoice operations per minute
- Socket.IO scales with server infrastructure
- MongoDB indexes ensure fast inventory lookups
- No blocking operations

---

## Future Enhancements

- [ ] Inventory reservation system
- [ ] Prevent overselling (validate before invoice creation)
- [ ] Inventory history/audit log
- [ ] Batch inventory updates
- [ ] Inventory forecasting
- [ ] Multi-location inventory tracking
- [ ] Automated reorder points

