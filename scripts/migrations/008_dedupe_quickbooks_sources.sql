-- 008_dedupe_quickbooks_sources.sql
-- Collapses legacy duplicate QuickBooks source rows down to one per
-- (company_id, realmId). Before this migration the OAuth callback created a
-- new source row on every reconnect, so company_id=1 had 7 rows.
--
-- Strategy: keep the row with the highest id (most recent tokens), delete the
-- rest. Safe: warehouse fact tables key off company_id + invoice_id, not
-- source.id, so deleting redundant sources doesn't drop any analytical data.
--
-- Idempotent: safe to re-run.

BEGIN;

WITH ranked AS (
  SELECT
    id,
    company_id,
    connector_settings_json->>'realmId' AS realm_id,
    ROW_NUMBER() OVER (
      PARTITION BY company_id, connector_settings_json->>'realmId'
      ORDER BY id DESC
    ) AS rn
  FROM source
  WHERE connector_name ILIKE '%quickbooks%'
    AND connector_settings_json ? 'realmId'
)
DELETE FROM source
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

COMMIT;
