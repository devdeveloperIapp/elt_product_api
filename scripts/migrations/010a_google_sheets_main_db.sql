-- Run against MAIN DB: elt_product
-- Creates: google_sheets_connections table

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
