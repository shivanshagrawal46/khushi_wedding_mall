const express = require('express');
const Order = require('../models/Order');
const Delivery = require('../models/Delivery');
const DeliveryInvoice = require('../models/DeliveryInvoice');
const Client = require('../models/Client');
const User = require('../models/User');
const { protect, adminOnly } = require('../middleware/auth');
const { getDashboardCounters, getTodayDeliveries } = require('../utils/orderCache');

const router = express.Router();

// All routes require authentication
router.use(protect);

// @route   GET /api/analytics/delivery-performance
// @desc    Get comprehensive delivery performance analytics (on-time, early, late)
//          Uses Order model to track full order delivery performance
// @access  Private
router.get('/delivery-performance', async (req, res) => {
  try {
    const { startDate, endDate, employeeId, clientId } = req.query;
    
    // Build date filter - use orderDate for filtering
    const dateFilter = {};
    if (startDate || endDate) {
      dateFilter.orderDate = {};
      if (startDate) dateFilter.orderDate.$gte = new Date(startDate);
      if (endDate) dateFilter.orderDate.$lte = new Date(endDate);
    }
    
    // Build query - track fully delivered orders (both 'delivered' and 'completed' statuses)
    // Include orders with status = 'delivered'/'completed' (fully delivered orders)
    // Only require expectedDeliveryDate - we'll use updatedAt as delivery date
    const matchQuery = {
      status: { $in: ['delivered', 'completed'] }, // Only fully delivered orders
      expectedDeliveryDate: { $exists: true, $ne: null },
      ...dateFilter
    };
    
    if (employeeId) {
      matchQuery.employee = employeeId;
    }
    
    if (clientId) {
      matchQuery.client = clientId;
    }
    
    // ULTRA OPTIMIZED: Single aggregation for all delivery performance metrics using Order model
    // Use updatedAt (when status changed to delivered) as delivery date
    // Compare updatedAt vs expectedDeliveryDate to determine performance
    const performanceResult = await Order.aggregate([
      { $match: matchQuery },
      {
        // Calculate performance: compare updatedAt (when order was marked as delivered) vs expectedDeliveryDate
        $addFields: {
          calculatedPerformance: {
            $cond: {
              if: { $ne: ['$deliveryPerformance', null] },
              then: '$deliveryPerformance',
              else: {
                $let: {
                  vars: {
                    // Calculate difference in days (can be negative, zero, or positive)
                    diffDays: {
                      $divide: [
                        { $subtract: ['$updatedAt', '$expectedDeliveryDate'] },
                        1000 * 60 * 60 * 24
                      ]
                    }
                  },
                  in: {
                    $cond: {
                      // If updatedAt < expectedDeliveryDate → early (delivered before expected)
                      if: { $lt: ['$$diffDays', 0] },
                      then: 'early',
                      else: {
                        $cond: {
                          // If updatedAt == expectedDeliveryDate (same day) → on_time
                          // Also consider same day as on_time (diffDays between 0 and 1)
                          if: { $lte: ['$$diffDays', 1] },
                          then: 'on_time',
                          else: 'late' // If updatedAt > expectedDeliveryDate → late
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      {
        $facet: {
          // Performance counts - use calculatedPerformance
          onTime: [{ $match: { calculatedPerformance: 'on_time' } }, { $count: 'count' }],
          early: [{ $match: { calculatedPerformance: 'early' } }, { $count: 'count' }],
          late: [{ $match: { calculatedPerformance: 'late' } }, { $count: 'count' }],
          total: [{ $count: 'count' }],
          
          // Performance by month (for charts) - use updatedAt (when order was marked as delivered)
          monthlyPerformance: [
            {
              $group: {
                _id: {
                  year: { $year: '$updatedAt' },
                  month: { $month: '$updatedAt' },
                  performance: '$calculatedPerformance'
                },
                count: { $sum: 1 }
              }
            },
            { $sort: { '_id.year': 1, '_id.month': 1 } }
          ],
          
          // Performance by day (last 30 days for trends) - use updatedAt
          dailyPerformance: [
            {
              $match: {
                updatedAt: {
                  $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
                }
              }
            },
            {
              $group: {
                _id: {
                  date: { $dateToString: { format: '%Y-%m-%d', date: '$updatedAt' } },
                  performance: '$calculatedPerformance'
                },
                count: { $sum: 1 }
              }
            },
            { $sort: { '_id.date': 1 } }
          ],
          
          // Average delivery time (days difference) - compare updatedAt vs expectedDeliveryDate
          avgDeliveryTime: [
            {
              $project: {
                diffDays: {
                  $divide: [
                    { $subtract: ['$updatedAt', '$expectedDeliveryDate'] },
                    1000 * 60 * 60 * 24
                  ]
                }
              }
            },
            {
              $group: {
                _id: null,
                avgDays: { $avg: '$diffDays' },
                minDays: { $min: '$diffDays' },
                maxDays: { $max: '$diffDays' }
              }
            }
          ]
        }
      }
    ]);
    
    const result = performanceResult[0];
    const onTimeDeliveries = result.onTime[0]?.count || 0;
    const earlyDeliveries = result.early[0]?.count || 0;
    const lateDeliveries = result.late[0]?.count || 0;
    const totalDeliveries = result.total[0]?.count || 0;
    
    // Format monthly performance for charts
    const monthlyData = {};
    result.monthlyPerformance.forEach(item => {
      const key = `${item._id.year}-${String(item._id.month).padStart(2, '0')}`;
      if (!monthlyData[key]) {
        monthlyData[key] = { onTime: 0, early: 0, late: 0, total: 0 };
      }
      monthlyData[key][item._id.performance] = item.count;
      monthlyData[key].total += item.count;
    });
    
    // Format daily performance for trends
    const dailyData = {};
    result.dailyPerformance.forEach(item => {
      if (!dailyData[item._id.date]) {
        dailyData[item._id.date] = { onTime: 0, early: 0, late: 0, total: 0 };
      }
      dailyData[item._id.date][item._id.performance] = item.count;
      dailyData[item._id.date].total += item.count;
    });
    
    const avgDeliveryTime = result.avgDeliveryTime[0] || null;
    
    res.json({
      success: true,
      data: {
        summary: {
          totalDeliveries,
          onTimeDeliveries,
          earlyDeliveries,
          lateDeliveries,
          onTimePercentage: totalDeliveries > 0 
            ? Math.round((onTimeDeliveries / totalDeliveries) * 100) 
            : 0,
          earlyPercentage: totalDeliveries > 0 
            ? Math.round((earlyDeliveries / totalDeliveries) * 100) 
            : 0,
          latePercentage: totalDeliveries > 0 
            ? Math.round((lateDeliveries / totalDeliveries) * 100) 
            : 0
        },
        performanceMetrics: avgDeliveryTime ? {
          averageDaysDifference: Math.round(avgDeliveryTime.avgDays * 100) / 100,
          minDaysDifference: Math.round(avgDeliveryTime.minDays * 100) / 100,
          maxDaysDifference: Math.round(avgDeliveryTime.maxDays * 100) / 100
        } : null,
        monthlyTrends: Object.keys(monthlyData).sort().map(date => ({
          date,
          ...monthlyData[date]
        })),
        dailyTrends: Object.keys(dailyData).sort().map(date => ({
          date,
          ...dailyData[date]
        })),
        chartData: {
          pieChart: [
            { name: 'On Time', value: onTimeDeliveries, color: '#10b981' },
            { name: 'Early', value: earlyDeliveries, color: '#3b82f6' },
            { name: 'Late', value: lateDeliveries, color: '#ef4444' }
          ],
          barChart: Object.keys(monthlyData).sort().map(date => ({
            month: date,
            onTime: monthlyData[date].onTime,
            early: monthlyData[date].early,
            late: monthlyData[date].late
          }))
        }
      }
    });
  } catch (error) {
    console.error('Get delivery performance error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Server error'
    });
  }
});

// @route   GET /api/analytics/employees
// @desc    Get comprehensive employee performance statistics
//          Tracks by employeeName field in orders (string matching)
// @access  Private
router.get('/employees', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const employees = await User.find({ role: 'employee', isActive: true })
      .select('name username employeeStats')
      .lean();
    
    // Build date filter for orders
    const dateFilter = {};
    if (startDate || endDate) {
      dateFilter.orderDate = {};
      if (startDate) dateFilter.orderDate.$gte = new Date(startDate);
      if (endDate) dateFilter.orderDate.$lte = new Date(endDate);
    }
    
    // Get detailed stats for each employee using Order model (employeeName field)
    const employeeStats = await Promise.all(employees.map(async (employee) => {
      // Get order stats - filter by employeeName (case-insensitive) OR employee ObjectId
      // This handles cases where employeeName might not match exactly or is null
      const orderStats = await Order.aggregate([
        {
          $match: {
            $or: [
              { employeeName: { $regex: new RegExp(`^${employee.name}$`, 'i') } }, // Case-insensitive match
              { employee: employee._id } // Fallback to ObjectId match
            ],
            ...dateFilter
          }
        },
        {
          $facet: {
            total: [{ $count: 'count' }],
            open: [{ $match: { status: 'open' } }, { $count: 'count' }],
            inProgress: [{ $match: { status: { $in: ['in_progress', 'partial_delivered'] } } }, { $count: 'count' }],
            completed: [{ $match: { status: 'completed' } }, { $count: 'count' }],
            totalRevenue: [
              {
                $group: {
                  _id: null,
                  total: { $sum: '$grandTotal' }
                }
              }
            ]
          }
        }
      ]);
      
      // Get delivery performance stats from Order model (fully delivered orders created by this employee)
      // Use updatedAt as delivery date (when status changed to delivered/completed)
      const deliveryStats = await Order.aggregate([
        {
          $match: {
            $or: [
              { employeeName: { $regex: new RegExp(`^${employee.name}$`, 'i') } }, // Case-insensitive match
              { employee: employee._id } // Fallback to ObjectId match
            ],
            status: { $in: ['delivered', 'completed'] }, // Only fully delivered orders
            expectedDeliveryDate: { $exists: true, $ne: null },
            ...dateFilter
          }
        },
        {
          // Calculate performance: compare updatedAt (when delivered) vs expectedDeliveryDate
          $addFields: {
            calculatedPerformance: {
              $cond: {
                if: { $ne: ['$deliveryPerformance', null] },
                then: '$deliveryPerformance',
                else: {
                  $let: {
                    vars: {
                      diffDays: {
                        $divide: [
                          { $subtract: ['$updatedAt', '$expectedDeliveryDate'] },
                          1000 * 60 * 60 * 24
                        ]
                      }
                    },
                    in: {
                      $cond: {
                        if: { $lt: ['$$diffDays', 0] },
                        then: 'early',
                        else: {
                          $cond: {
                            if: { $lte: ['$$diffDays', 1] },
                            then: 'on_time',
                            else: 'late'
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        {
          $facet: {
            total: [{ $count: 'count' }],
            onTime: [{ $match: { calculatedPerformance: 'on_time' } }, { $count: 'count' }],
            early: [{ $match: { calculatedPerformance: 'early' } }, { $count: 'count' }],
            late: [{ $match: { calculatedPerformance: 'late' } }, { $count: 'count' }],
            totalAmount: [
              {
                $group: {
                  _id: null,
                  total: { $sum: '$grandTotal' }
                }
              }
            ]
          }
        }
      ]);
      
      const orderResult = orderStats[0] || {};
      const deliveryResult = deliveryStats[0] || {};
      
      const totalOrders = orderResult.total?.[0]?.count || 0;
      const openOrders = orderResult.open?.[0]?.count || 0;
      const inProgressOrders = orderResult.inProgress?.[0]?.count || 0;
      const completedOrders = orderResult.completed?.[0]?.count || 0;
      const totalRevenue = orderResult.totalRevenue?.[0]?.total || 0;
      
      const totalDeliveries = deliveryResult.total?.[0]?.count || 0;
      const onTimeDeliveries = deliveryResult.onTime?.[0]?.count || 0;
      const earlyDeliveries = deliveryResult.early?.[0]?.count || 0;
      const lateDeliveries = deliveryResult.late?.[0]?.count || 0;
      const deliveryRevenue = deliveryResult.totalAmount?.[0]?.total || 0;
      
      const onTimePercentage = totalDeliveries > 0 
        ? Math.round((onTimeDeliveries / totalDeliveries) * 100) 
        : 0;
      
      return {
        _id: employee._id,
        name: employee.name,
        username: employee.username,
        orders: {
          total: totalOrders,
          open: openOrders,
          inProgress: inProgressOrders,
          completed: completedOrders,
          totalRevenue
        },
        deliveries: {
          total: totalDeliveries,
          onTime: onTimeDeliveries,
          early: earlyDeliveries,
          late: lateDeliveries,
          onTimePercentage,
          totalRevenue: deliveryRevenue
        },
        performance: {
          onTimePercentage,
          averageOrdersPerMonth: totalOrders > 0 ? Math.round(totalOrders / 12) : 0,
          completionRate: totalOrders > 0 
            ? Math.round((completedOrders / totalOrders) * 100) 
            : 0
        }
      };
    }));
    
    // Sort by total deliveries (descending)
    employeeStats.sort((a, b) => b.deliveries.total - a.deliveries.total);
    
    res.json({
      success: true,
      data: employeeStats,
      summary: {
        totalEmployees: employeeStats.length,
        totalDeliveries: employeeStats.reduce((sum, emp) => sum + emp.deliveries.total, 0),
        totalOrders: employeeStats.reduce((sum, emp) => sum + emp.orders.total, 0),
        averageOnTimePercentage: employeeStats.length > 0
          ? Math.round(
              employeeStats.reduce((sum, emp) => sum + emp.deliveries.onTimePercentage, 0) / 
              employeeStats.length
            )
          : 0
      }
    });
  } catch (error) {
    console.error('Get employee stats error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Server error'
    });
  }
});

// @route   GET /api/analytics/employees/:id
// @desc    Get detailed stats for specific employee with time-series data
// @access  Private
router.get('/employees/:id', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const employee = await User.findById(req.params.id)
      .select('name username employeeStats')
      .lean();
    
    if (!employee) {
      return res.status(404).json({
        success: false,
        error: 'Employee not found'
      });
    }
    
    // Build date filter
    const dateFilter = {};
    if (startDate || endDate) {
      dateFilter.orderDate = {};
      if (startDate) dateFilter.orderDate.$gte = new Date(startDate);
      if (endDate) dateFilter.orderDate.$lte = new Date(endDate);
    }
    
    // Get comprehensive stats - all based on Order model (employeeName field)
    const [orderStats, deliveryStats, recentOrders, monthlyTrends] = await Promise.all([
      // Order statistics - filter by employeeName (case-insensitive) OR employee ObjectId
      Order.aggregate([
        {
          $match: {
            $or: [
              { employeeName: { $regex: new RegExp(`^${employee.name}$`, 'i') } }, // Case-insensitive match
              { employee: employee._id } // Fallback to ObjectId match
            ],
            ...dateFilter
          }
        },
        {
          $facet: {
            total: [{ $count: 'count' }],
            open: [{ $match: { status: 'open' } }, { $count: 'count' }],
            inProgress: [{ $match: { status: { $in: ['in_progress', 'partial_delivered'] } } }, { $count: 'count' }],
            completed: [{ $match: { status: 'completed' } }, { $count: 'count' }],
            totalRevenue: [
              {
                $group: {
                  _id: null,
                  total: { $sum: '$grandTotal' },
                  totalAdvance: { $sum: '$advance' },
                  totalDue: { $sum: '$balanceDue' }
                }
              }
            ]
          }
        }
      ]),
      
      // Delivery statistics from Order model (fully delivered orders created by this employee)
      // Use updatedAt as delivery date (when status changed to delivered/completed)
      Order.aggregate([
        {
          $match: {
            $or: [
              { employeeName: { $regex: new RegExp(`^${employee.name}$`, 'i') } }, // Case-insensitive match
              { employee: employee._id } // Fallback to ObjectId match
            ],
            status: { $in: ['delivered', 'completed'] }, // Only fully delivered orders
            expectedDeliveryDate: { $exists: true, $ne: null },
            ...dateFilter
          }
        },
        {
          // Calculate performance: compare updatedAt (when delivered) vs expectedDeliveryDate
          $addFields: {
            calculatedPerformance: {
              $cond: {
                if: { $ne: ['$deliveryPerformance', null] },
                then: '$deliveryPerformance',
                else: {
                  $let: {
                    vars: {
                      diffDays: {
                        $divide: [
                          { $subtract: ['$updatedAt', '$expectedDeliveryDate'] },
                          1000 * 60 * 60 * 24
                        ]
                      }
                    },
                    in: {
                      $cond: {
                        if: { $lt: ['$$diffDays', 0] },
                        then: 'early',
                        else: {
                          $cond: {
                            if: { $lte: ['$$diffDays', 1] },
                            then: 'on_time',
                            else: 'late'
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        {
          $facet: {
            total: [{ $count: 'count' }],
            onTime: [{ $match: { calculatedPerformance: 'on_time' } }, { $count: 'count' }],
            early: [{ $match: { calculatedPerformance: 'early' } }, { $count: 'count' }],
            late: [{ $match: { calculatedPerformance: 'late' } }, { $count: 'count' }],
            totalRevenue: [
              {
                $group: {
                  _id: null,
                  total: { $sum: '$grandTotal' }
                }
              }
            ]
          }
        }
      ]),
      
      // Recent orders - filter by employeeName (case-insensitive) OR employee ObjectId
      Order.find({
        $or: [
          { employeeName: { $regex: new RegExp(`^${employee.name}$`, 'i') } },
          { employee: employee._id }
        ],
        ...dateFilter
      })
        .select('orderNumber partyName orderDate status deliveryPerformance grandTotal actualDeliveryDate expectedDeliveryDate')
        .sort('-orderDate')
        .limit(10)
        .lean(),
      
      // Monthly trends from Order model - filter by employeeName (case-insensitive) OR employee ObjectId
      // Use updatedAt as delivery date (when status changed to delivered/completed)
      Order.aggregate([
        {
          $match: {
            $or: [
              { employeeName: { $regex: new RegExp(`^${employee.name}$`, 'i') } }, // Case-insensitive match
              { employee: employee._id } // Fallback to ObjectId match
            ],
            status: { $in: ['delivered', 'completed'] }, // Only fully delivered orders
            expectedDeliveryDate: { $exists: true, $ne: null },
            ...dateFilter
          }
        },
        {
          // Calculate performance: compare updatedAt (when delivered) vs expectedDeliveryDate
          $addFields: {
            calculatedPerformance: {
              $cond: {
                if: { $ne: ['$deliveryPerformance', null] },
                then: '$deliveryPerformance',
                else: {
                  $let: {
                    vars: {
                      diffDays: {
                        $divide: [
                          { $subtract: ['$updatedAt', '$expectedDeliveryDate'] },
                          1000 * 60 * 60 * 24
                        ]
                      }
                    },
                    in: {
                      $cond: {
                        if: { $lt: ['$$diffDays', 0] },
                        then: 'early',
                        else: {
                          $cond: {
                            if: { $lte: ['$$diffDays', 1] },
                            then: 'on_time',
                            else: 'late'
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        {
          $group: {
            _id: {
              year: { $year: '$updatedAt' }, // Use updatedAt as delivery date
              month: { $month: '$updatedAt' },
              performance: '$calculatedPerformance'
            },
            count: { $sum: 1 }
          }
        },
        { $sort: { '_id.year': -1, '_id.month': -1 } }
      ])
    ]);
    
    const orderResult = orderStats[0] || {};
    const deliveryResult = deliveryStats[0] || {};
    
    const totalOrders = orderResult.total?.[0]?.count || 0;
    const openOrders = orderResult.open?.[0]?.count || 0;
    const inProgressOrders = orderResult.inProgress?.[0]?.count || 0;
    const completedOrders = orderResult.completed?.[0]?.count || 0;
    const orderRevenue = orderResult.totalRevenue?.[0] || {};
    
    const totalDeliveries = deliveryResult.total?.[0]?.count || 0;
    const onTimeDeliveries = deliveryResult.onTime?.[0]?.count || 0;
    const earlyDeliveries = deliveryResult.early?.[0]?.count || 0;
    const lateDeliveries = deliveryResult.late?.[0]?.count || 0;
    const deliveryRevenue = deliveryResult.totalRevenue?.[0]?.total || 0;
    
    // Format monthly trends
    const monthlyData = {};
    monthlyTrends.forEach(item => {
      const key = `${item._id.year}-${String(item._id.month).padStart(2, '0')}`;
      if (!monthlyData[key]) {
        monthlyData[key] = { onTime: 0, early: 0, late: 0, total: 0 };
      }
      if (item._id.performance) {
        monthlyData[key][item._id.performance] = item.count;
      }
      monthlyData[key].total += item.count;
    });
    
    res.json({
      success: true,
      data: {
        employee: {
          _id: employee._id,
          name: employee.name,
          username: employee.username
        },
        orders: {
          total: totalOrders,
          open: openOrders,
          inProgress: inProgressOrders,
          completed: completedOrders,
          revenue: {
            total: orderRevenue.total || 0,
            advance: orderRevenue.totalAdvance || 0,
            due: orderRevenue.totalDue || 0
          }
        },
        deliveries: {
          total: totalDeliveries,
          onTime: onTimeDeliveries,
          early: earlyDeliveries,
          late: lateDeliveries,
          onTimePercentage: totalDeliveries > 0 
            ? Math.round((onTimeDeliveries / totalDeliveries) * 100) 
            : 0,
          totalRevenue: deliveryRevenue
        },
        performance: {
          onTimePercentage: totalDeliveries > 0 
            ? Math.round((onTimeDeliveries / totalDeliveries) * 100) 
            : 0,
          completionRate: totalOrders > 0 
            ? Math.round((completedOrders / totalOrders) * 100) 
            : 0,
          averageOrdersPerMonth: totalOrders > 0 ? Math.round(totalOrders / 12) : 0
        },
        trends: {
          monthly: Object.keys(monthlyData).sort().map(date => ({
            date,
            ...monthlyData[date]
          }))
        },
        recentOrders,
        chartData: {
          performancePie: [
            { name: 'On Time', value: onTimeDeliveries, color: '#10b981' },
            { name: 'Early', value: earlyDeliveries, color: '#3b82f6' },
            { name: 'Late', value: lateDeliveries, color: '#ef4444' }
          ],
          monthlyBar: Object.keys(monthlyData).sort().map(date => ({
            month: date,
            onTime: monthlyData[date].onTime,
            early: monthlyData[date].early,
            late: monthlyData[date].late
          }))
        }
      }
    });
  } catch (error) {
    console.error('Get employee detail error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Server error'
    });
  }
});

// @route   GET /api/analytics/clients
// @desc    Get comprehensive client analytics with order and payment stats
// @access  Private
router.get('/clients', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    // Build date filter
    const dateFilter = {};
    if (startDate || endDate) {
      dateFilter.orderDate = {};
      if (startDate) dateFilter.orderDate.$gte = new Date(startDate);
      if (endDate) dateFilter.orderDate.$lte = new Date(endDate);
    }
    
    // Get all clients with comprehensive stats
    const clients = await Client.find()
      .select('partyName mobile address email totalOrders totalSpent')
      .lean();
    
    // Get detailed stats for each client
    const clientStats = await Promise.all(clients.map(async (client) => {
      const stats = await Order.aggregate([
        { $match: { client: client._id, ...dateFilter } },
        {
          $facet: {
            total: [{ $count: 'count' }],
            open: [{ $match: { status: 'open' } }, { $count: 'count' }],
            inProgress: [{ $match: { status: { $in: ['in_progress', 'partial_delivered'] } } }, { $count: 'count' }],
            completed: [{ $match: { status: 'completed' } }, { $count: 'count' }],
            delivered: [{ $match: { status: 'delivered' } }, { $count: 'count' }],
            unpaid: [{ $match: { paymentStatus: 'unpaid' } }, { $count: 'count' }],
            partial: [{ $match: { paymentStatus: 'partial' } }, { $count: 'count' }],
            paid: [{ $match: { paymentStatus: 'paid' } }, { $count: 'count' }],
            revenue: [
              {
                $group: {
                  _id: null,
                  totalAmount: { $sum: '$grandTotal' },
                  totalPaid: { $sum: '$advance' },
                  totalDue: { $sum: '$balanceDue' }
                }
              }
            ]
          }
        }
      ]);
      
      const result = stats[0] || {};
      const revenue = result.revenue?.[0] || {};
      
      return {
        _id: client._id,
        partyName: client.partyName,
        mobile: client.mobile,
        address: client.address,
        email: client.email,
        orders: {
          total: result.total?.[0]?.count || 0,
          open: result.open?.[0]?.count || 0,
          inProgress: result.inProgress?.[0]?.count || 0,
          completed: result.completed?.[0]?.count || 0,
          delivered: result.delivered?.[0]?.count || 0
        },
        payments: {
          unpaid: result.unpaid?.[0]?.count || 0,
          partial: result.partial?.[0]?.count || 0,
          paid: result.paid?.[0]?.count || 0
        },
        revenue: {
          totalAmount: revenue.totalAmount || 0,
          totalPaid: revenue.totalPaid || 0,
          totalDue: revenue.totalDue || 0,
          paymentPercentage: revenue.totalAmount > 0
            ? Math.round((revenue.totalPaid / revenue.totalAmount) * 100)
            : 0
        }
      };
    }));
    
    // Sort by total orders (descending)
    clientStats.sort((a, b) => b.orders.total - a.orders.total);
    
    res.json({
      success: true,
      data: clientStats,
      summary: {
        totalClients: clientStats.length,
        totalOrders: clientStats.reduce((sum, c) => sum + c.orders.total, 0),
        totalRevenue: clientStats.reduce((sum, c) => sum + c.revenue.totalAmount, 0),
        totalPaid: clientStats.reduce((sum, c) => sum + c.revenue.totalPaid, 0),
        totalDue: clientStats.reduce((sum, c) => sum + c.revenue.totalDue, 0)
      }
    });
  } catch (error) {
    console.error('Get client analytics error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Server error'
    });
  }
});

// @route   GET /api/analytics/clients/:id
// @desc    Get detailed analytics for specific client with time-series data
// @access  Private
router.get('/clients/:id', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const client = await Client.findById(req.params.id).lean();
    
    if (!client) {
      return res.status(404).json({
        success: false,
        error: 'Client not found'
      });
    }
    
    // Build date filter
    const dateFilter = {};
    if (startDate || endDate) {
      dateFilter.orderDate = {};
      if (startDate) dateFilter.orderDate.$gte = new Date(startDate);
      if (endDate) dateFilter.orderDate.$lte = new Date(endDate);
    }
    
    // Get comprehensive client stats
    const [orderStats, allOrders, monthlyTrends, paymentTrends] = await Promise.all([
      // Order statistics
      Order.aggregate([
        { $match: { client: client._id, ...dateFilter } },
        {
          $facet: {
            total: [{ $count: 'count' }],
            open: [{ $match: { status: 'open' } }, { $count: 'count' }],
            inProgress: [{ $match: { status: { $in: ['in_progress', 'partial_delivered'] } } }, { $count: 'count' }],
            completed: [{ $match: { status: 'completed' } }, { $count: 'count' }],
            delivered: [{ $match: { status: 'delivered' } }, { $count: 'count' }],
            unpaid: [{ $match: { paymentStatus: 'unpaid' } }, { $count: 'count' }],
            partial: [{ $match: { paymentStatus: 'partial' } }, { $count: 'count' }],
            paid: [{ $match: { paymentStatus: 'paid' } }, { $count: 'count' }],
            revenue: [
              {
                $group: {
                  _id: null,
                  totalAmount: { $sum: '$grandTotal' },
                  totalPaid: { $sum: '$advance' },
                  totalDue: { $sum: '$balanceDue' }
                }
              }
            ]
          }
        }
      ]),
      
      // All orders with details
      Order.find({ client: client._id, ...dateFilter })
        .select('orderNumber orderDate status paymentStatus grandTotal balanceDue advance items comment')
        .sort('-orderDate')
        .lean(),
      
      // Monthly order trends
      Order.aggregate([
        { $match: { client: client._id, ...dateFilter } },
        {
          $group: {
            _id: {
              year: { $year: '$orderDate' },
              month: { $month: '$orderDate' }
            },
            count: { $sum: 1 },
            revenue: { $sum: '$grandTotal' }
          }
        },
        { $sort: { '_id.year': -1, '_id.month': -1 } }
      ]),
      
      // Payment trends
      Order.aggregate([
        { $match: { client: client._id, ...dateFilter } },
        {
          $group: {
            _id: {
              year: { $year: '$orderDate' },
              month: { $month: '$orderDate' },
              paymentStatus: '$paymentStatus'
            },
            count: { $sum: 1 },
            amount: { $sum: '$grandTotal' }
          }
        },
        { $sort: { '_id.year': -1, '_id.month': -1 } }
      ])
    ]);
    
    const stats = orderStats[0] || {};
    const revenue = stats.revenue?.[0] || {};
    
    // Format monthly trends
    const monthlyData = {};
    monthlyTrends.forEach(item => {
      const key = `${item._id.year}-${String(item._id.month).padStart(2, '0')}`;
      monthlyData[key] = {
        orders: item.count,
        revenue: item.revenue
      };
    });
    
    // Format payment trends
    const paymentData = {};
    paymentTrends.forEach(item => {
      const key = `${item._id.year}-${String(item._id.month).padStart(2, '0')}`;
      if (!paymentData[key]) {
        paymentData[key] = { unpaid: 0, partial: 0, paid: 0 };
      }
      paymentData[key][item._id.paymentStatus] = item.count;
    });
    
    res.json({
      success: true,
      data: {
        client: {
          _id: client._id,
          partyName: client.partyName,
          mobile: client.mobile,
          address: client.address,
          email: client.email
        },
        summary: {
          orders: {
            total: stats.total?.[0]?.count || 0,
            open: stats.open?.[0]?.count || 0,
            inProgress: stats.inProgress?.[0]?.count || 0,
            completed: stats.completed?.[0]?.count || 0,
            delivered: stats.delivered?.[0]?.count || 0
          },
          payments: {
            unpaid: stats.unpaid?.[0]?.count || 0,
            partial: stats.partial?.[0]?.count || 0,
            paid: stats.paid?.[0]?.count || 0
          },
          revenue: {
            totalAmount: revenue.totalAmount || 0,
            totalPaid: revenue.totalPaid || 0,
            totalDue: revenue.totalDue || 0,
            paymentPercentage: revenue.totalAmount > 0
              ? Math.round((revenue.totalPaid / revenue.totalAmount) * 100)
              : 0
          }
        },
        orders: allOrders,
        trends: {
          monthly: Object.keys(monthlyData).sort().map(date => ({
            date,
            ...monthlyData[date]
          })),
          payments: Object.keys(paymentData).sort().map(date => ({
            date,
            ...paymentData[date]
          }))
        },
        chartData: {
          orderStatusPie: [
            { name: 'Open', value: stats.open?.[0]?.count || 0 },
            { name: 'In Progress', value: stats.inProgress?.[0]?.count || 0 },
            { name: 'Completed', value: stats.completed?.[0]?.count || 0 },
            { name: 'Delivered', value: stats.delivered?.[0]?.count || 0 }
          ],
          paymentStatusPie: [
            { name: 'Unpaid', value: stats.unpaid?.[0]?.count || 0 },
            { name: 'Partial', value: stats.partial?.[0]?.count || 0 },
            { name: 'Paid', value: stats.paid?.[0]?.count || 0 }
          ],
          monthlyRevenue: Object.keys(monthlyData).sort().map(date => ({
            month: date,
            revenue: monthlyData[date].revenue,
            orders: monthlyData[date].orders
          }))
        }
      }
    });
  } catch (error) {
    console.error('Get client detail error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Server error'
    });
  }
});

// @route   GET /api/analytics/payments
// @desc    Get comprehensive payment analytics with filtering and trends
// @access  Private
router.get('/payments', async (req, res) => {
  try {
    const { 
      clientId,
      paymentStatus,
      deliveryStatus,
      startDate,
      endDate
    } = req.query;
    
    const query = {};
    
    // Filter by client
    if (clientId) {
      query.client = clientId;
    }
    
    // Filter by payment status
    if (paymentStatus) {
      query.paymentStatus = paymentStatus;
    }
    
    // Filter by delivery status
    if (deliveryStatus) {
      query.status = deliveryStatus;
    }
    
    // Date range
    if (startDate || endDate) {
      query.orderDate = {};
      if (startDate) query.orderDate.$gte = new Date(startDate);
      if (endDate) query.orderDate.$lte = new Date(endDate);
    }
    
    // Get comprehensive payment analytics
    const [orders, paymentStats, monthlyTrends] = await Promise.all([
      // All orders matching filter
      Order.find(query)
        .select('orderNumber partyName mobile orderDate status paymentStatus grandTotal balanceDue advance')
        .sort('-orderDate')
        .lean(),
      
      // Payment statistics
      Order.aggregate([
        { $match: query },
        {
          $facet: {
            total: [{ $count: 'count' }],
            unpaid: [{ $match: { paymentStatus: 'unpaid' } }, { $count: 'count' }],
            partial: [{ $match: { paymentStatus: 'partial' } }, { $count: 'count' }],
            paid: [{ $match: { paymentStatus: 'paid' } }, { $count: 'count' }],
            revenue: [
              {
                $group: {
                  _id: null,
                  totalAmount: { $sum: '$grandTotal' },
                  totalPaid: { $sum: '$advance' },
                  totalDue: { $sum: '$balanceDue' }
                }
              }
            ]
          }
        }
      ]),
      
      // Monthly payment trends
      Order.aggregate([
        { $match: query },
        {
          $group: {
            _id: {
              year: { $year: '$orderDate' },
              month: { $month: '$orderDate' },
              paymentStatus: '$paymentStatus'
            },
            count: { $sum: 1 },
            amount: { $sum: '$grandTotal' },
            paid: { $sum: '$advance' }
          }
        },
        { $sort: { '_id.year': -1, '_id.month': -1 } }
      ])
    ]);
    
    const stats = paymentStats[0] || {};
    const revenue = stats.revenue?.[0] || {};
    
    // Format monthly trends
    const monthlyData = {};
    monthlyTrends.forEach(item => {
      const key = `${item._id.year}-${String(item._id.month).padStart(2, '0')}`;
      if (!monthlyData[key]) {
        monthlyData[key] = { unpaid: 0, partial: 0, paid: 0, totalAmount: 0, totalPaid: 0 };
      }
      monthlyData[key][item._id.paymentStatus] = item.count;
      monthlyData[key].totalAmount += item.amount;
      monthlyData[key].totalPaid += item.paid;
    });
    
    // Filter orders by delivery status if specified
    let filteredOrders = orders;
    if (deliveryStatus === 'delivered_not_paid') {
      filteredOrders = orders.filter(o => 
        o.status === 'delivered' && o.paymentStatus !== 'paid'
      );
    } else if (deliveryStatus === 'open_payments') {
      filteredOrders = orders.filter(o => 
        o.paymentStatus === 'unpaid' || o.paymentStatus === 'partial'
      );
    } else if (deliveryStatus === 'closed_payments') {
      filteredOrders = orders.filter(o => o.paymentStatus === 'paid');
    }
    
    res.json({
      success: true,
      data: {
        summary: {
          total: stats.total?.[0]?.count || 0,
          unpaid: stats.unpaid?.[0]?.count || 0,
          partial: stats.partial?.[0]?.count || 0,
          paid: stats.paid?.[0]?.count || 0,
          revenue: {
            totalAmount: revenue.totalAmount || 0,
            totalPaid: revenue.totalPaid || 0,
            totalDue: revenue.totalDue || 0,
            collectionRate: revenue.totalAmount > 0
              ? Math.round((revenue.totalPaid / revenue.totalAmount) * 100)
              : 0
          }
        },
        orders: filteredOrders,
        count: filteredOrders.length,
        trends: {
          monthly: Object.keys(monthlyData).sort().map(date => ({
            date,
            ...monthlyData[date]
          }))
        },
        chartData: {
          paymentStatusPie: [
            { name: 'Unpaid', value: stats.unpaid?.[0]?.count || 0, color: '#ef4444' },
            { name: 'Partial', value: stats.partial?.[0]?.count || 0, color: '#f59e0b' },
            { name: 'Paid', value: stats.paid?.[0]?.count || 0, color: '#10b981' }
          ],
          monthlyRevenue: Object.keys(monthlyData).sort().map(date => ({
            month: date,
            totalAmount: monthlyData[date].totalAmount,
            totalPaid: monthlyData[date].totalPaid,
            totalDue: monthlyData[date].totalAmount - monthlyData[date].totalPaid
          }))
        }
      }
    });
  } catch (error) {
    console.error('Get payment analytics error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Server error'
    });
  }
});

module.exports = router;
