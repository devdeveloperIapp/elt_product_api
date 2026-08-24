-- =============================================================
-- 004_powerbi_views.sql
-- Phase 6 — Power BI consumption views.
--
-- Each star schema gets a small set of denormalised views that Power BI
-- can import directly. Every view exposes `company_id` so a single PBIX
-- can serve every tenant via Row-Level Security (see RLS section below).
--
-- Run AFTER 003_tenant_columns.sql AND after the v2 warehouse bootstrap
-- (services/warehouse + scripts/migrations/bootstrap_v2.sql).
-- =============================================================

-- =================================================================
-- QUICKBOOKS — quickbooks_domain.vw_dashboard
-- =================================================================
CREATE OR REPLACE VIEW quickbooks_domain.vw_dashboard AS
SELECT
  ft.company_id,
  ft.transaction_date,
  ft.transaction_type,
  ft.amount,
  ft.currency,
  ft.is_paid,
  c.display_name  AS customer_name,
  a.account_name  AS account_name,
  a.account_type  AS account_type
FROM quickbooks_domain.fact_transactions ft
LEFT JOIN quickbooks_domain.dim_customers c
  ON c.company_id = ft.company_id AND c.customer_id = ft.customer_id
LEFT JOIN quickbooks_domain.dim_accounts a
  ON a.company_id = ft.company_id AND a.account_id = ft.account_id;

-- Monthly revenue / expense / profit roll-up.
CREATE OR REPLACE VIEW quickbooks_domain.vw_revenue_monthly AS
SELECT
  company_id,
  date_trunc('month', transaction_date)::date AS month,
  SUM(CASE WHEN transaction_type = 'revenue' THEN amount ELSE 0 END) AS revenue,
  SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END) AS expenses,
  SUM(CASE WHEN transaction_type = 'revenue' THEN amount ELSE 0 END)
    - SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END) AS net_profit,
  COUNT(*) FILTER (WHERE transaction_type = 'revenue') AS revenue_txn_count
FROM quickbooks_domain.fact_transactions
GROUP BY company_id, date_trunc('month', transaction_date);

-- Outstanding receivables (per customer).
CREATE OR REPLACE VIEW quickbooks_domain.vw_ar_aging AS
SELECT
  company_id,
  customer_id,
  customer_name,
  COUNT(*) FILTER (WHERE status = 'Pending')  AS open_invoices,
  COUNT(*) FILTER (WHERE status = 'Overdue')  AS overdue_invoices,
  SUM(balance) AS open_balance
FROM quickbooks_domain.fact_invoices
WHERE balance > 0
GROUP BY company_id, customer_id, customer_name;

-- =================================================================
-- ZOHOBOOKS — zohobooks_domain.vw_dashboard
-- =================================================================
CREATE OR REPLACE VIEW zohobooks_domain.vw_dashboard AS
SELECT
  ft.company_id,
  ft.transaction_date,
  ft.transaction_type,
  ft.amount,
  ft.currency,
  ft.is_paid,
  c.display_name AS customer_name,
  v.display_name AS vendor_name
FROM zohobooks_domain.fact_transactions ft
LEFT JOIN zohobooks_domain.dim_customers c
  ON c.company_id = ft.company_id AND c.customer_id = ft.customer_id
LEFT JOIN zohobooks_domain.dim_vendors v
  ON v.company_id = ft.company_id AND v.vendor_id = ft.vendor_id;

CREATE OR REPLACE VIEW zohobooks_domain.vw_revenue_monthly AS
SELECT
  company_id,
  date_trunc('month', transaction_date)::date AS month,
  SUM(CASE WHEN transaction_type = 'revenue' THEN amount ELSE 0 END) AS revenue,
  SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END) AS expenses,
  SUM(CASE WHEN transaction_type = 'revenue' THEN amount ELSE 0 END)
    - SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END) AS net_profit
FROM zohobooks_domain.fact_transactions
GROUP BY company_id, date_trunc('month', transaction_date);

-- =================================================================
-- SHOPIFY — shopify_domain.vw_dashboard
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

-- =================================================================
-- ANALYTICS — cross-source unified view
-- One schema, one place to add cross-source roll-ups.
-- =================================================================
CREATE SCHEMA IF NOT EXISTS analytics;

CREATE OR REPLACE VIEW analytics.vw_revenue_unified AS
SELECT 'quickbooks' AS source, company_id, month, revenue, expenses, net_profit
FROM quickbooks_domain.vw_revenue_monthly
UNION ALL
SELECT 'zohobooks',  company_id, month, revenue, expenses, net_profit
FROM zohobooks_domain.vw_revenue_monthly
UNION ALL
SELECT 'shopify',    company_id, month, revenue, NULL, NULL
FROM shopify_domain.vw_revenue_monthly;

-- =================================================================
-- ROW-LEVEL SECURITY (RLS) — for Power BI service principal logins
-- =================================================================
-- Strategy:
--   1. Create a Postgres role per Power BI dataset connection.
--   2. The role's session sets `app.current_company_id` via
--      ALTER ROLE <role> SET app.current_company_id = '<company_id>';
--      OR  SET LOCAL app.current_company_id = '<id>';  on each session.
--   3. The policy below filters every view by that GUC.
--
-- Apply only to the underlying base tables (not the views) — views inherit
-- RLS from base tables, so the same policy protects every view above.
-- =================================================================

DO $$
DECLARE
  schemas TEXT[] := ARRAY['quickbooks_domain','zohobooks_domain','shopify_domain'];
  s TEXT; t TEXT;
BEGIN
  FOREACH s IN ARRAY schemas LOOP
    FOR t IN
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = s AND table_type = 'BASE TABLE'
         AND (table_name LIKE 'fact_%' OR table_name LIKE 'dim_%')
    LOOP
      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', s, t);
      EXECUTE format(
        'DROP POLICY IF EXISTS rls_company_isolation ON %I.%I',
        s, t
      );
      EXECUTE format($p$
        CREATE POLICY rls_company_isolation ON %I.%I
        USING (company_id = current_setting('app.current_company_id', true)::INTEGER)
      $p$, s, t);
    END LOOP;
  END LOOP;
END $$;

-- =================================================================
-- HOW TO USE FROM POWER BI
-- =================================================================
-- 1. Create a read-only Postgres role for Power BI:
--      CREATE ROLE pbi_reader LOGIN PASSWORD '...';
--      GRANT USAGE  ON SCHEMA quickbooks_domain, zohobooks_domain, shopify_domain, analytics TO pbi_reader;
--      GRANT SELECT ON ALL TABLES    IN SCHEMA quickbooks_domain, zohobooks_domain, shopify_domain, analytics TO pbi_reader;
--      ALTER DEFAULT PRIVILEGES IN SCHEMA quickbooks_domain, zohobooks_domain, shopify_domain
--        GRANT SELECT ON TABLES TO pbi_reader;
--
-- 2. Per-tenant connection: in the Power BI dataset's "Advanced" connection
--    options, pass `application_name=pbi&options=-c app.current_company_id=42`.
--    OR fan out to one row-level filter per tenant via PBI Service deployment.
-- =================================================================
