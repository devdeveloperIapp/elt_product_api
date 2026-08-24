// One-off bootstrap for quickbooks_domain.report_profit_loss/balance_sheet/
// cash_flow (v2 counterpart of the legacy domain_tables.report_* tables —
// see model/warehouse/V2FinancialReportModel.js). Safe to re-run.
//
// Usage: node scripts/bootstrap_v2_financial_reports.js

require('dotenv').config();
const { warehouseV2DB } = require('../connection/dbConnection');
const getV2FinancialReportModel = require('../model/warehouse/V2FinancialReportModel');

(async () => {
  try {
    await warehouseV2DB.authenticate();
    await warehouseV2DB.query('CREATE SCHEMA IF NOT EXISTS quickbooks_domain;');

    for (const reportType of ['profit_loss', 'balance_sheet', 'cash_flow']) {
      const ReportModel = getV2FinancialReportModel(reportType);
      await ReportModel.sync({ force: false });
      await warehouseV2DB.query(`
        DO $$ BEGIN
          ALTER TABLE quickbooks_domain.report_${reportType}
          ADD CONSTRAINT uq_v2_report_${reportType}_co_type_range
          UNIQUE (company_id, report_type, date_range_start, date_range_end);
        EXCEPTION WHEN duplicate_table THEN NULL;
        END $$;
      `);
      console.log(`✅ synced quickbooks_domain.report_${reportType}`);
    }

    console.log('Done.');
    process.exit(0);
  } catch (err) {
    console.error('Bootstrap failed:', err);
    process.exit(1);
  }
})();
