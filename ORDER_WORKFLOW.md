# 📋 Order Workflow - Complete Guide

## Overview

The system uses **Orders** as the primary entity, with **Deliveries** and **DeliveryInvoices** linked to them. The old Invoice system is deprecated - all invoices are now DeliveryInvoices generated per delivery.

---

## 🎯 Core Concept

### Order → Deliveries → Invoices

1. **Order** is created with items and quantities
2. **Deliveries** are created (full or partial)
3. **DeliveryInvoice** is generated for each delivery
4. All invoices are linked to the order

---

## 📊 Workflow Scenarios

### Scenario 1: Full Delivery (All Items at Once)

```
1. Create Order
   - Order: 25 Chairs, 32 Carpets
   - Status: open
   - Progress: 0%

2. Create Full Delivery
   - Deliver all remaining items (25 Chairs + 32 Carpets)
   - Order status: in_progress → completed
   - Progress: 100%

3. Generate Invoice
   - Create DeliveryInvoice for this delivery
   - Invoice includes all items
   - Link to order
```

**API Calls:**
```bash
# 1. Create Order
POST /api/orders
{
  "partyName": "Customer Name",
  "mobile": "9999999999",
  "items": [
    { "productName": "Chairs", "price": 50, "quantity": 25 },
    { "productName": "Carpets", "price": 200, "quantity": 32 }
  ]
}

# 2. Create Full Delivery (deliver all remaining)
POST /api/orders/{order-id}/deliveries
{
  "deliveryDate": "2024-12-25",
  "isFullDelivery": true  // ← Delivers all remaining items
}

# 3. Generate Invoice
POST /api/orders/deliveries/{delivery-id}/invoice
{
  "advance": 5000
}
```

---

### Scenario 2: Partial Deliveries (Multiple Stages)

```
1. Create Order
   - Order: 25 Chairs, 32 Carpets
   - Status: open
   - Progress: 0%

2. First Partial Delivery (Dec 23)
   - Deliver: 10 Chairs
   - Order status: in_progress
   - Progress: 19% (10/52 items)
   - Remaining: 15 Chairs, 32 Carpets

3. Generate Invoice for First Delivery
   - Invoice #1: 10 Chairs
   - Link to order

4. Second Partial Delivery (Dec 24)
   - Deliver: 5 Chairs
   - Order status: partial_delivered
   - Progress: 29% (15/52 items)
   - Remaining: 10 Chairs, 32 Carpets

5. Generate Invoice for Second Delivery
   - Invoice #2: 5 Chairs
   - Link to order

6. Third Partial Delivery (Dec 25)
   - Deliver: 10 Chairs + 32 Carpets (remaining all)
   - Order status: completed
   - Progress: 100%
   - Remaining: 0

7. Generate Invoice for Third Delivery
   - Invoice #3: 10 Chairs + 32 Carpets
   - Link to order
```

**API Calls:**
```bash
# 1. Create Order
POST /api/orders
{ ... }

# 2. First Delivery (10 Chairs)
POST /api/orders/{order-id}/deliveries
{
  "items": [
    { "productName": "Chairs", "price": 50, "quantity": 10 }
  ],
  "deliveryDate": "2024-12-23"
}

# 3. Generate Invoice #1
POST /api/orders/deliveries/{delivery-1-id}/invoice
{ "advance": 1000 }

# 4. Second Delivery (5 Chairs)
POST /api/orders/{order-id}/deliveries
{
  "items": [
    { "productName": "Chairs", "price": 50, "quantity": 5 }
  ],
  "deliveryDate": "2024-12-24"
}

# 5. Generate Invoice #2
POST /api/orders/deliveries/{delivery-2-id}/invoice
{ "advance": 500 }

# 6. Third Delivery (Remaining: 10 Chairs + 32 Carpets)
POST /api/orders/{order-id}/deliveries
{
  "isFullDelivery": true,  // ← Delivers all remaining
  "deliveryDate": "2024-12-25"
}

# 7. Generate Invoice #3
POST /api/orders/deliveries/{delivery-3-id}/invoice
{ "advance": 8000 }
```

---

## 📡 API Endpoints

### Order Management

#### `GET /api/orders/:id/history`
**Get complete order history with all deliveries and invoices**

**Response:**
```json
{
  "success": true,
  "data": {
    "order": {
      "orderNumber": "ORD24120001",
      "partyName": "Customer Name",
      "status": "completed",
      "progress": 100,
      "items": [
        { "productName": "Chairs", "quantity": 25, "deliveredQuantity": 25, "remainingQuantity": 0 },
        { "productName": "Carpets", "quantity": 32, "deliveredQuantity": 32, "remainingQuantity": 0 }
      ]
    },
    "history": [
      {
        "delivery": {
          "deliveryNumber": "DEL24120001",
          "deliveryDate": "2024-12-23",
          "status": "delivered",
          "grandTotal": 500,
          "items": [
            { "productName": "Chairs", "quantity": 10, "price": 50 }
          ]
        },
        "invoice": {
          "invoiceNumber": "INV24120001",
          "invoiceDate": "2024-12-23",
          "grandTotal": 500,
          "advance": 1000,
          "balanceDue": -500,
          "paymentStatus": "paid"
        },
        "invoiceGenerated": true
      },
      {
        "delivery": {
          "deliveryNumber": "DEL24120002",
          "deliveryDate": "2024-12-24",
          "status": "delivered",
          "grandTotal": 250,
          "items": [
            { "productName": "Chairs", "quantity": 5, "price": 50 }
          ]
        },
        "invoice": {
          "invoiceNumber": "INV24120002",
          "invoiceDate": "2024-12-24",
          "grandTotal": 250,
          "advance": 500,
          "balanceDue": -250,
          "paymentStatus": "paid"
        },
        "invoiceGenerated": true
      }
    ],
    "summary": {
      "totalDeliveries": 2,
      "totalInvoices": 2,
      "totalDelivered": 15,
      "totalRemaining": 42
    }
  }
}
```

#### `GET /api/orders/:id/invoices`
**Get all invoices for an order**

**Response:**
```json
{
  "success": true,
  "data": {
    "orderNumber": "ORD24120001",
    "invoices": [
      {
        "invoiceNumber": "INV24120001",
        "invoiceDate": "2024-12-23",
        "deliveryDate": "2024-12-23",
        "deliveryNumber": "DEL24120001",
        "grandTotal": 500,
        "advance": 1000,
        "balanceDue": -500,
        "paymentStatus": "paid"
      },
      {
        "invoiceNumber": "INV24120002",
        "invoiceDate": "2024-12-24",
        "deliveryDate": "2024-12-24",
        "deliveryNumber": "DEL24120002",
        "grandTotal": 250,
        "advance": 500,
        "balanceDue": -250,
        "paymentStatus": "paid"
      }
    ],
    "totalInvoices": 2,
    "totalAmount": 750,
    "totalPaid": 1500,
    "totalDue": -750
  }
}
```

#### `POST /api/orders/:id/deliveries`
**Create delivery (full or partial)**

**Full Delivery:**
```json
{
  "deliveryDate": "2024-12-25",
  "isFullDelivery": true  // ← Delivers all remaining items
}
```

**Partial Delivery:**
```json
{
  "items": [
    { "productName": "Chairs", "price": 50, "quantity": 10 }
  ],
  "deliveryDate": "2024-12-23"
}
```

#### `POST /api/orders/deliveries/:deliveryId/invoice`
**Generate invoice for delivery**

**Auto-generate (no data needed):**
```bash
POST /api/orders/deliveries/{delivery-id}/invoice
{}
```

**With advance payment:**
```json
{
  "advance": 5000,
  "notes": "Partial payment received"
}
```

---

## 🔄 Order States

### Status Flow
```
open → in_progress → partial_delivered → completed
  ↓
cancelled (admin only)
```

### Progress Calculation
```
Progress = (Total Delivered / Total Ordered) × 100
```

### Auto-Status Updates
- **0% progress**: `open`
- **1-99% progress**: `in_progress` → `partial_delivered`
- **100% progress**: `completed`

---

## 📊 Order History View

### What You Can See

1. **Order Details**
   - Order number, customer, date
   - All items with quantities
   - Total amount, balance due
   - Current status and progress

2. **Delivery History**
   - All deliveries with dates
   - Items delivered in each delivery
   - Delivery status
   - Delivery totals

3. **Invoice History**
   - All invoices linked to deliveries
   - Invoice numbers and dates
   - Payment status per invoice
   - Advance payments and balance due

4. **Summary**
   - Total deliveries count
   - Total invoices count
   - Total delivered quantities
   - Total remaining quantities

---

## 🎯 Key Features

### ✅ Full Delivery Support
- Deliver all remaining items at once
- Set `isFullDelivery: true` or omit `items` array
- Automatically calculates what to deliver

### ✅ Partial Delivery Support
- Deliver specific items and quantities
- Validates remaining quantities
- Tracks progress automatically

### ✅ Per-Delivery Invoicing
- Generate invoice for each delivery
- Track payments per invoice
- All invoices linked to order

### ✅ Complete History
- View all deliveries with dates
- View all invoices with payments
- Track order from start to completion

### ✅ Real-Time Updates
- Socket.IO events for all operations
- Auto-updates in frontend
- No polling needed

---

## 💡 Best Practices

1. **Always generate invoice after delivery**
   - Creates proper paper trail
   - Tracks payments accurately

2. **Use full delivery for single-stage orders**
   - Simpler workflow
   - One invoice per order

3. **Use partial deliveries for multi-stage orders**
   - Better tracking
   - Multiple invoices as needed

4. **Check order history regularly**
   - Monitor delivery progress
   - Track invoice payments
   - Identify issues early

---

## 🚀 Quick Reference

### Create Order → Full Delivery → Invoice
```bash
POST /api/orders
POST /api/orders/{id}/deliveries (isFullDelivery: true)
POST /api/orders/deliveries/{id}/invoice
```

### Create Order → Partial Deliveries → Invoices
```bash
POST /api/orders
POST /api/orders/{id}/deliveries (items: [...])
POST /api/orders/deliveries/{id}/invoice
POST /api/orders/{id}/deliveries (items: [...])
POST /api/orders/deliveries/{id}/invoice
# Repeat until complete
```

### View Complete History
```bash
GET /api/orders/{id}/history
```

### View All Invoices
```bash
GET /api/orders/{id}/invoices
```

---

## 📝 Summary

- ✅ **Orders** are the primary entity
- ✅ **Deliveries** track what was delivered and when
- ✅ **DeliveryInvoices** are generated per delivery
- ✅ All invoices are linked to the order
- ✅ Complete history available via `/api/orders/:id/history`
- ✅ Supports both full and partial deliveries
- ✅ Real-time updates via Socket.IO

**The old Invoice system is deprecated - use Orders + Deliveries + DeliveryInvoices!** 🎉


