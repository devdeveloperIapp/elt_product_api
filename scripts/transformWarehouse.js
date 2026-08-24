// scripts/transformWarehouse.js
// Run: node scripts/transformWarehouse.js

require('dotenv').config();
const { Op }      = require('sequelize');
const { warehouseDB } = require('../connection/dbConnection');

// ── Raw models
const getRaw = require('../model/warehouse/RawEntityModel');

// ── Domain models
const DimAccount      = require('../model/warehouse/DimAccount');
const DimCustomer     = require('../model/warehouse/DimCustomer');
const DimVendor       = require('../model/warehouse/DimVendor');
const FactInvoice     = require('../model/warehouse/FactInvoice');
const FactBill        = require('../model/warehouse/FactBill');
const FactPayment     = require('../model/warehouse/FactPayment');
const FactTransaction = require('../model/warehouse/FactTransaction');
const FactSalesReceipt = require('../model/warehouse/FactSalesReceipt');
const AggRevenueMonthly = require('../model/warehouse/AggRevenueMonthly');

// 🟢 No hard-coded company IDs. Pick one of:
//   1. CLI arg:  node scripts/transformWarehouse.js --companyId=42
//   2. Env var:  COMPANY_ID=42 node scripts/transformWarehouse.js
//   3. Auto:     iterate every qb_companies row that has a QuickBooks realm_id.
let companyId = null;       // populated per iteration in run()
const today   = new Date();

const resolveCompanyIds = async () => {
  const cliArg = process.argv.find(a => a.startsWith('--companyId='));
  if (cliArg) return [Number(cliArg.split('=')[1])];
  if (process.env.COMPANY_ID) return [Number(process.env.COMPANY_ID)];

  // Auto-discover all QB-connected companies from qb_companies.
  const Company = require('../model/Company');
  const rows = await Company.findAll({
    where: { quickbooks_realm_id: { [Op.ne]: null } },
    attributes: ['id', 'name'],
    raw: true,
  });
  if (!rows.length) {
    console.warn('⚠️  No qb_companies rows with quickbooks_realm_id — nothing to transform.');
  } else {
    console.log(`ℹ️  Auto-discovered ${rows.length} QB-connected companies:`,
      rows.map(r => `${r.id}:${r.name}`).join(', '));
  }
  return rows.map(r => r.id);
};

/* ====================================================================== */
const run = async () => {
  console.log('🚀 Starting warehouse transformation...');
  const ids = await resolveCompanyIds();

  for (const id of ids) {
    companyId = id;
    console.log(`\n=== Processing company_id=${companyId} ===`);

    await transformDimAccounts();
    await transformDimCustomers();
    await transformDimVendors();
    await transformFactInvoices();
    await transformFactBills();
    await transformFactPayments();
    await transformFactTransactions();
    await transformFactSalesReceipts();
    await transformAggRevenueMonthly();
  }

  console.log('\n✅ All transformations complete!');
  process.exit(0);
};

/* ====================================================================== */
/*                         DIM ACCOUNTS                                   */
/* ====================================================================== */
const transformDimAccounts = async () => {
  console.log('\n[1/9] Transforming dim_accounts...');
  const RawAccount = await getRaw('Account');
  const records    = await RawAccount.findAll({ where: { company_id: companyId }, raw: true });

  for (const r of records) {
    const d = r.raw_payload;
    await DimAccount.upsert({
      company_id:       companyId,
      account_id:       d.Id,
      account_name:     d.Name,
      account_type:     d.AccountType,
      account_sub_type: d.AccountSubType || null,
      current_balance:  d.CurrentBalance || 0,
      currency:         d.CurrencyRef?.value || 'USD',
      is_active:        d.Active !== false,
      updated_at:       new Date()
    }, { conflictFields: ['company_id', 'account_id'] });
  }
  console.log(`   ✓ ${records.length} accounts`);
};

/* ====================================================================== */
/*                         DIM CUSTOMERS                                  */
/* ====================================================================== */
const transformDimCustomers = async () => {
  console.log('\n[2/9] Transforming dim_customers...');
  const RawCustomer = await getRaw('Customer');
  const records     = await RawCustomer.findAll({ where: { company_id: companyId }, raw: true });

  for (const r of records) {
    const d = r.raw_payload;
    await DimCustomer.upsert({
      company_id:   companyId,
      customer_id:  d.Id,
      display_name: d.DisplayName,
      email:        d.PrimaryEmailAddr?.Address || null,
      balance:      d.Balance  || 0,
      is_active:    d.Active !== false,
      updated_at:   new Date()
    }, { conflictFields: ['company_id', 'customer_id'] });
  }
  console.log(`   ✓ ${records.length} customers`);
};

/* ====================================================================== */
/*                         DIM VENDORS                                    */
/* ====================================================================== */
const transformDimVendors = async () => {
  console.log('\n[3/9] Transforming dim_vendors...');
  const RawVendor = await getRaw('Vendor');
  const records   = await RawVendor.findAll({ where: { company_id: companyId }, raw: true });

  for (const r of records) {
    const d = r.raw_payload;
    await DimVendor.upsert({
      company_id:   companyId,
      vendor_id:    d.Id,
      display_name: d.DisplayName,
      email:        d.PrimaryEmailAddr?.Address   || null,
      phone:        d.PrimaryPhone?.FreeFormNumber || null,
      balance:      d.Balance  || 0,
      is_active:    d.Active !== false,
      updated_at:   new Date()
    }, { conflictFields: ['company_id', 'vendor_id'] });
  }
  console.log(`   ✓ ${records.length} vendors`);
};

/* ====================================================================== */
/*                         FACT INVOICES                                  */
/* ====================================================================== */
const transformFactInvoices = async () => {
  console.log('\n[4/9] Transforming fact_invoices...');
  const RawInvoice = await getRaw('Invoice');
  const records    = await RawInvoice.findAll({ where: { company_id: companyId }, raw: true });

  for (const r of records) {
    const d      = r.raw_payload;
    const status = d.Balance === 0              ? 'Paid'
                 : d.DueDate && new Date(d.DueDate) < today ? 'Overdue'
                 : 'Pending';

    await FactInvoice.upsert({
      company_id:       companyId,
      invoice_id:       d.Id,
      doc_number:       d.DocNumber,
      customer_id:      d.CustomerRef?.value || null,
      customer_name:    d.CustomerRef?.name  || null,
      transaction_date: d.TxnDate,
      due_date:         d.DueDate  || null,
      amount:           d.TotalAmt || 0,
      balance:          d.Balance  || 0,
      status,
      source_type:      r.source_type,
      currency:         d.CurrencyRef?.value || 'USD'
    }, { conflictFields: ['company_id', 'source_type', 'invoice_id'] });
  }
  console.log(`   ✓ ${records.length} invoices`);
};

/* ====================================================================== */
/*                         FACT BILLS                                     */
/* ====================================================================== */
const transformFactBills = async () => {
  console.log('\n[5/9] Transforming fact_bills...');
  const RawBill = await getRaw('Bill');
  const records = await RawBill.findAll({ where: { company_id: companyId }, raw: true });

  for (const r of records) {
    const d      = r.raw_payload;
    const status = d.Balance === 0              ? 'Paid'
                 : d.DueDate && new Date(d.DueDate) < today ? 'Overdue'
                 : 'Pending';

    await FactBill.upsert({
      company_id:       companyId,
      bill_id:          d.Id,
      doc_number:       d.DocNumber   || null,
      vendor_id:        d.VendorRef?.value || null,
      vendor_name:      d.VendorRef?.name  || null,
      transaction_date: d.TxnDate,
      due_date:         d.DueDate  || null,
      amount:           d.TotalAmt || 0,
      balance:          d.Balance  || 0,
      status,
      source_type:      r.source_type,
      currency:         d.CurrencyRef?.value || 'USD'
    }, { conflictFields: ['company_id', 'source_type', 'bill_id'] });
  }
  console.log(`   ✓ ${records.length} bills`);
};

/* ====================================================================== */
/*                         FACT PAYMENTS                                  */
/* ====================================================================== */
const transformFactPayments = async () => {
  console.log('\n[6/9] Transforming fact_payments...');
  const RawPayment = await getRaw('Payment');
  const records    = await RawPayment.findAll({ where: { company_id: companyId }, raw: true });

  for (const r of records) {
    const d = r.raw_payload;
    await FactPayment.upsert({
      company_id:       companyId,
      payment_id:       d.Id,
      customer_id:      d.CustomerRef?.value     || null,
      customer_name:    d.CustomerRef?.name       || null,
      transaction_date: d.TxnDate,
      amount:           d.TotalAmt || 0,
      payment_method:   d.PaymentMethodRef?.name  || null,
      source_type:      r.source_type,
      currency:         d.CurrencyRef?.value || 'USD'
    }, { conflictFields: ['company_id', 'source_type', 'payment_id'] });
  }
  console.log(`   ✓ ${records.length} payments`);
};

/* ====================================================================== */
/*                         FACT TRANSACTIONS (combined)                   */
/* ====================================================================== */
const transformFactTransactions = async () => {
  console.log('\n[7/9] Transforming fact_transactions...');

  // Invoices → revenue
  const RawInvoice = await getRaw('Invoice');
  const invoices   = await RawInvoice.findAll({ where: { company_id: companyId }, raw: true });
  for (const r of invoices) {
    const d = r.raw_payload;
    await FactTransaction.upsert({
      company_id:       companyId,
      transaction_date: d.TxnDate,
      amount:           d.TotalAmt || 0,
      transaction_type: 'revenue',
      account_id:       d.DepositToAccountRef?.value || null,
      customer_id:      d.CustomerRef?.value         || null,
      source_type:      r.source_type,
      source_ref_id:    `invoice_${d.Id}`,
      currency:         d.CurrencyRef?.value || 'USD',
      is_paid:          d.Balance === 0
    }, { conflictFields: ['company_id', 'source_type', 'source_ref_id'] });
  }

  // Bills → expense
  const RawBill = await getRaw('Bill');
  const bills   = await RawBill.findAll({ where: { company_id: companyId }, raw: true });
  for (const r of bills) {
    const d = r.raw_payload;
    await FactTransaction.upsert({
      company_id:       companyId,
      transaction_date: d.TxnDate,
      amount:           d.TotalAmt || 0,
      transaction_type: 'expense',
      account_id:       d.APAccountRef?.value || null,
      customer_id:      null,
      source_type:      r.source_type,
      source_ref_id:    `bill_${d.Id}`,
      currency:         d.CurrencyRef?.value || 'USD',
      is_paid:          d.Balance === 0
    }, { conflictFields: ['company_id', 'source_type', 'source_ref_id'] });
  }

  // Payments
  const RawPayment = await getRaw('Payment');
  const payments   = await RawPayment.findAll({ where: { company_id: companyId }, raw: true });
  for (const r of payments) {
    const d = r.raw_payload;
    await FactTransaction.upsert({
      company_id:       companyId,
      transaction_date: d.TxnDate,
      amount:           d.TotalAmt || 0,
      transaction_type: 'payment',
      account_id:       d.DepositToAccountRef?.value || null,
      customer_id:      d.CustomerRef?.value         || null,
      source_type:      r.source_type,
      source_ref_id:    `payment_${d.Id}`,
      currency:         d.CurrencyRef?.value || 'USD',
      is_paid:          true
    }, { conflictFields: ['company_id', 'source_type', 'source_ref_id'] });
  }

  console.log(`   ✓ ${invoices.length + bills.length + payments.length} transactions`);
};

/* ====================================================================== */
/*                         FACT SALES RECEIPTS                            */
/* ====================================================================== */
const transformFactSalesReceipts = async () => {
  console.log('\n[8/9] Transforming fact_salesreceipts...');
  const RawSales  = await getRaw('SalesReceipt');
  const records   = await RawSales.findAll({ where: { company_id: companyId }, raw: true });

  // fact_transactions mein save karo as revenue
  for (const r of records) {
    const d = r.raw_payload;
    await FactTransaction.upsert({
      company_id:       companyId,
      transaction_date: d.TxnDate,
      amount:           d.TotalAmt || 0,
      transaction_type: 'revenue',
      customer_id:      d.CustomerRef?.value || null,
      source_type:      r.source_type,
      source_ref_id:    `salesreceipt_${d.Id}`,
      currency:         d.CurrencyRef?.value || 'USD',
      is_paid:          true  // sales receipt = already paid
    }, { conflictFields: ['company_id', 'source_type', 'source_ref_id'] });
  }
  console.log(`   ✓ ${records.length} sales receipts`);
};

/* ====================================================================== */
/*                         AGG REVENUE MONTHLY                            */
/* ====================================================================== */
const transformAggRevenueMonthly = async () => {
  console.log('\n[9/9] Transforming agg_revenue_monthly...');

  // Parameterised — companyId is bound, never interpolated.
  await warehouseDB.query(`
    INSERT INTO domain_tables.agg_revenue_monthly
      (company_id, year, month, month_label, revenue, expenses, net_profit, invoice_count, source_type)
    SELECT
      company_id,
      EXTRACT(YEAR  FROM transaction_date)::int  AS year,
      EXTRACT(MONTH FROM transaction_date)::int  AS month,
      TO_CHAR(transaction_date, 'Mon YYYY')      AS month_label,
      SUM(CASE WHEN transaction_type = 'revenue' THEN amount ELSE 0 END) AS revenue,
      SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END) AS expenses,
      SUM(CASE WHEN transaction_type = 'revenue' THEN amount ELSE 0 END) -
      SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END) AS net_profit,
      COUNT(CASE WHEN transaction_type = 'revenue' THEN 1 END)           AS invoice_count,
      source_type
    FROM domain_tables.fact_transactions
    WHERE company_id = :companyId
    GROUP BY company_id, year, month, month_label, source_type
    ON CONFLICT (company_id, year, month, source_type)
    DO UPDATE SET
      revenue       = EXCLUDED.revenue,
      expenses      = EXCLUDED.expenses,
      net_profit    = EXCLUDED.net_profit,
      invoice_count = EXCLUDED.invoice_count,
      updated_at    = NOW();
  `, { type: 'INSERT', replacements: { companyId } });

  console.log(`   ✓ agg_revenue_monthly updated`);
};

/* ====================================================================== */
run().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});