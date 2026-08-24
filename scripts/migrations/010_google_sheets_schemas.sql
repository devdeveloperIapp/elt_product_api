-- migrations/010_google_sheets_schemas.sql
-- Creates the google_sheets_connections table in the main DB
-- and raw/domain schemas + tables in elt_warehouse_v2.
--
-- Run against:
--   Main DB   : psql $POSTGRESQL_DATABASE -f this_file.sql
--   Warehouse : psql $WAREHOUSE_V2_DB     -f this_file.sql   (for schema/table creation)
--
-- Or simply let Sequelize auto-sync on first boot (RawModelFactory calls Model.sync()).

-- ============================================================
-- MAIN DB: google_sheets_connections
-- ============================================================
CREATE TABLE IF NOT EXISTS google_sheets_connections (
  id                       SERIAL PRIMARY KEY,
  company_id               INTEGER NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  google_email             VARCHAR(255),
  access_token             TEXT NOT NULL,
  refresh_token            TEXT NOT NULL,
  token_expiry             BIGINT,
  scope                    TEXT,
  selected_spreadsheet_ids JSONB    DEFAULT '[]',
  sync_status              VARCHAR(16) DEFAULT 'pending'
                             CHECK (sync_status IN ('pending','in_progress','completed','failed')),
  error_message            TEXT,
  last_sync_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- WAREHOUSE DB (elt_warehouse_v2): raw schemas + tables
-- ============================================================
CREATE SCHEMA IF NOT EXISTS google_sheets_raw;
CREATE SCHEMA IF NOT EXISTS google_sheets_domain;

-- Raw spreadsheet metadata (one row per spreadsheet file)
CREATE TABLE IF NOT EXISTS google_sheets_raw.raw_spreadsheet (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   INTEGER  NOT NULL,
  source_type  VARCHAR  NOT NULL DEFAULT 'googlesheets',
  source_id    VARCHAR  NOT NULL,   -- Google spreadsheetId
  raw_payload  JSONB    NOT NULL,
  sync_token   VARCHAR,
  ingested_at  TIMESTAMPTZ DEFAULT NOW(),
  is_deleted   BOOLEAN  DEFAULT FALSE,
  UNIQUE (company_id, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_gsr_spreadsheet_company ON google_sheets_raw.raw_spreadsheet (company_id);

-- Raw sheet rows (one row per data row in a worksheet tab)
CREATE TABLE IF NOT EXISTS google_sheets_raw.raw_sheet_row (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   INTEGER  NOT NULL,
  source_type  VARCHAR  NOT NULL DEFAULT 'googlesheets',
  source_id    VARCHAR  NOT NULL,   -- composite: spreadsheetId__sheetName__rowIndex
  raw_payload  JSONB    NOT NULL,
  sync_token   VARCHAR,
  ingested_at  TIMESTAMPTZ DEFAULT NOW(),
  is_deleted   BOOLEAN  DEFAULT FALSE,
  UNIQUE (company_id, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_gsr_row_company ON google_sheets_raw.raw_sheet_row (company_id, ingested_at);

-- ============================================================
-- WAREHOUSE DB: domain tables
-- ============================================================

-- dim_spreadsheets
CREATE TABLE IF NOT EXISTS google_sheets_domain.dim_spreadsheets (
  spreadsheet_sk BIGSERIAL PRIMARY KEY,
  company_id     INTEGER  NOT NULL,
  spreadsheet_id VARCHAR  NOT NULL,
  title          VARCHAR,
  owner_email    VARCHAR,
  locale         VARCHAR(16),
  time_zone      VARCHAR(64),
  sheet_count    INTEGER  DEFAULT 0,
  drive_url      TEXT,
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, spreadsheet_id)
);

-- dim_sheets
CREATE TABLE IF NOT EXISTS google_sheets_domain.dim_sheets (
  sheet_sk       BIGSERIAL PRIMARY KEY,
  company_id     INTEGER  NOT NULL,
  spreadsheet_id VARCHAR  NOT NULL,
  sheet_id       INTEGER,
  sheet_name     VARCHAR,
  sheet_index    INTEGER,
  row_count      INTEGER  DEFAULT 0,
  column_count   INTEGER  DEFAULT 0,
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, spreadsheet_id, sheet_id)
);

-- fact_sheet_rows
CREATE TABLE IF NOT EXISTS google_sheets_domain.fact_sheet_rows (
  row_sk         BIGSERIAL PRIMARY KEY,
  company_id     INTEGER  NOT NULL,
  spreadsheet_id VARCHAR  NOT NULL,
  sheet_name     VARCHAR  NOT NULL,
  row_index      INTEGER  NOT NULL,
  row_data       JSONB,
  ingested_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, spreadsheet_id, sheet_name, row_index)
);
CREATE INDEX IF NOT EXISTS idx_gsd_rows_company_sheet
  ON google_sheets_domain.fact_sheet_rows (company_id, spreadsheet_id);
