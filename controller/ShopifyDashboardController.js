// controller/ShopifyDashboardController.js
//
// Shopify-only dashboard, reading from warehouse v2 `shopify_domain.*`.
// Shopify is ecommerce, not accounting — no invoices/bills/vendors/P&L like
// QuickBooks or Zoho. Widgets here are order/product/customer shaped
// instead: Overview (revenue, orders, AOV, top products), Orders,
// Products, Customers.

const { Op, fn, col } = require('sequelize');
const { getDomainModel } = require('../model/warehouse/DomainModelFactory');
require('../services/warehouse/transformers/shopifyTransformer'); // registers shopify_domain models

const DimCustomer  = getDomainModel('shopify', 'dim_customers');
const DimProduct   = getDomainModel('shopify', 'dim_products');
const FactOrder    = getDomainModel('shopify', 'fact_orders');
const FactOrderLine = getDomainModel('shopify', 'fact_order_lines');
const { getMonthlyRevenue } = require('../services/warehouse/shopifyAggregates');

/* ====================================================================== */
/*                     1. OVERVIEW DASHBOARD                              */
/* ====================================================================== */
exports.getOverviewDashboard = async (req, res) => {
  try {
    const { companyId } = req.params;
    const { period = 'MTD' } = req.query;
    const { startDate, endDate } = getDateRange(period);

    const [revenue, orderCount, recentOrders, monthlyChart, topProducts] = await Promise.all([

      FactOrder.findOne({
        attributes: [[fn('COALESCE', fn('SUM', col('total_amount')), 0), 'total']],
        where: { company_id: companyId, transaction_date: { [Op.between]: [startDate, endDate] } },
        raw: true
      }),

      FactOrder.count({
        where: { company_id: companyId, transaction_date: { [Op.between]: [startDate, endDate] } }
      }),

      FactOrder.findAll({
        where: { company_id: companyId },
        order: [['transaction_date', 'DESC']],
        limit: 10,
        raw: true
      }),

      getMonthlyRevenue(companyId, { limit: 12 }),

      FactOrderLine.findAll({
        attributes: [
          'product_id', 'title',
          [fn('SUM', col('line_total')), 'totalRevenue'],
          [fn('SUM', col('quantity')),   'unitsSold']
        ],
        where: { company_id: companyId },
        group: ['product_id', 'title'],
        order: [[fn('SUM', col('line_total')), 'DESC']],
        limit: 5,
        raw: true
      })
    ]);

    const totalRevenue = parseFloat(revenue?.total || 0);
    const avgOrderValue = orderCount > 0 ? (totalRevenue / orderCount) : 0;

    res.json({
      success: true,
      period,
      source: 'shopify',
      lastUpdated: new Date(),
      metrics: {
        revenue:      { value: totalRevenue,  label: 'Revenue' },
        orders:       { value: orderCount,    label: 'Orders' },
        avgOrderValue:{ value: parseFloat(avgOrderValue.toFixed(2)), label: 'Avg Order Value' }
      },
      charts: {
        monthly: monthlyChart.map(m => ({
          month:   m.month_label,
          revenue: parseFloat(m.revenue || 0),
          orders:  parseInt(m.order_count || 0)
        })),
        topProducts: topProducts.map(p => ({
          productId: p.product_id,
          title:     p.title || 'Unknown',
          revenue:   parseFloat(p.totalRevenue || 0),
          unitsSold: parseInt(p.unitsSold || 0)
        }))
      },
      recentOrders: recentOrders.map(o => ({
        id:                o.order_id,
        orderNumber:       o.order_number,
        customerEmail:     o.customer_email,
        amount:            parseFloat(o.total_amount),
        financialStatus:   o.financial_status,
        fulfillmentStatus: o.fulfillment_status,
        date:              o.transaction_date,
        source:            'shopify'
      }))
    });

  } catch (error) {
    console.error('[SHOPIFY OVERVIEW] Error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

/* ====================================================================== */
/*                     2. ORDERS DASHBOARD                                */
/* ====================================================================== */
exports.getOrdersDashboard = async (req, res) => {
  try {
    const { companyId } = req.params;
    const { financialStatus, page = 1, limit = 20 } = req.query;

    const whereClause = { company_id: companyId };
    if (financialStatus) whereClause.financial_status = financialStatus;

    const [statusMetrics, orders, monthlyTrend] = await Promise.all([
      FactOrder.findAll({
        attributes: [
          'financial_status',
          [fn('COUNT', col('order_id')), 'count'],
          [fn('SUM', col('total_amount')), 'amount']
        ],
        where: { company_id: companyId },
        group: ['financial_status'],
        raw: true
      }),

      FactOrder.findAll({
        where: whereClause,
        order: [['transaction_date', 'DESC']],
        limit:  parseInt(limit),
        offset: (parseInt(page) - 1) * parseInt(limit),
        raw:    true
      }),

      getMonthlyRevenue(companyId, { limit: 12 })
    ]);

    res.json({
      success: true,
      metrics: {
        total: {
          count:  statusMetrics.reduce((s, m) => s + parseInt(m.count || 0), 0),
          amount: statusMetrics.reduce((s, m) => s + parseFloat(m.amount || 0), 0)
        },
        byFinancialStatus: statusMetrics.map(m => ({
          status: m.financial_status || 'unknown',
          count:  parseInt(m.count || 0),
          amount: parseFloat(m.amount || 0)
        }))
      },
      orders,
      monthlyTrend: monthlyTrend.map(m => ({
        month:  m.month_label,
        revenue:parseFloat(m.revenue || 0),
        orders: parseInt(m.order_count || 0)
      }))
    });

  } catch (error) {
    console.error('[SHOPIFY ORDERS] Error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

/* ====================================================================== */
/*                     3. PRODUCTS DASHBOARD                              */
/* ====================================================================== */
exports.getProductsDashboard = async (req, res) => {
  try {
    const { companyId } = req.params;

    const [products, topSellers, lowStock] = await Promise.all([
      DimProduct.findAll({
        where: { company_id: companyId },
        order: [['updated_at', 'DESC']],
        raw:   true
      }),

      FactOrderLine.findAll({
        attributes: [
          'product_id', 'title',
          [fn('SUM', col('line_total')), 'totalRevenue'],
          [fn('SUM', col('quantity')),   'unitsSold']
        ],
        where: { company_id: companyId },
        group: ['product_id', 'title'],
        order: [[fn('SUM', col('line_total')), 'DESC']],
        limit: 10,
        raw: true
      }),

      DimProduct.findAll({
        where: { company_id: companyId, inventory_qty: { [Op.lt]: 10 } },
        order: [['inventory_qty', 'ASC']],
        limit: 10,
        raw: true
      })
    ]);

    res.json({
      success: true,
      metrics: {
        totalProducts: products.length,
        activeProducts: products.filter(p => p.status === 'active').length
      },
      topSellers: topSellers.map(p => ({
        productId: p.product_id,
        title:     p.title || 'Unknown',
        revenue:   parseFloat(p.totalRevenue || 0),
        unitsSold: parseInt(p.unitsSold || 0)
      })),
      lowStock,
      products
    });

  } catch (error) {
    console.error('[SHOPIFY PRODUCTS] Error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

/* ====================================================================== */
/*                     4. CUSTOMERS DASHBOARD                             */
/* ====================================================================== */
exports.getCustomersDashboard = async (req, res) => {
  try {
    const { companyId } = req.params;

    const [customers, topCustomers] = await Promise.all([
      DimCustomer.findAll({
        where: { company_id: companyId },
        order: [['total_spent', 'DESC']],
        raw:   true
      }),

      FactOrder.findAll({
        attributes: [
          'customer_id', 'customer_email',
          [fn('SUM', col('total_amount')), 'totalRevenue'],
          [fn('COUNT', col('order_id')),   'orderCount']
        ],
        where: { company_id: companyId },
        group: ['customer_id', 'customer_email'],
        order: [[fn('SUM', col('total_amount')), 'DESC']],
        limit: 10,
        raw: true
      })
    ]);

    res.json({
      success: true,
      metrics: {
        totalCustomers: customers.length,
        totalRevenue:   topCustomers.reduce((s, c) => s + parseFloat(c.totalRevenue || 0), 0)
      },
      topCustomers: topCustomers.map(c => ({
        customerId:   c.customer_id,
        email:        c.customer_email,
        totalRevenue: parseFloat(c.totalRevenue || 0),
        orderCount:   parseInt(c.orderCount || 0)
      })),
      customers
    });

  } catch (error) {
    console.error('[SHOPIFY CUSTOMERS] Error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

/* ====================================================================== */
/*                         HELPER — Date Range                            */
/* ====================================================================== */
const getDateRange = (period) => {
  const now = new Date();
  let startDate;
  switch (period) {
    case 'MTD':
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case 'QTD':
      const q = Math.floor(now.getMonth() / 3);
      startDate = new Date(now.getFullYear(), q * 3, 1);
      break;
    case 'YTD':
      startDate = new Date(now.getFullYear(), 0, 1);
      break;
    default:
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
  }
  return {
    startDate: startDate.toISOString().split('T')[0],
    endDate:   now.toISOString().split('T')[0]
  };
};
