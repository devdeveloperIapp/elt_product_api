// services/warehouse/transformers/zohobooksTransformer.js
// Zoho Books raw -> domain pipeline. Tables live in `zohobooks_domain`.
//
// Conventional Zoho entity names you should pass to insertRawData:
//   'Customer', 'Vendor', 'Item', 'Invoice', 'Bill', 'Payment', 'Account',
//   'VendorPayment', 'SalesOrder', 'PurchaseOrder', 'Expense', 'CreditNote', 'Estimate'

const { DataTypes } = require('sequelize');
const { defineDomainModel } = require('../../../model/warehouse/DomainModelFactory');
const { getRawModel } = require('../../../model/warehouse/RawModelFactory');
const { registerTransformer } = require('../ingestionService');

const SOURCE = 'zohobooks';

// ---------- existing models ----------

const DimCustomer = defineDomainModel(SOURCE, 'dim_customers', {
  customer_sk:  { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:   { type: DataTypes.INTEGER, allowNull: false },
  customer_id:  { type: DataTypes.STRING, allowNull: false },
  display_name: { type: DataTypes.STRING },
  email:        { type: DataTypes.STRING },
  phone:        { type: DataTypes.STRING },
  balance:      { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  is_active:    { type: DataTypes.BOOLEAN, defaultValue: true },
  updated_at:   { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, { indexes: [{ unique: true, fields: ['company_id', 'customer_id'] }] });

const DimVendor = defineDomainModel(SOURCE, 'dim_vendors', {
  vendor_sk:    { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:   { type: DataTypes.INTEGER, allowNull: false },
  vendor_id:    { type: DataTypes.STRING, allowNull: false },
  display_name: { type: DataTypes.STRING },
  email:        { type: DataTypes.STRING },
  phone:        { type: DataTypes.STRING },
  balance:      { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  is_active:    { type: DataTypes.BOOLEAN, defaultValue: true },
  updated_at:   { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, { indexes: [{ unique: true, fields: ['company_id', 'vendor_id'] }] });

const DimItem = defineDomainModel(SOURCE, 'dim_items', {
  item_sk:     { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:  { type: DataTypes.INTEGER, allowNull: false },
  item_id:     { type: DataTypes.STRING, allowNull: false },
  name:        { type: DataTypes.STRING },
  sku:         { type: DataTypes.STRING },
  rate:        { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  unit:        { type: DataTypes.STRING(32) },
  is_active:   { type: DataTypes.BOOLEAN, defaultValue: true },
  updated_at:  { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, { indexes: [{ unique: true, fields: ['company_id', 'item_id'] }] });

const FactInvoice = defineDomainModel(SOURCE, 'fact_invoices', {
  invoice_sk:       { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:       { type: DataTypes.INTEGER, allowNull: false },
  invoice_id:       { type: DataTypes.STRING, allowNull: false },
  invoice_number:   { type: DataTypes.STRING },
  customer_id:      { type: DataTypes.STRING },
  customer_name:    { type: DataTypes.STRING },
  transaction_date: { type: DataTypes.DATEONLY },
  due_date:         { type: DataTypes.DATEONLY },
  amount:           { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  balance:          { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  status:           { type: DataTypes.STRING(16) },
  currency:         { type: DataTypes.STRING(8), defaultValue: 'INR' },
  created_at:       { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [
    { unique: true, fields: ['company_id', 'invoice_id'] },
    { fields: ['transaction_date'] },
  ],
});

const FactBill = defineDomainModel(SOURCE, 'fact_bills', {
  bill_sk:          { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:       { type: DataTypes.INTEGER, allowNull: false },
  bill_id:          { type: DataTypes.STRING, allowNull: false },
  bill_number:      { type: DataTypes.STRING },
  vendor_id:        { type: DataTypes.STRING },
  vendor_name:      { type: DataTypes.STRING },
  transaction_date: { type: DataTypes.DATEONLY },
  due_date:         { type: DataTypes.DATEONLY },
  amount:           { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  balance:          { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  status:           { type: DataTypes.STRING(16) },
  currency:         { type: DataTypes.STRING(8), defaultValue: 'INR' },
  created_at:       { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [
    { unique: true, fields: ['company_id', 'bill_id'] },
    { fields: ['transaction_date'] },
  ],
});

const FactPayment = defineDomainModel(SOURCE, 'fact_payments', {
  payment_sk:       { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:       { type: DataTypes.INTEGER, allowNull: false },
  payment_id:       { type: DataTypes.STRING, allowNull: false },
  customer_id:      { type: DataTypes.STRING },
  customer_name:    { type: DataTypes.STRING },
  transaction_date: { type: DataTypes.DATEONLY },
  amount:           { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  payment_method:   { type: DataTypes.STRING },
  currency:         { type: DataTypes.STRING(8), defaultValue: 'INR' },
  created_at:       { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [
    { unique: true, fields: ['company_id', 'payment_id'] },
    { fields: ['transaction_date'] },
  ],
});

const FactTransaction = defineDomainModel(SOURCE, 'fact_transactions', {
  transaction_sk:   { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:       { type: DataTypes.INTEGER, allowNull: false },
  transaction_date: { type: DataTypes.DATEONLY },
  amount:           { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  transaction_type: { type: DataTypes.STRING(16) },
  customer_id:      { type: DataTypes.STRING },
  vendor_id:        { type: DataTypes.STRING },
  source_ref_id:    { type: DataTypes.STRING, allowNull: false },
  currency:         { type: DataTypes.STRING(8), defaultValue: 'INR' },
  is_paid:          { type: DataTypes.BOOLEAN, defaultValue: false },
  created_at:       { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [
    { unique: true, fields: ['company_id', 'source_ref_id'] },
    { fields: ['transaction_date'] },
    { fields: ['transaction_type'] },
  ],
});

// ---------- new models ----------

const FactVendorPayment = defineDomainModel(SOURCE, 'fact_vendor_payments', {
  vendor_payment_sk: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:        { type: DataTypes.INTEGER, allowNull: false },
  payment_id:        { type: DataTypes.STRING, allowNull: false },
  vendor_id:         { type: DataTypes.STRING },
  vendor_name:       { type: DataTypes.STRING },
  transaction_date:  { type: DataTypes.DATEONLY },
  amount:            { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  payment_method:    { type: DataTypes.STRING },
  currency:          { type: DataTypes.STRING(8), defaultValue: 'INR' },
  created_at:        { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'payment_id'] }],
});
FactVendorPayment.sync({ force: false }).catch(e => console.warn('[sync] fact_vendor_payments:', e.message));

const FactSalesOrder = defineDomainModel(SOURCE, 'fact_sales_orders', {
  sales_order_sk:   { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:       { type: DataTypes.INTEGER, allowNull: false },
  salesorder_id:    { type: DataTypes.STRING, allowNull: false },
  salesorder_number:{ type: DataTypes.STRING },
  customer_id:      { type: DataTypes.STRING },
  customer_name:    { type: DataTypes.STRING },
  transaction_date: { type: DataTypes.DATEONLY },
  shipment_date:    { type: DataTypes.DATEONLY },
  amount:           { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  status:           { type: DataTypes.STRING(16) },
  currency:         { type: DataTypes.STRING(8), defaultValue: 'INR' },
  created_at:       { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'salesorder_id'] }],
});
FactSalesOrder.sync({ force: false }).catch(e => console.warn('[sync] fact_sales_orders:', e.message));

const FactPurchaseOrder = defineDomainModel(SOURCE, 'fact_purchase_orders', {
  purchase_order_sk:      { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:             { type: DataTypes.INTEGER, allowNull: false },
  purchaseorder_id:       { type: DataTypes.STRING, allowNull: false },
  purchaseorder_number:   { type: DataTypes.STRING },
  vendor_id:              { type: DataTypes.STRING },
  vendor_name:            { type: DataTypes.STRING },
  transaction_date:       { type: DataTypes.DATEONLY },
  expected_delivery_date: { type: DataTypes.DATEONLY, allowNull: true },
  amount:                 { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  status:                 { type: DataTypes.STRING(16) },
  currency:               { type: DataTypes.STRING(8), defaultValue: 'INR' },
  created_at:             { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'purchaseorder_id'] }],
});
FactPurchaseOrder.sync({ force: false }).catch(e => console.warn('[sync] fact_purchase_orders:', e.message));

const FactExpense = defineDomainModel(SOURCE, 'fact_expenses', {
  expense_sk:   { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:   { type: DataTypes.INTEGER, allowNull: false },
  expense_id:   { type: DataTypes.STRING, allowNull: false },
  expense_date: { type: DataTypes.DATEONLY },
  vendor_id:    { type: DataTypes.STRING },
  vendor_name:  { type: DataTypes.STRING },
  account_name: { type: DataTypes.STRING },
  amount:       { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  currency:     { type: DataTypes.STRING(8), defaultValue: 'INR' },
  is_billable:  { type: DataTypes.BOOLEAN, defaultValue: false },
  created_at:   { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'expense_id'] }],
});
FactExpense.sync({ force: false }).catch(e => console.warn('[sync] fact_expenses:', e.message));

const FactCreditNote = defineDomainModel(SOURCE, 'fact_credit_notes', {
  credit_note_sk:   { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:       { type: DataTypes.INTEGER, allowNull: false },
  creditnote_id:    { type: DataTypes.STRING, allowNull: false },
  creditnote_number:{ type: DataTypes.STRING },
  customer_id:      { type: DataTypes.STRING },
  customer_name:    { type: DataTypes.STRING },
  transaction_date: { type: DataTypes.DATEONLY },
  amount:           { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  balance:          { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  status:           { type: DataTypes.STRING(16) },
  currency:         { type: DataTypes.STRING(8), defaultValue: 'INR' },
  created_at:       { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'creditnote_id'] }],
});
FactCreditNote.sync({ force: false }).catch(e => console.warn('[sync] fact_credit_notes:', e.message));

const FactEstimate = defineDomainModel(SOURCE, 'fact_estimates', {
  estimate_sk:     { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:      { type: DataTypes.INTEGER, allowNull: false },
  estimate_id:     { type: DataTypes.STRING, allowNull: false },
  estimate_number: { type: DataTypes.STRING },
  customer_id:     { type: DataTypes.STRING },
  customer_name:   { type: DataTypes.STRING },
  transaction_date:{ type: DataTypes.DATEONLY },
  expiry_date:     { type: DataTypes.DATEONLY, allowNull: true },
  amount:          { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  status:          { type: DataTypes.STRING(16) },
  currency:        { type: DataTypes.STRING(8), defaultValue: 'INR' },
  created_at:      { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'estimate_id'] }],
});
FactEstimate.sync({ force: false }).catch(e => console.warn('[sync] fact_estimates:', e.message));

const DimChartOfAccount = defineDomainModel(SOURCE, 'dim_chart_of_accounts', {
  account_sk:   { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:   { type: DataTypes.INTEGER, allowNull: false },
  account_id:   { type: DataTypes.STRING, allowNull: false },
  account_name: { type: DataTypes.STRING },
  account_type: { type: DataTypes.STRING },
  account_code: { type: DataTypes.STRING },
  is_active:    { type: DataTypes.BOOLEAN, defaultValue: true },
  updated_at:   { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'account_id'] }],
});
DimChartOfAccount.sync({ force: false }).catch(e => console.warn('[sync] dim_chart_of_accounts:', e.message));

const FactJournalEntry = defineDomainModel(SOURCE, 'fact_journal_entries', {
  journal_sk:       { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:       { type: DataTypes.INTEGER, allowNull: false },
  journal_id:       { type: DataTypes.STRING, allowNull: false },
  journal_date:     { type: DataTypes.DATEONLY },
  reference_number: { type: DataTypes.STRING },
  notes:            { type: DataTypes.TEXT },
  total:            { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  currency:         { type: DataTypes.STRING(8), defaultValue: 'INR' },
  status:           { type: DataTypes.STRING(16) },
  created_at:       { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'journal_id'] }],
});
FactJournalEntry.sync({ force: false }).catch(e => console.warn('[sync] fact_journal_entries:', e.message));

const DimTax = defineDomainModel(SOURCE, 'dim_taxes', {
  tax_sk:         { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:     { type: DataTypes.INTEGER, allowNull: false },
  tax_id:         { type: DataTypes.STRING, allowNull: false },
  tax_name:       { type: DataTypes.STRING },
  tax_type:       { type: DataTypes.STRING },
  tax_percentage: { type: DataTypes.DECIMAL(8, 4), defaultValue: 0 },
  is_active:      { type: DataTypes.BOOLEAN, defaultValue: true },
  updated_at:     { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'tax_id'] }],
});
DimTax.sync({ force: false }).catch(e => console.warn('[sync] dim_taxes:', e.message));

const FactRecurringInvoice = defineDomainModel(SOURCE, 'fact_recurring_invoices', {
  recur_sk:            { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:          { type: DataTypes.INTEGER, allowNull: false },
  recurrence_id:       { type: DataTypes.STRING, allowNull: false },
  customer_id:         { type: DataTypes.STRING },
  customer_name:       { type: DataTypes.STRING },
  amount:              { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  recurrence_frequency:{ type: DataTypes.STRING },
  status:              { type: DataTypes.STRING(16) },
  currency:            { type: DataTypes.STRING(8), defaultValue: 'INR' },
  created_at:          { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'recurrence_id'] }],
});
FactRecurringInvoice.sync({ force: false }).catch(e => console.warn('[sync] fact_recurring_invoices:', e.message));

const DimBankAccount = defineDomainModel(SOURCE, 'dim_bank_accounts', {
  bank_account_sk:  { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:       { type: DataTypes.INTEGER, allowNull: false },
  account_id:       { type: DataTypes.STRING, allowNull: false },
  account_name:     { type: DataTypes.STRING },
  account_type:     { type: DataTypes.STRING },
  bank_name:        { type: DataTypes.STRING },
  currency_code:    { type: DataTypes.STRING(8), defaultValue: 'INR' },
  current_balance:  { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  is_active:        { type: DataTypes.BOOLEAN, defaultValue: true },
  updated_at:       { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'account_id'] }],
});
DimBankAccount.sync({ force: false }).catch(e => console.warn('[sync] dim_bank_accounts:', e.message));

const FactBankTransaction = defineDomainModel(SOURCE, 'fact_bank_transactions', {
  bank_txn_sk:      { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:       { type: DataTypes.INTEGER, allowNull: false },
  transaction_id:   { type: DataTypes.STRING, allowNull: false },
  account_id:       { type: DataTypes.STRING },
  transaction_date: { type: DataTypes.DATEONLY },
  amount:           { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  transaction_type: { type: DataTypes.STRING },
  description:      { type: DataTypes.TEXT },
  currency:         { type: DataTypes.STRING(8), defaultValue: 'INR' },
  created_at:       { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'transaction_id'] }],
});
FactBankTransaction.sync({ force: false }).catch(e => console.warn('[sync] fact_bank_transactions:', e.message));

const DimProject = defineDomainModel(SOURCE, 'dim_projects', {
  project_sk:    { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:    { type: DataTypes.INTEGER, allowNull: false },
  project_id:    { type: DataTypes.STRING, allowNull: false },
  project_name:  { type: DataTypes.STRING },
  customer_id:   { type: DataTypes.STRING },
  customer_name: { type: DataTypes.STRING },
  status:        { type: DataTypes.STRING(16) },
  billing_type:  { type: DataTypes.STRING },
  rate:          { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  created_at:    { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'project_id'] }],
});
DimProject.sync({ force: false }).catch(e => console.warn('[sync] dim_projects:', e.message));

const DimPriceList = defineDomainModel(SOURCE, 'dim_price_lists', {
  pricelist_sk:  { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:    { type: DataTypes.INTEGER, allowNull: false },
  pricelist_id:  { type: DataTypes.STRING, allowNull: false },
  name:          { type: DataTypes.STRING },
  pricebook_type:{ type: DataTypes.STRING },
  discount:      { type: DataTypes.DECIMAL(8, 4), defaultValue: 0 },
  currency_code: { type: DataTypes.STRING(8), defaultValue: 'INR' },
  is_active:     { type: DataTypes.BOOLEAN, defaultValue: true },
  updated_at:    { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'pricelist_id'] }],
});
DimPriceList.sync({ force: false }).catch(e => console.warn('[sync] dim_price_lists:', e.message));

const FactRetainerInvoice = defineDomainModel(SOURCE, 'fact_retainer_invoices', {
  retainer_sk:         { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:          { type: DataTypes.INTEGER, allowNull: false },
  retainerinvoice_id:  { type: DataTypes.STRING, allowNull: false },
  customer_id:         { type: DataTypes.STRING },
  customer_name:       { type: DataTypes.STRING },
  date:                { type: DataTypes.DATEONLY },
  amount:              { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  balance:             { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  status:              { type: DataTypes.STRING(16) },
  currency:            { type: DataTypes.STRING(8), defaultValue: 'INR' },
  created_at:          { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'retainerinvoice_id'] }],
});
FactRetainerInvoice.sync({ force: false }).catch(e => console.warn('[sync] fact_retainer_invoices:', e.message));

// ---------- helpers ----------
const fetchRaw = async (entity, companyId) => {
  const Model = getRawModel(SOURCE, entity);
  // Ensure table exists (no-op if already created; handles empty-fetch entities)
  await Model.sync({ force: false });
  return Model.findAll({ where: { company_id: companyId, is_deleted: false }, raw: true });
};

const computeStatus = (balance, dueDate) => {
  if (Number(balance) === 0) return 'paid';
  if (dueDate && new Date(dueDate) < new Date()) return 'overdue';
  return 'open';
};

// ---------- existing transforms ----------
const transformDimCustomers = async (companyId) => {
  const rows = await fetchRaw('Customer', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:   companyId,
    customer_id:  String(d.contact_id || d.customer_id),
    display_name: d.contact_name || d.company_name || null,
    email:        d.email || null,
    phone:        d.phone || d.mobile || null,
    balance:      Number(d.outstanding_receivable_amount || 0),
    is_active:    d.status !== 'inactive',
    updated_at:   new Date(),
  }));
  await DimCustomer.bulkCreate(mapped, {
    updateOnDuplicate: ['display_name', 'email', 'phone', 'balance', 'is_active', 'updated_at'],
  });
  return mapped.length;
};

const transformDimVendors = async (companyId) => {
  const rows = await fetchRaw('Vendor', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:   companyId,
    vendor_id:    String(d.contact_id || d.vendor_id),
    display_name: d.contact_name || d.company_name || null,
    email:        d.email || null,
    phone:        d.phone || d.mobile || null,
    balance:      Number(d.outstanding_payable_amount || 0),
    is_active:    d.status !== 'inactive',
    updated_at:   new Date(),
  }));
  await DimVendor.bulkCreate(mapped, {
    updateOnDuplicate: ['display_name', 'email', 'phone', 'balance', 'is_active', 'updated_at'],
  });
  return mapped.length;
};

const transformDimItems = async (companyId) => {
  const rows = await fetchRaw('Item', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id: companyId,
    item_id:    String(d.item_id),
    name:       d.name || null,
    sku:        d.sku || null,
    rate:       Number(d.rate || 0),
    unit:       d.unit || null,
    is_active:  d.status !== 'inactive',
    updated_at: new Date(),
  }));
  await DimItem.bulkCreate(mapped, {
    updateOnDuplicate: ['name', 'sku', 'rate', 'unit', 'is_active', 'updated_at'],
  });
  return mapped.length;
};

const transformFactInvoices = async (companyId) => {
  const rows = await fetchRaw('Invoice', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:       companyId,
    invoice_id:       String(d.invoice_id),
    invoice_number:   d.invoice_number || null,
    customer_id:      d.customer_id ? String(d.customer_id) : null,
    customer_name:    d.customer_name || null,
    transaction_date: d.date || null,
    due_date:         d.due_date || null,
    amount:           Number(d.total || 0),
    balance:          Number(d.balance || 0),
    status:           d.status || computeStatus(d.balance, d.due_date),
    currency:         d.currency_code || 'INR',
  }));
  await FactInvoice.bulkCreate(mapped, {
    updateOnDuplicate: ['invoice_number', 'customer_id', 'customer_name', 'transaction_date', 'due_date', 'amount', 'balance', 'status', 'currency'],
  });
  return mapped.length;
};

const transformFactBills = async (companyId) => {
  const rows = await fetchRaw('Bill', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:       companyId,
    bill_id:          String(d.bill_id),
    bill_number:      d.bill_number || null,
    vendor_id:        d.vendor_id ? String(d.vendor_id) : null,
    vendor_name:      d.vendor_name || null,
    transaction_date: d.date || null,
    due_date:         d.due_date || null,
    amount:           Number(d.total || 0),
    balance:          Number(d.balance || 0),
    status:           d.status || computeStatus(d.balance, d.due_date),
    currency:         d.currency_code || 'INR',
  }));
  await FactBill.bulkCreate(mapped, {
    updateOnDuplicate: ['bill_number', 'vendor_id', 'vendor_name', 'transaction_date', 'due_date', 'amount', 'balance', 'status', 'currency'],
  });
  return mapped.length;
};

const transformFactPayments = async (companyId) => {
  const rows = await fetchRaw('Payment', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:       companyId,
    payment_id:       String(d.payment_id),
    customer_id:      d.customer_id ? String(d.customer_id) : null,
    customer_name:    d.customer_name || null,
    transaction_date: d.date || null,
    amount:           Number(d.amount || 0),
    payment_method:   d.payment_mode || null,
    currency:         d.currency_code || 'INR',
  }));
  await FactPayment.bulkCreate(mapped, {
    updateOnDuplicate: ['customer_id', 'customer_name', 'transaction_date', 'amount', 'payment_method', 'currency'],
  });
  return mapped.length;
};

const transformFactTransactions = async (companyId) => {
  const [invoices, bills, payments] = await Promise.all([
    fetchRaw('Invoice', companyId),
    fetchRaw('Bill', companyId),
    fetchRaw('Payment', companyId),
  ]);

  const rows = [];
  for (const r of invoices) {
    const d = r.raw_payload;
    rows.push({
      company_id:       companyId,
      transaction_date: d.date || null,
      amount:           Number(d.total || 0),
      transaction_type: 'revenue',
      customer_id:      d.customer_id ? String(d.customer_id) : null,
      vendor_id:        null,
      source_ref_id:    `invoice_${d.invoice_id}`,
      currency:         d.currency_code || 'INR',
      is_paid:          Number(d.balance || 0) === 0,
    });
  }
  for (const r of bills) {
    const d = r.raw_payload;
    rows.push({
      company_id:       companyId,
      transaction_date: d.date || null,
      amount:           Number(d.total || 0),
      transaction_type: 'expense',
      customer_id:      null,
      vendor_id:        d.vendor_id ? String(d.vendor_id) : null,
      source_ref_id:    `bill_${d.bill_id}`,
      currency:         d.currency_code || 'INR',
      is_paid:          Number(d.balance || 0) === 0,
    });
  }
  for (const r of payments) {
    const d = r.raw_payload;
    rows.push({
      company_id:       companyId,
      transaction_date: d.date || null,
      amount:           Number(d.amount || 0),
      transaction_type: 'payment',
      customer_id:      d.customer_id ? String(d.customer_id) : null,
      vendor_id:        null,
      source_ref_id:    `payment_${d.payment_id}`,
      currency:         d.currency_code || 'INR',
      is_paid:          true,
    });
  }
  if (!rows.length) return 0;
  await FactTransaction.bulkCreate(rows, {
    updateOnDuplicate: ['transaction_date', 'amount', 'transaction_type', 'customer_id', 'vendor_id', 'currency', 'is_paid'],
  });
  return rows.length;
};

// ---------- new transforms ----------

const transformFactVendorPayments = async (companyId) => {
  const rows = await fetchRaw('VendorPayment', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:       companyId,
    payment_id:       String(d.payment_id),
    vendor_id:        d.vendor_id ? String(d.vendor_id) : null,
    vendor_name:      d.vendor_name || null,
    transaction_date: d.date || null,
    amount:           Number(d.amount || 0),
    payment_method:   d.payment_mode || null,
    currency:         d.currency_code || 'INR',
  }));
  await FactVendorPayment.bulkCreate(mapped, {
    updateOnDuplicate: ['vendor_id', 'vendor_name', 'transaction_date', 'amount', 'payment_method', 'currency'],
  });
  return mapped.length;
};

const transformFactSalesOrders = async (companyId) => {
  const rows = await fetchRaw('SalesOrder', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:        companyId,
    salesorder_id:     String(d.salesorder_id),
    salesorder_number: d.salesorder_number || null,
    customer_id:       d.customer_id ? String(d.customer_id) : null,
    customer_name:     d.customer_name || null,
    transaction_date:  d.date || null,
    shipment_date:     d.shipment_date || null,
    amount:            Number(d.total || 0),
    status:            d.status || null,
    currency:          d.currency_code || 'INR',
  }));
  await FactSalesOrder.bulkCreate(mapped, {
    updateOnDuplicate: ['salesorder_number', 'customer_id', 'customer_name', 'transaction_date', 'shipment_date', 'amount', 'status', 'currency'],
  });
  return mapped.length;
};

const transformFactPurchaseOrders = async (companyId) => {
  const rows = await fetchRaw('PurchaseOrder', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:             companyId,
    purchaseorder_id:       String(d.purchaseorder_id),
    purchaseorder_number:   d.purchaseorder_number || null,
    vendor_id:              d.vendor_id ? String(d.vendor_id) : null,
    vendor_name:            d.vendor_name || null,
    transaction_date:       d.date || null,
    expected_delivery_date: d.delivery_date || null,
    amount:                 Number(d.total || 0),
    status:                 d.status || null,
    currency:               d.currency_code || 'INR',
  }));
  await FactPurchaseOrder.bulkCreate(mapped, {
    updateOnDuplicate: ['purchaseorder_number', 'vendor_id', 'vendor_name', 'transaction_date', 'expected_delivery_date', 'amount', 'status', 'currency'],
  });
  return mapped.length;
};

const transformFactExpenses = async (companyId) => {
  const rows = await fetchRaw('Expense', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:   companyId,
    expense_id:   String(d.expense_id),
    expense_date: d.expense_date || null,
    vendor_id:    d.vendor_id ? String(d.vendor_id) : null,
    vendor_name:  d.vendor_name || null,
    account_name: d.account_name || null,
    amount:       Number(d.total || 0),
    currency:     d.currency_code || 'INR',
    is_billable:  Boolean(d.is_billable),
  }));
  await FactExpense.bulkCreate(mapped, {
    updateOnDuplicate: ['expense_date', 'vendor_id', 'vendor_name', 'account_name', 'amount', 'currency', 'is_billable'],
  });
  return mapped.length;
};

const transformFactCreditNotes = async (companyId) => {
  const rows = await fetchRaw('CreditNote', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:        companyId,
    creditnote_id:     String(d.creditnote_id),
    creditnote_number: d.creditnote_number || null,
    customer_id:       d.customer_id ? String(d.customer_id) : null,
    customer_name:     d.customer_name || null,
    transaction_date:  d.date || null,
    amount:            Number(d.total || 0),
    balance:           Number(d.balance || 0),
    status:            d.status || null,
    currency:          d.currency_code || 'INR',
  }));
  await FactCreditNote.bulkCreate(mapped, {
    updateOnDuplicate: ['creditnote_number', 'customer_id', 'customer_name', 'transaction_date', 'amount', 'balance', 'status', 'currency'],
  });
  return mapped.length;
};

const transformFactEstimates = async (companyId) => {
  const rows = await fetchRaw('Estimate', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:       companyId,
    estimate_id:      String(d.estimate_id),
    estimate_number:  d.estimate_number || null,
    customer_id:      d.customer_id ? String(d.customer_id) : null,
    customer_name:    d.customer_name || null,
    transaction_date: d.date || null,
    expiry_date:      d.expiry_date || null,
    amount:           Number(d.total || 0),
    status:           d.status || null,
    currency:         d.currency_code || 'INR',
  }));
  await FactEstimate.bulkCreate(mapped, {
    updateOnDuplicate: ['estimate_number', 'customer_id', 'customer_name', 'transaction_date', 'expiry_date', 'amount', 'status', 'currency'],
  });
  return mapped.length;
};

const transformDimChartOfAccounts = async (companyId) => {
  const rows = await fetchRaw('ChartOfAccount', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:   companyId,
    account_id:   String(d.account_id),
    account_name: d.account_name || null,
    account_type: d.account_type || null,
    account_code: d.account_code || null,
    is_active:    d.is_active !== false,
    updated_at:   new Date(),
  }));
  await DimChartOfAccount.bulkCreate(mapped, {
    updateOnDuplicate: ['account_name', 'account_type', 'account_code', 'is_active', 'updated_at'],
  });
  return mapped.length;
};

const transformFactJournalEntries = async (companyId) => {
  const rows = await fetchRaw('JournalEntry', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:       companyId,
    journal_id:       String(d.journal_id),
    journal_date:     d.journal_date || null,
    reference_number: d.reference_number || null,
    notes:            d.notes || null,
    total:            Number(d.total || 0),
    currency:         d.currency_code || 'INR',
    status:           d.status || null,
  }));
  await FactJournalEntry.bulkCreate(mapped, {
    updateOnDuplicate: ['journal_date', 'reference_number', 'notes', 'total', 'currency', 'status'],
  });
  return mapped.length;
};

const transformDimTaxes = async (companyId) => {
  const rows = await fetchRaw('Tax', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:     companyId,
    tax_id:         String(d.tax_id),
    tax_name:       d.tax_name || null,
    tax_type:       d.tax_type || null,
    tax_percentage: Number(d.tax_percentage || 0),
    is_active:      d.status !== 'inactive',
    updated_at:     new Date(),
  }));
  await DimTax.bulkCreate(mapped, {
    updateOnDuplicate: ['tax_name', 'tax_type', 'tax_percentage', 'is_active', 'updated_at'],
  });
  return mapped.length;
};

const transformFactRecurringInvoices = async (companyId) => {
  const rows = await fetchRaw('RecurringInvoice', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:           companyId,
    recurrence_id:        String(d.recurrence_id),
    customer_id:          d.customer_id ? String(d.customer_id) : null,
    customer_name:        d.customer_name || null,
    amount:               Number(d.amount || d.total || 0),
    recurrence_frequency: d.recurrence_frequency || null,
    status:               d.status || null,
    currency:             d.currency_code || 'INR',
  }));
  await FactRecurringInvoice.bulkCreate(mapped, {
    updateOnDuplicate: ['customer_id', 'customer_name', 'amount', 'recurrence_frequency', 'status', 'currency'],
  });
  return mapped.length;
};

const transformDimBankAccounts = async (companyId) => {
  const rows = await fetchRaw('BankAccount', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:      companyId,
    account_id:      String(d.account_id),
    account_name:    d.account_name || null,
    account_type:    d.account_type || null,
    bank_name:       d.bank_name || null,
    currency_code:   d.currency_code || 'INR',
    current_balance: Number(d.balance || 0),
    is_active:       d.is_active !== false,
    updated_at:      new Date(),
  }));
  await DimBankAccount.bulkCreate(mapped, {
    updateOnDuplicate: ['account_name', 'account_type', 'bank_name', 'currency_code', 'current_balance', 'is_active', 'updated_at'],
  });
  return mapped.length;
};

const transformFactBankTransactions = async (companyId) => {
  const rows = await fetchRaw('BankTransaction', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:       companyId,
    transaction_id:   String(d.transaction_id),
    account_id:       d.account_id ? String(d.account_id) : null,
    transaction_date: d.date || null,
    amount:           Number(d.amount || 0),
    transaction_type: d.transaction_type || null,
    description:      d.description || null,
    currency:         d.currency_code || 'INR',
  }));
  await FactBankTransaction.bulkCreate(mapped, {
    updateOnDuplicate: ['account_id', 'transaction_date', 'amount', 'transaction_type', 'description', 'currency'],
  });
  return mapped.length;
};

const transformDimProjects = async (companyId) => {
  const rows = await fetchRaw('Project', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:    companyId,
    project_id:    String(d.project_id),
    project_name:  d.project_name || null,
    customer_id:   d.customer_id ? String(d.customer_id) : null,
    customer_name: d.customer_name || null,
    status:        d.status || null,
    billing_type:  d.billing_type || null,
    rate:          Number(d.rate || 0),
  }));
  await DimProject.bulkCreate(mapped, {
    updateOnDuplicate: ['project_name', 'customer_id', 'customer_name', 'status', 'billing_type', 'rate'],
  });
  return mapped.length;
};

const transformDimPriceLists = async (companyId) => {
  const rows = await fetchRaw('PriceList', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:     companyId,
    pricelist_id:   String(d.pricebook_id || d.pricelist_id),  // API returns pricebook_id
    name:           d.name || null,
    pricebook_type: d.pricebook_type || null,
    discount:       Number(d.discount || 0),
    currency_code:  d.currency_code || 'INR',
    is_active:      d.status !== 'inactive',
    updated_at:     new Date(),
  }));
  await DimPriceList.bulkCreate(mapped, {
    updateOnDuplicate: ['name', 'pricebook_type', 'discount', 'currency_code', 'is_active', 'updated_at'],
  });
  return mapped.length;
};

const transformFactRetainerInvoices = async (companyId) => {
  const rows = await fetchRaw('RetainerInvoice', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:         companyId,
    retainerinvoice_id: String(d.retainerinvoice_id),
    customer_id:        d.customer_id ? String(d.customer_id) : null,
    customer_name:      d.customer_name || null,
    date:               d.date || null,
    amount:             Number(d.amount || d.total || 0),
    balance:            Number(d.balance || 0),
    status:             d.status || null,
    currency:           d.currency_code || 'INR',
  }));
  await FactRetainerInvoice.bulkCreate(mapped, {
    updateOnDuplicate: ['customer_id', 'customer_name', 'date', 'amount', 'balance', 'status', 'currency'],
  });
  return mapped.length;
};

const runPipeline = async ({ companyId, entities }) => {
  const all = !entities || entities.length === 0;
  const wants = (n) => all || entities.includes(n);
  const summary = {};
  if (wants('dim_customers'))          summary.dim_customers          = await transformDimCustomers(companyId);
  if (wants('dim_vendors'))            summary.dim_vendors            = await transformDimVendors(companyId);
  if (wants('dim_items'))              summary.dim_items              = await transformDimItems(companyId);
  if (wants('fact_invoices'))          summary.fact_invoices          = await transformFactInvoices(companyId);
  if (wants('fact_bills'))             summary.fact_bills             = await transformFactBills(companyId);
  if (wants('fact_payments'))          summary.fact_payments          = await transformFactPayments(companyId);
  if (wants('fact_transactions'))      summary.fact_transactions      = await transformFactTransactions(companyId);
  if (wants('fact_vendor_payments'))   summary.fact_vendor_payments   = await transformFactVendorPayments(companyId);
  if (wants('fact_sales_orders'))      summary.fact_sales_orders      = await transformFactSalesOrders(companyId);
  if (wants('fact_purchase_orders'))   summary.fact_purchase_orders   = await transformFactPurchaseOrders(companyId);
  if (wants('fact_expenses'))          summary.fact_expenses          = await transformFactExpenses(companyId);
  if (wants('fact_credit_notes'))      summary.fact_credit_notes      = await transformFactCreditNotes(companyId);
  if (wants('fact_estimates'))         summary.fact_estimates         = await transformFactEstimates(companyId);
  if (wants('dim_chart_of_accounts'))  summary.dim_chart_of_accounts  = await transformDimChartOfAccounts(companyId);
  if (wants('fact_journal_entries'))   summary.fact_journal_entries   = await transformFactJournalEntries(companyId);
  if (wants('dim_taxes'))              summary.dim_taxes              = await transformDimTaxes(companyId);
  if (wants('fact_recurring_invoices'))summary.fact_recurring_invoices= await transformFactRecurringInvoices(companyId);
  if (wants('dim_bank_accounts'))      summary.dim_bank_accounts      = await transformDimBankAccounts(companyId);
  if (wants('fact_bank_transactions')) summary.fact_bank_transactions = await transformFactBankTransactions(companyId);
  if (wants('dim_projects'))           summary.dim_projects           = await transformDimProjects(companyId);
  if (wants('dim_price_lists'))        summary.dim_price_lists        = await transformDimPriceLists(companyId);
  if (wants('fact_retainer_invoices')) summary.fact_retainer_invoices = await transformFactRetainerInvoices(companyId);
  return summary;
};

registerTransformer(SOURCE, runPipeline);

module.exports = { runPipeline };
