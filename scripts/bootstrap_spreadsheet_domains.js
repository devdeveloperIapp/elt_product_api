// One-off bootstrap for the spreadsheet-shaped v2 domains:
// google_sheets_domain, google_drive_domain, excel_domain
// (dim_spreadsheets / dim_sheets / fact_sheet_rows in each).
// Safe to re-run (sync only creates what's missing).
//
// Usage: node scripts/bootstrap_spreadsheet_domains.js

require('dotenv').config();
const { warehouseV2DB } = require('../connection/dbConnection');
const { getDomainModel } = require('../model/warehouse/DomainModelFactory');
const { getRawModel } = require('../model/warehouse/RawModelFactory');

require('../services/warehouse/transformers/googleSheetsTransformer');
require('../services/warehouse/transformers/googleDriveTransformer');
require('../services/warehouse/transformers/excelTransformer');

const SOURCES = ['googlesheets', 'googledrive', 'excel'];
const RAW_SCHEMAS = {
  googlesheets: 'google_sheets_raw',
  googledrive:  'google_drive_raw',
  excel:        'excel_raw',
};
const DOMAIN_SCHEMAS = {
  googlesheets: 'google_sheets_domain',
  googledrive:  'google_drive_domain',
  excel:        'excel_domain',
};
const RAW_ENTITIES = ['spreadsheet', 'sheet_row']; // fetchRaw() calls in each transformer

(async () => {
  try {
    await warehouseV2DB.authenticate();

    for (const source of SOURCES) {
      // ---- raw layer ----
      await warehouseV2DB.query(`CREATE SCHEMA IF NOT EXISTS ${RAW_SCHEMAS[source]};`);
      for (const entity of RAW_ENTITIES) {
        const model = getRawModel(source, entity);
        await model.sync({ force: false });
        console.log(`✅ synced ${RAW_SCHEMAS[source]}.raw_${entity}`);
      }

      // ---- domain layer ----
      await warehouseV2DB.query(`CREATE SCHEMA IF NOT EXISTS ${DOMAIN_SCHEMAS[source]};`);
      for (const table of ['dim_spreadsheets', 'dim_sheets', 'fact_sheet_rows']) {
        const model = getDomainModel(source, table);
        await model.sync({ force: false });
        console.log(`✅ synced ${DOMAIN_SCHEMAS[source]}.${table}`);
      }
    }

    console.log('Done.');
    process.exit(0);
  } catch (err) {
    console.error('Bootstrap failed:', err);
    process.exit(1);
  }
})();
