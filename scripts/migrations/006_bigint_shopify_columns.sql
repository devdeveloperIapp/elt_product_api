-- =============================================================
-- 006_bigint_shopify_columns.sql
-- Widen INTEGER → BIGINT for columns that can exceed 2 147 483 647.
--
-- Shopify uses sentinel value 9 999 999 999 for "unlimited" inventory,
-- which overflows a 32-bit INTEGER.  This migration safely widens the
-- 7 affected columns by:
--
--   1. Dropping dependent views (CASCADE handles nested deps).
--   2. Dropping RLS policies that block ALTER COLUMN.
--   3. Running targeted ALTER TABLE … TYPE BIGINT.
--   4. Re-applying RLS policies.
--   5. Recreating all views (exact copies from 004_powerbi_views.sql).
--
-- Safe to run multiple times — all DROP statements use IF EXISTS.
-- =============================================================

BEGIN;

-- =================================================================
-- STEP 1 — Drop dependent views (CASCADE removes nested deps too)
-- =================================================================

-- analytics unified view references shopify vw_revenue_monthly
DROP VIEW IF EXISTS analytics.vw_revenue_unified CASCADE;

-- shopify views that reference the columns we are widening
DROP VIEW IF EXISTS shopify_domain.vw_dashboard        CASCADE;
DROP VIEW IF EXISTS shopify_domain.vw_revenue_monthly  CASCADE;
DROP VIEW IF EXISTS shopify_domain.vw_top_products     CASCADE;

-- =================================================================
-- STEP 2 — Drop RLS policies that block ALTER COLUMN
-- =================================================================
DROP POLICY IF EXISTS rls_company_isolation ON shopify_domain.dim_customers;
DROP POLICY IF EXISTS rls_company_isolation ON shopify_domain.dim_products;
DROP POLICY IF EXISTS rls_company_isolation ON shopify_domain.fact_orders;
DROP POLICY IF EXISTS rls_company_isolation ON shopify_domain.fact_order_lines;

-- Extra safety: drop policies on any new shopify tables added in bootstrap_v2
DROP POLICY IF EXISTS rls_company_isolation ON shopify_domain.dim_collections;
DROP POLICY IF EXISTS rls_company_isolation ON shopify_domain.dim_price_rules;
DROP POLICY IF EXISTS rls_company_isolation ON shopify_domain.fact_collects;

-- =================================================================
-- STEP 3 — Widen the specific columns (only the 7 that need it)
-- =================================================================

-- dim_customers.orders_count
ALTER TABLE shopify_domain.dim_customers
  ALTER COLUMN orders_count TYPE BIGINT;

-- dim_products.inventory_qty
ALTER TABLE shopify_domain.dim_products
  ALTER COLUMN inventory_qty TYPE BIGINT;

-- fact_orders.line_items_count
ALTER TABLE shopify_domain.fact_orders
  ALTER COLUMN line_items_count TYPE BIGINT;

-- fact_order_lines.quantity
ALTER TABLE shopify_domain.fact_order_lines
  ALTER COLUMN quantity TYPE BIGINT;

-- dim_collections.products_count (table may not exist on older deploys)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'shopify_domain'
       AND table_name   = 'dim_collections'
       AND column_name  = 'products_count'
  ) THEN
    ALTER TABLE shopify_domain.dim_collections ALTER COLUMN products_count TYPE BIGINT;
  END IF;
END $$;

-- dim_price_rules.usage_limit
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'shopify_domain'
       AND table_name   = 'dim_price_rules'
       AND column_name  = 'usage_limit'
  ) THEN
    ALTER TABLE shopify_domain.dim_price_rules ALTER COLUMN usage_limit TYPE BIGINT;
  END IF;
END $$;

-- fact_collects.position
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'shopify_domain'
       AND table_name   = 'fact_collects'
       AND column_name  = 'position'
  ) THEN
    ALTER TABLE shopify_domain.fact_collects ALTER COLUMN position TYPE BIGINT;
  END IF;
END $$;

-- =================================================================
-- STEP 4 — Recreate RLS policies on all shopify_domain base tables
-- Uses the same dynamic DO block as 004_powerbi_views.sql so any
-- new tables added in the future are automatically covered.
-- =================================================================

DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'shopify_domain'
       AND table_type   = 'BASE TABLE'
       AND (table_name LIKE 'fact_%' OR table_name LIKE 'dim_%')
  LOOP
    EXECUTE format('ALTER TABLE shopify_domain.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS rls_company_isolation ON shopify_domain.%I', t);
    EXECUTE format($p$
      CREATE POLICY rls_company_isolation ON shopify_domain.%I
      USING (company_id = current_setting('app.current_company_id', true)::INTEGER)
    $p$, t);
  END LOOP;
END $$;

-- =================================================================
-- STEP 5 — Recreate Shopify views (exact copies from 004_powerbi_views.sql)
-- =================================================================

CREATE OR REPLACE VIEW shopify_domain.vw_dashboard AS
SELECT
  fo.company_id,
  fo.transaction_date::date     AS order_date,
  fo.order_number,
  fo.total_amount,
  fo.subtotal,
  fo.tax_amount,
  fo.discount_amount,
  fo.financial_status,
  fo.fulfillment_status,
  fo.currency,
  c.display_name                AS customer_name,
  c.email                       AS customer_email,
  fo.line_items_count
FROM shopify_domain.fact_orders fo
LEFT JOIN shopify_domain.dim_customers c
  ON c.company_id = fo.company_id AND c.customer_id = fo.customer_id;

CREATE OR REPLACE VIEW shopify_domain.vw_revenue_monthly AS
SELECT
  company_id,
  date_trunc('month', transaction_date)::date AS month,
  SUM(total_amount) FILTER (WHERE financial_status = 'paid') AS revenue,
  COUNT(*) FILTER (WHERE financial_status = 'paid')          AS paid_orders,
  COUNT(*)                                                   AS total_orders,
  AVG(total_amount) FILTER (WHERE financial_status = 'paid') AS aov
FROM shopify_domain.fact_orders
GROUP BY company_id, date_trunc('month', transaction_date);

CREATE OR REPLACE VIEW shopify_domain.vw_top_products AS
SELECT
  company_id,
  product_id,
  title,
  sku,
  SUM(quantity) AS units_sold,
  SUM(line_total) AS gross_revenue
FROM shopify_domain.fact_order_lines
WHERE product_id IS NOT NULL
GROUP BY company_id, product_id, title, sku;

-- Recreate the cross-source unified view (references all three sources)
CREATE OR REPLACE VIEW analytics.vw_revenue_unified AS
SELECT 'quickbooks' AS source, company_id, month, revenue, expenses, net_profit
FROM quickbooks_domain.vw_revenue_monthly
UNION ALL
SELECT 'zohobooks',  company_id, month, revenue, expenses, net_profit
FROM zohobooks_domain.vw_revenue_monthly
UNION ALL
SELECT 'shopify',    company_id, month, revenue, NULL, NULL
FROM shopify_domain.vw_revenue_monthly;

COMMIT;

-- =================================================================
-- VERIFICATION (run manually after applying)
-- =================================================================
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_schema = 'shopify_domain'
--   AND column_name IN ('orders_count','inventory_qty','line_items_count','quantity','products_count','usage_limit','position')
-- ORDER BY table_name, column_name;
--
-- Expected: all rows show data_type = 'bigint'
-- =================================================================
