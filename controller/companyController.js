// controller/companyController.js
const { Company, QuickBooksConnection, QuickBooksData, User, Role, Source } = require('../model');
const { Op } = require('sequelize');

const getCompanyDashboardData = async (req, res) => {
  try {
    const { companyId } = req.params;
    const userId = req.user.id;

    console.log(`Fetching dashboard data for company: ${companyId}, user: ${userId}`);

    // Get company with QuickBooks connection
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
      return res.status(404).json({ 
        success: false, 
        message: 'Company not found' 
      });
    }

    // Check if user has access to this company
    const user = await User.findByPk(userId);
    if (user.company_id !== parseInt(companyId) && user.role_id !== 1) { // Assuming role_id 1 is admin
      return res.status(403).json({ 
        success: false, 
        message: 'You do not have access to this company' 
      });
    }

    // Resolve the real Source row for QuickBooks (used by /api/source/auth/quickbooks/entities/:sourceId).
    // NOTE: do NOT use quickbooksConnection.id here — that's the PK of the
    // quickbooks_connections table and has no relation to source.id.
    const qbSource = await Source.findOne({
      where: {
        company_id: companyId,
        connector_name: { [Op.iLike]: '%quickbooks%' },
      },
      order: [['id', 'DESC']],
      attributes: ['id'],
    });
    const sourceId = qbSource?.id || null;
    const quickBooksConnected = !!company.quickbooksConnection;

    // Initialize financial data
    let financialData = {
      revenue: 0,
      expenses: 0,
      netIncome: 0,
      cashBalance: 0,
      monthlyData: [],
      expensesByCategory: [],
      profitLossSummary: [],
      balanceSheetSummary: []
    };

    // If QuickBooks is connected, fetch and process data
    if (quickBooksConnected && sourceId) {
      financialData = await processQuickBooksData(companyId, sourceId);
    }

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
      financialData
    });

  } catch (error) {
    console.error('Error in getCompanyDashboardData:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
};

// Process QuickBooks data for dashboard
const processQuickBooksData = async (companyId, sourceId) => {
  try {
    // Fetch all QuickBooks data for this company
    const qbData = await QuickBooksData.findAll({
      where: { 
        company_id: companyId,
        source_id: sourceId
      }
    });

    console.log(`Found ${qbData.length} QuickBooks records for company ${companyId}`);

    // Organize data by type
    const dataByType = {};
    qbData.forEach(item => {
      const type = item.data_type;
      if (!dataByType[type]) {
        dataByType[type] = [];
      }
      dataByType[type].push(item.data);
    });

    // Calculate metrics
    const revenue = calculateRevenue(dataByType);
    const expenses = calculateExpenses(dataByType);
    const cashBalance = calculateCashBalance(dataByType);
    
    return {
      revenue,
      expenses,
      netIncome: revenue - expenses,
      cashBalance,
      monthlyData: generateMonthlyData(dataByType),
      expensesByCategory: generateExpensesByCategory(dataByType),
      profitLossSummary: generateProfitLossSummary(dataByType),
      balanceSheetSummary: generateBalanceSheetSummary(dataByType)
    };
  } catch (error) {
    console.error('Error processing QuickBooks data:', error);
    return {
      revenue: 0,
      expenses: 0,
      netIncome: 0,
      cashBalance: 0,
      monthlyData: [],
      expensesByCategory: [],
      profitLossSummary: [],
      balanceSheetSummary: []
    };
  }
};

// Helper functions
const calculateRevenue = (data) => {
  let total = 0;
  if (data.invoice) {
    total += data.invoice.reduce((sum, inv) => sum + (inv.TotalAmt || 0), 0);
  }
  if (data.salesreceipt) {
    total += data.salesreceipt.reduce((sum, sr) => sum + (sr.TotalAmt || 0), 0);
  }
  if (data.payment) {
    total += data.payment.reduce((sum, p) => sum + (p.TotalAmt || 0), 0);
  }
  return total;
};

const calculateExpenses = (data) => {
  let total = 0;
  if (data.bill) {
    total += data.bill.reduce((sum, bill) => sum + (bill.TotalAmt || 0), 0);
  }
  if (data.purchase) {
    total += data.purchase.reduce((sum, purchase) => sum + (purchase.TotalAmt || 0), 0);
  }
  if (data.expense) {
    total += data.expense.reduce((sum, exp) => sum + (exp.TotalAmt || 0), 0);
  }
  return total;
};

const calculateCashBalance = (data) => {
  let balance = 0;
  if (data.account) {
    const cashAccounts = data.account.filter(acc => 
      acc.AccountType === 'Bank' || acc.AccountType === 'Cash' || acc.AccountType === 'CreditCard'
    );
    balance += cashAccounts.reduce((sum, acc) => sum + (acc.CurrentBalance || 0), 0);
  }
  return balance;
};

const generateMonthlyData = (data) => {
  const monthlyMap = {};
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  
  // Process invoices (revenue)
  if (data.invoice) {
    data.invoice.forEach(inv => {
      if (inv.TxnDate) {
        const date = new Date(inv.TxnDate);
        const monthKey = `${months[date.getMonth()]} ${date.getFullYear()}`;
        
        if (!monthlyMap[monthKey]) {
          monthlyMap[monthKey] = { month: monthKey, revenue: 0, expenses: 0 };
        }
        monthlyMap[monthKey].revenue += inv.TotalAmt || 0;
      }
    });
  }
  
  // Process bills (expenses)
  if (data.bill) {
    data.bill.forEach(bill => {
      if (bill.TxnDate) {
        const date = new Date(bill.TxnDate);
        const monthKey = `${months[date.getMonth()]} ${date.getFullYear()}`;
        
        if (!monthlyMap[monthKey]) {
          monthlyMap[monthKey] = { month: monthKey, revenue: 0, expenses: 0 };
        }
        monthlyMap[monthKey].expenses += bill.TotalAmt || 0;
      }
    });
  }
  
  return Object.values(monthlyMap).sort((a, b) => {
    const dateA = new Date(a.month);
    const dateB = new Date(b.month);
    return dateA - dateB;
  }).slice(-12); // Last 12 months
};

const generateExpensesByCategory = (data) => {
  const categoryMap = {};
  
  if (data.bill) {
    data.bill.forEach(bill => {
      const category = bill.Line?.[0]?.AccountBasedExpenseLineDetail?.AccountRef?.name || 'Other';
      if (!categoryMap[category]) {
        categoryMap[category] = { name: category, value: 0 };
      }
      categoryMap[category].value += bill.TotalAmt || 0;
    });
  }
  
  if (data.purchase) {
    data.purchase.forEach(purchase => {
      const category = purchase.Line?.[0]?.AccountBasedExpenseLineDetail?.AccountRef?.name || 'Other';
      if (!categoryMap[category]) {
        categoryMap[category] = { name: category, value: 0 };
      }
      categoryMap[category].value += purchase.TotalAmt || 0;
    });
  }
  
  return Object.values(categoryMap)
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);
};

const generateProfitLossSummary = (data) => {
  const summary = [];
  
  if (data.account) {
    const revenueAccounts = data.account.filter(acc => acc.AccountType === 'Revenue');
    revenueAccounts.slice(0, 4).forEach(acc => {
      summary.push({
        category: acc.Name || 'Revenue',
        amount: acc.CurrentBalance || 0,
        type: 'Revenue'
      });
    });
    
    const expenseAccounts = data.account.filter(acc => acc.AccountType === 'Expense');
    expenseAccounts.slice(0, 4).forEach(acc => {
      summary.push({
        category: acc.Name || 'Expense',
        amount: (acc.CurrentBalance || 0) * -1,
        type: 'Expense'
      });
    });
  }
  
  return summary;
};

const generateBalanceSheetSummary = (data) => {
  const summary = [];
  
  if (data.account) {
    const assetAccounts = data.account.filter(acc => 
      acc.AccountType === 'Asset' || acc.AccountType === 'Bank' || acc.AccountType === 'Accounts Receivable'
    );
    const totalAssets = assetAccounts.reduce((sum, acc) => sum + (acc.CurrentBalance || 0), 0);
    summary.push({ category: 'Assets', amount: totalAssets });
    
    const liabilityAccounts = data.account.filter(acc => 
      acc.AccountType === 'Liability' || acc.AccountType === 'Accounts Payable' || acc.AccountType === 'CreditCard'
    );
    const totalLiabilities = liabilityAccounts.reduce((sum, acc) => sum + (acc.CurrentBalance || 0), 0);
    summary.push({ category: 'Liabilities', amount: totalLiabilities });
    
    const equityAccounts = data.account.filter(acc => acc.AccountType === 'Equity');
    const totalEquity = equityAccounts.reduce((sum, acc) => sum + (acc.CurrentBalance || 0), 0);
    summary.push({ category: 'Equity', amount: totalEquity });
  }
  
  return summary;
};

// Create company (if you need this)
const createCompany = async (req, res) => {
  try {
    const { name, domain, subscription_plan, currency, timezone } = req.body;
    
    const company = await Company.create({
      name,
      domain,
      subscription_plan: subscription_plan || 'basic',
      subscription_status: 'active',
      currency: currency || 'USD',
      timezone: timezone || 'UTC'
    });
    
    res.status(201).json({
      success: true,
      data: company
    });
  } catch (error) {
    console.error('Error creating company:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get all companies
const getAllCompanies = async (req, res) => {
  try {
    const companies = await Company.findAll();
    res.json({ success: true, data: companies });
  } catch (error) {
    console.error('Error fetching companies:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

const listCompanies = async (req, res) => {
  try {
    const { isSuperAdmin, companyId } = req.auth;
    const where = isSuperAdmin ? {} : { id: companyId };
    const companies = await Company.findAll({
      where,
      include: [{ model: User, as: 'users', attributes: ['id', 'display_name', 'email', 'user_name', 'is_active', 'company_id'], include: [{ model: Role, as: 'userRole', attributes: ['id', 'name'] }] }],
      order: [['id', 'DESC']],
    });
    return res.json({ success: true, data: companies });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const adminCreateCompany = async (req, res) => {
  try {
    const { name, domain, subscription_plan, currency, timezone } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Company name is required' });
    const company = await Company.create({
      name, domain: domain || null,
      subscription_plan: subscription_plan || 'basic',
      subscription_status: 'trial',
      subscription_expiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      currency: currency || 'USD',
      timezone: timezone || 'UTC',
      is_active: true,
    });
    return res.status(201).json({ success: true, data: company, message: 'Company created' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const updateCompany = async (req, res) => {
  try {
    const company = await Company.findByPk(req.params.id);
    if (!company) return res.status(404).json({ success: false, message: 'Company not found' });
    const { name, domain, subscription_plan, subscription_status, currency, timezone, is_active } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (domain !== undefined) updates.domain = domain;
    if (subscription_plan !== undefined) updates.subscription_plan = subscription_plan;
    if (subscription_status !== undefined) updates.subscription_status = subscription_status;
    if (currency !== undefined) updates.currency = currency;
    if (timezone !== undefined) updates.timezone = timezone;
    if (is_active !== undefined) updates.is_active = is_active;
    await company.update(updates);
    return res.json({ success: true, data: company, message: 'Company updated' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const deleteCompany = async (req, res) => {
  try {
    const company = await Company.findByPk(req.params.id);
    if (!company) return res.status(404).json({ success: false, message: 'Company not found' });
    await User.update({ company_id: null }, { where: { company_id: company.id } });
    await company.destroy();
    return res.json({ success: true, message: 'Company deleted' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const assignUser = async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'userId required' });
    const user = await User.findByPk(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    await user.update({ company_id: req.params.id });
    return res.json({ success: true, message: 'User assigned to company' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  getCompanyDashboardData,
  createCompany,
  getAllCompanies,
  listCompanies,
  adminCreateCompany,
  updateCompany,
  deleteCompany,
  assignUser,
};