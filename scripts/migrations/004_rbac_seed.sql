-- =============================================================
-- 004_rbac_seed.sql  (v2 — works alongside existing data)
-- Adds ELT-specific permissions, nav items, and mappings.
-- ALL inserts use ON CONFLICT DO NOTHING — safe to re-run.
-- =============================================================

BEGIN;

-- ── 1. Add missing permissions (ELT pipeline features) ────────────────────────
INSERT INTO permissions (name, code, module, description) VALUES
  -- Navigation management
  ('Manage Navigation',    'manage_navigation',   'navigation',   'Create, edit, delete navigation items'),

  -- Sources
  ('View Sources',         'view_sources',        'data_source',  'List and view data sources'),
  ('Create Source',        'create_source',       'data_source',  'Add new data sources'),
  ('Edit Source',          'edit_source',         'data_source',  'Modify data source config'),
  ('Delete Source',        'delete_source',       'data_source',  'Remove data sources'),

  -- Destinations
  ('View Destinations',    'view_destinations',   'data_source',  'List and view destinations'),
  ('Create Destination',   'create_destination',  'data_source',  'Add new destinations'),
  ('Edit Destination',     'edit_destination',    'data_source',  'Modify destination config'),
  ('Delete Destination',   'delete_destination',  'data_source',  'Remove destinations'),

  -- Connections
  ('View Connections',     'view_connections',    'data_source',  'List and view connections'),
  ('Create Connection',    'create_connection',   'data_source',  'Create new connections'),
  ('Edit Connection',      'edit_connection',     'data_source',  'Modify connections'),
  ('Sync Connection',      'sync_connection',     'data_source',  'Trigger manual sync'),
  ('Delete Connection',    'delete_connection',   'data_source',  'Remove connections'),

  -- Categories
  ('View Categories',      'view_categories',     'report',       'View report categories'),
  ('Manage Categories',    'manage_categories',   'report',       'Create, edit, delete categories'),

  -- AI Insights
  ('View Insights',        'view_insights',       'dashboard',    'View AI-generated insights'),

  -- Suggested Questions
  ('View Suggested Questions',   'view_suggested_questions',  'report', 'View suggested questions'),
  ('Manage Suggested Questions', 'manage_suggested_questions','report', 'Manage suggested questions')
ON CONFLICT (name) DO NOTHING;

-- ── 2. Add missing nav items ──────────────────────────────────────────────────
INSERT INTO navigation_items (name, icon, path, module, sort_order, is_active) VALUES
  ('Sources',      'plug',       '/source',           'data_source', 20, TRUE),
  ('Destinations', 'box',        '/destination',      'data_source', 30, TRUE),
  ('Connections',  'folder',     '/connection',       'data_source', 40, TRUE),
  ('Insights',     'pie-chart',  '/insights',         'dashboard',   55, TRUE),
  ('Categories',   'tags',       '/categories',       'report',      51, TRUE),
  ('Nav Manager',  'cogs',       '/admin/navigation', 'navigation',  90, TRUE)
ON CONFLICT DO NOTHING;

-- ── 3. Wire nav items to permissions ─────────────────────────────────────────
INSERT INTO navigation_permissions (navigation_id, permission_id)
SELECT n.id, p.id
FROM navigation_items n, permissions p
WHERE
  (n.module = 'data_source' AND n.name = 'Sources'      AND p.code = 'view_sources')      OR
  (n.module = 'data_source' AND n.name = 'Destinations' AND p.code = 'view_destinations') OR
  (n.module = 'data_source' AND n.name = 'Connections'  AND p.code = 'view_connections')  OR
  (n.module = 'dashboard'   AND n.name = 'Insights'     AND p.code = 'view_insights')     OR
  (n.module = 'report'      AND n.name = 'Categories'   AND p.code = 'view_categories')   OR
  (n.module = 'navigation'  AND n.name = 'Nav Manager'  AND p.code = 'manage_navigation')
ON CONFLICT DO NOTHING;

-- ── 4. Assign new permissions to roles ────────────────────────────────────────

-- Super Admin (id=1) gets ALL permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT 1, p.id FROM permissions p
ON CONFLICT DO NOTHING;

-- Company Admin (id=2): all ELT features except manage_navigation
INSERT INTO role_permissions (role_id, permission_id)
SELECT 2, p.id FROM permissions p
WHERE p.code IN (
  'view_sources','create_source','edit_source','delete_source',
  'view_destinations','create_destination','edit_destination','delete_destination',
  'view_connections','create_connection','edit_connection','sync_connection','delete_connection',
  'view_categories','manage_categories',
  'view_insights',
  'view_suggested_questions','manage_suggested_questions',
  'view_add_source'
)
ON CONFLICT DO NOTHING;

-- Manager (id=3): view + sync, no delete/create
INSERT INTO role_permissions (role_id, permission_id)
SELECT 3, p.id FROM permissions p
WHERE p.code IN (
  'view_sources','view_destinations','view_connections','sync_connection',
  'view_categories','view_insights',
  'view_reports','view_charts','view_dashboard',
  'view_business_overview','view_invoice','view_vendor',
  'view_customers','view_revenues','view_pl_report','view_cash_flow',
  'view_suggested_questions','view_add_source'
)
ON CONFLICT DO NOTHING;

-- Viewer (id=4): read-only
INSERT INTO role_permissions (role_id, permission_id)
SELECT 4, p.id FROM permissions p
WHERE p.code IN (
  'view_sources','view_destinations','view_connections',
  'view_categories','view_insights',
  'view_reports','view_charts','view_dashboard',
  'view_business_overview','view_invoice','view_vendor',
  'view_customers','view_revenues','view_pl_report','view_cash_flow',
  'view_suggested_questions','view_add_source'
)
ON CONFLICT DO NOTHING;

-- ── 5. Verify summary ─────────────────────────────────────────────────────────
DO $$
DECLARE
  perm_count INTEGER;
  nav_count  INTEGER;
  rp_count   INTEGER;
BEGIN
  SELECT COUNT(*) INTO perm_count FROM permissions;
  SELECT COUNT(*) INTO nav_count  FROM navigation_items;
  SELECT COUNT(*) INTO rp_count   FROM role_permissions;
  RAISE NOTICE '=== Seed complete ===';
  RAISE NOTICE '  permissions:     %', perm_count;
  RAISE NOTICE '  navigation_items: %', nav_count;
  RAISE NOTICE '  role_permissions: %', rp_count;
END $$;

COMMIT;
