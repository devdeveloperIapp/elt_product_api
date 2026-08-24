// One-off bootstrap for the legacy `domain_tables` schema in elt_warehouse.
// Creates the schema and every GOLD-layer table (dims/facts/reports) from
// their Sequelize model definitions. Safe to re-run (idempotent — sync
// only creates what's missing).
//
// Usage: node scripts/bootstrap_domain_tables.js

require('dotenv').config();
const { warehouseDB } = require('../connection/dbConnection');

const DimAccount = require('../model/warehouse/DimAccount');
const DimCustomer = require('../model/warehouse/DimCustomer');
const DimVendor = require('../model/warehouse/DimVendor');
const FactBill = require('../model/warehouse/FactBill');
const FactInvoice = require('../model/warehouse/FactInvoice');
const FactPayment = require('../model/warehouse/FactPayment');
const FactSalesReceipt = require('../model/warehouse/FactSalesReceipt');
const FactTransaction = require('../model/warehouse/FactTransaction');
const AggRevenueMonthly = require('../model/warehouse/AggRevenueMonthly');
const getFinancialReportModel = require('../model/warehouse/FinancialReportModel');

(async () => {
  try {
    await warehouseDB.authenticate();
    await warehouseDB.query('CREATE SCHEMA IF NOT EXISTS domain_tables;');

    const models = [
      DimAccount, DimCustomer, DimVendor,
      FactBill, FactInvoice, FactPayment, FactSalesReceipt, FactTransaction,
      AggRevenueMonthly,
    ];
    for (const model of models) {
      await model.sync({ force: false });
      console.log(`✅ synced ${model.getTableName().schema}.${model.getTableName().tableName}`);
    }

    for (const reportType of ['profit_loss', 'balance_sheet', 'cash_flow']) {
      const ReportModel = await getFinancialReportModel(reportType);
      await ReportModel.sync({ force: false });
      // ReportModel.upsert() (see QuickBookLogingController.generateFinancialReports)
      // conflicts on these columns — the model deliberately omits index
      // definitions (see FinancialReportModel.js), so add it by hand.
      await warehouseDB.query(`
        DO $$ BEGIN
          ALTER TABLE domain_tables.report_${reportType}
          ADD CONSTRAINT uq_report_${reportType}_co_type_range
          UNIQUE (company_id, report_type, date_range_start, date_range_end);
        EXCEPTION WHEN duplicate_table THEN NULL;
        END $$;
      `);
      console.log(`✅ synced domain_tables.report_${reportType}`);
    }

    console.log('Done.');
    process.exit(0);
  } catch (err) {
    console.error('Bootstrap failed:', err);
    process.exit(1);
  }
})();
