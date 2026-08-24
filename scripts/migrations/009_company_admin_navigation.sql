-- 009_company_admin_navigation.sql
-- 1) Adds a per-item flag so we can hide certain nav rows from the SuperAdmin
--    sidebar while still letting admins assign them to other roles.
-- 2) Seeds the Company Admin financial-report nav items (Cash Flow, Balance
--    Sheet, Revenue, P&L, Expenses, Business Overview) and wires them to the
--    Company Admin role (id=2).
--
-- Idempotent: safe to re-run.

BEGIN;

-- ── 1. Add the visibility flag ────────────────────────────────────────────────
ALTER TABLE navigation_items
  ADD COLUMN IF NOT EXISTS is_super_admin_visible BOOLEAN NOT NULL DEFAULT TRUE;

-- ── 2. Permissions for the financial reports (upsert) ────────────────────────
-- NOTE: a few of these already exist from 004_rbac_seed.sql; ON CONFLICT keeps
-- this script safe to re-run.
INSERT INTO permissions (name, code, module, description) VALUES
  ('View Business Overview', 'view_business_overview', 'dashboard', 'View business overview dashboard'),
  ('View Cash Flow',         'view_cash_flow',         'dashboard', 'View cash-flow statement'),
  ('View Balance Sheet',     'view_balance_sheet',     'dashboard', 'View balance sheet report'),
  ('View Revenue',           'view_revenues',          'dashboard', 'View revenue breakdown'),
  ('View P&L Report',        'view_pl_report',         'dashboard', 'View profit & loss report'),
  ('View Expenses',          'view_expenses',          'dashboard', 'View expense breakdown')
ON CONFLICT DO NOTHING;

-- ── 3. Navigation items (Company Admin only — hidden from SuperAdmin) ────────
INSERT INTO navigation_items
  (name, icon, path, module, sort_order, is_active, is_super_admin_visible)
VALUES
  ('Business Overview', 'layout-dashboard', '/reports/overview',     'dashboard', 110, TRUE, FALSE),
  ('Cash Flow',         'wallet',           '/reports/cash-flow',    'dashboard', 120, TRUE, FALSE),
  ('Balance Sheet',     'file-text',        '/reports/balance-sheet','dashboard', 130, TRUE, FALSE),
  ('Revenue',           'trending-up',      '/reports/revenue',      'dashboard', 140, TRUE, FALSE),
  ('P&L Report',        'bar-chart',        '/reports/pl',           'dashboard', 150, TRUE, FALSE),
  ('Expenses',          'receipt',          '/reports/expenses',     'dashboard', 160, TRUE, FALSE)
ON CONFLICT DO NOTHING;

-- If a previous run inserted these rows before the flag column existed, force
-- the flag to FALSE for the financial-report rows.
UPDATE navigation_items
SET    is_super_admin_visible = FALSE
WHERE  path IN (
  '/reports/overview', '/reports/cash-flow', '/reports/balance-sheet',
  '/reports/revenue',  '/reports/pl',        '/reports/expenses'
);

-- ── 4. Wire nav → permissions ────────────────────────────────────────────────
INSERT INTO navigation_permissions (navigation_id, permission_id)
SELECT n.id, p.id
FROM navigation_items n, permissions p
WHERE
  (n.path = '/reports/overview'      AND p.code = 'view_business_overview') OR
  (n.path = '/reports/cash-flow'     AND p.code = 'view_cash_flow')         OR
  (n.path = '/reports/balance-sheet' AND p.code = 'view_balance_sheet')     OR
  (n.path = '/reports/revenue'       AND p.code = 'view_revenues')          OR
  (n.path = '/reports/pl'            AND p.code = 'view_pl_report')         OR
  (n.path = '/reports/expenses'      AND p.code = 'view_expenses')
ON CONFLICT DO NOTHING;

-- ── 5. Grant permissions to Company Admin role (id=2) ────────────────────────
INSERT INTO role_permissions (role_id, permission_id)
SELECT 2, p.id FROM permissions p
WHERE p.code IN (
  'view_business_overview','view_cash_flow','view_balance_sheet',
  'view_revenues','view_pl_report','view_expenses'
)
ON CONFLICT DO NOTHING;

-- (We intentionally do NOT grant these to SuperAdmin role-id=1 here. SuperAdmin
--  still has all permissions via the catch-all in 004_rbac_seed.sql; the
--  is_super_admin_visible flag is what actually hides them in the sidebar.)

COMMIT;
