-- =============================================================
-- 003_tenant_columns.sql  (v2 — no FK to companies, safe to re-run)
-- Phase 2 — Multi-tenant DB hardening.
-- Adds company_id to all tenant-scoped tables and backfills from users.
-- =============================================================

BEGIN;

-- ── source ──────────────────────────────────────────────────────────────────
ALTER TABLE source ADD COLUMN IF NOT EXISTS company_id INTEGER;
UPDATE source s
   SET company_id = u.company_id
  FROM users u
 WHERE u.id = s.created_by
   AND s.company_id IS NULL;
CREATE INDEX IF NOT EXISTS ix_source_company_id ON source (company_id);

-- ── destination ──────────────────────────────────────────────────────────────
ALTER TABLE destination ADD COLUMN IF NOT EXISTS company_id INTEGER;
UPDATE destination d
   SET company_id = u.company_id
  FROM users u
 WHERE u.id = d.created_by
   AND d.company_id IS NULL;
CREATE INDEX IF NOT EXISTS ix_destination_company_id ON destination (company_id);

-- ── connections ───────────────────────────────────────────────────────────────
ALTER TABLE connections ADD COLUMN IF NOT EXISTS company_id INTEGER;
UPDATE connections c
   SET company_id = s.company_id
  FROM source s
 WHERE s.id::text = c.source_id::text
   AND c.company_id IS NULL;
CREATE INDEX IF NOT EXISTS ix_connections_company_id ON connections (company_id);

-- ── connection_schema_details ─────────────────────────────────────────────────
ALTER TABLE connection_schema_details ADD COLUMN IF NOT EXISTS company_id INTEGER;
UPDATE connection_schema_details d
   SET company_id = c.company_id
  FROM connections c
 WHERE c.connection_id = d.connection_id
   AND d.company_id IS NULL;
CREATE INDEX IF NOT EXISTS ix_connection_schema_details_company_id ON connection_schema_details (company_id);

-- ── connection_sync_runs ──────────────────────────────────────────────────────
ALTER TABLE connection_sync_runs ADD COLUMN IF NOT EXISTS company_id INTEGER;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='connection_sync_runs' AND column_name='connection_id') THEN
    EXECUTE $sql$
      UPDATE connection_sync_runs r
         SET company_id = c.company_id
        FROM connections c
       WHERE c.connection_id = r.connection_id
         AND r.company_id IS NULL
    $sql$;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS ix_connection_sync_runs_company_id ON connection_sync_runs (company_id);

-- ── categories ────────────────────────────────────────────────────────────────
ALTER TABLE categories ADD COLUMN IF NOT EXISTS company_id INTEGER;
CREATE INDEX IF NOT EXISTS ix_categories_company_id ON categories (company_id);

-- ── reports ───────────────────────────────────────────────────────────────────
ALTER TABLE reports ADD COLUMN IF NOT EXISTS company_id INTEGER;
CREATE INDEX IF NOT EXISTS ix_reports_company_id ON reports (company_id);

-- ── suggested_question ────────────────────────────────────────────────────────
ALTER TABLE suggested_question ADD COLUMN IF NOT EXISTS company_id INTEGER;
CREATE INDEX IF NOT EXISTS ix_suggested_question_company_id ON suggested_question (company_id);

-- ── chats (optional) ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='chats') THEN
    EXECUTE 'ALTER TABLE chats ADD COLUMN IF NOT EXISTS company_id INTEGER';
    EXECUTE 'CREATE INDEX IF NOT EXISTS ix_chats_company_id ON chats (company_id)';
  END IF;
END $$;

-- ── orphan audit ──────────────────────────────────────────────────────────────
DO $$
DECLARE r TEXT; cnt INTEGER;
BEGIN
  RAISE NOTICE '=== Orphan audit (NULL company_id) ===';
  FOREACH r IN ARRAY ARRAY['source','destination','connections',
                            'connection_schema_details','connection_sync_runs',
                            'categories','reports','suggested_question']
  LOOP
    EXECUTE format('SELECT COUNT(*) FROM %I WHERE company_id IS NULL', r) INTO cnt;
    RAISE NOTICE '  %: % rows NULL', r, cnt;
  END LOOP;
END $$;

COMMIT;
