# 🎪 Khushi Wedding Mall - CRM API Documentation

## Overview

A complete CRM (Customer Relationship Management) system for **Khushi Wedding Mall** - a Tent & Decoration rental business. This API handles clients, products, invoices, employees, and authentication.

**Base URL:** `http://localhost:3002`

---

## 🔑 Default Login Credentials

### Admin Account
| Field | Value |
|-------|-------|
| Username | `admin` |
| Password | `Radhika@Khushbu@2004` |
| Role | Admin (Full Access) |

### Employee Account
| Field | Value |
|-------|-------|
| Username | `employee` |
| Password | `password@123` |
| Role | Employee (Limited Access) |

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Create `.env` file (already created):
```env
PORT=3000
NODE_ENV=development
MONGODB_URI=mongodb://localhost:27017/khushi_wedding_mall
JWT_SECRET=KhushiWeddingMall@SecretKey#2024!SuperSecure
JWT_EXPIRES_IN=7d
```

### 3. Start MongoDB
Make sure MongoDB is running on your system.

### 4. Seed Database (Create Admin/Employee)
```bash
npm run seed
```

### 5. Start Server
```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

---

## 🔌 Real-Time Updates with Socket.IO

This API includes **Socket.IO** for real-time, bidirectional communication. Changes made by one user are instantly broadcasted to all connected clients without requiring page refresh.

### Connection

**Socket.IO Endpoint:** `http://localhost:3002`

#### JavaScript Client Example
```javascript
import io from 'socket.io-client';

const socket = io('http://localhost:3002');

socket.on('connect', () => {
  console.log('Connected to server:', socket.id);
});

socket.on('disconnect', () => {
  console.log('Disconnected from server');
});
```

### Real-Time Events

The server emits the following events for real-time updates:

#### Product Events
| Event | Trigger | Payload |
|-------|---------|---------|
| `product:created` | New product added | `{ product }` |
| `product:updated` | Product updated | `{ product }` |
| `product:deleted` | Product deleted | `{ productId }` |
| `product:inventory-updated` | Inventory changed | `{ product }` |

#### Invoice Events
| Event | Trigger | Payload |
|-------|---------|---------|
| `invoice:created` | New invoice created | `{ invoice }` |
| `invoice:updated` | Invoice updated | `{ invoice }` |
| `invoice:deleted` | Invoice permanently deleted | `{ invoiceId, invoiceNumber }` |
| `invoice:cancelled` | Invoice cancelled | `{ invoiceId, invoiceNumber }` |
| `invoice:delivery-status-updated` | Delivery status changed | `{ invoiceId, invoiceNumber, deliveryStatus }` |
| `invoice:payment-recorded` | Payment received | `{ invoiceId, invoiceNumber, advance, balanceDue, paymentStatus }` |
| `invoice:inventory-reduced` | Invoice created, inventory reduced | `{ invoiceId, invoiceNumber, affectedProducts[] }` |
| `invoice:inventory-restored` | Invoice deleted/cancelled, inventory restored | `{ invoiceId, invoiceNumber, affectedProducts[] }` |
| `invoice:inventory-adjusted` | Invoice updated, inventory adjusted | `{ invoiceId, invoiceNumber, affectedProducts[] }` |

#### Inventory Events
| Event | Trigger | Payload |
|-------|---------|---------|
| `inventory:low-stock-alert` | Product inventory falls below threshold | `{ products[] }` |

#### Client Events
| Event | Trigger | Payload |
|-------|---------|---------|
| `client:created` | New client added | `{ client }` |
| `client:updated` | Client updated | `{ client }` |

#### Employee Events
| Event | Trigger | Payload |
|-------|---------|---------|
| `employee:created` | New employee added | `{ employee }` |
| `employee:updated` | Employee updated | `{ employee }` |
| `employee:deactivated` | Employee deactivated | `{ employeeId }` |

### Usage Example

```javascript
import io from 'socket.io-client';

const socket = io('http://localhost:3002');

// Listen for new invoices
socket.on('invoice:created', (data) => {
  console.log('New invoice created:', data.invoice);
  // Update your UI automatically
  updateInvoiceList(data.invoice);
});

// Listen for delivery status updates
socket.on('invoice:delivery-status-updated', (data) => {
  console.log(`Invoice ${data.invoiceNumber} status: ${data.deliveryStatus}`);
  // Update specific invoice status in UI
  updateDeliveryStatus(data.invoiceId, data.deliveryStatus);
});

// Listen for payment updates
socket.on('invoice:payment-recorded', (data) => {
  console.log(`Payment recorded for ${data.invoiceNumber}`);
  console.log(`Balance due: ₹${data.balanceDue}`);
  // Update payment status in UI
  updatePaymentInfo(data);
});

// Listen for product updates
socket.on('product:created', (data) => {
  console.log('New product added:', data.product);
  addProductToList(data.product);
});

socket.on('product:inventory-updated', (data) => {
  console.log('Inventory updated:', data.product);
  updateProductInventory(data.product);
});

// Listen for low stock alerts
socket.on('inventory:low-stock-alert', (data) => {
  console.log('⚠️ Low stock alert:', data.products);
  showLowStockNotification(data.products);
});

// Listen for invoice inventory changes
socket.on('invoice:inventory-reduced', (data) => {
  console.log('📉 Inventory reduced for invoice:', data.invoiceNumber);
  refreshInventoryDisplay();
});

socket.on('invoice:inventory-restored', (data) => {
  console.log('📈 Inventory restored for invoice:', data.invoiceNumber);
  refreshInventoryDisplay();
});

socket.on('invoice:inventory-adjusted', (data) => {
  console.log('🔄 Inventory adjusted for invoice:', data.invoiceNumber);
  refreshInventoryDisplay();
});
```

### Benefits
- ✅ **Instant Updates**: See changes immediately without refreshing
- ✅ **Multi-User Support**: Multiple users can work simultaneously
- ✅ **Live Tracking**: Real-time delivery and payment status updates
- ✅ **Inventory Sync**: Live inventory updates across all clients
- ✅ **Better UX**: No manual refresh needed

---

## 📡 API Endpoints

### Authentication Headers
All protected routes require JWT token in header:
```
Authorization: Bearer <your_jwt_token>
```

---

## 🔐 Auth APIs

### POST `/api/auth/login`
Login user and get JWT token.

**Access:** Public

**Request Body:**
```json
{
  "username": "admin",
  "password": "Radhika@Khushbu@2004"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIs...",
    "user": {
      "id": "65...",
      "username": "admin",
      "name": "Administrator",
      "role": "admin"
    }
  }
}
```

---

### GET `/api/auth/me`
Get current logged-in user details.

**Access:** Private (Requires Token)

**Response:**
```json
{
  "success": true,
  "data": {
    "_id": "65...",
    "username": "admin",
    "name": "Administrator",
    "role": "admin",
    "isActive": true
  }
}
```

---

### PUT `/api/auth/change-password`
Change current user's password.

**Access:** Private

**Request Body:**
```json
{
  "currentPassword": "oldPassword123",
  "newPassword": "newPassword456"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Password changed successfully"
}
```

---

## 📦 Products APIs

### GET `/api/products`
Get all products with pagination and filtering.

**Access:** Private

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| search | string | - | Search by name/description |
| category | string | - | Filter by category |
| active | string | "true" | Filter active/inactive ("true", "false", "all") |
| page | number | 1 | Page number |
| limit | number | 50 | Items per page |
| sort | string | "-createdAt" | Sort field (prefix `-` for descending) |

**Example:** `GET /api/products?search=tent&category=tent&page=1&limit=20`

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "65...",
      "name": "Shamiyana Tent 20x40",
      "description": "Large tent for wedding functions",
      "price": 5000,
      "inventory": 10,
      "category": "tent",
      "unit": "piece",
      "isActive": true
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 25,
    "pages": 1
  }
}
```

---

### GET `/api/products/categories`
Get all unique product categories.

**Access:** Private

**Response:**
```json
{
  "success": true,
  "data": ["chairs", "decoration", "lighting", "tent"]
}
```

---

### GET `/api/products/search?q=`
Quick search for invoice creation (autocomplete).

**Access:** Private

**Query:** `?q=sha` (minimum 2 characters)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "65...",
      "name": "Shamiyana Tent",
      "price": 5000,
      "unit": "piece",
      "category": "tent"
    }
  ]
}
```

---

### GET `/api/products/low-stock`
Get products with low inventory (below threshold).

**Access:** Private

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| threshold | number | 10 | Inventory threshold for low stock |

**Example:** `GET /api/products/low-stock?threshold=15`

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "65...",
      "name": "Wedding Tent",
      "inventory": 5,
      "category": "tent",
      "unit": "piece",
      "price": 5000
    },
    {
      "_id": "65...",
      "name": "Chair Cover",
      "inventory": 8,
      "category": "decoration",
      "unit": "piece",
      "price": 50
    }
  ],
  "count": 2
}
```

**Real-Time Updates:**
- Socket.IO event `inventory:low-stock-alert` is emitted when products fall below threshold
- Automatically triggered when inventory changes via invoice operations
- Can be used for dashboard alerts and notifications

---

### GET `/api/products/:id`
Get single product by ID.

**Access:** Private

**Response:**
```json
{
  "success": true,
  "data": {
    "_id": "65...",
    "name": "Shamiyana Tent 20x40",
    "description": "Large tent for wedding functions",
    "price": 5000,
    "inventory": 10,
    "category": "tent",
    "unit": "piece",
    "isActive": true,
    "createdAt": "2024-01-01T10:00:00.000Z"
  }
}
```

---

### POST `/api/products`
Create new product.

**Access:** Admin Only

**Request Body:**
```json
{
  "name": "Shamiyana Tent 20x40",
  "description": "Large tent for wedding functions",
  "price": 5000,
  "inventory": 10,
  "category": "tent",
  "unit": "piece"
}
```

**Response:** `201 Created`
```json
{
  "success": true,
  "data": {
    "_id": "65...",
    "name": "Shamiyana Tent 20x40",
    ...
  }
}
```

---

### PUT `/api/products/:id`
Update product.

**Access:** Admin Only

**Request Body:** (all fields optional)
```json
{
  "name": "Updated Name",
  "price": 6000,
  "inventory": 15,
  "isActive": true
}
```

---

### DELETE `/api/products/:id`
Soft delete product (sets isActive to false).

**Access:** Admin Only

**Response:**
```json
{
  "success": true,
  "message": "Product deleted successfully"
}
```

---

### PUT `/api/products/:id/inventory`
Update product inventory only.

**Access:** Admin Only

**Request Body:**
```json
{
  "inventory": 25
}
```

---

## 👥 Clients APIs

### GET `/api/clients/autocomplete?q=`
Fast autocomplete search for clients.

**Access:** Private

**Query:** `?q=raj` (minimum 2 characters)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "65...",
      "partyName": "Rajesh Kumar",
      "mobile": "9876543210",
      "address": "123 Main Street"
    }
  ]
}
```

---

### GET `/api/clients`
Get all clients with pagination.

**Access:** Private

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| search | string | - | Search by name/mobile |
| page | number | 1 | Page number |
| limit | number | 50 | Items per page |
| sort | string | "-updatedAt" | Sort field |

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "65...",
      "partyName": "Rajesh Kumar",
      "mobile": "9876543210",
      "address": "123 Main Street",
      "totalOrders": 5,
      "totalSpent": 150000
    }
  ],
  "pagination": { ... }
}
```

---

### GET `/api/clients/:id`
Get single client with recent invoices.

**Access:** Private

**Response:**
```json
{
  "success": true,
  "data": {
    "_id": "65...",
    "partyName": "Rajesh Kumar",
    "mobile": "9876543210",
    "address": "123 Main Street",
    "email": "rajesh@email.com",
    "totalOrders": 5,
    "totalSpent": 150000,
    "recentInvoices": [
      {
        "invoiceNumber": "KWM241200001",
        "grandTotal": 50000,
        "orderDate": "2024-12-01",
        "deliveryStatus": "delivered",
        "paymentStatus": "paid"
      }
    ]
  }
}
```

---

### POST `/api/clients`
Create new client.

**Access:** Private

**Request Body:**
```json
{
  "partyName": "Rajesh Kumar",
  "mobile": "9876543210",
  "address": "123 Main Street, City",
  "email": "rajesh@email.com",
  "notes": "VIP customer"
}
```

---

### PUT `/api/clients/:id`
Update client.

**Access:** Private

**Request Body:** (all fields optional)
```json
{
  "partyName": "Rajesh Kumar",
  "mobile": "9876543210",
  "address": "Updated Address"
}
```

---

### GET `/api/clients/:id/invoices`
Get all invoices for a specific client.

**Access:** Private

**Query Parameters:** `page`, `limit`

---

## 🧾 Invoices APIs

### GET `/api/invoices`
Get all invoices with filtering.

**Access:** Private

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| search | string | - | Search by party name/mobile/invoice number |
| deliveryStatus | string | - | Filter: pending, in_transit, delivered, returned, cancelled |
| paymentStatus | string | - | Filter: unpaid, partial, paid |
| startDate | date | - | Filter by order date range start |
| endDate | date | - | Filter by order date range end |
| page | number | 1 | Page number |
| limit | number | 50 | Items per page |
| sort | string | "-orderDate" | Sort field |

**Example:** `GET /api/invoices?deliveryStatus=pending&paymentStatus=unpaid`

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "65...",
      "invoiceNumber": "KWM241200001",
      "partyName": "Rajesh Kumar",
      "mobile": "9876543210",
      "grandTotal": 50000,
      "balanceDue": 25000,
      "orderDate": "2024-12-01",
      "deliveryDate": "2024-12-15",
      "deliveryStatus": "pending",
      "paymentStatus": "partial"
    }
  ],
  "pagination": { ... }
}
```

---

### GET `/api/invoices/stats`
Get dashboard statistics.

**Access:** Private

**Response:**
```json
{
  "success": true,
  "data": {
    "totalInvoices": 150,
    "pendingDeliveries": 25,
    "unpaidInvoices": 45,
    "todayDeliveries": 5,
    "monthlyRevenue": 500000,
    "monthlyAdvance": 350000,
    "monthlyInvoices": 30
  }
}
```

---

### GET `/api/invoices/upcoming-deliveries`
Get upcoming deliveries.

**Access:** Private

**Query:** `?days=7` (default 7 days)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "invoiceNumber": "KWM241200001",
      "partyName": "Rajesh Kumar",
      "mobile": "9876543210",
      "deliveryDate": "2024-12-15",
      "deliveryStatus": "pending",
      "grandTotal": 50000,
      "balanceDue": 25000
    }
  ]
}
```

---

### GET `/api/invoices/:id`
Get single invoice with full details.

**Access:** Private

**Response:**
```json
{
  "success": true,
  "data": {
    "_id": "65...",
    "invoiceNumber": "KWM241200001",
    "partyName": "Rajesh Kumar",
    "mobile": "9876543210",
    "items": [
      {
        "productName": "Shamiyana Tent 20x40",
        "price": 5000,
        "quantity": 2,
        "total": 10000
      },
      {
        "productName": "Plastic Chairs",
        "price": 20,
        "quantity": 200,
        "total": 4000
      }
    ],
    "subtotal": 14000,
    "localFreight": 500,
    "transportation": 1000,
    "gstPercent": 18,
    "gstAmount": 2520,
    "discount": 500,
    "grandTotal": 17520,
    "advance": 10000,
    "balanceDue": 7520,
    "orderDate": "2024-12-01",
    "deliveryDate": "2024-12-15",
    "deliveryStatus": "pending",
    "paymentStatus": "partial",
    "notes": "Customer requested early morning delivery",
    "createdBy": {
      "name": "Administrator",
      "username": "admin"
    }
  }
}
```

---

### POST `/api/invoices`
Create new invoice.

**Access:** Private

**Request Body:**
```json
{
  "partyName": "Rajesh Kumar",
  "mobile": "9876543210",
  "items": [
    {
      "productName": "Shamiyana Tent 20x40",
      "price": 5000,
      "quantity": 2
    },
    {
      "productName": "Plastic Chairs",
      "price": 20,
      "quantity": 200
    }
  ],
  "localFreight": 500,
  "transportation": 1000,
  "gstPercent": 18,
  "discount": 500,
  "advance": 10000,
  "deliveryDate": "2024-12-15",
  "orderDate": "2024-12-01",
  "notes": "Customer requested early morning delivery"
}
```

**Note:** 
- `invoiceNumber` is auto-generated (format: KWM241200001)
- `subtotal`, `gstAmount`, `grandTotal`, `balanceDue` are auto-calculated
- Client is auto-created/updated if not exists

---

### PUT `/api/invoices/:id`
Update invoice.

**Access:** Private

**Request Body:** (all fields optional)
```json
{
  "partyName": "Rajesh Kumar",
  "mobile": "9876543210",
  "items": [...],
  "localFreight": 600,
  "deliveryDate": "2024-12-20",
  "deliveryStatus": "in_transit",
  "notes": "Updated notes"
}
```

---

### PATCH `/api/invoices/:id/delivery-status`
Update delivery status only (quick update).

**Access:** Private

**Request Body:**
```json
{
  "deliveryStatus": "delivered"
}
```

**Valid Values:** `pending`, `in_transit`, `delivered`, `returned`, `cancelled`

---

### PATCH `/api/invoices/:id/payment`
Record a payment.

**Access:** Private

**Request Body:**
```json
{
  "amount": 5000
}
```

**Note:** Payment status auto-updates:
- `unpaid` → if advance = 0
- `partial` → if advance > 0 but < grandTotal
- `paid` → if advance >= grandTotal

---

### DELETE `/api/invoices/:id`
Cancel invoice (soft delete).

**Access:** Admin Only

**Response:**
```json
{
  "success": true,
  "message": "Invoice cancelled successfully"
}
```

---

## 👨‍💼 Employees APIs

### GET `/api/employees`
Get all employees.

**Access:** Admin Only

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| active | string | "true" | Filter: "true", "false", "all" |
| page | number | 1 | Page number |
| limit | number | 50 | Items per page |

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "65...",
      "username": "employee",
      "name": "Default Employee",
      "phone": "9876543210",
      "role": "employee",
      "isActive": true
    }
  ],
  "pagination": { ... }
}
```

---

### GET `/api/employees/:id`
Get single employee.

**Access:** Admin Only

---

### POST `/api/employees`
Create new employee.

**Access:** Admin Only

**Request Body:**
```json
{
  "username": "john",
  "password": "john@123",
  "name": "John Doe",
  "phone": "9876543210"
}
```

---

### PUT `/api/employees/:id`
Update employee.

**Access:** Admin Only

**Request Body:**
```json
{
  "name": "John Doe Updated",
  "phone": "9876543211",
  "isActive": true
}
```

---

### PUT `/api/employees/:id/reset-password`
Reset employee password.

**Access:** Admin Only

**Request Body:**
```json
{
  "newPassword": "newPassword123"
}
```

---

### DELETE `/api/employees/:id`
Deactivate employee (soft delete).

**Access:** Admin Only

---

## 🏥 Health Check

### GET `/api/health`
Server health check.

**Access:** Public

**Response:**
```json
{
  "success": true,
  "status": "healthy",
  "timestamp": "2024-12-11T10:30:00.000Z",
  "uptime": 3600.5
}
```

---

### GET `/`
API information.

**Access:** Public

**Response:**
```json
{
  "message": "Khushi Wedding Mall CRM API",
  "version": "1.0.0",
  "status": "running",
  "endpoints": {
    "auth": "/api/auth",
    "products": "/api/products",
    "employees": "/api/employees",
    "invoices": "/api/invoices",
    "clients": "/api/clients",
    "health": "/api/health"
  }
}
```

---

## 📊 Invoice Number Format

Invoice numbers are auto-generated in format:
```
KWM + YY + MM + 4-digit sequence
Example: KWM241200001
         │   ││  │
         │   ││  └─ Sequential number (resets monthly)
         │   │└──── Month (12 = December)
         │   └───── Year (24 = 2024)
         └───────── Khushi Wedding Mall prefix
```

---

## ⚠️ Error Responses

All error responses follow this format:
```json
{
  "success": false,
  "error": "Error message here"
}
```

### Common HTTP Status Codes:
| Code | Meaning |
|------|---------|
| 200 | Success |
| 201 | Created |
| 400 | Bad Request (validation error) |
| 401 | Unauthorized (invalid/missing token) |
| 403 | Forbidden (insufficient permissions) |
| 404 | Not Found |
| 429 | Too Many Requests (rate limited) |
| 500 | Server Error |

---

## 🔒 Security Features

1. **JWT Authentication** - Stateless token-based auth (7-day expiry)
2. **Password Hashing** - bcrypt with 12 rounds
3. **Rate Limiting** - 1000 requests/15min (general), 20 requests/15min (login)
4. **Helmet** - Security headers
5. **CORS** - Configurable cross-origin policy (applies to both REST API and Socket.IO)
6. **Input Validation** - Mongoose schema validation
7. **Soft Deletes** - Data is never permanently deleted
8. **Socket.IO Security** - CORS-enabled WebSocket connections with origin validation

---

## 📁 Project Structure

```
khushi_wedding_mall/
├── config/
│   └── db.js              # MongoDB connection
├── middleware/
│   └── auth.js            # JWT & role middleware
├── models/
│   ├── Client.js          # Client schema
│   ├── Invoice.js         # Invoice schema
│   ├── Product.js         # Product schema
│   └── User.js            # User schema
├── routes/
│   ├── auth.js            # Auth routes
│   ├── clients.js         # Client routes
│   ├── employees.js       # Employee routes
│   ├── invoices.js        # Invoice routes
│   └── products.js        # Product routes
├── scripts/
│   └── seed.js            # Database seeder
├── .env                   # Environment variables
├── package.json           # Dependencies
├── server.js              # Main server file
└── API_DOCUMENTATION.md   # This file
```

---

## 🛠️ NPM Scripts

```bash
npm start      # Start production server
npm run dev    # Start development server (with nodemon)
npm run seed   # Seed database with admin/employee users
```

---

## 📞 Support

For any issues or questions, contact the development team.

**Made with ❤️ for Khushi Wedding Mall**

