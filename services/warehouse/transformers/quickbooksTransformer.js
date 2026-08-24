// services/warehouse/transformers/quickbooksTransformer.js
// Registers QuickBooks domain models and the transformation pipeline.
// Tables live in schema `quickbooks_domain`.

const { DataTypes, Op } = require('sequelize');
const { warehouseV2DB } = require('../../../connection/dbConnection');
const { defineDomainModel } = require('../../../model/warehouse/DomainModelFactory');
const { getRawModel } = require('../../../model/warehouse/RawModelFactory');
const { registerTransformer } = require('../ingestionService');

const SOURCE = 'quickbooks';

// ---------------------------------------------------------------------------
// Domain model definitions (all in `quickbooks_domain` schema)
// ---------------------------------------------------------------------------
const DimAccount = defineDomainModel(SOURCE, 'dim_accounts', {
  account_sk:        { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:        { type: DataTypes.INTEGER, allowNull: false },
  account_id:        { type: DataTypes.STRING,  allowNull: false },
  account_name:      { type: DataTypes.STRING },
  account_type:      { type: DataTypes.STRING },
  account_sub_type:  { type: DataTypes.STRING },
  current_balance:   { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  currency:          { type: DataTypes.STRING(8), defaultValue: 'USD' },
  is_active:         { type: DataTypes.BOOLEAN, defaultValue: true },
  updated_at:        { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'account_id'] }],
});

const DimCustomer = defineDomainModel(SOURCE, 'dim_customers', {
  customer_sk:   { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:    { type: DataTypes.INTEGER, allowNull: false },
  customer_id:   { type: DataTypes.STRING, allowNull: false },
  display_name:  { type: DataTypes.STRING },
  email:         { type: DataTypes.STRING },
  balance:       { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  is_active:     { type: DataTypes.BOOLEAN, defaultValue: true },
  updated_at:    { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'customer_id'] }],
});

const DimVendor = defineDomainModel(SOURCE, 'dim_vendors', {
  vendor_sk:     { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:    { type: DataTypes.INTEGER, allowNull: false },
  vendor_id:     { type: DataTypes.STRING, allowNull: false },
  display_name:  { type: DataTypes.STRING },
  email:         { type: DataTypes.STRING },
  phone:         { type: DataTypes.STRING },
  balance:       { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  is_active:     { type: DataTypes.BOOLEAN, defaultValue: true },
  updated_at:    { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'vendor_id'] }],
});

const FactInvoice = defineDomainModel(SOURCE, 'fact_invoices', {
  invoice_sk:       { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:       { type: DataTypes.INTEGER, allowNull: false },
  invoice_id:       { type: DataTypes.STRING, allowNull: false },
  doc_number:       { type: DataTypes.STRING },
  customer_id:      { type: DataTypes.STRING },
  customer_name:    { type: DataTypes.STRING },
  transaction_date: { type: DataTypes.DATEONLY },
  due_date:         { type: DataTypes.DATEONLY },
  amount:           { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  balance:          { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  status:           { type: DataTypes.STRING(16) },
  currency:         { type: DataTypes.STRING(8), defaultValue: 'USD' },
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
  doc_number:       { type: DataTypes.STRING },
  vendor_id:        { type: DataTypes.STRING },
  vendor_name:      { type: DataTypes.STRING },
  transaction_date: { type: DataTypes.DATEONLY },
  due_date:         { type: DataTypes.DATEONLY },
  amount:           { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  balance:          { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  status:           { type: DataTypes.STRING(16) },
  currency:         { type: DataTypes.STRING(8), defaultValue: 'USD' },
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
  currency:         { type: DataTypes.STRING(8), defaultValue: 'USD' },
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
  transaction_type: { type: DataTypes.STRING(16) },  // revenue | expense | payment
  account_id:       { type: DataTypes.STRING },
  customer_id:      { type: DataTypes.STRING },
  source_ref_id:    { type: DataTypes.STRING, allowNull: false },
  currency:         { type: DataTypes.STRING(8), defaultValue: 'USD' },
  is_paid:          { type: DataTypes.BOOLEAN, defaultValue: false },
  created_at:       { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [
    { unique: true, fields: ['company_id', 'source_ref_id'] },
    { fields: ['transaction_date'] },
    { fields: ['transaction_type'] },
  ],
});

// ---------------------------------------------------------------------------
// Schema is owned by `scripts/migrations/*.sql` (bootstrap_v2 → 005 → 006).
// We deliberately do NOT call Model.sync({ alter: true }) here:
//   • PowerBI views (vw_dashboard, vw_ar_aging, vw_revenue_monthly) and RLS
//     policies depend on these columns — Postgres blocks any column-type
//     alter while a view/policy references it, so every boot used to spit
//     `cannot alter type of a column used by a view or rule` warnings.
//   • The migrations already created the right shape; Sequelize doesn't
//     need to second-guess them.
// `ensureDomainTables()` is kept as a no-op for backwards compatibility with
// the call site in transform(); remove that call too if we ever clean it up.
// ---------------------------------------------------------------------------
const ensureDomainTables = () => Promise.resolve();

// ---------------------------------------------------------------------------
// Transformation pipeline
// ---------------------------------------------------------------------------
const today = () => new Date();

const computeStatus = (balance, dueDate) => {
  if (Number(balance) === 0) return 'Paid';
  if (dueDate && new Date(dueDate) < today()) return 'Overdue';
  return 'Pending';
};

const fetchRaw = async (entity, companyId) => {
  const Model = getRawModel(SOURCE, entity);
  return Model.findAll({ where: { company_id: companyId, is_deleted: false }, raw: true });
};

const transformDimAccounts = async (companyId) => {
  const rows = await fetchRaw('Account', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:       companyId,
    account_id:       d.Id,
    account_name:     d.Name,
    account_type:     d.AccountType,
    account_sub_type: d.AccountSubType || null,
    current_balance:  d.CurrentBalance || 0,
    currency:         d.CurrencyRef?.value || 'USD',
    is_active:        d.Active !== false,
    updated_at:       new Date(),
  }));
  await DimAccount.bulkCreate(mapped, {
    updateOnDuplicate: ['account_name', 'account_type', 'account_sub_type', 'current_balance', 'currency', 'is_active', 'updated_at'],
  });
  return mapped.length;
};

const transformDimCustomers = async (companyId) => {
  const rows = await fetchRaw('Customer', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:   companyId,
    customer_id:  d.Id,
    display_name: d.DisplayName,
    email:        d.PrimaryEmailAddr?.Address || null,
    balance:      d.Balance || 0,
    is_active:    d.Active !== false,
    updated_at:   new Date(),
  }));
  await DimCustomer.bulkCreate(mapped, {
    updateOnDuplicate: ['display_name', 'email', 'balance', 'is_active', 'updated_at'],
  });
  return mapped.length;
};

const transformDimVendors = async (companyId) => {
  const rows = await fetchRaw('Vendor', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:   companyId,
    vendor_id:    d.Id,
    display_name: d.DisplayName,
    email:        d.PrimaryEmailAddr?.Address || null,
    phone:        d.PrimaryPhone?.FreeFormNumber || null,
    balance:      d.Balance || 0,
    is_active:    d.Active !== false,
    updated_at:   new Date(),
  }));
  await DimVendor.bulkCreate(mapped, {
    updateOnDuplicate: ['display_name', 'email', 'phone', 'balance', 'is_active', 'updated_at'],
  });
  return mapped.length;
};

const transformFactInvoices = async (companyId) => {
  const rows = await fetchRaw('Invoice', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:       companyId,
    invoice_id:       d.Id,
    doc_number:       d.DocNumber || null,
    customer_id:      d.CustomerRef?.value || null,
    customer_name:    d.CustomerRef?.name || null,
    transaction_date: d.TxnDate,
    due_date:         d.DueDate || null,
    amount:           d.TotalAmt || 0,
    balance:          d.Balance || 0,
    status:           computeStatus(d.Balance, d.DueDate),
    currency:         d.CurrencyRef?.value || 'USD',
  }));
  await FactInvoice.bulkCreate(mapped, {
    updateOnDuplicate: ['doc_number', 'customer_id', 'customer_name', 'transaction_date', 'due_date', 'amount', 'balance', 'status', 'currency'],
  });
  return mapped.length;
};

const transformFactBills = async (companyId) => {
  const rows = await fetchRaw('Bill', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:       companyId,
    bill_id:          d.Id,
    doc_number:       d.DocNumber || null,
    vendor_id:        d.VendorRef?.value || null,
    vendor_name:      d.VendorRef?.name || null,
    transaction_date: d.TxnDate,
    due_date:         d.DueDate || null,
    amount:           d.TotalAmt || 0,
    balance:          d.Balance || 0,
    status:           computeStatus(d.Balance, d.DueDate),
    currency:         d.CurrencyRef?.value || 'USD',
  }));
  await FactBill.bulkCreate(mapped, {
    updateOnDuplicate: ['doc_number', 'vendor_id', 'vendor_name', 'transaction_date', 'due_date', 'amount', 'balance', 'status', 'currency'],
  });
  return mapped.length;
};

const transformFactPayments = async (companyId) => {
  const rows = await fetchRaw('Payment', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:       companyId,
    payment_id:       d.Id,
    customer_id:      d.CustomerRef?.value || null,
    customer_name:    d.CustomerRef?.name || null,
    transaction_date: d.TxnDate,
    amount:           d.TotalAmt || 0,
    payment_method:   d.PaymentMethodRef?.name || null,
    currency:         d.CurrencyRef?.value || 'USD',
  }));
  await FactPayment.bulkCreate(mapped, {
    updateOnDuplicate: ['customer_id', 'customer_name', 'transaction_date', 'amount', 'payment_method', 'currency'],
  });
  return mapped.length;
};

const transformFactTransactions = async (companyId) => {
  // Build the unified transaction grain from invoices (revenue), bills (expense), payments
  const [invoices, bills, payments, salesReceipts] = await Promise.all([
    fetchRaw('Invoice', companyId),
    fetchRaw('Bill', companyId),
    fetchRaw('Payment', companyId),
    fetchRaw('SalesReceipt', companyId),
  ]);

  const rows = [];

  for (const r of invoices) {
    const d = r.raw_payload;
    rows.push({
      company_id:       companyId,
      transaction_date: d.TxnDate,
      amount:           d.TotalAmt || 0,
      transaction_type: 'revenue',
      account_id:       d.DepositToAccountRef?.value || null,
      customer_id:      d.CustomerRef?.value || null,
      source_ref_id:    `invoice_${d.Id}`,
      currency:         d.CurrencyRef?.value || 'USD',
      is_paid:          d.Balance === 0,
    });
  }
  for (const r of bills) {
    const d = r.raw_payload;
    rows.push({
      company_id:       companyId,
      transaction_date: d.TxnDate,
      amount:           d.TotalAmt || 0,
      transaction_type: 'expense',
      account_id:       d.APAccountRef?.value || null,
      customer_id:      null,
      source_ref_id:    `bill_${d.Id}`,
      currency:         d.CurrencyRef?.value || 'USD',
      is_paid:          d.Balance === 0,
    });
  }
  for (const r of payments) {
    const d = r.raw_payload;
    rows.push({
      company_id:       companyId,
      transaction_date: d.TxnDate,
      amount:           d.TotalAmt || 0,
      transaction_type: 'payment',
      account_id:       d.DepositToAccountRef?.value || null,
      customer_id:      d.CustomerRef?.value || null,
      source_ref_id:    `payment_${d.Id}`,
      currency:         d.CurrencyRef?.value || 'USD',
      is_paid:          true,
    });
  }
  for (const r of salesReceipts) {
    const d = r.raw_payload;
    rows.push({
      company_id:       companyId,
      transaction_date: d.TxnDate,
      amount:           d.TotalAmt || 0,
      transaction_type: 'revenue',
      account_id:       d.DepositToAccountRef?.value || null,
      customer_id:      d.CustomerRef?.value || null,
      source_ref_id:    `salesreceipt_${d.Id}`,
      currency:         d.CurrencyRef?.value || 'USD',
      is_paid:          true,
    });
  }

  if (!rows.length) return 0;
  await FactTransaction.bulkCreate(rows, {
    updateOnDuplicate: ['transaction_date', 'amount', 'transaction_type', 'account_id', 'customer_id', 'currency', 'is_paid'],
  });
  return rows.length;
};

// ---------------------------------------------------------------------------
// Pipeline orchestration (registered with ingestionService)
// ---------------------------------------------------------------------------
const runPipeline = async ({ companyId, entities }) => {
  await ensureDomainTables();

  const all = !entities || entities.length === 0;
  const wants = (name) => all || entities.includes(name);

  const summary = {};

  if (wants('dim_accounts'))      summary.dim_accounts      = await transformDimAccounts(companyId);
  if (wants('dim_customers'))     summary.dim_customers     = await transformDimCustomers(companyId);
  if (wants('dim_vendors'))       summary.dim_vendors       = await transformDimVendors(companyId);
  if (wants('fact_invoices'))     summary.fact_invoices     = await transformFactInvoices(companyId);
  if (wants('fact_bills'))        summary.fact_bills        = await transformFactBills(companyId);
  if (wants('fact_payments'))     summary.fact_payments     = await transformFactPayments(companyId);
  if (wants('fact_transactions')) summary.fact_transactions = await transformFactTransactions(companyId);

  return summary;
};

registerTransformer(SOURCE, runPipeline);

module.exports = { runPipeline };
