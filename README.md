# Khushi Wedding Mall - Internal CRM

A fast, optimized internal CRM system for tent and decoration business. Features invoice generation, payment tracking, delivery management, and inventory control.

## Features

- **🔐 Two-tier Authentication**: Admin and Employee roles with strong passwords
- **📦 Product Management**: Add products with optional price and inventory
- **👥 Employee Management**: Create and manage employee accounts
- **📄 Invoice Generation**: Complete invoice system with items, GST, freight, discounts
- **💰 Payment Tracking**: Track advance payments and balance due
- **🚚 Delivery Management**: Track delivery status with date filters
- **🔍 Smart Search**: Autocomplete for returning clients, fast product search
- **⚡ Optimized for Speed**: MongoDB indexes, lean queries, parallel execution
- **🔌 Real-Time Updates**: Socket.IO for instant updates without page refresh

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Create a `.env` file:

```env
MONGODB_URI=mongodb://localhost:27017/khushi_wedding_mall
JWT_SECRET=your_super_secret_jwt_key_here_change_in_production
JWT_EXPIRES_IN=7d
PORT=3000
NODE_ENV=development
```

### 3. Seed Initial Users

```bash
npm run seed
```

This creates:
- **Admin**: username `admin`, password `Radhika@Khushbu@2004`
- **Employee**: username `employee`, password `password@123`

### 4. Start Server

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

## API Endpoints

### Authentication

| Method | Endpoint | Description | Access |
|--------|----------|-------------|--------|
| POST | `/api/auth/login` | Login | Public |
| GET | `/api/auth/me` | Get current user | Private |
| PUT | `/api/auth/change-password` | Change password | Private |

### Products

| Method | Endpoint | Description | Access |
|--------|----------|-------------|--------|
| GET | `/api/products` | List all products | Private |
| GET | `/api/products/search?q=` | Quick search | Private |
| GET | `/api/products/categories` | Get categories | Private |
| GET | `/api/products/:id` | Get single product | Private |
| POST | `/api/products` | Create product | Admin |
| PUT | `/api/products/:id` | Update product | Admin |
| DELETE | `/api/products/:id` | Delete product | Admin |

### Employees (Admin Only)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/employees` | List employees |
| GET | `/api/employees/:id` | Get employee |
| POST | `/api/employees` | Create employee |
| PUT | `/api/employees/:id` | Update employee |
| PUT | `/api/employees/:id/reset-password` | Reset password |
| DELETE | `/api/employees/:id` | Deactivate employee |

### Invoices

| Method | Endpoint | Description | Access |
|--------|----------|-------------|--------|
| GET | `/api/invoices` | List invoices | Private |
| GET | `/api/invoices/stats` | Dashboard stats | Private |
| GET | `/api/invoices/upcoming-deliveries` | Upcoming deliveries | Private |
| GET | `/api/invoices/:id` | Get invoice | Private |
| POST | `/api/invoices` | Create invoice | Private |
| PUT | `/api/invoices/:id` | Update invoice | Private |
| PATCH | `/api/invoices/:id/delivery-status` | Update delivery | Private |
| PATCH | `/api/invoices/:id/payment` | Record payment | Private |
| DELETE | `/api/invoices/:id` | Cancel invoice | Admin |

### Clients

| Method | Endpoint | Description | Access |
|--------|----------|-------------|--------|
| GET | `/api/clients` | List clients | Private |
| GET | `/api/clients/autocomplete?q=` | Search clients | Private |
| GET | `/api/clients/:id` | Get client | Private |
| GET | `/api/clients/:id/invoices` | Client invoices | Private |
| POST | `/api/clients` | Create client | Private |
| PUT | `/api/clients/:id` | Update client | Private |

## Invoice Structure

```json
{
  "partyName": "Customer Name",
  "mobile": "9876543210",
  "items": [
    {
      "productName": "Tent 20x20",
      "price": 5000,
      "quantity": 2
    }
  ],
  "localFreight": 500,
  "transportation": 1000,
  "gstPercent": 18,
  "discount": 500,
  "advance": 5000,
  "deliveryDate": "2024-12-25",
  "notes": "Wedding decoration"
}
```

## Performance Optimizations

- **MongoDB Indexes**: Text search, compound indexes on frequently queried fields
- **Lean Queries**: Returns plain JS objects instead of Mongoose documents
- **Parallel Execution**: `Promise.all` for independent database operations
- **Connection Pooling**: 50 max connections with 10 minimum
- **Compression**: Gzip compression for all responses
- **Rate Limiting**: Protection against abuse
- **Real-Time Updates**: Socket.IO for instant data synchronization across clients

## Real-Time Features

The system uses **Socket.IO** to provide instant updates:

- ✅ **Product Changes**: Instantly see when products are added, updated, or inventory changes
- ✅ **Invoice Updates**: New invoices appear immediately for all users
- ✅ **Delivery Tracking**: Real-time delivery status updates
- ✅ **Payment Updates**: Instant payment recording and balance updates
- ✅ **Multi-User Support**: Multiple users can work simultaneously with live sync

**Socket.IO Connection:** `http://localhost:3002`

See [API_DOCUMENTATION.md](./API_DOCUMENTATION.md) for complete Socket.IO event list and usage examples.

## Security Features

- JWT authentication with 7-day expiry
- Password hashing with bcrypt (12 rounds)
- Helmet.js security headers
- CORS protection
- Rate limiting on API and auth routes
- Input validation and sanitization

## Project Structure

```
khushi_wedding_mall/
├── config/
│   └── db.js           # MongoDB connection
├── middleware/
│   └── auth.js         # JWT verification
├── models/
│   ├── User.js         # User schema
│   ├── Product.js      # Product schema
│   ├── Client.js       # Client schema
│   └── Invoice.js      # Invoice schema
├── routes/
│   ├── auth.js         # Auth routes
│   ├── products.js     # Product routes
│   ├── employees.js    # Employee routes
│   ├── invoices.js     # Invoice routes
│   └── clients.js      # Client routes
├── scripts/
│   └── seed.js         # Database seeder
├── server.js           # Main entry point
├── package.json
└── .env
```

## License

ISC
