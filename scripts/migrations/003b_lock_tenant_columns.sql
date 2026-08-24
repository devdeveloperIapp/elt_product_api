-- =============================================================
-- 003b_lock_tenant_columns.sql
-- Run AFTER 003_tenant_columns.sql, AFTER you have inspected/cleaned
-- orphan rows. This flips company_id to NOT NULL and locks the FK.
--
-- DESTRUCTIVE: Will fail if any tenant-scoped table still has rows
-- with NULL company_id. Run the orphan audit at the end of 003 first.
-- =============================================================

BEGIN;

ALTER TABLE source                     ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE destination                ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE connections                ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE connection_schema_details  ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE connection_sync_runs       ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE categories                 ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE reports                    ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE suggested_question         ALTER COLUMN company_id SET NOT NULL;

COMMIT;
