const { Op, fn, col } = require('sequelize');
// ---------------------------------------------------------------------------
// Fully migrated to warehouse v2 (`quickbooks_domain.*`) — Dim/Fact reads
// (Step 1) and now Financial Reports (Step 5) too. This dashboard is
// QuickBooks-only for now — the legacy `domain_tables.*` tables were a
// single multi-source (source_type column) design, while v2 splits each
// source into its own schema. Legacy is verified to match (see conversation
// Step 4 — report_data byte-for-byte identical; legacy dim/fact was in fact
// found stale/unreliable after incremental syncs, v2 always accurate) and is
// no longer read from here.
// ---------------------------------------------------------------------------
const { getDomainModel } = require('../model/warehouse/DomainModelFactory');
require('../services/warehouse/transformers/quickbooksTransformer'); // registers quickbooks_domain models
const DimAccount      = getDomainModel('quickbooks', 'dim_accounts');
const DimCustomer     = getDomainModel('quickbooks', 'dim_customers');
const DimVendor       = getDomainModel('quickbooks', 'dim_vendors');
const FactInvoice     = getDomainModel('quickbooks', 'fact_invoices');
const FactBill        = getDomainModel('quickbooks', 'fact_bills');
const FactPayment     = getDomainModel('quickbooks', 'fact_payments');
const FactTransaction = getDomainModel('quickbooks', 'fact_transactions');
const { getMonthlyRevenue } = require('../services/warehouse/quickbooksAggregates');
const getFinancialReportModel = require('../model/warehouse/V2FinancialReportModel');

/* ====================================================================== */
/*                     1. BUSINESS OVERVIEW DASHBOARD                     */
/* ====================================================================== */
exports.getOverviewDashboard = async (req, res) => {
  try {
    const { companyId } = req.params;
    const { period = 'MTD', source = 'all' } = req.query;
    const { startDate, endDate } = getDateRange(period);

    // v2 (quickbooks_domain) is single-source — the `source` query param is
    // accepted for API compatibility but no longer filters anything.

    const [
      revenue,
      expenses,
      receivables,
      recentInvoices,
      monthlyChart,
      expenseBreakdown
    ] = await Promise.all([

      // Total Revenue
      FactTransaction.findOne({
        attributes: [[fn('COALESCE', fn('SUM', col('amount')), 0), 'total']],
        where: {
          company_id: companyId,
          transaction_type: 'revenue',
          transaction_date: { [Op.between]: [startDate, endDate] }
        },
        raw: true
      }),

      // Total Expenses
      FactTransaction.findOne({
        attributes: [[fn('COALESCE', fn('SUM', col('amount')), 0), 'total']],
        where: {
          company_id: companyId,
          transaction_type: 'expense',
          transaction_date: { [Op.between]: [startDate, endDate] }
        },
        raw: true
      }),

      // Receivables (unpaid invoices)
      FactInvoice.findOne({
        attributes: [[fn('COALESCE', fn('SUM', col('balance')), 0), 'total']],
        where: {
          company_id: companyId,
          status: { [Op.in]: ['Pending', 'Overdue'] }
        },
        raw: true
      }),

      // Recent Invoices
      FactInvoice.findAll({
        where: { company_id: companyId },
        order: [['transaction_date', 'DESC']],
        limit: 10,
        raw: true
      }),

      // Monthly Chart — live rollup from quickbooks_domain.fact_transactions
      getMonthlyRevenue(companyId, { limit: 12 }),

      // Expense Breakdown — fact_bills se
      FactBill.findAll({
        attributes: [
          'vendor_name',
          [fn('SUM', col('amount')), 'total']
        ],
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
    const profitMargin  = totalRevenue > 0
      ? ((netProfit / totalRevenue) * 100).toFixed(1)
      : 0;

    res.json({
      success: true,
      period,
      source,
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
        id:         inv.invoice_id,
        docNumber:  inv.doc_number,
        customer:   inv.customer_name,
        amount:     parseFloat(inv.amount),
        balance:    parseFloat(inv.balance),
        date:       inv.transaction_date,
        dueDate:    inv.due_date,
        status:     inv.status,
        source:     'quickbooks'
      }))
    });

  } catch (error) {
    console.error('[OVERVIEW] Error:', error.message);
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

      // Metrics
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

      // Invoices list with pagination
      FactInvoice.findAll({
        where: whereClause,
        order: [['transaction_date', 'DESC']],
        limit:  parseInt(limit),
        offset: (parseInt(page) - 1) * parseInt(limit),
        raw:    true
      }),

      // Monthly trend
      getMonthlyRevenue(companyId, { limit: 12 })
    ]);

    // Metrics group karo
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
    console.error('[INVOICE] Error:', error.message);
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

      // All vendors
      DimVendor.findAll({
        where: { company_id: companyId, is_active: true },
        order: [['balance', 'DESC']],
        raw:   true
      }),

      // Bill metrics
      FactBill.findAll({
        attributes: [
          'status',
          [fn('COUNT', col('bill_id')), 'count'],
          [fn('SUM', col('amount')),    'amount']
        ],
        where: { company_id: companyId },
        group: ['status'],
        raw:   true
      }),

      // Recent bills
      FactBill.findAll({
        where: { company_id: companyId },
        order: [['transaction_date', 'DESC']],
        limit: 10,
        raw:   true
      }),

      // Top vendors by spend
      FactBill.findAll({
        attributes: [
          'vendor_id',
          'vendor_name',
          [fn('SUM', col('amount')),   'totalSpend'],
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
    console.error('[VENDOR] Error:', error.message);
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

      // All customers
      DimCustomer.findAll({
        where: { company_id: companyId,
            // is_active: true
        },
        order: [['balance', 'DESC']],
        raw:   true
      }),

      // Top customers by revenue
      FactInvoice.findAll({
        attributes: [
          'customer_id',
          'customer_name',
          [fn('SUM',   col('amount')),  'totalRevenue'],
          [fn('COUNT', col('invoice_id')), 'invoiceCount'],
          [fn('SUM',   col('balance')), 'outstanding']
        ],
        where: { company_id: companyId },
        group: ['customer_id', 'customer_name'],
        order: [[fn('SUM', col('amount')), 'DESC']],
        limit: 10,
        raw:   true
      }),

      // Recent payments
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
        totalCustomers:  customers.length,
        totalRevenue:    topCustomers.reduce((s, c) => s + parseFloat(c.totalRevenue  || 0), 0),
        totalOutstanding:topCustomers.reduce((s, c) => s + parseFloat(c.outstanding   || 0), 0)
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
    console.error('[CUSTOMER] Error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

/* ====================================================================== */
/*                     5. REVENUE DASHBOARD                               */
/* ====================================================================== */
exports.getRevenueDashboard = async (req, res) => {
  try {
    const { companyId } = req.params;
    const { source = 'all', year = new Date().getFullYear() } = req.query;

    const monthly = await getMonthlyRevenue(companyId, { year: parseInt(year) });

    const totalRevenue  = monthly.reduce((s, m) => s + parseFloat(m.revenue   || 0), 0);
    const totalExpenses = monthly.reduce((s, m) => s + parseFloat(m.expenses  || 0), 0);
    const totalProfit   = monthly.reduce((s, m) => s + parseFloat(m.net_profit || 0), 0);

    res.json({
      success: true,
      year,
      source,
      metrics: {
        totalRevenue,
        totalExpenses,
        totalProfit,
        profitMargin: totalRevenue > 0
          ? ((totalProfit / totalRevenue) * 100).toFixed(1)
          : 0
      },
      monthly: monthly.map(m => ({
        month:     m.month_label,
        revenue:   parseFloat(m.revenue    || 0),
        expenses:  parseFloat(m.expenses   || 0),
        netProfit: parseFloat(m.net_profit || 0),
        count:     parseInt(m.invoice_count || 0)
      })),
      // v2 is single-source (quickbooks only) — no per-source breakdown to group by yet.
      bySource: [{
        source:        'quickbooks',
        totalRevenue,
        totalExpenses,
        totalProfit
      }]
    });

  } catch (error) {
    console.error('[REVENUE] Error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

/* ====================================================================== */
/*                     6. P&L DASHBOARD                                   */
/* ====================================================================== */
exports.getPLDashboard = async (req, res) => {
  try {
    const { companyId } = req.params;

    const ReportModel = await getFinancialReportModel('profit_loss');
    const report = await ReportModel.findOne({
      where: { company_id: companyId },
      order: [['generated_at', 'DESC']],
      raw:   true
    });

    // Summary — live rollup from quickbooks_domain.fact_transactions
    const summary = await getMonthlyRevenue(companyId);

    res.json({
      success: true,
      report:  report?.report_data || null,
      summary: summary.map(s => ({
        month:     s.month_label,
        revenue:   parseFloat(s.revenue    || 0),
        expenses:  parseFloat(s.expenses   || 0),
        netProfit: parseFloat(s.net_profit || 0)
      }))
    });

  } catch (error) {
    console.error('[PL] Error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

/* ====================================================================== */
/*                     7. CASH FLOW DASHBOARD                             */
/* ====================================================================== */
exports.getCashFlowDashboard = async (req, res) => {
  try {
    const { companyId } = req.params;

    const ReportModel = await getFinancialReportModel('cash_flow');
    const report = await ReportModel.findOne({
      where: { company_id: companyId },
      order: [['generated_at', 'DESC']],
      raw:   true
    });

    // Cash accounts
    const cashAccounts = await DimAccount.findAll({
      where: {
        company_id:   companyId,
        account_type: { [Op.in]: ['Bank', 'Other Current Asset'] },
        is_active:    true
      },
      raw: true
    });

    const totalCash = cashAccounts.reduce(
      (s, a) => s + parseFloat(a.current_balance || 0), 0
    );

    res.json({
      success:      true,
      totalCash,
      cashAccounts,
      report:       report?.report_data || null
    });

  } catch (error) {
    console.error('[CASHFLOW] Error:', error.message);
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