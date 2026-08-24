// scripts/run_excel_migration.js
require('dotenv').config();
const { mainDB, warehouseV2DB } = require('../connection/dbConnection');

const mainDbSQL = `
CREATE TABLE IF NOT EXISTS excel_connections (
  id                SERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  file_size_bytes   INTEGER,
  sheet_count       INTEGER DEFAULT 0,
  total_rows        INTEGER DEFAULT 0,
  sync_status       VARCHAR(16) DEFAULT 'pending'
                      CHECK (sync_status IN ('pending','in_progress','completed','failed')),
  error_message     TEXT,
  last_sync_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);
`;

const warehouseSQL = `
CREATE SCHEMA IF NOT EXISTS excel_raw;
CREATE SCHEMA IF NOT EXISTS excel_domain;

CREATE TABLE IF NOT EXISTS excel_raw.raw_spreadsheet (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  INTEGER NOT NULL,
  source_type VARCHAR NOT NULL DEFAULT 'excel',
  source_id   VARCHAR NOT NULL,
  raw_payload JSONB   NOT NULL,
  sync_token  VARCHAR,
  ingested_at TIMESTAMPTZ DEFAULT NOW(),
  is_deleted  BOOLEAN DEFAULT FALSE,
  UNIQUE (company_id, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_excel_raw_ss_company ON excel_raw.raw_spreadsheet (company_id);

CREATE TABLE IF NOT EXISTS excel_raw.raw_sheet_row (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  INTEGER NOT NULL,
  source_type VARCHAR NOT NULL DEFAULT 'excel',
  source_id   VARCHAR NOT NULL,
  raw_payload JSONB   NOT NULL,
  sync_token  VARCHAR,
  ingested_at TIMESTAMPTZ DEFAULT NOW(),
  is_deleted  BOOLEAN DEFAULT FALSE,
  UNIQUE (company_id, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_excel_raw_row_company ON excel_raw.raw_sheet_row (company_id, ingested_at);

CREATE TABLE IF NOT EXISTS excel_domain.dim_spreadsheets (
  spreadsheet_sk  BIGSERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL,
  spreadsheet_id  VARCHAR NOT NULL,
  title           VARCHAR,
  sheet_count     INTEGER DEFAULT 0,
  total_rows      INTEGER DEFAULT 0,
  file_size_bytes INTEGER,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, spreadsheet_id)
);

CREATE TABLE IF NOT EXISTS excel_domain.dim_sheets (
  sheet_sk       BIGSERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL,
  spreadsheet_id VARCHAR NOT NULL,
  sheet_name     VARCHAR,
  sheet_index    INTEGER,
  row_count      INTEGER DEFAULT 0,
  column_count   INTEGER DEFAULT 0,
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, spreadsheet_id, sheet_name)
);

CREATE TABLE IF NOT EXISTS excel_domain.fact_sheet_rows (
  row_sk         BIGSERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL,
  spreadsheet_id VARCHAR NOT NULL,
  sheet_name     VARCHAR NOT NULL,
  row_index      INTEGER NOT NULL,
  row_data       JSONB,
  ingested_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, spreadsheet_id, sheet_name, row_index)
);
CREATE INDEX IF NOT EXISTS idx_excel_domain_rows
  ON excel_domain.fact_sheet_rows (company_id, spreadsheet_id);
`;

async function run() {
  try {
    console.log('\n📦 Connecting to main DB:', process.env.POSTGRESQL_DATABASE);
    await mainDB.authenticate();
    console.log('✅ Main DB connected');

    console.log('\n🔧 Running main DB migration (excel_connections)...');
    await mainDB.query(mainDbSQL);
    console.log('✅ excel_connections table created (or already exists)');

    console.log('\n📦 Connecting to warehouse DB:', process.env.WAREHOUSE_V2_DB);
    await warehouseV2DB.authenticate();
    console.log('✅ Warehouse DB connected');

    console.log('\n🔧 Running warehouse migration (schemas + tables)...');
    const statements = warehouseSQL.split(';').map(s => s.trim()).filter(s => s.length > 0);
    for (const stmt of statements) {
      await warehouseV2DB.query(stmt);
      console.log('  ✅', stmt.split('\n')[0].substring(0, 70));
    }

    console.log('\n🎉 Excel migration complete!\n');
  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await mainDB.close().catch(() => {});
    await warehouseV2DB.close().catch(() => {});
  }
}

run();
