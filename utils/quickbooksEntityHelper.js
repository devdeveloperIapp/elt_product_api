/**
 * QuickBooks Entity Helper
 * Single source of truth for all QuickBooks entities
 * Ensures consistency between schema discovery and ETL processes
 */

const QUICKBOOKS_ENTITIES = {
  // ==================== CORE ACCOUNTING ENTITIES ====================
  ACCOUNT: {
    apiName: "Account",
    displayName: "Accounts",
    category: "chart_of_accounts",
    description: "Chart of accounts including assets, liabilities, equity, income, and expenses",
  },
  CUSTOMER: {
    apiName: "Customer",
    displayName: "Customers",
    category: "contacts",
    description: "Business customers and their contact information",
  },
  VENDOR: {
    apiName: "Vendor",
    displayName: "Vendors",
    category: "contacts",
    description: "Business vendors and suppliers",
  },
  EMPLOYEE: {
    apiName: "Employee",
    displayName: "Employees",
    category: "contacts",
    description: "Company employees and their details",
  },

  // ==================== TRANSACTION ENTITIES ====================
  INVOICE: {
    apiName: "Invoice",
    displayName: "Invoices",
    category: "sales",
    description: "Customer invoices and sales transactions",
  },
  BILL: {
    apiName: "Bill",
    displayName: "Bills",
    category: "purchases",
    description: "Vendor bills and purchase transactions",
  },
  PAYMENT: {
    apiName: "Payment",
    displayName: "Payments",
    category: "sales",
    description: "Customer payments against invoices",
  },
  BILL_PAYMENT: {
    apiName: "BillPayment",
    displayName: "Bill Payments",
    category: "purchases",
    description: "Payments made to vendors against bills",
  },
  CREDIT_MEMO: {
    apiName: "CreditMemo",
    displayName: "Credit Memos",
    category: "sales",
    description: "Credit memos issued to customers",
  },
  SALES_RECEIPT: {
    apiName: "SalesReceipt",
    displayName: "Sales Receipts",
    category: "sales",
    description: "Sales receipts for immediate payments",
  },
  REFUND_RECEIPT: {
    apiName: "RefundReceipt",
    displayName: "Refund Receipts",
    category: "sales",
    description: "Refunds issued to customers",
  },
  DEPOSIT: {
    apiName: "Deposit",
    displayName: "Deposits",
    category: "banking",
    description: "Bank deposits and transactions",
  },
  JOURNAL_ENTRY: {
    apiName: "JournalEntry",
    displayName: "Journal Entries",
    category: "accounting",
    description: "Manual journal entries for accounting adjustments",
  },

  // ==================== PRODUCT/SERVICE ENTITIES ====================
  ITEM: {
    apiName: "Item",
    displayName: "Items",
    category: "products_services",
    description: "Products, services, and inventory items",
  },

  // ==================== ORGANIZATION ENTITIES ====================
  DEPARTMENT: {
    apiName: "Department",
    displayName: "Departments",
    category: "organization",
    description: "Company departments for tracking and reporting",
  },
  CLASS: {
    apiName: "Class",
    displayName: "Classes",
    category: "organization",
    description: "Classes for tracking income and expenses by segment",
  },
  TERM: {
    apiName: "Term",
    displayName: "Payment Terms",
    category: "organization",
    description: "Payment terms for customers and vendors",
  },

  // ==================== TAX ENTITIES ====================
  TAX_CODE: {
    apiName: "TaxCode",
    displayName: "Tax Codes",
    category: "tax",
    description: "Tax codes for sales tax calculations",
  },
  TAX_RATE: {
    apiName: "TaxRate",
    displayName: "Tax Rates",
    category: "tax",
    description: "Tax rates applied to transactions",
  },
  TAX_AGENCY: {
    apiName: "TaxAgency",
    displayName: "Tax Agencies",
    category: "tax",
    description: "Government tax agencies for reporting",
  },

  // ==================== OTHER ENTITIES ====================
  PAYMENT_METHOD: {
    apiName: "PaymentMethod",
    displayName: "Payment Methods",
    category: "preferences",
    description: "Accepted payment methods (credit card, cash, check, etc.)",
  },
  BUDGET: {
    apiName: "Budget",
    displayName: "Budgets",
    category: "planning",
    description: "Budget plans for financial planning",
  },
  PURCHASE_ORDER: {
    apiName: "PurchaseOrder",
    displayName: "Purchase Orders",
    category: "purchases",
    description: "Purchase orders for inventory and services",
  },
  PURCHASE: {
    apiName: "Purchase",
    displayName: "Purchases",
    category: "purchases",
    description: "Purchase transactions for goods and services",
  },
  TRANSFER: {
    apiName: "Transfer",
    displayName: "Transfers",
    category: "banking",
    description: "Fund transfers between accounts",
  },
  ESTIMATE: {
    apiName: "Estimate",
    displayName: "Estimates",
    category: "sales",
    description: "Sales estimates and quotes for customers",
  },

  // ==================== NEWLY ADDED ENTITIES ====================
  ATTACHABLE: {
    apiName: "Attachable",
    displayName: "Attachments",
    category: "files",
    description: "Files and attachments linked to QuickBooks entities",
  },
  COMPANY_INFO: {
    apiName: "CompanyInfo",
    displayName: "Company Information",
    category: "company",
    description: "Basic company information and preferences",
  },
  PREFERENCES: {
    apiName: "Preferences",
    displayName: "Preferences",
    category: "company",
    description: "Company-wide accounting preferences and settings",
  },
  CUSTOMER_TYPE: {
    apiName: "CustomerType",
    displayName: "Customer Types",
    category: "contacts",
    description: "Classification of customers by type",
  },
  TAX_CLASSIFICATION: {
    apiName: "TaxClassification",
    displayName: "Tax Classifications",
    category: "tax",
    description: "Tax classifications for entities",
  },
  COMPANY_CURRENCY: {
    apiName: "CompanyCurrency",
    displayName: "Company Currencies",
    category: "currency",
    description: "Currencies used by the company",
  },
  EXCHANGE_RATE: {
    apiName: "ExchangeRate",
    displayName: "Exchange Rates",
    category: "currency",
    description: "Currency exchange rates",
  },
  JOURNAL_CODE: {
    apiName: "JournalCode",
    displayName: "Journal Codes",
    category: "accounting",
    description: "Journal codes for accounting entries",
  },
  CREDIT_CARD_PAYMENT: {
    apiName: "CreditCardPayment",
    displayName: "Credit Card Payments",
    category: "banking",
    description: "Credit card payment transactions",
  },
  REIMBURSE_CHARGE: {
    apiName: "ReimburseCharge",
    displayName: "Reimburse Charges",
    category: "expenses",
    description: "Employee expense reimbursements",
  },
  RECURRING_TRANSACTION: {
    apiName: "RecurringTransaction",
    displayName: "Recurring Transactions",
    category: "automation",
    description: "Scheduled recurring transactions",
  },
  BATCH: {
    apiName: "Batch",
    displayName: "Batches",
    category: "operations",
    description: "Batch operations for multiple transactions",
  },
  CHANGE_DATA_CAPTURE: {
    apiName: "ChangeDataCapture",
    displayName: "Change Data Capture",
    category: "sync",
    description: "Track changes to QuickBooks data",
  },
  ENTITLEMENTS: {
    apiName: "Entitlements",
    displayName: "Entitlements",
    category: "subscriptions",
    description: "User entitlements and permissions",
  },
  TAX_PAYMENT: {
    apiName: "TaxPayment",
    displayName: "Tax Payments",
    category: "tax",
    description: "Tax payments to tax agencies",
  },

  // ==================== REPORTING ENTITIES ====================
  AP_AGING_DETAIL: {
    apiName: "APAgingDetail",
    displayName: "AP Aging Detail",
    category: "reports",
    description: "Accounts Payable aging detail report",
  },
  AR_AGING_DETAIL: {
    apiName: "ARAgingDetail",
    displayName: "AR Aging Detail",
    category: "reports",
    description: "Accounts Receivable aging detail report",
  },
  BALANCE_SHEET: {
    apiName: "BalanceSheet",
    displayName: "Balance Sheet",
    category: "reports",
    description: "Balance sheet financial statement",
  },
  PROFIT_AND_LOSS: {
    apiName: "ProfitAndLoss",
    displayName: "Profit and Loss",
    category: "reports",
    description: "Profit and Loss statement",
  },
  PROFIT_AND_LOSS_DETAIL: {
    apiName: "ProfitAndLossDetail",
    displayName: "Profit and Loss Detail",
    category: "reports",
    description: "Detailed Profit and Loss statement",
  },
  CASH_FLOW: {
    apiName: "CashFlow",
    displayName: "Cash Flow",
    category: "reports",
    description: "Cash flow statement",
  },
  TRIAL_BALANCE: {
    apiName: "TrialBalance",
    displayName: "Trial Balance",
    category: "reports",
    description: "Trial balance report",
  },
  GENERAL_LEDGER: {
    apiName: "GeneralLedger",
    displayName: "General Ledger",
    category: "reports",
    description: "General ledger report",
  },
  JOURNAL_REPORT: {
    apiName: "JournalReport",
    displayName: "Journal Report",
    category: "reports",
    description: "Journal report",
  },
  CUSTOMER_BALANCE: {
    apiName: "CustomerBalance",
    displayName: "Customer Balance",
    category: "reports",
    description: "Customer balance summary",
  },
  VENDOR_BALANCE: {
    apiName: "VendorBalance",
    displayName: "Vendor Balance",
    category: "reports",
    description: "Vendor balance summary",
  },
  VENDOR_BALANCE_DETAIL: {
    apiName: "VendorBalanceDetail",
    displayName: "Vendor Balance Detail",
    category: "reports",
    description: "Detailed vendor balance report",
  },
  SALES_BY_CLASS_SUMMARY: {
    apiName: "SalesByClassSummary",
    displayName: "Sales by Class Summary",
    category: "reports",
    description: "Sales summary by class",
  },
  SALES_BY_CUSTOMER: {
    apiName: "SalesByCustomer",
    displayName: "Sales by Customer",
    category: "reports",
    description: "Sales analysis by customer",
  },
  SALES_BY_DEPARTMENT: {
    apiName: "SalesByDepartment",
    displayName: "Sales by Department",
    category: "reports",
    description: "Sales analysis by department",
  },
  SALES_BY_PRODUCT: {
    apiName: "SalesByProduct",
    displayName: "Sales by Product",
    category: "reports",
    description: "Sales analysis by product",
  },
  TAX_SUMMARY: {
    apiName: "TaxSummary",
    displayName: "Tax Summary",
    category: "reports",
    description: "Tax summary report",
  },
};

// ==================== HELPER FUNCTIONS ====================

/**
 * Get API name for QuickBooks entity
 */
const getEntityAPIName = (entityKey) => {
  return QUICKBOOKS_ENTITIES[entityKey]?.apiName || entityKey;
};

/**
 * Get display name for QuickBooks entity
 */
const getEntityDisplayName = (entityKey) => {
  return QUICKBOOKS_ENTITIES[entityKey]?.displayName || entityKey;
};

/**
 * Get all entities for schema discovery (returns API names)
 */
const getAllEntitiesForSchemaDiscovery = () => {
  return Object.values(QUICKBOOKS_ENTITIES).map((entity) => entity.apiName);
};

/**
 * Get entity map for ETL processing
 * Converts table names to API names (e.g., 'customers' → 'Customer')
 */
const getEntityMapForETL = () => {
  const entityMap = {};
  Object.values(QUICKBOOKS_ENTITIES).forEach((entity) => {
    const tableName = entity.apiName.toLowerCase() + "s";  // 'customers'
    entityMap[tableName] = entity.apiName;                 // 'customers' → 'Customer'

    const singularTableName = entity.apiName.toLowerCase(); // 'customer'  
    entityMap[singularTableName] = entity.apiName;         // 'customer' → 'Customer'
  });
  return entityMap;
};

/**
 * Get entities by category for organized UI display
 */
const getEntitiesByCategory = () => {
  const categories = {};
  Object.values(QUICKBOOKS_ENTITIES).forEach((entity) => {
    if (!categories[entity.category]) {
      categories[entity.category] = [];
    }
    categories[entity.category].push({
      apiName: entity.apiName,
      displayName: entity.displayName,
      description: entity.description,
    });
  });
  return categories;
};

/**
 * Validate if entity exists in QuickBooks
 */
const isValidQuickBooksEntity = (entityName) => {
  return Object.values(QUICKBOOKS_ENTITIES).some(
    (entity) => entity.apiName.toLowerCase() === entityName.toLowerCase()
  );
};

/**
 * Get entity details by API name
 */
const getEntityDetails = (apiName) => {
  return Object.values(QUICKBOOKS_ENTITIES).find(
    (entity) => entity.apiName.toLowerCase() === apiName.toLowerCase()
  );
};

/**
 * Get popular entities (most commonly used)
 */
const getPopularEntities = () => {
  const popular = [
    "Account",
    "Customer", 
    "Invoice",
    "Payment",
    "Bill",
    "Item",
    "Vendor",
    "JournalEntry",
  ];
  return popular.map((apiName) => getEntityDetails(apiName)).filter(Boolean);
};
// ✅ Helper function to format dates for QuickBooks API
  const formatQbDate = (date) => {
    if (!date) return '';
    const d = new Date(date);
    return d.toISOString().split('T')[0]; // YYYY-MM-DD format
  };
module.exports = {
  QUICKBOOKS_ENTITIES,
  getEntityAPIName,
  getEntityDisplayName,
  getAllEntitiesForSchemaDiscovery,
  getEntityMapForETL,
  getEntitiesByCategory,
  isValidQuickBooksEntity,
  getEntityDetails,
  getPopularEntities,
  formatQbDate,
};