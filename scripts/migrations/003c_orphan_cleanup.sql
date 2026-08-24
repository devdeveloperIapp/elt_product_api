-- =============================================================
-- 003c_orphan_cleanup.sql
-- Cleans up orphan rows (company_id IS NULL) so 003b can run.
--
-- What this does:
--   1. Assign company_id=1 to users 1-7 (legacy test/admin accounts)
--   2. Re-run backfill on source/destination/connections/csd/csr
--      for rows still NULL (created_by=1 which now has company_id=1)
--   3. Backfill suggested_question via user_id join
--   4. Assign company_id=1 to categories (no created_by column)
--   5. Delete 38 junk "Quickbooks login pending" rows (NULL created_by)
-- =============================================================

BEGIN;

-- ── 1. Give legacy users a company ──────────────────────────────
UPDATE users
SET    company_id = 1
WHERE  id IN (1, 3, 4, 5, 6, 7)
  AND  company_id IS NULL;

-- ── 2. Backfill source ───────────────────────────────────────────
UPDATE source s
SET    company_id = u.company_id
FROM   users u
WHERE  u.id = s.created_by
  AND  s.company_id IS NULL
  AND  u.company_id IS NOT NULL;

-- Delete leftover source rows where created_by is still NULL
-- (the 38 incomplete QB-login pending rows, IDs 84-121)
DELETE FROM source
WHERE  company_id IS NULL
  AND  created_by IS NULL;

-- ── 3. Backfill destination ──────────────────────────────────────
UPDATE destination d
SET    company_id = u.company_id
FROM   users u
WHERE  u.id = d.created_by
  AND  d.company_id IS NULL
  AND  u.company_id IS NOT NULL;

-- ── 4. Backfill connections via source's company_id ─────────────
-- (connections has no created_by; source_id is stored as VARCHAR)
UPDATE connections c
SET    company_id = s.company_id
FROM   source s
WHERE  s.id::text = c.source_id
  AND  c.company_id IS NULL
  AND  s.company_id IS NOT NULL;

-- ── 5. Backfill connection_schema_details via parent connection ──
UPDATE connection_schema_details csd
SET    company_id = c.company_id
FROM   connections c
WHERE  c.connection_id = csd.connection_id
  AND  csd.company_id IS NULL
  AND  c.company_id IS NOT NULL;

-- ── 6. Backfill connection_sync_runs via parent connection ───────
UPDATE connection_sync_runs csr
SET    company_id = c.company_id
FROM   connections c
WHERE  c.connection_id = csr.connection_id
  AND  csr.company_id IS NULL
  AND  c.company_id IS NOT NULL;

-- ── 7. Backfill suggested_question via user_id ───────────────────
UPDATE suggested_question sq
SET    company_id = u.company_id
FROM   users u
WHERE  u.id = sq.user_id
  AND  sq.company_id IS NULL
  AND  u.company_id IS NOT NULL;

-- ── 8. Assign categories to company 1 ───────────────────────────
-- (no created_by; these are the 5 global demo categories)
UPDATE categories
SET    company_id = 1
WHERE  company_id IS NULL;

-- ── 9. Backfill reports via category ────────────────────────────
UPDATE reports r
SET    company_id = cat.company_id
FROM   categories cat
WHERE  cat.id = r.category_id
  AND  r.company_id IS NULL
  AND  cat.company_id IS NOT NULL;

-- ── Verify: show remaining NULLs (should all be 0) ───────────────
SELECT 'source'                   AS tbl, COUNT(*) AS remaining_nulls FROM source                    WHERE company_id IS NULL
UNION ALL
SELECT 'destination',                      COUNT(*)                   FROM destination               WHERE company_id IS NULL
UNION ALL
SELECT 'connections',                      COUNT(*)                   FROM connections               WHERE company_id IS NULL
UNION ALL
SELECT 'connection_schema_details',        COUNT(*)                   FROM connection_schema_details WHERE company_id IS NULL
UNION ALL
SELECT 'connection_sync_runs',             COUNT(*)                   FROM connection_sync_runs      WHERE company_id IS NULL
UNION ALL
SELECT 'categories',                       COUNT(*)                   FROM categories                WHERE company_id IS NULL
UNION ALL
SELECT 'reports',                          COUNT(*)                   FROM reports                   WHERE company_id IS NULL
UNION ALL
SELECT 'suggested_question',               COUNT(*)                   FROM suggested_question        WHERE company_id IS NULL;

COMMIT;
