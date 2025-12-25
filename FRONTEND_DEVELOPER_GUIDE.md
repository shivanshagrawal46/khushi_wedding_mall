# 🚀 Complete Frontend Developer Guide

## Welcome! 👋

This is your **complete guide** to integrating with the Khushi Wedding Mall CRM Backend. This documentation is written in **simple, easy-to-understand language** with **real examples** that you can copy and use directly in your frontend application.

---

## 📋 Table of Contents

1. [Getting Started](#getting-started)
2. [Base URL & Configuration](#base-url--configuration)
3. [Authentication](#authentication)
4. [API Endpoints](#api-endpoints)
5. [Real-Time Updates (Socket.IO)](#real-time-updates-socketio)
6. [Data Models](#data-models)
7. [Error Handling](#error-handling)
8. [Complete Integration Examples](#complete-integration-examples)
9. [Best Practices](#best-practices)

---

## 🎯 Getting Started

### What You Need

1. **Backend Server Running**
   - Default URL: `http://192.168.1.10:3002` (or your server IP)
   - Make sure the server is running and accessible
   - Check: Open `http://192.168.1.10:3002/api/health` in browser

2. **API Base URL**
   ```
   http://192.168.1.10:3002/api
   ```

3. **Authentication Token**
   - You'll get this after logging in
   - Include it in all API requests
   - Token expires after 7 days (default)

### Quick Start (5 Minutes)

**Step 1: Login**
```javascript
const response = await fetch('http://192.168.1.10:3002/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'admin',
    password: 'password123'
  })
});

const { data } = await response.json();
const token = data.token; // Save this!
```

**Step 2: Fetch Products**
```javascript
const response = await fetch('http://192.168.1.10:3002/api/products', {
  headers: { 'Authorization': `Bearer ${token}` }
});

const { data } = await response.json();
console.log('Products:', data.data);
```

**Step 3: Connect Socket.IO**
```javascript
import { io } from 'socket.io-client';

const socket = io('http://192.168.1.10:3002', {
  auth: { token }
});

socket.on('product:updated', (data) => {
  console.log('Product updated:', data.product);
});
```

**That's it! You're ready to build! 🚀**

---

## 🔧 Base URL & Configuration

### Base URL

```javascript
const API_BASE_URL = 'http://192.168.1.10:3002/api';
```

**Important**: Replace `192.168.1.10:3002` with your actual server IP and port.

### Network Access

The backend is configured to accept requests from:
- Same network devices (mobile, tablets, other computers)
- Network IP: `http://192.168.1.10:3002` (configurable in `.env`)

---

## 🔐 Authentication

### How Authentication Works

1. **Login** → Get a token
2. **Store token** → Save it (localStorage, secure storage, etc.)
3. **Send token** → Include in every API request header
4. **Token expires** → After 7 days (default), user needs to login again

### Login Endpoint

**POST** `/api/auth/login`

**Request:**
```javascript
const response = await fetch(`${API_BASE_URL}/auth/login`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    username: 'admin',
    password: 'password123'
  })
});

const data = await response.json();
```

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": "507f1f77bcf86cd799439011",
      "username": "admin",
      "name": "Admin User",
      "role": "admin"
    }
  }
}
```

**Error Response (401):**
```json
{
  "success": false,
  "error": "Invalid credentials"
}
```

### Get Current User

**GET** `/api/auth/me`

**Headers Required:**
```javascript
{
  'Authorization': `Bearer ${token}`
}
```

**Example:**
```javascript
const response = await fetch(`${API_BASE_URL}/auth/me`, {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

const data = await response.json();
// Returns: { success: true, data: { user object } }
```

### Change Password

**PUT** `/api/auth/change-password`

**Request:**
```javascript
const response = await fetch(`${API_BASE_URL}/auth/change-password`, {
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    currentPassword: 'oldpassword',
    newPassword: 'newpassword123'
  })
});
```

---

## 📡 API Endpoints

### Common Response Format

**Success:**
```json
{
  "success": true,
  "data": { /* your data */ }
}
```

**Error:**
```json
{
  "success": false,
  "error": "Error message here"
}
```

### HTTP Status Codes

- `200` - Success
- `201` - Created successfully
- `400` - Bad request (validation error)
- `401` - Unauthorized (no token or invalid token)
- `403` - Forbidden (insufficient permissions)
- `404` - Not found
- `500` - Server error

---

## 📦 Products API

### Get All Products

**GET** `/api/products`

**Query Parameters:**
- `search` - Search by name/description
- `category` - Filter by category
- `active` - `true`, `false`, or `all` (default: `true`)
- `page` - Page number (default: 1)
- `limit` - Items per page (default: 50)
- `sort` - Sort field (default: `-createdAt`)

**Example:**
```javascript
// Get all active products
const response = await fetch(`${API_BASE_URL}/products?active=true&page=1&limit=50`, {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

const data = await response.json();
// data.data = array of products
// data.pagination = { page, limit, total, pages }
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "507f1f77bcf86cd799439011",
      "name": "Red Carpet",
      "description": "Premium red carpet",
      "price": 500,
      "inventory": 25,
      "category": "Carpets",
      "unit": "meter",
      "isActive": true,
      "createdAt": "2024-01-15T10:30:00.000Z",
      "updatedAt": "2024-01-15T10:30:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 150,
    "pages": 3
  }
}
```

### Search Products (Quick Search)

**GET** `/api/products/search?q=chair`

**Example:**
```javascript
const response = await fetch(`${API_BASE_URL}/products/search?q=chair`, {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

const data = await response.json();
// Returns: { success: true, data: [array of matching products] }
```

### Get Low Stock Products

**GET** `/api/products/low-stock?threshold=10`

**Example:**
```javascript
const response = await fetch(`${API_BASE_URL}/products/low-stock?threshold=10`, {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

const data = await response.json();
// Returns products with inventory < 10
```

### Get Categories

**GET** `/api/products/categories`

**Example:**
```javascript
const response = await fetch(`${API_BASE_URL}/products/categories`, {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

const data = await response.json();
// Returns: { success: true, data: ["Carpets", "Chairs", "Tables", ...] }
```

### Create Product (Admin Only)

**POST** `/api/products`

**Request:**
```javascript
const response = await fetch(`${API_BASE_URL}/products`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    name: "Gold Chair",
    description: "Premium gold colored chair",
    price: 150,
    inventory: 50,
    category: "Chairs",
    unit: "piece"
  })
});
```

### Update Product (Admin Only)

**PUT** `/api/products/:id`

**Example:**
```javascript
const productId = "507f1f77bcf86cd799439011";

const response = await fetch(`${API_BASE_URL}/products/${productId}`, {
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    name: "Updated Name",
    price: 200,
    inventory: 30,
    isActive: true
  })
});
```

### Update Inventory (Admin Only)

**PUT** `/api/products/:id/inventory`

**Example:**
```javascript
const response = await fetch(`${API_BASE_URL}/products/${productId}/inventory`, {
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    inventory: 100
  })
});
```

---

## 📋 Orders API

### Get All Orders

**GET** `/api/orders`

**Query Parameters:**
- `search` - Search by party name, mobile, or order number
- `status` - Filter by status: `open`, `in_progress`, `partial_delivered`, `delivered`, `completed`, `cancelled`
- `paymentStatus` - Filter by payment: `unpaid`, `partial`, `paid`
- `startDate` - Filter from date (YYYY-MM-DD)
- `endDate` - Filter to date (YYYY-MM-DD)
- `page` - Page number (default: 1)
- `limit` - Items per page (default: 50)
- `sort` - Sort field (default: `-orderDate`)

**Example:**
```javascript
const response = await fetch(`${API_BASE_URL}/orders?status=open&page=1&limit=20`, {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

const data = await response.json();
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "507f1f77bcf86cd799439011",
      "orderNumber": "ORD24120001",
      "partyName": "John's Wedding",
      "mobile": "9999999999",
      "grandTotal": 50000,
      "balanceDue": 20000,
      "orderDate": "2024-12-01T10:00:00.000Z",
      "expectedDeliveryDate": "2024-12-25T00:00:00.000Z",
      "status": "open",
      "paymentStatus": "partial",
      "progress": 0,
      "totalDeliveries": 0,
      "employeeName": "John Doe",
      "comment": "Red chairs with gold trim",
      "isLocked": false
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "pages": 8
  }
}
```

### Get Order Statistics

**GET** `/api/orders/stats`

**Example:**
```javascript
const response = await fetch(`${API_BASE_URL}/orders/stats`, {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

const data = await response.json();
```

**Response:**
```json
{
  "success": true,
  "data": {
    "totalOrders": 500,
    "openOrders": 50,
    "inProgressOrders": 30,
    "completedOrders": 400,
    "unpaidOrders": 80,
    "monthlyRevenue": 5000000,
    "monthlyAdvance": 3000000,
    "monthlyOrders": 100
  }
}
```

### Get Single Order

**GET** `/api/orders/:id`

**Example:**
```javascript
// Can use order ID or order number
const orderId = "507f1f77bcf86cd799439011";
// OR
const orderNumber = "ORD24120001";

const response = await fetch(`${API_BASE_URL}/orders/${orderId}`, {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

### Create Order

**POST** `/api/orders`

**Request:**
```javascript
const response = await fetch(`${API_BASE_URL}/orders`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    partyName: "John's Wedding",
    mobile: "9999999999",
    items: [
      {
        productName: "Red Chair",
        price: 50,
        quantity: 25
      },
      {
        productName: "Red Carpet",
        price: 200,
        quantity: 32
      }
    ],
    localFreight: 500,
    transportation: 1000,
    gstPercent: 18,
    discount: 500,
    advance: 10000,
    expectedDeliveryDate: "2024-12-25",
    employeeName: "John Doe",
    employeeId: "employee-user-id", // Optional
    comment: "Red chairs with gold trim. Carpets should be 10x12 size.", // Customization notes
    notes: "Urgent order"
  })
});
```

**Response:**
```json
{
  "success": true,
  "order": {
    "_id": "507f1f77bcf86cd799439011",
    "orderNumber": "ORD24120001",
    "partyName": "John's Wedding",
    "items": [...],
    "grandTotal": 50000,
    "status": "open",
    "progress": 0
  },
  "inventoryResult": {
    "success": true,
    "affectedProducts": [...]
  }
}
```

### Update Order

**PUT** `/api/orders/:id`

**Note**: Cannot update if order is completed/locked.

**Request:**
```javascript
const response = await fetch(`${API_BASE_URL}/orders/${orderId}`, {
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    comment: "Updated customization notes",
    employeeName: "Jane Doe",
    expectedDeliveryDate: "2024-12-30",
    notes: "Updated notes"
  })
});
```

### Get Order History

**GET** `/api/orders/:id/history`

**Example:**
```javascript
const response = await fetch(`${API_BASE_URL}/orders/${orderId}/history`, {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

**Response:**
```json
{
  "success": true,
  "data": {
    "order": {
      "orderNumber": "ORD24120001",
      "partyName": "John's Wedding",
      "comment": "Red chairs with gold trim", // NOT in invoices
      "employeeName": "John Doe",
      "items": [...],
      "status": "completed",
      "progress": 100
    },
    "history": [
      {
        "delivery": {
          "deliveryNumber": "DEL24120001",
          "deliveryDate": "2024-12-23",
          "actualDeliveryDate": "2024-12-23",
          "deliveryPerformance": "on_time",
          "status": "delivered",
          "items": [...]
        },
        "invoice": {
          "invoiceNumber": "INV24120001",
          "invoiceDate": "2024-12-23",
          "grandTotal": 25000,
          "advance": 10000,
          "balanceDue": 15000,
          "paymentStatus": "partial"
        },
        "invoiceGenerated": true
      }
    ],
    "summary": {
      "totalDeliveries": 2,
      "totalInvoices": 2,
      "totalDelivered": 57,
      "totalRemaining": 0
    }
  }
}
```

### Create Delivery

**POST** `/api/orders/:id/deliveries`

**Request:**
```javascript
const response = await fetch(`${API_BASE_URL}/orders/${orderId}/deliveries`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    items: [
      {
        productName: "Red Chair",
        price: 50,
        quantity: 10
      }
    ],
    deliveryDate: "2024-12-23",
    actualDeliveryDate: "2024-12-23", // When actually delivered
    localFreight: 200,
    transportation: 500,
    gstPercent: 18,
    discount: 200,
    notes: "Delivered to front entrance"
  })
});
```

**For Full Delivery (all remaining items):**
```javascript
{
  isFullDelivery: true,
  deliveryDate: "2024-12-25",
  actualDeliveryDate: "2024-12-25"
}
```

### Generate Invoice for Delivery

**POST** `/api/orders/deliveries/:deliveryId/invoice`

**Request:**
```javascript
const response = await fetch(`${API_BASE_URL}/orders/deliveries/${deliveryId}/invoice`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    advance: 5000,
    notes: "First payment received"
  })
});
```

### Cancel Order

**PATCH** `/api/orders/:id/cancel` (Admin Only)

**Example:**
```javascript
const response = await fetch(`${API_BASE_URL}/orders/${orderId}/cancel`, {
  method: 'PATCH',
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

**Note**: This restores inventory automatically.

---

## 👥 Clients API

### Get All Clients

**GET** `/api/clients`

**Query Parameters:**
- `search` - Search by party name or mobile
- `page` - Page number
- `limit` - Items per page

**Example:**
```javascript
const response = await fetch(`${API_BASE_URL}/clients?search=john`, {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

### Autocomplete Clients

**GET** `/api/clients/autocomplete?q=john`

**Example:**
```javascript
const response = await fetch(`${API_BASE_URL}/clients/autocomplete?q=john`, {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

// Returns: { success: true, data: [array of matching clients] }
```

### Create Client

**POST** `/api/clients`

**Request:**
```javascript
const response = await fetch(`${API_BASE_URL}/clients`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    partyName: "John's Wedding",
    mobile: "9999999999",
    address: "123 Main St",
    email: "john@example.com",
    notes: "VIP customer"
  })
});
```

---

## 📊 Analytics API

### Get Delivery Performance

**GET** `/api/analytics/delivery-performance`

**Query Parameters:**
- `startDate` - Start date (YYYY-MM-DD)
- `endDate` - End date (YYYY-MM-DD)

**Example:**
```javascript
const response = await fetch(`${API_BASE_URL}/analytics/delivery-performance?startDate=2024-01-01&endDate=2024-12-31`, {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

**Response:**
```json
{
  "success": true,
  "data": {
    "onTime": 45,
    "early": 12,
    "late": 8,
    "total": 65,
    "onTimePercentage": 69
  }
}
```

### Get Employee Performance

**GET** `/api/analytics/employees`

**Example:**
```javascript
const response = await fetch(`${API_BASE_URL}/analytics/employees`, {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "employee-id",
      "name": "John Doe",
      "username": "john",
      "totalOrders": 25,
      "onTimeDeliveries": 20,
      "earlyDeliveries": 3,
      "lateDeliveries": 2,
      "totalDeliveries": 25,
      "onTimePercentage": 80
    }
  ]
}
```

### Get Employee Details

**GET** `/api/analytics/employees/:id`

**Example:**
```javascript
const response = await fetch(`${API_BASE_URL}/analytics/employees/${employeeId}`, {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

### Get Client Analytics

**GET** `/api/analytics/clients`

**Example:**
```javascript
const response = await fetch(`${API_BASE_URL}/analytics/clients`, {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

### Get Client Details

**GET** `/api/analytics/clients/:id`

**Example:**
```javascript
const response = await fetch(`${API_BASE_URL}/analytics/clients/${clientId}`, {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

**Response:**
```json
{
  "success": true,
  "data": {
    "client": {
      "_id": "client-id",
      "partyName": "John's Wedding",
      "mobile": "9999999999"
    },
    "summary": {
      "totalOrders": 10,
      "openOrders": 2,
      "completedOrders": 8,
      "totalAmount": 50000,
      "totalPaid": 45000,
      "totalDue": 5000
    },
    "orders": {
      "all": [...],
      "open": [...],
      "completed": [...]
    },
    "payments": {
      "unpaid": [...],
      "partial": [...],
      "paid": [...]
    }
  }
}
```

### Get Payment Analytics

**GET** `/api/analytics/payments`

**Query Parameters:**
- `clientId` - Filter by client
- `paymentStatus` - `unpaid`, `partial`, `paid`
- `deliveryStatus` - `open`, `in_progress`, `delivered`, `completed`, `delivered_not_paid`, `open_payments`, `closed_payments`
- `startDate` - Start date (YYYY-MM-DD)
- `endDate` - End date (YYYY-MM-DD)

**Examples:**
```javascript
// All unpaid orders
const unpaid = await fetch(`${API_BASE_URL}/analytics/payments?paymentStatus=unpaid`, {
  headers: { 'Authorization': `Bearer ${token}` }
});

// Delivered but not paid
const deliveredNotPaid = await fetch(`${API_BASE_URL}/analytics/payments?deliveryStatus=delivered_not_paid`, {
  headers: { 'Authorization': `Bearer ${token}` }
});

// Unpaid for specific client
const clientUnpaid = await fetch(`${API_BASE_URL}/analytics/payments?clientId=${clientId}&paymentStatus=unpaid`, {
  headers: { 'Authorization': `Bearer ${token}` }
});
```

---

## 🔌 Real-Time Updates (Socket.IO)

### Setup Socket.IO Connection

**JavaScript/TypeScript:**
```javascript
import { io } from 'socket.io-client';

const socket = io('http://192.168.1.10:3002', {
  auth: {
    token: 'your-jwt-token-here'
  },
  transports: ['websocket', 'polling']
});

// Connection events
socket.on('connect', () => {
  console.log('✅ Connected to server');
});

socket.on('disconnect', () => {
  console.log('❌ Disconnected from server');
});

socket.on('connect_error', (error) => {
  console.error('Connection error:', error);
});
```

**Flutter/Dart:**
```dart
import 'package:socket_io_client/socket_io_client.dart' as IO;

IO.Socket socket = IO.io('http://192.168.1.10:3002', <String, dynamic>{
  'transports': ['websocket', 'polling'],
  'autoConnect': false,
});

socket.connect();

socket.onConnect((_) {
  print('✅ Connected');
});

socket.onDisconnect((_) {
  print('❌ Disconnected');
});
```

### Socket.IO Events

#### Product Events

**`product:created`** - New product created
```javascript
socket.on('product:created', (data) => {
  console.log('New product:', data.product);
  // Update your product list
});
```

**`product:updated`** - Product updated
```javascript
socket.on('product:updated', (data) => {
  console.log('Product updated:', data.product);
  // Update product in your list
});
```

**`product:deleted`** - Product deleted (soft delete)
```javascript
socket.on('product:deleted', (data) => {
  console.log('Product deleted:', data.productId);
  // Remove from your list
});
```

**`product:inventory-updated`** - Product inventory changed
```javascript
socket.on('product:inventory-updated', (data) => {
  console.log('Inventory updated:', data.product);
  // Update inventory in your UI
});
```

#### Order Events

**`order:created`** - New order created
```javascript
socket.on('order:created', (data) => {
  console.log('New order:', data.order);
  // Add to orders list
});
```

**`order:updated`** - Order updated
```javascript
socket.on('order:updated', (data) => {
  console.log('Order updated:', data.order);
  // Update order in your list
});
```

**`order:cancelled`** - Order cancelled
```javascript
socket.on('order:cancelled', (data) => {
  console.log('Order cancelled:', data.orderNumber);
  // Update order status
});
```

**`order:payment-updated`** - Order payment updated
```javascript
socket.on('order:payment-updated', (data) => {
  console.log('Payment updated:', data.order);
  // Update payment status
});
```

**`order:locked`** - Order completed and locked
```javascript
socket.on('order:locked', (data) => {
  console.log('Order locked:', data.orderId);
  // Disable edit buttons, show read-only view
});
```

#### Delivery Events

**`delivery:created`** - New delivery created
```javascript
socket.on('delivery:created', (data) => {
  console.log('New delivery:', data.delivery);
  // Add to deliveries list
});
```

**`delivery:status-updated`** - Delivery status changed
```javascript
socket.on('delivery:status-updated', (data) => {
  console.log('Delivery status updated:', data.delivery);
  // Update delivery status
});
```

#### Invoice Events

**`invoice:created`** - Invoice generated
```javascript
socket.on('invoice:created', (data) => {
  console.log('Invoice created:', data.invoice);
  // Add to invoices list
});
```

#### Inventory Events

**`inventory:updated`** - Inventory changed (from order/invoice)
```javascript
socket.on('inventory:updated', (data) => {
  console.log('Inventory updated:', data);
  // Update product inventory in UI
});
```

**`inventory:low-stock-alert`** - Low stock alert (products < 10)
```javascript
socket.on('inventory:low-stock-alert', (data) => {
  console.log('Low stock products:', data.products);
  // Show alert notification
});
```

**`order:inventory-restored`** - Inventory restored (order cancelled)
```javascript
socket.on('order:inventory-restored', (data) => {
  console.log('Inventory restored:', data.affectedProducts);
  // Update inventory for affected products
});
```

**`invoice:inventory-reduced`** - Inventory reduced (invoice created)
```javascript
socket.on('invoice:inventory-reduced', (data) => {
  console.log('Inventory reduced:', data);
  // Update product inventory
});
```

**`invoice:inventory-adjusted`** - Inventory adjusted (invoice updated)
```javascript
socket.on('invoice:inventory-adjusted', (data) => {
  console.log('Inventory adjusted:', data);
  // Update product inventory
});
```

#### Client Events

**`client:created`** - New client created
```javascript
socket.on('client:created', (data) => {
  console.log('New client:', data.client);
  // Add to clients list
});
```

**`client:updated`** - Client updated
```javascript
socket.on('client:updated', (data) => {
  console.log('Client updated:', data.client);
  // Update client in list
});
```

#### Employee Events

**`employee:created`** - New employee created
```javascript
socket.on('employee:created', (data) => {
  console.log('New employee:', data.employee);
  // Add to employees list
});
```

**`employee:updated`** - Employee updated
```javascript
socket.on('employee:updated', (data) => {
  console.log('Employee updated:', data.employee);
  // Update employee in list
});
```

**`employee:deactivated`** - Employee deactivated
```javascript
socket.on('employee:deactivated', (data) => {
  console.log('Employee deactivated:', data.employeeId);
  // Remove or mark as inactive
});
```

#### Invoice Events (Legacy - Still Supported)

**`invoice:created`** - Invoice created
```javascript
socket.on('invoice:created', (data) => {
  console.log('Invoice created:', data.invoice);
});
```

**`invoice:updated`** - Invoice updated
```javascript
socket.on('invoice:updated', (data) => {
  console.log('Invoice updated:', data.invoice);
});
```

**`invoice:deleted`** - Invoice deleted
```javascript
socket.on('invoice:deleted', (data) => {
  console.log('Invoice deleted:', data);
});
```

**`invoice:cancelled`** - Invoice cancelled
```javascript
socket.on('invoice:cancelled', (data) => {
  console.log('Invoice cancelled:', data);
});
```

**`invoice:delivery-status-updated`** - Invoice delivery status changed
```javascript
socket.on('invoice:delivery-status-updated', (data) => {
  console.log('Delivery status updated:', data);
});
```

**`invoice:payment-recorded`** - Payment recorded on invoice
```javascript
socket.on('invoice:payment-recorded', (data) => {
  console.log('Payment recorded:', data);
});
```

**`invoice:generated`** - Delivery invoice generated
```javascript
socket.on('invoice:generated', (data) => {
  console.log('Invoice generated:', data.invoice);
  console.log('For delivery:', data.delivery);
});
```

#### Employee Events

**`employee:stats-updated`** - Employee statistics updated
```javascript
socket.on('employee:stats-updated', (data) => {
  console.log('Employee stats updated:', data);
  // Update employee performance dashboard
});
```

#### Client Events

**`client:stats-updated`** - Client statistics updated
```javascript
socket.on('client:stats-updated', (data) => {
  console.log('Client stats updated:', data);
  // Update client analytics
});
```

---

## 📊 Data Models

### Product Model

```typescript
interface Product {
  _id: string;
  name: string;
  description?: string;
  price: number | null;
  inventory: number | null;
  category?: string;
  unit: string; // "piece", "meter", "kg", etc.
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
```

### Order Model

```typescript
interface Order {
  _id: string;
  orderNumber: string;
  partyName: string;
  mobile: string;
  client?: string; // Client ID
  items: OrderItem[];
  subtotal: number;
  localFreight: number;
  transportation: number;
  gstPercent: number;
  gstAmount: number;
  discount: number;
  grandTotal: number;
  advance: number;
  balanceDue: number;
  orderDate: string;
  expectedDeliveryDate?: string;
  actualDeliveryDate?: string;
  status: 'open' | 'in_progress' | 'partial_delivered' | 'delivered' | 'completed' | 'cancelled';
  paymentStatus: 'unpaid' | 'partial' | 'paid';
  progress: number; // 0-100
  totalDeliveries: number;
  employeeName?: string;
  employee?: string; // Employee user ID
  comment?: string; // Customization notes (NOT in invoice)
  notes?: string;
  deliveryPerformance?: 'on_time' | 'early' | 'late';
  isLocked: boolean; // true when completed
  createdBy: string; // User ID
  createdAt: string;
  updatedAt: string;
}

interface OrderItem {
  product?: string; // Product ID
  productName: string;
  price: number;
  quantity: number;
  deliveredQuantity: number;
  remainingQuantity: number;
  total: number;
}
```

### Delivery Model

```typescript
interface Delivery {
  _id: string;
  deliveryNumber: string;
  order: string; // Order ID
  orderNumber: string;
  partyName: string;
  mobile: string;
  items: DeliveryItem[];
  subtotal: number;
  localFreight: number;
  transportation: number;
  gstPercent: number;
  gstAmount: number;
  discount: number;
  grandTotal: number;
  deliveryDate: string;
  actualDeliveryDate?: string;
  expectedDeliveryDate?: string;
  deliveryPerformance?: 'on_time' | 'early' | 'late';
  status: 'pending' | 'in_transit' | 'delivered' | 'returned';
  invoice?: string; // Invoice ID
  invoiceGenerated: boolean;
  deliveredBy?: string; // User ID
  notes?: string;
  createdAt: string;
  updatedAt: string;
}
```

### DeliveryInvoice Model

```typescript
interface DeliveryInvoice {
  _id: string;
  invoiceNumber: string;
  delivery: string; // Delivery ID
  deliveryNumber: string;
  order: string; // Order ID
  orderNumber: string;
  partyName: string;
  mobile: string;
  client?: string; // Client ID
  items: InvoiceItem[];
  subtotal: number;
  localFreight: number;
  transportation: number;
  gstPercent: number;
  gstAmount: number;
  discount: number;
  grandTotal: number;
  advance: number;
  balanceDue: number;
  invoiceDate: string;
  deliveryDate: string;
  paymentStatus: 'unpaid' | 'partial' | 'paid';
  createdBy: string; // User ID
  notes?: string;
  createdAt: string;
  updatedAt: string;
}
```

### Client Model

```typescript
interface Client {
  _id: string;
  partyName: string;
  mobile: string;
  address?: string;
  email?: string;
  notes?: string;
  totalOrders: number;
  completedOrders: number;
  openOrders: number;
  totalSpent: number;
  totalPaid: number;
  totalDue: number;
  createdAt: string;
  updatedAt: string;
}
```

### User Model

```typescript
interface User {
  _id: string;
  username: string;
  name: string;
  role: 'admin' | 'employee';
  phone?: string;
  isActive: boolean;
  employeeStats?: {
    totalOrders: number;
    onTimeDeliveries: number;
    earlyDeliveries: number;
    lateDeliveries: number;
    totalDeliveries: number;
    lastUpdated: string;
  };
  createdAt: string;
  updatedAt: string;
}
```

---

## ⚠️ Error Handling

### Standard Error Response

All errors follow this format:
```json
{
  "success": false,
  "error": "Error message here"
}
```

### Common Errors

**401 Unauthorized:**
```json
{
  "success": false,
  "error": "Not authorized - No token provided"
}
```
**Solution**: Include `Authorization: Bearer <token>` header

**403 Forbidden:**
```json
{
  "success": false,
  "error": "Admin access required"
}
```
**Solution**: User doesn't have required permissions

**404 Not Found:**
```json
{
  "success": false,
  "error": "Order not found"
}
```
**Solution**: Check if ID exists

**400 Bad Request:**
```json
{
  "success": false,
  "error": "Product name is required"
}
```
**Solution**: Check request body validation

**500 Server Error:**
```json
{
  "success": false,
  "error": "Server error"
}
```
**Solution**: Server issue, retry or contact admin

### Error Handling Example

```javascript
async function fetchOrders() {
  try {
    const response = await fetch(`${API_BASE_URL}/orders`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    const data = await response.json();

    if (!response.ok) {
      // Handle error
      if (response.status === 401) {
        // Token expired, redirect to login
        localStorage.removeItem('token');
        window.location.href = '/login';
      } else {
        // Show error message
        alert(data.error || 'An error occurred');
      }
      return;
    }

    if (data.success) {
      // Use data.data
      return data.data;
    }
  } catch (error) {
    console.error('Network error:', error);
    alert('Network error. Please check your connection.');
  }
}
```

---

## 💻 Complete Integration Examples

### React Example

```javascript
import { useState, useEffect } from 'react';
import { io } from 'socket.io-client';

const API_BASE_URL = 'http://192.168.1.10:3002/api';

function App() {
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [orders, setOrders] = useState([]);
  const [socket, setSocket] = useState(null);

  // Login
  const handleLogin = async (username, password) => {
    const response = await fetch(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await response.json();
    if (data.success) {
      setToken(data.data.token);
      localStorage.setItem('token', data.data.token);
      connectSocket(data.data.token);
    }
  };

  // Connect Socket.IO
  const connectSocket = (authToken) => {
    const newSocket = io('http://192.168.1.10:3002', {
      auth: { token: authToken }
    });

    newSocket.on('order:created', (data) => {
      setOrders(prev => [data.order, ...prev]);
    });

    newSocket.on('order:updated', (data) => {
      setOrders(prev => prev.map(order => 
        order._id === data.order._id ? data.order : order
      ));
    });

    setSocket(newSocket);
  };

  // Fetch Orders
  const fetchOrders = async () => {
    const response = await fetch(`${API_BASE_URL}/orders`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await response.json();
    if (data.success) {
      setOrders(data.data);
    }
  };

  useEffect(() => {
    if (token) {
      fetchOrders();
      connectSocket(token);
    }
  }, [token]);

  return (
    <div>
      {/* Your UI here */}
    </div>
  );
}
```

### Flutter Example

```dart
import 'package:http/http.dart' as http;
import 'package:socket_io_client/socket_io_client.dart' as IO;
import 'dart:convert';

class ApiService {
  static const String baseUrl = 'http://192.168.1.10:3002/api';
  String? token;

  // Login
  Future<Map<String, dynamic>> login(String username, String password) async {
    final response = await http.post(
      Uri.parse('$baseUrl/auth/login'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'username': username,
        'password': password,
      }),
    );

    final data = jsonDecode(response.body);
    if (data['success']) {
      token = data['data']['token'];
    }
    return data;
  }

  // Get Orders
  Future<List<dynamic>> getOrders() async {
    final response = await http.get(
      Uri.parse('$baseUrl/orders'),
      headers: {'Authorization': 'Bearer $token'},
    );

    final data = jsonDecode(response.body);
    return data['success'] ? data['data'] : [];
  }

  // Create Order
  Future<Map<String, dynamic>> createOrder(Map<String, dynamic> orderData) async {
    final response = await http.post(
      Uri.parse('$baseUrl/orders'),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $token',
      },
      body: jsonEncode(orderData),
    );

    return jsonDecode(response.body);
  }
}

// Socket.IO Connection
class SocketService {
  IO.Socket? socket;

  void connect(String token) {
    socket = IO.io('http://192.168.1.10:3002', <String, dynamic>{
      'transports': ['websocket', 'polling'],
      'auth': {'token': token},
    });

    socket!.onConnect((_) {
      print('Connected');
    });

    socket!.on('order:created', (data) {
      print('New order: $data');
      // Update your state
    });
  }
}
```

---

## ✅ Best Practices

### 1. Token Management

```javascript
// Store token securely
localStorage.setItem('token', token);

// Include in all requests
headers: {
  'Authorization': `Bearer ${token}`
}

// Handle token expiration
if (response.status === 401) {
  // Redirect to login
  localStorage.removeItem('token');
  window.location.href = '/login';
}
```

### 2. Error Handling

```javascript
// Always check response.ok
if (!response.ok) {
  const error = await response.json();
  // Handle error
}

// Always check data.success
if (data.success) {
  // Use data.data
} else {
  // Handle error: data.error
}
```

### 3. Loading States

```javascript
const [loading, setLoading] = useState(false);

const fetchData = async () => {
  setLoading(true);
  try {
    const data = await fetchOrders();
    setOrders(data);
  } finally {
    setLoading(false);
  }
};
```

### 4. Real-Time Updates

```javascript
// Connect Socket.IO once
useEffect(() => {
  if (token) {
    const socket = io('http://192.168.1.10:3002', {
      auth: { token }
    });

    // Listen to events
    socket.on('order:updated', handleOrderUpdate);

    // Cleanup on unmount
    return () => socket.disconnect();
  }
}, [token]);
```

### 5. Pagination

```javascript
const [page, setPage] = useState(1);
const [limit] = useState(50);

const fetchOrders = async () => {
  const response = await fetch(
    `${API_BASE_URL}/orders?page=${page}&limit=${limit}`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  const data = await response.json();
  // Use data.data and data.pagination
};
```

### 6. Form Validation

```javascript
// Validate before sending
const createOrder = async (orderData) => {
  if (!orderData.partyName || !orderData.mobile) {
    alert('Party name and mobile are required');
    return;
  }

  if (!orderData.items || orderData.items.length === 0) {
    alert('At least one item is required');
    return;
  }

  // Send request
  const response = await fetch(`${API_BASE_URL}/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(orderData)
  });
};
```

---

## 🎯 Quick Reference

### Base URL
```
http://192.168.1.10:3002/api
```

### Authentication Header
```
Authorization: Bearer <your-token>
```

### Common Endpoints
- Login: `POST /api/auth/login`
- Products: `GET /api/products`
- Orders: `GET /api/orders`
- Create Order: `POST /api/orders`
- Analytics: `GET /api/analytics/*`

### Socket.IO URL
```
http://192.168.1.10:3002
```

### Order Status Values
- `open` - Just created
- `in_progress` - Delivery started
- `partial_delivered` - Partially delivered
- `delivered` - Fully delivered (payment pending)
- `completed` - Fully delivered AND paid (locked)
- `cancelled` - Cancelled

### Payment Status Values
- `unpaid` - No payment
- `partial` - Partial payment
- `paid` - Fully paid

---

## 🆘 Need Help?

### Common Issues

1. **Connection Error**
   - Check if server is running
   - Verify IP address and port
   - Check firewall settings

2. **401 Unauthorized**
   - Token expired or missing
   - Include token in Authorization header
   - Login again to get new token

3. **403 Forbidden**
   - User doesn't have required permissions
   - Check user role (admin vs employee)

4. **Socket.IO Not Connecting**
   - Check network connectivity
   - Verify Socket.IO URL
   - Check if token is valid

---

## 📚 Additional Resources

- **Backend Repository**: Check backend code for more details
- **API Documentation**: See `OPTIMIZATION_REPORT.md` for performance details
- **System Architecture**: See `ORDER_SYSTEM_ARCHITECTURE.md`

---

## 🎉 You're Ready!

You now have everything you need to build an amazing frontend for this CRM system. The backend is optimized, fast, and ready for production. Happy coding! 🚀

**Questions?** Check the code examples above or review the backend source code for more details.

