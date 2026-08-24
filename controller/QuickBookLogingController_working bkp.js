// controllers/QuickBookLogingController.js (updated version)


const Source = require("../model/sourceModel");
const axios = require("axios");
// Import new models
const {
  Company,
  QuickBooksConnection,
  QuickBooksData,
  FinancialReport,
  DashboardConfig,
  ChartConfig,
  ScheduledReport,
  User
} = require("../model/index");

/* ====================================================================== */
/*                      COMPANY MANAGEMENT FUNCTIONS                       */
/* ====================================================================== */

// Create a new company
exports.createCompany = async (req, res) => {
  try {
    const { name, domain, subscription_plan, currency, timezone } = req.body;

    const company = await Company.create({
      name,
      domain,
      subscription_plan: subscription_plan || 'basic',
      subscription_status: 'trial',
      subscription_expiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days trial
      currency: currency || 'USD',
      timezone: timezone || 'UTC',
      fiscal_year_start: new Date(new Date().getFullYear(), 0, 1) // Jan 1st of current year
    });

    // Create default dashboard config for the company
    await DashboardConfig.create({
      company_id: company.id,
      config_name: 'Default Dashboard',
      layout: {
        widgets: [
          { id: 'revenue', position: { x: 0, y: 0, w: 6, h: 2 } },
          { id: 'expenses', position: { x: 6, y: 0, w: 6, h: 2 } },
          { id: 'profitLoss', position: { x: 0, y: 2, w: 8, h: 4 } },
          { id: 'expensesChart', position: { x: 8, y: 2, w: 4, h: 4 } }
        ]
      },
      widgets: {
        revenue: { type: 'metric', title: 'Revenue', dataSource: 'revenue' },
        expenses: { type: 'metric', title: 'Expenses', dataSource: 'expenses' },
        profitLoss: { type: 'chart', title: 'Profit & Loss', chartType: 'line', dataSource: 'profit_loss' },
        expensesChart: { type: 'chart', title: 'Expenses by Category', chartType: 'pie', dataSource: 'expenses_by_category' }
      },
      is_default: true
    });

    res.status(201).json({
      success: true,
      message: 'Company created successfully',
      data: company
    });
  } catch (error) {
    console.error('Error creating company:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get all companies
exports.getAllCompanies = async (req, res) => {
  try {
    const companies = await Company.findAll({
      include: [
        {
          model: QuickBooksConnection,
          attributes: ['realm_id', 'sync_status', 'last_sync_at']
        }
      ]
    });

    res.json({
      success: true,
      data: companies
    });
  } catch (error) {
    console.error('Error fetching companies:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get company by ID
exports.getCompanyById = async (req, res) => {
  try {
    const { companyId } = req.params;

    const company = await Company.findByPk(companyId, {
      include: [
        {
          model: QuickBooksConnection,
          attributes: ['realm_id', 'sync_status', 'last_sync_at', 'access_token', 'refresh_token', 'expires_in']
        },
        {
          model: DashboardConfig,
          where: { is_default: true },
          required: false
        }
      ]
    });

    if (!company) {
      return res.status(404).json({ success: false, message: 'Company not found' });
    }

    res.json({
      success: true,
      data: company
    });
  } catch (error) {
    console.error('Error fetching company:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Update company
exports.updateCompany = async (req, res) => {
  try {
    const { companyId } = req.params;
    const updateData = req.body;

    const company = await Company.findByPk(companyId);

    if (!company) {
      return res.status(404).json({ success: false, message: 'Company not found' });
    }

    await company.update(updateData);

    res.json({
      success: true,
      message: 'Company updated successfully',
      data: company
    });
  } catch (error) {
    console.error('Error updating company:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Delete company
exports.deleteCompany = async (req, res) => {
  try {
    const { companyId } = req.params;

    const company = await Company.findByPk(companyId);

    if (!company) {
      return res.status(404).json({ success: false, message: 'Company not found' });
    }

    await company.destroy();

    res.json({
      success: true,
      message: 'Company deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting company:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/* ====================================================================== */
/*                      QUICKBOOKS CONNECTION FUNCTIONS                    */
/* ====================================================================== */

// Updated QuickBooks callback with company association
exports.quickBooksCallback = async (req, res) => {
  try {
    const { code, realmId, state } = req.query;
    console.log("QuickBooks callback received:", { code, realmId, state });

    // Exchange code for tokens
    const response = await axios.post(
      "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.QB_REDIRECT_URI
      }),
      {
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              `${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`
            ).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded"
        }
      }
    );

    const { access_token, refresh_token, expires_in, x_refresh_token_expires_in } = response.data;
    
    // Get user to find their company
    const user = await User.findByPk(state, {
      include: [{ model: Company ,as: 'company' }]
    });

    if (!user) {
      throw new Error('User not found');
    }

    // If user doesn't have a company, create one
    let companyId = user.company_id;
    if (!companyId) {
      const company = await Company.create({
        name: `Company_${user.id}`,
        quickbooks_realm_id: realmId
      });
      companyId = company.id;
      
      // Update user with company ID
      await user.update({ company_id: companyId });
    }

    // Save QuickBooks connection
    const [connection, created] = await QuickBooksConnection.findOrCreate({
      where: { company_id: companyId },
      defaults: {
        company_id: companyId,
        realm_id: realmId,
        access_token,
        refresh_token,
        token_type: 'bearer',
        expires_in,
        x_refresh_token_expires_in,
        sync_status: 'pending'
      }
    });

    if (!created) {
      await connection.update({
        realm_id: realmId,
        access_token,
        refresh_token,
        expires_in,
        x_refresh_token_expires_in,
        sync_status: 'pending'
      });
    }

    // Update company with realm ID
    await Company.update(
      { quickbooks_realm_id: realmId },
      { where: { id: companyId } }
    );

    // Save in Source model (for backward compatibility)
    const createdSource = await Source.create({
      source_name: "Quickbooks login",
      connector_name: "Quickbooks login",
      connector_settings_json: {
        userId: state,
        companyId: companyId,
        type: "quickbooks",
        realmId,
        access_token,
        refresh_token,
        expires_at: Date.now() + expires_in * 1000
      },
      sandbox: true
    });

    const sourceId = createdSource.id;

    // Trigger initial sync
    await triggerQuickBooksSync(companyId, sourceId, access_token, realmId);

    res.redirect(
      `${process.env.FRONTEND_URL}/company/${companyId}/dashboard?quickbooks=success&realmId=${realmId}&sourceId=${sourceId}`
    );

  } catch (err) {
    console.log(err.response?.data || err.message);
    res.redirect(
      `${process.env.FRONTEND_URL}?quickbooks=error&message=${encodeURIComponent(err.message)}`
    );
  }
};

// Trigger QuickBooks sync
const triggerQuickBooksSync = async (companyId, sourceId, access_token, realmId) => {
  try {
    // Update sync status
    await QuickBooksConnection.update(
      { sync_status: 'in_progress' },
      { where: { company_id: companyId } }
    );

    // Define entity types to sync
    const entityTypes = [
      'Account', 'Customer', 'Vendor', 'Invoice', 'Bill', 'Payment',
      'JournalEntry', 'Estimate', 'BillPayment', 'Department', 'Deposit',
      'Employee', 'Item', 'PaymentMethod', 'Purchase', 'PurchaseOrder',
      'RefundReceipt', 'SalesReceipt', 'TaxCode', 'TaxRate', 'Term',
      'TimeActivity', 'Transfer', 'VendorCredit'
    ];

    const baseUrl = process.env.QB_ENVIRONMENT === "sandbox"
      ? "https://sandbox-quickbooks.api.intuit.com"
      : "https://quickbooks.api.intuit.com";

    // Sync each entity type
    for (const entityType of entityTypes) {
      try {
        console.log(`Syncing ${entityType} for company ${companyId}...`);
        
        let allEntities = [];
        let startPosition = 1;
        const maxResults = 1000;
        let hasMore = true;

        while (hasMore) {
          const query = `SELECT * FROM ${entityType} STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;
          
          const response = await axios.get(
            `${baseUrl}/v3/company/${realmId}/query`,
            {
              params: { query },
              headers: {
                Authorization: `Bearer ${access_token}`,
                Accept: "application/json"
              }
            }
          );

          const entities = response.data.QueryResponse[entityType] || [];
          allEntities = [...allEntities, ...entities];

          if (entities.length < maxResults) {
            hasMore = false;
          } else {
            startPosition += maxResults;
          }
        }

        // Save entities to database
        await saveQuickBooksEntities(companyId, sourceId, entityType, allEntities);

      } catch (error) {
        console.error(`Error syncing ${entityType}:`, error.message);
      }
    }

    // Generate financial reports
    await generateFinancialReports(companyId, access_token, realmId);

    // Update sync status
    await QuickBooksConnection.update(
      { 
        sync_status: 'completed',
        last_sync_at: new Date()
      },
      { where: { company_id: companyId } }
    );

  } catch (error) {
    console.error('Error in triggerQuickBooksSync:', error);
    await QuickBooksConnection.update(
      { 
        sync_status: 'failed',
        error_message: error.message
      },
      { where: { company_id: companyId } }
    );
  }
};

// Save QuickBooks entities to database
// const saveQuickBooksEntities = async (companyId, sourceId, entityType, entities) => {
//   const dataType = entityType.toLowerCase();
//   const batchSize = 100;

//   for (let i = 0; i < entities.length; i += batchSize) {
//     const batch = entities.slice(i, i + batchSize);
    
//     const records = batch.map(entity => ({
//       company_id: companyId,
//       source_id: sourceId,
//       data_type: dataType,
//       quickbooks_id: entity.Id,
//       data: entity,
//       sync_token: entity.SyncToken,
//       sync_version: entity.SyncToken,
//       is_active: entity.Active !== false
//     }));

//     // Use bulkCreate with update on duplicate
//     await QuickBooksData.bulkCreate(records, {
//       updateOnDuplicate: ['data', 'sync_token', 'sync_version', 'is_active', 'updated_at']
//     });
//   }

//   console.log(`Saved ${entities.length} ${entityType} records for company ${companyId}`);
// };
// In your QuickBookLogingController.js, update the saveQuickBooksEntities function
// const saveQuickBooksEntities = async (companyId, sourceId, entityType, entities) => {
//   const dataType = entityType.toLowerCase();
//   const batchSize = 100;

//   for (let i = 0; i < entities.length; i += batchSize) {
//     const batch = entities.slice(i, i + batchSize);
    
//     const records = batch.map(entity => ({
//       company_id: companyId,
//       source_id: sourceId,
//       data_type: dataType,
//       quickbooks_id: entity.Id,
//       data: entity,
//       sync_token: entity.SyncToken,
//       sync_version: entity.SyncToken,
//       is_active: entity.Active !== false
//     }));

//     try {
//       // Use bulkCreate with update on duplicate
//       await QuickBooksData.bulkCreate(records, {
//         updateOnDuplicate: ['data', 'sync_token', 'sync_version', 'is_active', 'updated_at'],
//         validate: true
//       });
//       console.log(`Saved ${records.length} ${entityType} records for company ${companyId}`);
//     } catch (error) {
//       console.error(`Error saving ${entityType} batch:`, {
//         message: error.message,
//         errors: error.errors?.map(e => ({
//           message: e.message,
//           type: e.type,
//           path: e.path,
//           value: e.value
//         })),
//         firstRecord: records[0] // Log first record to see structure
//       });
//       throw error;
//     }
//   }
// };

const saveQuickBooksEntities = async (companyId, sourceId, entityType, entities) => {
  const dataType = entityType.toLowerCase();
  const batchSize = 100;
  let savedCount = 0;
  let errorCount = 0;

  for (let i = 0; i < entities.length; i += batchSize) {
    const batch = entities.slice(i, i + batchSize);
    
    const records = batch.map(entity => ({
      company_id: companyId,
      source_id: sourceId,
      data_type: dataType,
      quickbooks_id: entity.Id,
      data: entity,
      sync_token: entity.SyncToken,
      sync_version: entity.SyncToken,
      is_active: entity.Active !== false
    }));

    try {
      // Try to insert/update each record individually to handle duplicates gracefully
      for (const record of records) {
        try {
          await QuickBooksData.upsert(record, {
            conflictFields: ['company_id', 'data_type', 'quickbooks_id']
          });
          savedCount++;
        } catch (err) {
          if (err.name === 'SequelizeUniqueConstraintError') {
            // Record already exists, try updating it
            await QuickBooksData.update(record, {
              where: {
                company_id: record.company_id,
                data_type: record.data_type,
                quickbooks_id: record.quickbooks_id
              }
            });
            savedCount++;
          } else {
            console.error(`Error saving ${entityType} record ${record.quickbooks_id}:`, err.message);
            errorCount++;
          }
        }
      }
      
      console.log(`Processed ${records.length} ${entityType} records (${savedCount} saved, ${errorCount} errors)`);
    } catch (error) {
      console.error(`Error in batch for ${entityType}:`, error.message);
    }
  }
};
// Generate financial reports from synced data
const generateFinancialReports = async (companyId, access_token, realmId) => {
  try {
    const baseUrl = process.env.QB_ENVIRONMENT === "sandbox"
      ? "https://sandbox-quickbooks.api.intuit.com"
      : "https://quickbooks.api.intuit.com";

    // Define report types to generate
    const reportTypes = [
      { type: 'profit_loss', endpoint: 'ProfitAndLoss' },
      { type: 'balance_sheet', endpoint: 'BalanceSheet' },
      { type: 'cash_flow', endpoint: 'CashFlow' }
    ];

    const startDate = new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0]; // Jan 1
    const endDate = new Date().toISOString().split('T')[0]; // Today

    for (const report of reportTypes) {
      try {
        const response = await axios.get(
          `${baseUrl}/v3/company/${realmId}/reports/${report.endpoint}`,
          {
            params: {
              start_date: startDate,
              end_date: endDate
            },
            headers: {
              Authorization: `Bearer ${access_token}`,
              Accept: "application/json"
            }
          }
        );

        // Save report to database
        await FinancialReport.create({
          company_id: companyId,
          report_type: report.type,
          report_name: `${report.type} Report`,
          report_data: response.data,
          date_range_start: startDate,
          date_range_end: endDate
        });

      } catch (error) {
        console.error(`Error generating ${report.type} report:`, error.message);
      }
    }

  } catch (error) {
    console.error('Error generating financial reports:', error);
  }
};

/* ====================================================================== */
/*                      DASHBOARD DATA FUNCTIONS                           */
/* ====================================================================== */

// Get dashboard data for a company
// exports.getCompanyDashboardData = async (req, res) => {
//   try {
//     const { companyId } = req.params;

//     // Get company with connection
//     const company = await Company.findByPk(companyId, {
//       include: [
//         {
//           model: QuickBooksConnection,
//           attributes: ['realm_id', 'sync_status', 'last_sync_at']
//         }
//       ]
//     });

//     if (!company) {
//       return res.status(404).json({ success: false, message: 'Company not found' });
//     }

//     // Get latest financial data
//     const recentReports = await FinancialReport.findAll({
//       where: { company_id: companyId },
//       order: [['created_at', 'DESC']],
//       limit: 3
//     });

//     // Get dashboard config
//     const dashboardConfig = await DashboardConfig.findOne({
//       where: { 
//         company_id: companyId,
//         is_default: true 
//       }
//     });

//     // Get key metrics from QuickBooks data
//     const keyMetrics = await calculateKeyMetrics(companyId);

//     res.json({
//       success: true,
//       data: {
//         company,
//         quickBooksConnected: !!company.QuickBooksConnection,
//         lastSync: company.QuickBooksConnection?.last_sync_at,
//         syncStatus: company.QuickBooksConnection?.sync_status,
//         keyMetrics,
//         recentReports,
//         dashboardConfig
//       }
//     });

//   } catch (error) {
//     console.error('Error getting dashboard data:', error);
//     res.status(500).json({ success: false, message: error.message });
//   }
// };

// Replace your existing getCompanyDashboardData (lines 404-448) with this:

exports.getCompanyDashboardData = async (req, res) => {
  try {
    const { companyId } = req.params;

    // Get company with connection
    const company = await Company.findByPk(companyId, {
      include: [
        {
          model: QuickBooksConnection,
          as: 'quickbooksConnection',
          attributes: ['id', 'realm_id', 'sync_status', 'last_sync_at']
        }
      ]
    });

    if (!company) {
      return res.status(404).json({ success: false, message: 'Company not found' });
    }

    const quickBooksConnected = !!company.quickbooksConnection;
    const sourceId = company.quickbooksConnection?.id || null;

    console.log('Company QB Connection:', company.quickbooksConnection);
    console.log('Source ID:', sourceId);
    // Get key metrics from QuickBooks data
    let keyMetrics = {
      totalRevenue: 0,
      totalExpenses: 0,
      netIncome: 0,
      accountsReceivable: 0,
      accountsPayable: 0,
      totalCustomers: 0,
      totalInvoices: 0
    };

    // Get monthly data for charts
    let monthlyData = [];
    let expensesByCategory = [];
    let profitLossSummary = [];
    let balanceSheetSummary = [];

    if (quickBooksConnected && sourceId) {
      // Calculate key metrics
      keyMetrics = await calculateKeyMetrics(companyId);
      
      // Get monthly data for revenue/expenses chart
      monthlyData = await generateMonthlyData(companyId);
      
      // Get expenses by category for pie chart
      expensesByCategory = await generateExpensesByCategory(companyId);
      
      // Get profit/loss summary
      profitLossSummary = await generateProfitLossSummary(companyId);
      
      // Get balance sheet summary
      balanceSheetSummary = await generateBalanceSheetSummary(companyId);
    }

    // Get latest financial reports
    const recentReports = await FinancialReport.findAll({
      where: { company_id: companyId },
      order: [['created_at', 'DESC']],
      limit: 3
    });

    // Get dashboard config
    const dashboardConfig = await DashboardConfig.findOne({
      where: { 
        company_id: companyId,
        is_default: true 
      }
    });

    // Return data in the format your frontend expects
    res.json({
      success: true,
      company: {
        id: company.id,
        name: company.name,
        domain: company.domain,
        subscription_plan: company.subscription_plan,
        subscription_status: company.subscription_status,
        currency: company.currency,
        timezone: company.timezone,
        sourceId: sourceId,
        quickbooks_realm_id: company.quickbooks_realm_id
      },
      quickBooksConnected,
      lastSync: company.quickbooksConnection?.last_sync_at,
      syncStatus: company.quickbooksConnection?.sync_status,
      financialData: {
        revenue: keyMetrics.totalRevenue,
        expenses: keyMetrics.totalExpenses,
        netIncome: keyMetrics.netIncome,
        cashBalance: keyMetrics.accountsReceivable - keyMetrics.accountsPayable,
        monthlyData: monthlyData,
        expensesByCategory: expensesByCategory,
        profitLossSummary: profitLossSummary,
        balanceSheetSummary: balanceSheetSummary
      },
      recentReports,
      dashboardConfig
    });

  } catch (error) {
    console.error('Error getting dashboard data:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Add these helper functions to generate chart data

const generateMonthlyData = async (companyId) => {
  try {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthlyMap = {};

    // Get invoices for revenue
    const invoices = await QuickBooksData.findAll({
      where: { 
        company_id: companyId,
        data_type: 'invoice'
      }
    });

    invoices.forEach(item => {
      const invoiceData = item.data;
      if (invoiceData.TxnDate) {
        const date = new Date(invoiceData.TxnDate);
        const monthKey = `${months[date.getMonth()]} ${date.getFullYear()}`;
        
        if (!monthlyMap[monthKey]) {
          monthlyMap[monthKey] = { month: monthKey, revenue: 0, expenses: 0 };
        }
        monthlyMap[monthKey].revenue += invoiceData.TotalAmt || 0;
      }
    });

    // Get bills for expenses
    const bills = await QuickBooksData.findAll({
      where: { 
        company_id: companyId,
        data_type: 'bill'
      }
    });

    bills.forEach(item => {
      const billData = item.data;
      if (billData.TxnDate) {
        const date = new Date(billData.TxnDate);
        const monthKey = `${months[date.getMonth()]} ${date.getFullYear()}`;
        
        if (!monthlyMap[monthKey]) {
          monthlyMap[monthKey] = { month: monthKey, revenue: 0, expenses: 0 };
        }
        monthlyMap[monthKey].expenses += billData.TotalAmt || 0;
      }
    });

    return Object.values(monthlyMap).sort((a, b) => {
      const dateA = new Date(a.month);
      const dateB = new Date(b.month);
      return dateA - dateB;
    }).slice(-12); // Last 12 months

  } catch (error) {
    console.error('Error generating monthly data:', error);
    return [];
  }
};

const generateExpensesByCategory = async (companyId) => {
  try {
    const categoryMap = {};

    const bills = await QuickBooksData.findAll({
      where: { 
        company_id: companyId,
        data_type: 'bill'
      }
    });

    bills.forEach(item => {
      const billData = item.data;
      const category = billData.Line?.[0]?.AccountBasedExpenseLineDetail?.AccountRef?.name || 'Other';
      
      if (!categoryMap[category]) {
        categoryMap[category] = { name: category, value: 0 };
      }
      categoryMap[category].value += billData.TotalAmt || 0;
    });

    return Object.values(categoryMap)
      .sort((a, b) => b.value - a.value)
      .slice(0, 5); // Top 5 categories

  } catch (error) {
    console.error('Error generating expenses by category:', error);
    return [];
  }
};

const generateProfitLossSummary = async (companyId) => {
  try {
    const summary = [];

    const accounts = await QuickBooksData.findAll({
      where: { 
        company_id: companyId,
        data_type: 'account'
      }
    });

    accounts.forEach(item => {
      const accountData = item.data;
      if (accountData.AccountType === 'Revenue') {
        summary.push({
          category: accountData.Name || 'Revenue',
          amount: accountData.CurrentBalance || 0,
          type: 'Revenue'
        });
      } else if (accountData.AccountType === 'Expense') {
        summary.push({
          category: accountData.Name || 'Expense',
          amount: (accountData.CurrentBalance || 0) * -1,
          type: 'Expense'
        });
      }
    });

    return summary.slice(0, 8); // Limit to 8 items

  } catch (error) {
    console.error('Error generating profit/loss summary:', error);
    return [];
  }
};

const generateBalanceSheetSummary = async (companyId) => {
  try {
    const summary = [];

    const accounts = await QuickBooksData.findAll({
      where: { 
        company_id: companyId,
        data_type: 'account'
      }
    });

    let totalAssets = 0;
    let totalLiabilities = 0;
    let totalEquity = 0;

    accounts.forEach(item => {
      const accountData = item.data;
      const accountType = accountData.AccountType;
      const balance = accountData.CurrentBalance || 0;

      if (accountType === 'Asset' || accountType === 'Bank' || accountType === 'Accounts Receivable') {
        totalAssets += balance;
      } else if (accountType === 'Liability' || accountType === 'Accounts Payable' || accountType === 'CreditCard') {
        totalLiabilities += balance;
      } else if (accountType === 'Equity') {
        totalEquity += balance;
      }
    });

    summary.push({ category: 'Assets', amount: totalAssets });
    summary.push({ category: 'Liabilities', amount: totalLiabilities });
    summary.push({ category: 'Equity', amount: totalEquity });

    return summary;

  } catch (error) {
    console.error('Error generating balance sheet summary:', error);
    return [];
  }
};

// Calculate key metrics from QuickBooks data
const calculateKeyMetrics = async (companyId) => {
  try {
    // Get accounts data
    const accounts = await QuickBooksData.findAll({
      where: { 
        company_id: companyId,
        data_type: 'account'
      }
    });

    // Get invoices data
    const invoices = await QuickBooksData.findAll({
      where: { 
        company_id: companyId,
        data_type: 'invoice'
      }
    });

    // Get customers data
    const customers = await QuickBooksData.findAll({
      where: { 
        company_id: companyId,
        data_type: 'customer'
      }
    });

    // Calculate metrics
    let totalRevenue = 0;
    let totalExpenses = 0;
    let accountsReceivable = 0;
    let accountsPayable = 0;

    // Process accounts
    accounts.forEach(account => {
      const accountData = account.data;
      if (accountData.AccountType === 'Revenue') {
        totalRevenue += accountData.CurrentBalance || 0;
      } else if (accountData.AccountType === 'Expenses') {
        totalExpenses += accountData.CurrentBalance || 0;
      } else if (accountData.AccountType === 'Accounts Receivable') {
        accountsReceivable += accountData.CurrentBalance || 0;
      } else if (accountData.AccountType === 'Accounts Payable') {
        accountsPayable += accountData.CurrentBalance || 0;
      }
    });

    // Process invoices for outstanding amounts
    invoices.forEach(invoice => {
      const invoiceData = invoice.data;
      if (invoiceData.Balance > 0) {
        accountsReceivable += invoiceData.Balance;
      }
    });

    return {
      totalRevenue,
      totalExpenses,
      netIncome: totalRevenue - totalExpenses,
      accountsReceivable,
      accountsPayable,
      totalCustomers: customers.length,
      totalInvoices: invoices.length
    };

  } catch (error) {
    console.error('Error calculating key metrics:', error);
    return {
      totalRevenue: 0,
      totalExpenses: 0,
      netIncome: 0,
      accountsReceivable: 0,
      accountsPayable: 0,
      totalCustomers: 0,
      totalInvoices: 0
    };
  }
};

// Get chart data for a specific chart
exports.getChartData = async (req, res) => {
  try {
    const { companyId, chartId } = req.params;

    const chartConfig = await ChartConfig.findOne({
      where: { 
        id: chartId,
        company_id: companyId 
      }
    });

    if (!chartConfig) {
      return res.status(404).json({ success: false, message: 'Chart not found' });
    }

    let chartData = [];

    // Generate chart data based on configuration
    switch (chartConfig.data_source) {
      case 'profit_loss':
        chartData = await getProfitLossData(companyId, chartConfig.configuration);
        break;
      case 'sales':
        chartData = await getSalesData(companyId, chartConfig.configuration);
        break;
      case 'expenses':
        chartData = await getExpensesData(companyId, chartConfig.configuration);
        break;
      default:
        chartData = await getCustomQueryData(companyId, chartConfig.configuration);
    }

    res.json({
      success: true,
      data: {
        chartConfig,
        chartData
      }
    });

  } catch (error) {
    console.error('Error getting chart data:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Helper functions for chart data
const getProfitLossData = async (companyId, config) => {
  // Get monthly profit/loss data
  const reports = await FinancialReport.findAll({
    where: { 
      company_id: companyId,
      report_type: 'profit_loss'
    },
    order: [['date_range_start', 'ASC']],
    limit: 12
  });

  return reports.map(report => ({
    month: report.date_range_start.toLocaleString('default', { month: 'short' }),
    profit: report.report_data?.Income || 0,
    loss: report.report_data?.Expenses || 0
  }));
};

const getSalesData = async (companyId, config) => {
  // Get sales data from invoices
  const invoices = await QuickBooksData.findAll({
    where: { 
      company_id: companyId,
      data_type: 'invoice'
    },
    limit: 100
  });

  // Group by month and calculate totals
  const salesByMonth = {};

  invoices.forEach(invoice => {
    const invoiceData = invoice.data;
    const date = new Date(invoiceData.TxnDate);
    const monthKey = `${date.getFullYear()}-${date.getMonth() + 1}`;
    
    if (!salesByMonth[monthKey]) {
      salesByMonth[monthKey] = {
        month: date.toLocaleString('default', { month: 'short' }),
        total: 0
      };
    }
    
    salesByMonth[monthKey].total += invoiceData.TotalAmt || 0;
  });

  return Object.values(salesByMonth);
};

const getExpensesData = async (companyId, config) => {
  // Get expenses by category
  const expenses = await QuickBooksData.findAll({
    where: { 
      company_id: companyId,
      data_type: 'bill'
    },
    limit: 100
  });

  const expensesByCategory = {};

  expenses.forEach(expense => {
    const expenseData = expense.data;
    const category = expenseData.Line?.[0]?.AccountBasedExpenseLineDetail?.AccountRef?.name || 'Other';
    
    if (!expensesByCategory[category]) {
      expensesByCategory[category] = {
        category,
        amount: 0
      };
    }
    
    expensesByCategory[category].amount += expenseData.TotalAmt || 0;
  });

  return Object.values(expensesByCategory);
};

const getCustomQueryData = async (companyId, config) => {
  // Implement custom query logic based on configuration
  return [];
};

/* ====================================================================== */
/*                      REPORT FUNCTIONS                                   */
/* ====================================================================== */

// Generate PDF report
// Generate PDF report
exports.generateReportPDF = async (req, res) => {
  try {
    const { companyId, reportId } = req.params;

    const report = await FinancialReport.findOne({
      where: { 
        id: reportId,
        company_id: companyId 
      }
    });

    if (!report) {
      return res.status(404).json({ success: false, message: 'Report not found' });
    }

    // Generate PDF using your preferred library
    // This is a placeholder - implement actual PDF generation
    const pdfBuffer = await generatePDFFromReport(report);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=report-${reportId}.pdf`);
    res.send(pdfBuffer);

  } catch (error) {
    console.error('Error generating PDF:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Schedule a report
exports.scheduleReport = async (req, res) => {
  try {
    const { companyId } = req.params;
    const { report_name, report_type, frequency, recipients, format } = req.body;

    // Calculate next generation date
    const nextGenerationAt = calculateNextGenerationDate(frequency);

    const scheduledReport = await ScheduledReport.create({
      company_id: companyId,
      report_name,
      report_type,
      frequency,
      recipients: recipients || [],
      format: format || 'pdf',
      next_generation_at: nextGenerationAt,
      is_active: true
    });

    res.status(201).json({
      success: true,
      message: 'Report scheduled successfully',
      data: scheduledReport
    });

  } catch (error) {
    console.error('Error scheduling report:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

const calculateNextGenerationDate = (frequency) => {
  const now = new Date();
  switch (frequency) {
    case 'daily':
      return new Date(now.setDate(now.getDate() + 1));
    case 'weekly':
      return new Date(now.setDate(now.getDate() + 7));
    case 'monthly':
      return new Date(now.setMonth(now.getMonth() + 1));
    case 'quarterly':
      return new Date(now.setMonth(now.getMonth() + 3));
    case 'yearly':
      return new Date(now.setFullYear(now.getFullYear() + 1));
    default:
      return new Date(now.setDate(now.getDate() + 1));
  }
};

// Generate PDF from report (placeholder)
const generatePDFFromReport = async (report) => {
  // Implement PDF generation logic here
  // You can use libraries like pdfkit, jsPDF, etc.
  return Buffer.from('PDF content');
};


/* ====================================================================== */
/*                      QUICKBOOKS AUTH FUNCTIONS                          */
/* ====================================================================== */

// Generate QuickBooks OAuth URL
exports.quickBooksAuth = async (req, res) => {
  try {
    const state = req.user.id; // logged in user id
    console.log("QuickBooks auth initiated for user:", state);

    const authUrl = `https://appcenter.intuit.com/connect/oauth2?client_id=${process.env.QB_CLIENT_ID}&response_type=code&scope=com.intuit.quickbooks.accounting&redirect_uri=${process.env.QB_REDIRECT_URI}&state=${state}`;

    res.json({ 
      success: true, 
      url: authUrl 
    });

  } catch (err) {
    console.error("Error in quickBooksAuth:", err);
    res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
};

// QuickBooks Refresh Token
exports.quickBooksRefreshToken = async (req, res) => {
  try {
    const { sourceId } = req.body;

    const source = await Source.findByPk(sourceId);

    if (!source) {
      return res.status(404).json({ 
        success: false, 
        message: 'Source not found' 
      });
    }

    const settings = source.connector_settings_json;
    
    const response = await axios.post(
      "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: settings.refresh_token
      }),
      {
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              `${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`
            ).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded"
        }
      }
    );

    settings.access_token = response.data.access_token;
    settings.refresh_token = response.data.refresh_token;
    settings.expires_at = Date.now() + response.data.expires_in * 1000;
    
    source.connector_settings_json = settings;
    await source.save();

    res.json({ 
      success: true, 
      message: "Token refreshed successfully" 
    });

  } catch (err) {
    console.error("Error refreshing token:", err);
    res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
};

// Get QuickBooks data for a source
exports.getQuickBooksData = async (req, res) => {
  try {
    const { sourceId } = req.params;

    const source = await Source.findByPk(sourceId);

    if (!source) {
      return res.status(404).json({ 
        success: false, 
        message: 'Source not found' 
      });
    }

    const settings = source.connector_settings_json;

    const baseUrl =
      process.env.QB_ENVIRONMENT === "sandbox"
        ? "https://sandbox-quickbooks.api.intuit.com"
        : "https://quickbooks.api.intuit.com";

    const headers = {
      Authorization: `Bearer ${settings.access_token}`,
      Accept: "application/json"
    };

    const customers = await axios.get(
      `${baseUrl}/v3/company/${settings.realmId}/query?query=select * from Customer`,
      { headers }
    );

    const invoices = await axios.get(
      `${baseUrl}/v3/company/${settings.realmId}/query?query=select * from Invoice`,
      { headers }
    );

    res.json({
      success: true,
      data: {
        customers: customers.data.QueryResponse.Customer || [],
        invoices: invoices.data.QueryResponse.Invoice || []
      }
    });

  } catch (err) {
    console.error("Error fetching QuickBooks data:", err);
    res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
};

// Get all QuickBooks entities
// exports.getAllQuickBooksEntities = async (req, res) => {
//   try {
//     const { sourceId } = req.params;
//     const { entityTypes } = req.query;

//     const source = await Source.findByPk(sourceId);

//     if (!source) {
//       return res.status(404).json({ 
//         success: false, 
//         message: 'Source not found' 
//       });
//     }

//     const settings = source.connector_settings_json;
    
//     // Check if token is expired and refresh if needed
//     if (settings.expires_at < Date.now()) {
//       // You'll need to implement token refresh logic here
//       return res.status(401).json({ 
//         success: false, 
//         message: 'Token expired. Please reconnect QuickBooks.' 
//       });
//     }

//     // Define all QuickBooks entity types
//     const allEntityTypes = [
//       'Account', 'Bill', 'BillPayment', 'Customer', 'Department',
//       'Deposit', 'Employee', 'Estimate', 'Invoice', 'Item',
//       'JournalEntry', 'Payment', 'PaymentMethod', 'Purchase',
//       'PurchaseOrder', 'RefundReceipt', 'SalesReceipt', 'TaxCode',
//       'TaxRate', 'Term', 'TimeActivity', 'Transfer', 'Vendor', 'VendorCredit'
//     ];

//     const typesToFetch = entityTypes ? entityTypes.split(',') : allEntityTypes;
//     const results = {};

//     const baseUrl = process.env.QB_ENVIRONMENT === "sandbox"
//       ? "https://sandbox-quickbooks.api.intuit.com"
//       : "https://quickbooks.api.intuit.com";

//     // Fetch each entity type
//     for (const entityType of typesToFetch) {
//       try {
//         console.log(`Fetching ${entityType}...`);
        
//         let allEntities = [];
//         let startPosition = 1;
//         const maxResults = 1000;
//         let hasMore = true;

//         while (hasMore) {
//           const query = `SELECT * FROM ${entityType} STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;
          
//           const response = await axios.get(
//             `${baseUrl}/v3/company/${settings.realmId}/query`,
//             {
//               params: { query },
//               headers: {
//                 Authorization: `Bearer ${settings.access_token}`,
//                 Accept: "application/json"
//               }
//             }
//           );

//           const entities = response.data.QueryResponse[entityType] || [];
//           allEntities = [...allEntities, ...entities];

//           if (entities.length < maxResults) {
//             hasMore = false;
//           } else {
//             startPosition += maxResults;
//           }
//         }

//         results[entityType] = allEntities;
//         console.log(`Fetched ${allEntities.length} ${entityType} records`);

//       } catch (error) {
//         console.error(`Error fetching ${entityType}:`, error.message);
//         results[entityType] = { error: error.message };
//       }
//     }

//     res.json({
//       success: true,
//       sourceId: source.id,
//       realmId: settings.realmId,
//       data: results,
//       summary: Object.keys(results).reduce((acc, key) => {
//         acc[key] = Array.isArray(results[key]) ? results[key].length : 0;
//         return acc;
//       }, {})
//     });

//   } catch (err) {
//     console.error("Error fetching QuickBooks data:", err);
//     res.status(500).json({ 
//       success: false, 
//       message: err.message 
//     });
//   }
// };

// Update this function in your QuickBookLogingController.js

// Get all QuickBooks entities
exports.getAllQuickBooksEntities = async (req, res) => {
  try {
    const { sourceId } = req.params;
    
    // 🟢 ADD THIS VALIDATION
    if (!sourceId || sourceId === 'undefined' || sourceId === 'null') {
      return res.status(400).json({ 
        success: false, 
        message: 'Valid source ID is required' 
      });
    }

    console.log(`Fetching source with ID: ${sourceId}`);

    const source = await Source.findByPk(parseInt(sourceId)); // 🟢 Parse to integer

    if (!source) {
      return res.status(404).json({ 
        success: false, 
        message: `Source not found with ID: ${sourceId}` 
      });
    }

    const settings = source.connector_settings_json;
    
    // Check if token is expired
    if (settings.expires_at < Date.now()) {
      return res.status(401).json({ 
        success: false, 
        message: 'Token expired. Please reconnect QuickBooks.' 
      });
    }

    // Rest of your function remains the same...
    const { entityTypes } = req.query;
    
    // Define all QuickBooks entity types
    const allEntityTypes = [
      'Account', 'Bill', 'BillPayment', 'Customer', 'Department',
      'Deposit', 'Employee', 'Estimate', 'Invoice', 'Item',
      'JournalEntry', 'Payment', 'PaymentMethod', 'Purchase',
      'PurchaseOrder', 'RefundReceipt', 'SalesReceipt', 'TaxCode',
      'TaxRate', 'Term', 'TimeActivity', 'Transfer', 'Vendor', 'VendorCredit'
    ];

    const typesToFetch = entityTypes ? entityTypes.split(',') : allEntityTypes;
    const results = {};

    const baseUrl = process.env.QB_ENVIRONMENT === "sandbox"
      ? "https://sandbox-quickbooks.api.intuit.com"
      : "https://quickbooks.api.intuit.com";

    // Fetch each entity type
    for (const entityType of typesToFetch) {
      try {
        console.log(`Fetching ${entityType}...`);
        
        let allEntities = [];
        let startPosition = 1;
        const maxResults = 1000;
        let hasMore = true;

        while (hasMore) {
          const query = `SELECT * FROM ${entityType} STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;
          
          const response = await axios.get(
            `${baseUrl}/v3/company/${settings.realmId}/query`,
            {
              params: { query },
              headers: {
                Authorization: `Bearer ${settings.access_token}`,
                Accept: "application/json"
              }
            }
          );

          const entities = response.data.QueryResponse[entityType] || [];
          allEntities = [...allEntities, ...entities];

          if (entities.length < maxResults) {
            hasMore = false;
          } else {
            startPosition += maxResults;
          }
        }

        results[entityType] = allEntities;
        console.log(`Fetched ${allEntities.length} ${entityType} records`);

      } catch (error) {
        console.error(`Error fetching ${entityType}:`, error.message);
        results[entityType] = { error: error.message };
      }
    }

    res.json({
      success: true,
      sourceId: source.id,
      realmId: settings.realmId,
      data: results,
      summary: Object.keys(results).reduce((acc, key) => {
        acc[key] = Array.isArray(results[key]) ? results[key].length : 0;
        return acc;
      }, {})
    });

  } catch (err) {
    console.error("Error fetching QuickBooks data:", err);
    res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
};

// Get specific QuickBooks entity
exports.getQuickBooksEntity = async (req, res) => {
  try {
    const { sourceId, entityType } = req.params;
    const { limit, offset, where } = req.query;

    const source = await Source.findByPk(sourceId);

    if (!source) {
      return res.status(404).json({ 
        success: false, 
        message: 'Source not found' 
      });
    }

    const settings = source.connector_settings_json;

    const baseUrl = process.env.QB_ENVIRONMENT === "sandbox"
      ? "https://sandbox-quickbooks.api.intuit.com"
      : "https://quickbooks.api.intuit.com";

    let query = `SELECT * FROM ${entityType}`;
    
    if (where) {
      query += ` WHERE ${where}`;
    }
    
    if (limit) {
      query += ` MAXRESULTS ${limit}`;
    }
    
    if (offset) {
      query += ` STARTPOSITION ${offset}`;
    }

    const response = await axios.get(
      `${baseUrl}/v3/company/${settings.realmId}/query`,
      {
        params: { query },
        headers: {
          Authorization: `Bearer ${settings.access_token}`,
          Accept: "application/json"
        }
      }
    );

    res.json({
      success: true,
      entityType,
      data: response.data.QueryResponse[entityType] || [],
      totalCount: response.data.QueryResponse.totalCount || 0
    });

  } catch (err) {
    console.error(`Error fetching ${req.params.entityType}:`, err);
    res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
};

// Sync QuickBooks data
exports.syncQuickBooksData = async (req, res) => {
  try {
    const { sourceId } = req.params;
    
    const source = await Source.findByPk(sourceId);

    if (!source) {
      return res.status(404).json({ 
        success: false, 
        message: 'Source not found' 
      });
    }

    const settings = source.connector_settings_json;
    
    // Check if token is expired
    if (settings.expires_at < Date.now()) {
      return res.status(401).json({ 
        success: false, 
        message: 'Token expired. Please reconnect QuickBooks.' 
      });
    }

    // Here you would implement your sync logic
    // This could call your triggerQuickBooksSync function

    res.json({
      success: true,
      message: "Sync completed successfully",
      sourceId: source.id
    });

  } catch (err) {
    console.error("Error syncing QuickBooks data:", err);
    res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
};


// exports.getRealmIdByUserId = async (req, res) => {
//     try {
//         const { userId } = req.params;
//         console.log("Fetching realm ID for user:", userId);

//         if (!userId) {
//             return res.status(400).json({
//                 success: false,
//                 data: null,
//                 message: "User ID is required."
//             });
//         }

//         // First get the user to find their company_id
//         const user = await User.findByPk(userId, {
//             attributes: ['id', 'company_id']
//         });

//         if (!user) {
//             return res.status(404).json({
//                 success: false,
//                 data: null,
//                 message: "User not found."
//             });
//         }

//         if (!user.company_id) {
//             return res.status(404).json({
//                 success: false,
//                 data: null,
//                 message: "User is not associated with any company."
//             });
//         }

//         // Directly query the QuickBooksConnection table using company_id
//         const quickbooksConnection = await QuickBooksConnection.findOne({
//             where: { 
//                 company_id: user.company_id 
//             },
//             attributes: ['id', 'realm_id',  'sync_status', 'last_sync_at'],
//             include: [{
//                 model: Company,
//                 as: 'company', // This should match your association
//                 attributes: ['id', 'name']
//             }]
//         });
// console.log("QuickBooks connection found:", quickbooksConnection.company?.id);
//         if (!quickbooksConnection) {
//             return res.status(404).json({
//                 success: false,
//                 data: null,
//                 message: "No QuickBooks connection found for this user's company."
//             });
//         }

//         return res.status(200).json({
//             success: true,
//             data: {
//                 realmId: quickbooksConnection.realm_id,
//                 connectionId: quickbooksConnection.id,
//                 companyId:quickbooksConnection.company?.id,
//                 companyName: quickbooksConnection.company?.name,
//                 // connectedAt: quickbooksConnection.connected_at,
//                 // lastSyncAt: quickbooksConnection.last_sync_at,
//                 // syncStatus: quickbooksConnection.sync_status,
//                 // status: quickbooksConnection.status
//             },
//             message: "Realm ID retrieved successfully."
//         });

//     } catch (error) {
//         console.error("Error fetching realm ID by user ID:", error);
//         return res.status(500).json({
//             success: false,
//             data: null,
//             message: "Something went wrong while fetching realm ID.",
//             error: process.env.NODE_ENV === 'development' ? error.message : undefined
//         });
//     }
// };



// Helper function to check if token is expired
const isTokenExpired = (quickbooksConnection) => {
  if (!quickbooksConnection || !quickbooksConnection.expires_in || !quickbooksConnection.updated_at) {
    return true; // If no expiry info, assume expired
  }

  // Calculate expiry time based on when token was updated
  const expiryTime = new Date(quickbooksConnection.updated_at);
  expiryTime.setSeconds(expiryTime.getSeconds() + quickbooksConnection.expires_in);
  
  // Check if current time is past expiry time
  const now = new Date();
  return now > expiryTime;
};

// Helper function to refresh QuickBooks token
const refreshQuickBooksToken = async (quickbooksConnection) => {
  try {
    console.log("Refreshing expired token for connection:", quickbooksConnection.id);
    
    const response = await axios.post(
      "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: quickbooksConnection.refresh_token
      }),
      {
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              `${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`
            ).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded"
        }
      }
    );

    const { access_token, refresh_token, expires_in } = response.data;
    
    // Update the connection with new tokens
    await quickbooksConnection.update({
      access_token: access_token,
      refresh_token: refresh_token,
      expires_in: expires_in,
      updated_at: new Date()
    });

    console.log("Token refreshed successfully for connection:", quickbooksConnection.id);
    
    return true;
  } catch (error) {
    console.error("Error refreshing token:", error.response?.data || error.message);
    return false;
  }
};

exports.getRealmIdByUserId = async (req, res) => {
    try {
        const { userId } = req.params;
        console.log("Fetching realm ID for user:", userId);

        if (!userId) {
            return res.status(400).json({
                success: false,
                data: null,
                message: "User ID is required."
            });
        }

        // First get the user to find their company_id
        const user = await User.findByPk(userId, {
            attributes: ['id', 'company_id']
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                data: null,
                message: "User not found."
            });
        }

        if (!user.company_id) {
            return res.status(404).json({
                success: false,
                data: null,
                message: "User is not associated with any company."
            });
        }

        // Directly query the QuickBooksConnection table using company_id
        const quickbooksConnection = await QuickBooksConnection.findOne({
            where: { 
                company_id: user.company_id 
            },
            attributes: [
                'id', 'realm_id', 'access_token', 'refresh_token', 
                'expires_in', 'updated_at', 'sync_status', 'last_sync_at'
            ],
            include: [{
                model: Company,
                as: 'company',
                attributes: ['id', 'name']
            }]
        });

        console.log("QuickBooks connection found:", quickbooksConnection?.company?.id);

        if (!quickbooksConnection) {
            return res.status(404).json({
                success: false,
                data: null,
                message: "No QuickBooks connection found for this user's company."
            });
        }

        // Check if token is expired - ONLY refresh if actually expired
        let tokenRefreshed = false;
        if (isTokenExpired(quickbooksConnection)) {
            console.log("Token is expired, refreshing...");
            const refreshSuccess = await refreshQuickBooksToken(quickbooksConnection);
            
            if (!refreshSuccess) {
                return res.status(401).json({
                    success: false,
                    data: null,
                    message: "QuickBooks token expired and could not be refreshed. Please reconnect QuickBooks.",
                    requiresReconnect: true
                });
            }
            
            tokenRefreshed = true;
            console.log("Token refreshed successfully");
        } else {
            console.log("Token is still valid, no refresh needed");
        }

        // Get the latest data (refresh the connection object if token was refreshed)
        const connectionData = tokenRefreshed 
            ? await QuickBooksConnection.findByPk(quickbooksConnection.id, {
                attributes: ['realm_id', 'sync_status', 'last_sync_at'],
                include: [{
                    model: Company,
                    as: 'company',
                    attributes: ['id', 'name']
                }]
              })
            : quickbooksConnection;

        return res.status(200).json({
            success: true,
            data: {
                realmId: connectionData.realm_id,
                connectionId: connectionData.id,
                companyId: connectionData.company?.id || user.company_id,
                companyName: connectionData.company?.name,
                syncStatus: connectionData.sync_status,
                lastSyncAt: connectionData.last_sync_at,
                tokenRefreshed: tokenRefreshed // Inform frontend if token was refreshed
            },
            message: tokenRefreshed 
                ? "Realm ID retrieved successfully with refreshed token." 
                : "Realm ID retrieved successfully."
        });

    } catch (error) {
        console.error("Error fetching realm ID by user ID:", error);
        return res.status(500).json({
            success: false,
            data: null,
            message: "Something went wrong while fetching realm ID.",
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

// Export all functions
// Export all functions
module.exports = {
  getRealmIdByUserId: exports.getRealmIdByUserId,
  // Company functions
  createCompany: exports.createCompany,
  getAllCompanies: exports.getAllCompanies,
  getCompanyById: exports.getCompanyById,
  updateCompany: exports.updateCompany,
  deleteCompany: exports.deleteCompany,
  
  // QuickBooks functions
  quickBooksAuth: exports.quickBooksAuth,           // ✅ Now this exists
  quickBooksCallback: exports.quickBooksCallback,
  quickBooksRefreshToken: exports.quickBooksRefreshToken,
  getQuickBooksData: exports.getQuickBooksData,
  getAllQuickBooksEntities: exports.getAllQuickBooksEntities,
  getQuickBooksEntity: exports.getQuickBooksEntity,
  syncQuickBooksData: exports.syncQuickBooksData,
  
  // Dashboard functions
  getCompanyDashboardData: exports.getCompanyDashboardData,
  getChartData: exports.getChartData,
  
  // Report functions
  generateReportPDF: exports.generateReportPDF,
  scheduleReport: exports.scheduleReport
};