# 📋 API Quick Reference Card

## 🔐 Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/login` | Login user |
| GET | `/api/auth/me` | Get current user |
| PUT | `/api/auth/change-password` | Change password |

---

## 📦 Products

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| GET | `/api/products` | Get all products | ✅ |
| GET | `/api/products/search?q=chair` | Quick search | ✅ |
| GET | `/api/products/low-stock?threshold=10` | Low stock products | ✅ |
| GET | `/api/products/categories` | Get categories | ✅ |
| GET | `/api/products/:id` | Get single product | ✅ |
| POST | `/api/products` | Create product | ✅ Admin |
| PUT | `/api/products/:id` | Update product | ✅ Admin |
| PUT | `/api/products/:id/inventory` | Update inventory | ✅ Admin |
| DELETE | `/api/products/:id` | Delete product | ✅ Admin |

---

## 📋 Orders

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| GET | `/api/orders` | Get all orders | ✅ |
| GET | `/api/orders/stats` | Order statistics | ✅ |
| GET | `/api/orders/upcoming-deliveries` | Upcoming deliveries | ✅ |
| GET | `/api/orders/:id` | Get single order | ✅ |
| GET | `/api/orders/:id/history` | Order history | ✅ |
| GET | `/api/orders/:id/deliveries` | Get deliveries | ✅ |
| GET | `/api/orders/:id/invoices` | Get invoices | ✅ |
| GET | `/api/orders/:id/remaining` | Remaining quantities | ✅ |
| GET | `/api/orders/:id/progress` | Order progress | ✅ |
| POST | `/api/orders` | Create order | ✅ |
| PUT | `/api/orders/:id` | Update order | ✅ |
| PATCH | `/api/orders/:id/cancel` | Cancel order | ✅ Admin |
| POST | `/api/orders/:id/deliveries` | Create delivery | ✅ |
| POST | `/api/orders/deliveries/:id/invoice` | Generate invoice | ✅ |
| PATCH | `/api/orders/deliveries/:id/status` | Update delivery status | ✅ |

---

## 👥 Clients

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| GET | `/api/clients` | Get all clients | ✅ |
| GET | `/api/clients/autocomplete?q=john` | Autocomplete | ✅ |
| GET | `/api/clients/:id` | Get single client | ✅ |
| POST | `/api/clients` | Create client | ✅ |
| PUT | `/api/clients/:id` | Update client | ✅ |
| DELETE | `/api/clients/:id` | Delete client | ✅ Admin |

---

## 📊 Analytics

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| GET | `/api/analytics/delivery-performance` | Delivery stats | ✅ |
| GET | `/api/analytics/employees` | All employees stats | ✅ |
| GET | `/api/analytics/employees/:id` | Employee details | ✅ |
| GET | `/api/analytics/clients` | All clients stats | ✅ |
| GET | `/api/analytics/clients/:id` | Client details | ✅ |
| GET | `/api/analytics/payments` | Payment analytics | ✅ |

---

## 🔌 Socket.IO Events

### Product Events
- `product:created`
- `product:updated`
- `product:deleted`
- `product:inventory-updated`

### Order Events
- `order:created`
- `order:updated`
- `order:cancelled`
- `order:payment-updated`
- `order:locked`
- `order:inventory-restored`

### Delivery Events
- `delivery:created`
- `delivery:status-updated`

### Invoice Events
- `invoice:created`
- `invoice:updated`
- `invoice:deleted`
- `invoice:cancelled`
- `invoice:generated`
- `invoice:payment-recorded`
- `invoice:delivery-status-updated`
- `invoice:inventory-reduced`
- `invoice:inventory-adjusted`

### Inventory Events
- `inventory:updated`
- `inventory:low-stock-alert`

### Client Events
- `client:created`
- `client:updated`

### Employee Events
- `employee:created`
- `employee:updated`
- `employee:deactivated`
- `employee:stats-updated`

---

## 📝 Common Request Headers

```javascript
{
  'Content-Type': 'application/json',
  'Authorization': 'Bearer <your-token>'
}
```

---

## 📊 Response Format

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
  "error": "Error message"
}
```

---

## 🔢 Status Codes

- `200` - Success
- `201` - Created
- `400` - Bad Request
- `401` - Unauthorized
- `403` - Forbidden
- `404` - Not Found
- `500` - Server Error

---

## 📌 Order Status Values

- `open` - Just created
- `in_progress` - Delivery started
- `partial_delivered` - Partially delivered
- `delivered` - Fully delivered
- `completed` - Delivered + Paid (locked)
- `cancelled` - Cancelled

---

## 💰 Payment Status Values

- `unpaid` - No payment
- `partial` - Partial payment
- `paid` - Fully paid

---

## 🚀 Base URL

```
http://192.168.1.10:3002/api
```

**Socket.IO URL:**
```
http://192.168.1.10:3002
```

---

**Print this page and keep it handy! 📌**


