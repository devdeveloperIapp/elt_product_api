-- 012_remove_insights_nav.sql
-- The Insights page has been removed from the frontend, so hide its sidebar
-- entry — otherwise the link stays visible and lands on a 404.
--
-- Deactivated rather than deleted: navigation_permissions cascades on delete,
-- and user_navigation_overrides holds rows keyed by this id with no foreign
-- key, so a DELETE would silently orphan them. Flipping is_active is
-- reversible and the navigation API already filters on it.
--
-- Safe to run more than once.

BEGIN;

UPDATE navigation_items
   SET is_active = false,
       updated_at = now()
 WHERE path = '/insights';

COMMIT;

-- To bring the page back later:
--   UPDATE navigation_items SET is_active = true WHERE path = '/insights';
