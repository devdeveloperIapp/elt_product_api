// controller/ZohoBooksDashboardController.js
//
// Zoho Books-only dashboard, reading from warehouse v2 `zohobooks_domain.*`.
// Zoho's domain shape mirrors QuickBooks (dim_customers/dim_vendors/
// fact_invoices/fact_bills/fact_payments/fact_transactions), so the widgets
// here match controller/DashboardController.js. No financial-statement
// endpoints (P&L/balance-sheet/cash-flow) — unlike QuickBooks, there is no
// report-generation pipeline for Zoho yet (see
// QuickBookLogingController.generateFinancialReports, which is QB-API
// specific). Add that separately if/when Zoho reports are needed.

const { Op, fn, col } = require('sequelize');
const { getDomainModel } = require('../model/warehouse/DomainModelFactory');
require('../services/warehouse/transformers/zohobooksTransformer'); // registers zohobooks_domain models

const DimCustomer     = getDomainModel('zohobooks', 'dim_customers');
const DimVendor       = getDomainModel('zohobooks', 'dim_vendors');
const FactInvoice     = getDomainModel('zohobooks', 'fact_invoices');
const FactBill        = getDomainModel('zohobooks', 'fact_bills');
const FactPayment     = getDomainModel('zohobooks', 'fact_payments');
const FactTransaction = getDomainModel('zohobooks', 'fact_transactions');
const { getMonthlyRevenue } = require('../services/warehouse/zohobooksAggregates');

/* ====================================================================== */
/*                     1. BUSINESS OVERVIEW DASHBOARD                     */
/* ====================================================================== */
exports.getOverviewDashboard = async (req, res) => {
  try {
    const { companyId } = req.params;
    const { period = 'MTD' } = req.query;
    const { startDate, endDate } = getDateRange(period);

    const [
      revenue,
      expenses,
      receivables,
      recentInvoices,
      monthlyChart,
      expenseBreakdown
    ] = await Promise.all([

      FactTransaction.findOne({
        attributes: [[fn('COALESCE', fn('SUM', col('amount')), 0), 'total']],
        where: {
          company_id: companyId,
          transaction_type: 'revenue',
          transaction_date: { [Op.between]: [startDate, endDate] }
        },
        raw: true
      }),

      FactTransaction.findOne({
        attributes: [[fn('COALESCE', fn('SUM', col('amount')), 0), 'total']],
        where: {
          company_id: companyId,
          transaction_type: 'expense',
          transaction_date: { [Op.between]: [startDate, endDate] }
        },
        raw: true
      }),

      FactInvoice.findOne({
        attributes: [[fn('COALESCE', fn('SUM', col('balance')), 0), 'total']],
        where: { company_id: companyId, status: { [Op.in]: ['Pending', 'Overdue'] } },
        raw: true
      }),

      FactInvoice.findAll({
        where: { company_id: companyId },
        order: [['transaction_date', 'DESC']],
        limit: 10,
        raw: true
      }),

      getMonthlyRevenue(companyId, { limit: 12 }),

      FactBill.findAll({
        attributes: ['vendor_name', [fn('SUM', col('amount')), 'total']],
        where: { company_id: companyId },
        group: ['vendor_name'],
        order: [[fn('SUM', col('amount')), 'DESC']],
        limit: 5,
        raw: true
      })
    ]);

    const totalRevenue  = parseFloat(revenue?.total  || 0);
    const totalExpenses = parseFloat(expenses?.total || 0);
    const netProfit     = totalRevenue - totalExpenses;
    const profitMargin  = totalRevenue > 0 ? ((netProfit / totalRevenue) * 100).toFixed(1) : 0;

    res.json({
      success: true,
      period,
      source: 'zohobooks',
      lastUpdated: new Date(),
      metrics: {
        revenue:     { value: totalRevenue,                label: 'Revenue'        },
        expenses:    { value: totalExpenses,               label: 'Expenses'       },
        netProfit:   { value: netProfit, margin: profitMargin, label: 'Net Profit' },
        receivables: { value: parseFloat(receivables?.total || 0), label: 'Receivables' }
      },
      charts: {
        monthly: monthlyChart.map(m => ({
          month:     m.month_label,
          revenue:   parseFloat(m.revenue   || 0),
          expenses:  parseFloat(m.expenses  || 0),
          netProfit: parseFloat(m.net_profit || 0)
        })),
        expenseBreakdown: expenseBreakdown.map(e => ({
          name:  e.vendor_name || 'Other',
          value: parseFloat(e.total || 0)
        }))
      },
      recentInvoices: recentInvoices.map(inv => ({
        id:        inv.invoice_id,
        docNumber: inv.invoice_number,
        customer:  inv.customer_name,
        amount:    parseFloat(inv.amount),
        balance:   parseFloat(inv.balance),
        date:      inv.transaction_date,
        dueDate:   inv.due_date,
        status:    inv.status,
        source:    'zohobooks'
      }))
    });

  } catch (error) {
    console.error('[ZOHO OVERVIEW] Error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

/* ====================================================================== */
/*                     2. INVOICE DASHBOARD                               */
/* ====================================================================== */
exports.getInvoiceDashboard = async (req, res) => {
  try {
    const { companyId } = req.params;
    const { status, page = 1, limit = 20 } = req.query;

    const whereClause = { company_id: companyId };
    if (status) whereClause.status = status;

    const [metrics, invoices, monthlyTrend] = await Promise.all([
      FactInvoice.findAll({
        attributes: [
          'status',
          [fn('COUNT', col('invoice_id')), 'count'],
          [fn('SUM',   col('amount')),     'amount'],
          [fn('SUM',   col('balance')),    'balance']
        ],
        where: { company_id: companyId },
        group: ['status'],
        raw: true
      }),

      FactInvoice.findAll({
        where: whereClause,
        order: [['transaction_date', 'DESC']],
        limit:  parseInt(limit),
        offset: (parseInt(page) - 1) * parseInt(limit),
        raw:    true
      }),

      getMonthlyRevenue(companyId, { limit: 12 })
    ]);

    const metricsMap = { Paid: {count:0,amount:0}, Pending: {count:0,amount:0}, Overdue: {count:0,amount:0} };
    metrics.forEach(m => {
      if (metricsMap[m.status]) {
        metricsMap[m.status].count  = parseInt(m.count  || 0);
        metricsMap[m.status].amount = parseFloat(m.amount || 0);
      }
    });

    res.json({
      success: true,
      metrics: {
        total:   {
          count:  metrics.reduce((s, m) => s + parseInt(m.count || 0), 0),
          amount: metrics.reduce((s, m) => s + parseFloat(m.amount || 0), 0)
        },
        paid:    metricsMap.Paid,
        pending: metricsMap.Pending,
        overdue: metricsMap.Overdue
      },
      invoices,
      monthlyTrend: monthlyTrend.map(m => ({
        month:   m.month_label,
        revenue: parseFloat(m.revenue || 0),
        count:   parseInt(m.invoice_count || 0)
      }))
    });

  } catch (error) {
    console.error('[ZOHO INVOICE] Error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

/* ====================================================================== */
/*                     3. VENDOR DASHBOARD                                */
/* ====================================================================== */
exports.getVendorDashboard = async (req, res) => {
  try {
    const { companyId } = req.params;

    const [vendors, billMetrics, recentBills, topVendors] = await Promise.all([
      DimVendor.findAll({
        where: { company_id: companyId, is_active: true },
        order: [['balance', 'DESC']],
        raw:   true
      }),

      FactBill.findAll({
        attributes: ['status', [fn('COUNT', col('bill_id')), 'count'], [fn('SUM', col('amount')), 'amount']],
        where: { company_id: companyId },
        group: ['status'],
        raw:   true
      }),

      FactBill.findAll({
        where: { company_id: companyId },
        order: [['transaction_date', 'DESC']],
        limit: 10,
        raw:   true
      }),

      FactBill.findAll({
        attributes: [
          'vendor_id', 'vendor_name',
          [fn('SUM', col('amount')),    'totalSpend'],
          [fn('COUNT', col('bill_id')), 'billCount']
        ],
        where: { company_id: companyId },
        group: ['vendor_id', 'vendor_name'],
        order: [[fn('SUM', col('amount')), 'DESC']],
        limit: 10,
        raw:   true
      })
    ]);

    const metricsMap = { Paid: {count:0,amount:0}, Pending: {count:0,amount:0}, Overdue: {count:0,amount:0} };
    billMetrics.forEach(m => {
      if (metricsMap[m.status]) {
        metricsMap[m.status].count  = parseInt(m.count  || 0);
        metricsMap[m.status].amount = parseFloat(m.amount || 0);
      }
    });

    res.json({
      success: true,
      metrics: {
        totalVendors: vendors.length,
        totalBills:   billMetrics.reduce((s, m) => s + parseInt(m.count  || 0), 0),
        totalSpend:   billMetrics.reduce((s, m) => s + parseFloat(m.amount || 0), 0),
        paid:         metricsMap.Paid,
        pending:      metricsMap.Pending,
        overdue:      metricsMap.Overdue
      },
      topVendors: topVendors.map(v => ({
        vendorId:   v.vendor_id,
        name:       v.vendor_name,
        totalSpend: parseFloat(v.totalSpend || 0),
        billCount:  parseInt(v.billCount    || 0)
      })),
      recentBills,
      vendors
    });

  } catch (error) {
    console.error('[ZOHO VENDOR] Error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

/* ====================================================================== */
/*                     4. CUSTOMER DASHBOARD                              */
/* ====================================================================== */
exports.getCustomerDashboard = async (req, res) => {
  try {
    const { companyId } = req.params;

    const [customers, topCustomers, recentPayments] = await Promise.all([
      DimCustomer.findAll({
        where: { company_id: companyId },
        order: [['balance', 'DESC']],
        raw:   true
      }),

      FactInvoice.findAll({
        attributes: [
          'customer_id', 'customer_name',
          [fn('SUM',   col('amount')),     'totalRevenue'],
          [fn('COUNT', col('invoice_id')), 'invoiceCount'],
          [fn('SUM',   col('balance')),    'outstanding']
        ],
        where: { company_id: companyId },
        group: ['customer_id', 'customer_name'],
        order: [[fn('SUM', col('amount')), 'DESC']],
        limit: 10,
        raw:   true
      }),

      FactPayment.findAll({
        where: { company_id: companyId },
        order: [['transaction_date', 'DESC']],
        limit: 10,
        raw:   true
      })
    ]);

    res.json({
      success: true,
      metrics: {
        totalCustomers:   customers.length,
        totalRevenue:     topCustomers.reduce((s, c) => s + parseFloat(c.totalRevenue  || 0), 0),
        totalOutstanding: topCustomers.reduce((s, c) => s + parseFloat(c.outstanding   || 0), 0)
      },
      topCustomers: topCustomers.map(c => ({
        customerId:   c.customer_id,
        name:         c.customer_name,
        totalRevenue: parseFloat(c.totalRevenue  || 0),
        invoiceCount: parseInt(c.invoiceCount    || 0),
        outstanding:  parseFloat(c.outstanding   || 0)
      })),
      recentPayments,
      customers
    });

  } catch (error) {
    console.error('[ZOHO CUSTOMER] Error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

/* ====================================================================== */
/*                     5. REVENUE DASHBOARD                               */
/* ====================================================================== */
exports.getRevenueDashboard = async (req, res) => {
  try {
    const { companyId } = req.params;
    const { year = new Date().getFullYear() } = req.query;

    const monthly = await getMonthlyRevenue(companyId, { year: parseInt(year) });

    const totalRevenue  = monthly.reduce((s, m) => s + parseFloat(m.revenue   || 0), 0);
    const totalExpenses = monthly.reduce((s, m) => s + parseFloat(m.expenses  || 0), 0);
    const totalProfit   = monthly.reduce((s, m) => s + parseFloat(m.net_profit || 0), 0);

    res.json({
      success: true,
      year,
      source: 'zohobooks',
      metrics: {
        totalRevenue,
        totalExpenses,
        totalProfit,
        profitMargin: totalRevenue > 0 ? ((totalProfit / totalRevenue) * 100).toFixed(1) : 0
      },
      monthly: monthly.map(m => ({
        month:     m.month_label,
        revenue:   parseFloat(m.revenue    || 0),
        expenses:  parseFloat(m.expenses   || 0),
        netProfit: parseFloat(m.net_profit || 0),
        count:     parseInt(m.invoice_count || 0)
      }))
    });

  } catch (error) {
    console.error('[ZOHO REVENUE] Error:', error.message);
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
