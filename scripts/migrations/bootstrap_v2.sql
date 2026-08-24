-- =============================================================
-- bootstrap_v2.sql
-- Run once against database `elt_warehouse_v2`.
-- Creates all per-source schemas and tables.
-- Idempotent (CREATE IF NOT EXISTS) so safe to re-run.
-- =============================================================

-- ---------- schemas (the user said these already exist; included
-- ---------- here for portability / disaster-recovery only) -----
CREATE SCHEMA IF NOT EXISTS quickbooks_raw;
CREATE SCHEMA IF NOT EXISTS quickbooks_domain;
CREATE SCHEMA IF NOT EXISTS zohobooks_raw;
CREATE SCHEMA IF NOT EXISTS zohobooks_domain;
CREATE SCHEMA IF NOT EXISTS shopify_raw;
CREATE SCHEMA IF NOT EXISTS shopify_domain;

-- =============================================================
-- generic raw-table template
-- =============================================================
-- Per source, create one raw_<entity> table per QB/Zoho/Shopify entity you ingest.
-- Below covers the entities currently used in the codebase. Add more as needed.

DO $$
DECLARE
  s text;
  e text;
  entities text[];
BEGIN
  FOREACH s IN ARRAY ARRAY['quickbooks_raw','zohobooks_raw','shopify_raw'] LOOP
    -- Choose entity list per source (case-insensitive table names)
    IF s = 'quickbooks_raw' THEN
      entities := ARRAY['account','customer','vendor','invoice','bill','payment','journalentry',
                        'estimate','billpayment','department','deposit','employee','item',
                        'paymentmethod','purchase','purchaseorder','refundreceipt','salesreceipt',
                        'taxcode','taxrate','term','timeactivity','transfer','vendorcredit'];
    ELSIF s = 'zohobooks_raw' THEN
      entities := ARRAY['customer','vendor','item','invoice','bill','payment','account',
                        'vendorpayment','salesorder','purchaseorder','expense','creditnote','estimate',
                        'chartofaccount','journalentry','tax','recurringinvoice','bankaccount',
                        'banktransaction','project','pricelist','retainerinvoice'];
    ELSE
      -- shopify_raw
      entities := ARRAY['customer','product','order','transaction',
                        'customcollection','smartcollection','draftorder','pricerule',
                        'location','collect','abandonedcheckout','tendertransaction','giftcard'];
    END IF;

    FOREACH e IN ARRAY entities LOOP
      EXECUTE format($f$
        CREATE TABLE IF NOT EXISTS %I.%I (
          id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          company_id   INTEGER NOT NULL,
          source_type  VARCHAR(64) NOT NULL,
          source_id    VARCHAR(128) NOT NULL,
          raw_payload  JSONB NOT NULL,
          sync_token   VARCHAR(64),
          ingested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          is_deleted   BOOLEAN NOT NULL DEFAULT FALSE,
          CONSTRAINT %I UNIQUE (company_id, source_type, source_id)
        );
        CREATE INDEX IF NOT EXISTS %I ON %I.%I (company_id, ingested_at);
      $f$,
        s, 'raw_' || e,
        'uq_' || s || '_raw_' || e,
        'ix_' || s || '_raw_' || e || '_co_ing', s, 'raw_' || e
      );
    END LOOP;
  END LOOP;
END$$;

-- =============================================================
-- quickbooks_domain
-- =============================================================
CREATE TABLE IF NOT EXISTS quickbooks_domain.dim_accounts (
  account_sk        BIGSERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL,
  account_id        VARCHAR(64) NOT NULL,
  account_name      TEXT,
  account_type      VARCHAR(64),
  account_sub_type  VARCHAR(64),
  current_balance   NUMERIC(18,2) DEFAULT 0,
  currency          VARCHAR(8) DEFAULT 'USD',
  is_active         BOOLEAN DEFAULT TRUE,
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, account_id)
);

CREATE TABLE IF NOT EXISTS quickbooks_domain.dim_customers (
  customer_sk   BIGSERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL,
  customer_id   VARCHAR(64) NOT NULL,
  display_name  TEXT,
  email         TEXT,
  balance       NUMERIC(18,2) DEFAULT 0,
  is_active     BOOLEAN DEFAULT TRUE,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, customer_id)
);

CREATE TABLE IF NOT EXISTS quickbooks_domain.dim_vendors (
  vendor_sk    BIGSERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL,
  vendor_id    VARCHAR(64) NOT NULL,
  display_name TEXT,
  email        TEXT,
  phone        TEXT,
  balance      NUMERIC(18,2) DEFAULT 0,
  is_active    BOOLEAN DEFAULT TRUE,
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, vendor_id)
);

CREATE TABLE IF NOT EXISTS quickbooks_domain.fact_invoices (
  invoice_sk       BIGSERIAL PRIMARY KEY,
  company_id       INTEGER NOT NULL,
  invoice_id       VARCHAR(64) NOT NULL,
  doc_number       VARCHAR(64),
  customer_id      VARCHAR(64),
  customer_name    TEXT,
  transaction_date DATE,
  due_date         DATE,
  amount           NUMERIC(18,2) DEFAULT 0,
  balance          NUMERIC(18,2) DEFAULT 0,
  status           VARCHAR(16),
  currency         VARCHAR(8) DEFAULT 'USD',
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, invoice_id)
);
CREATE INDEX IF NOT EXISTS ix_qb_fact_invoices_date ON quickbooks_domain.fact_invoices (transaction_date);

CREATE TABLE IF NOT EXISTS quickbooks_domain.fact_bills (
  bill_sk          BIGSERIAL PRIMARY KEY,
  company_id       INTEGER NOT NULL,
  bill_id          VARCHAR(64) NOT NULL,
  doc_number       VARCHAR(64),
  vendor_id        VARCHAR(64),
  vendor_name      TEXT,
  transaction_date DATE,
  due_date         DATE,
  amount           NUMERIC(18,2) DEFAULT 0,
  balance          NUMERIC(18,2) DEFAULT 0,
  status           VARCHAR(16),
  currency         VARCHAR(8) DEFAULT 'USD',
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, bill_id)
);
CREATE INDEX IF NOT EXISTS ix_qb_fact_bills_date ON quickbooks_domain.fact_bills (transaction_date);

CREATE TABLE IF NOT EXISTS quickbooks_domain.fact_payments (
  payment_sk       BIGSERIAL PRIMARY KEY,
  company_id       INTEGER NOT NULL,
  payment_id       VARCHAR(64) NOT NULL,
  customer_id      VARCHAR(64),
  customer_name    TEXT,
  transaction_date DATE,
  amount           NUMERIC(18,2) DEFAULT 0,
  payment_method   VARCHAR(64),
  currency         VARCHAR(8) DEFAULT 'USD',
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, payment_id)
);

CREATE TABLE IF NOT EXISTS quickbooks_domain.fact_transactions (
  transaction_sk   BIGSERIAL PRIMARY KEY,
  company_id       INTEGER NOT NULL,
  transaction_date DATE,
  amount           NUMERIC(18,2) DEFAULT 0,
  transaction_type VARCHAR(16),
  account_id       VARCHAR(64),
  customer_id      VARCHAR(64),
  source_ref_id    VARCHAR(128) NOT NULL,
  currency         VARCHAR(8) DEFAULT 'USD',
  is_paid          BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, source_ref_id)
);
CREATE INDEX IF NOT EXISTS ix_qb_fact_tx_date  ON quickbooks_domain.fact_transactions (transaction_date);
CREATE INDEX IF NOT EXISTS ix_qb_fact_tx_type  ON quickbooks_domain.fact_transactions (transaction_type);

-- =============================================================
-- zohobooks_domain
-- =============================================================
CREATE TABLE IF NOT EXISTS zohobooks_domain.dim_customers (
  customer_sk  BIGSERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL,
  customer_id  VARCHAR(64) NOT NULL,
  display_name TEXT,
  email        TEXT,
  phone        TEXT,
  balance      NUMERIC(18,2) DEFAULT 0,
  is_active    BOOLEAN DEFAULT TRUE,
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, customer_id)
);

CREATE TABLE IF NOT EXISTS zohobooks_domain.dim_vendors (
  vendor_sk    BIGSERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL,
  vendor_id    VARCHAR(64) NOT NULL,
  display_name TEXT,
  email        TEXT,
  phone        TEXT,
  balance      NUMERIC(18,2) DEFAULT 0,
  is_active    BOOLEAN DEFAULT TRUE,
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, vendor_id)
);

CREATE TABLE IF NOT EXISTS zohobooks_domain.dim_items (
  item_sk     BIGSERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL,
  item_id     VARCHAR(64) NOT NULL,
  name        TEXT,
  sku         VARCHAR(128),
  rate        NUMERIC(18,2) DEFAULT 0,
  unit        VARCHAR(32),
  is_active   BOOLEAN DEFAULT TRUE,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, item_id)
);

CREATE TABLE IF NOT EXISTS zohobooks_domain.fact_invoices (
  invoice_sk       BIGSERIAL PRIMARY KEY,
  company_id       INTEGER NOT NULL,
  invoice_id       VARCHAR(64) NOT NULL,
  invoice_number   VARCHAR(64),
  customer_id      VARCHAR(64),
  customer_name    TEXT,
  transaction_date DATE,
  due_date         DATE,
  amount           NUMERIC(18,2) DEFAULT 0,
  balance          NUMERIC(18,2) DEFAULT 0,
  status           VARCHAR(16),
  currency         VARCHAR(8) DEFAULT 'INR',
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, invoice_id)
);
CREATE INDEX IF NOT EXISTS ix_zb_fact_invoices_date ON zohobooks_domain.fact_invoices (transaction_date);

CREATE TABLE IF NOT EXISTS zohobooks_domain.fact_bills (
  bill_sk          BIGSERIAL PRIMARY KEY,
  company_id       INTEGER NOT NULL,
  bill_id          VARCHAR(64) NOT NULL,
  bill_number      VARCHAR(64),
  vendor_id        VARCHAR(64),
  vendor_name      TEXT,
  transaction_date DATE,
  due_date         DATE,
  amount           NUMERIC(18,2) DEFAULT 0,
  balance          NUMERIC(18,2) DEFAULT 0,
  status           VARCHAR(16),
  currency         VARCHAR(8) DEFAULT 'INR',
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, bill_id)
);

CREATE TABLE IF NOT EXISTS zohobooks_domain.fact_payments (
  payment_sk       BIGSERIAL PRIMARY KEY,
  company_id       INTEGER NOT NULL,
  payment_id       VARCHAR(64) NOT NULL,
  customer_id      VARCHAR(64),
  customer_name    TEXT,
  transaction_date DATE,
  amount           NUMERIC(18,2) DEFAULT 0,
  payment_method   VARCHAR(64),
  currency         VARCHAR(8) DEFAULT 'INR',
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, payment_id)
);

CREATE TABLE IF NOT EXISTS zohobooks_domain.fact_transactions (
  transaction_sk   BIGSERIAL PRIMARY KEY,
  company_id       INTEGER NOT NULL,
  transaction_date DATE,
  amount           NUMERIC(18,2) DEFAULT 0,
  transaction_type VARCHAR(16),
  customer_id      VARCHAR(64),
  vendor_id        VARCHAR(64),
  source_ref_id    VARCHAR(128) NOT NULL,
  currency         VARCHAR(8) DEFAULT 'INR',
  is_paid          BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, source_ref_id)
);

-- =============================================================
-- shopify_domain
-- =============================================================
CREATE TABLE IF NOT EXISTS shopify_domain.dim_customers (
  customer_sk  BIGSERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL,
  customer_id  VARCHAR(64) NOT NULL,
  display_name TEXT,
  email        TEXT,
  phone        TEXT,
  total_spent  NUMERIC(18,2) DEFAULT 0,
  orders_count BIGINT DEFAULT 0,
  state        VARCHAR(32),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, customer_id)
);

CREATE TABLE IF NOT EXISTS shopify_domain.dim_products (
  product_sk    BIGSERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL,
  product_id    VARCHAR(64) NOT NULL,
  title         TEXT,
  vendor        TEXT,
  product_type  TEXT,
  status        VARCHAR(16),
  price         NUMERIC(18,2) DEFAULT 0,
  sku           VARCHAR(128),
  inventory_qty BIGINT DEFAULT 0,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, product_id)
);

CREATE TABLE IF NOT EXISTS shopify_domain.fact_orders (
  order_sk          BIGSERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL,
  order_id          VARCHAR(64) NOT NULL,
  order_number      VARCHAR(64),
  customer_id       VARCHAR(64),
  customer_email    TEXT,
  transaction_date  TIMESTAMPTZ,
  subtotal          NUMERIC(18,2) DEFAULT 0,
  tax_amount        NUMERIC(18,2) DEFAULT 0,
  shipping_amount   NUMERIC(18,2) DEFAULT 0,
  discount_amount   NUMERIC(18,2) DEFAULT 0,
  total_amount      NUMERIC(18,2) DEFAULT 0,
  financial_status  VARCHAR(32),
  fulfillment_status VARCHAR(32),
  currency          VARCHAR(8) DEFAULT 'USD',
  line_items_count  BIGINT DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, order_id)
);
CREATE INDEX IF NOT EXISTS ix_sh_fact_orders_date   ON shopify_domain.fact_orders (transaction_date);
CREATE INDEX IF NOT EXISTS ix_sh_fact_orders_finstatus ON shopify_domain.fact_orders (financial_status);

CREATE TABLE IF NOT EXISTS shopify_domain.fact_order_lines (
  order_line_sk    BIGSERIAL PRIMARY KEY,
  company_id       INTEGER NOT NULL,
  order_id         VARCHAR(64) NOT NULL,
  line_item_id     VARCHAR(64) NOT NULL,
  product_id       VARCHAR(64),
  variant_id       VARCHAR(64),
  title            TEXT,
  sku              VARCHAR(128),
  quantity         BIGINT DEFAULT 0,
  price            NUMERIC(18,2) DEFAULT 0,
  total_discount   NUMERIC(18,2) DEFAULT 0,
  line_total       NUMERIC(18,2) DEFAULT 0,
  currency         VARCHAR(8) DEFAULT 'USD',
  transaction_date TIMESTAMPTZ,
  UNIQUE (company_id, line_item_id)
);
CREATE INDEX IF NOT EXISTS ix_sh_fact_order_lines_order   ON shopify_domain.fact_order_lines (order_id);
CREATE INDEX IF NOT EXISTS ix_sh_fact_order_lines_product ON shopify_domain.fact_order_lines (product_id);

-- new shopify_domain tables (added with collection/draft order/price rule entities)
CREATE TABLE IF NOT EXISTS shopify_domain.dim_collections (
  collection_sk   BIGSERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL,
  collection_id   VARCHAR(64) NOT NULL,
  title           TEXT,
  handle          TEXT,
  collection_type VARCHAR(16),
  products_count  BIGINT DEFAULT 0,
  is_published    BOOLEAN DEFAULT TRUE,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, collection_id)
);

CREATE TABLE IF NOT EXISTS shopify_domain.fact_draft_orders (
  draft_order_sk  BIGSERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL,
  draft_order_id  VARCHAR(64) NOT NULL,
  order_number    VARCHAR(64),
  customer_id     VARCHAR(64),
  customer_email  TEXT,
  total_amount    NUMERIC(18,2) DEFAULT 0,
  currency        VARCHAR(8) DEFAULT 'USD',
  status          VARCHAR(16),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, draft_order_id)
);

CREATE TABLE IF NOT EXISTS shopify_domain.dim_price_rules (
  price_rule_sk   BIGSERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL,
  price_rule_id   VARCHAR(64) NOT NULL,
  title           TEXT,
  value_type      VARCHAR(32),
  value           NUMERIC(18,2) DEFAULT 0,
  target_type     VARCHAR(32),
  starts_at       TIMESTAMPTZ,
  ends_at         TIMESTAMPTZ,
  usage_limit     BIGINT,
  is_active       BOOLEAN DEFAULT TRUE,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, price_rule_id)
);

-- new zohobooks_domain tables
CREATE TABLE IF NOT EXISTS zohobooks_domain.fact_vendor_payments (
  vendor_payment_sk BIGSERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL,
  payment_id        VARCHAR(64) NOT NULL,
  vendor_id         VARCHAR(64),
  vendor_name       TEXT,
  transaction_date  DATE,
  amount            NUMERIC(18,2) DEFAULT 0,
  payment_method    VARCHAR(64),
  currency          VARCHAR(8) DEFAULT 'INR',
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, payment_id)
);

CREATE TABLE IF NOT EXISTS zohobooks_domain.fact_sales_orders (
  sales_order_sk    BIGSERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL,
  salesorder_id     VARCHAR(64) NOT NULL,
  salesorder_number VARCHAR(64),
  customer_id       VARCHAR(64),
  customer_name     TEXT,
  transaction_date  DATE,
  shipment_date     DATE,
  amount            NUMERIC(18,2) DEFAULT 0,
  status            VARCHAR(16),
  currency          VARCHAR(8) DEFAULT 'INR',
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, salesorder_id)
);

CREATE TABLE IF NOT EXISTS zohobooks_domain.fact_purchase_orders (
  purchase_order_sk      BIGSERIAL PRIMARY KEY,
  company_id             INTEGER NOT NULL,
  purchaseorder_id       VARCHAR(64) NOT NULL,
  purchaseorder_number   VARCHAR(64),
  vendor_id              VARCHAR(64),
  vendor_name            TEXT,
  transaction_date       DATE,
  expected_delivery_date DATE,
  amount                 NUMERIC(18,2) DEFAULT 0,
  status                 VARCHAR(16),
  currency               VARCHAR(8) DEFAULT 'INR',
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, purchaseorder_id)
);

CREATE TABLE IF NOT EXISTS zohobooks_domain.fact_expenses (
  expense_sk    BIGSERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL,
  expense_id    VARCHAR(64) NOT NULL,
  expense_date  DATE,
  vendor_id     VARCHAR(64),
  vendor_name   TEXT,
  account_name  TEXT,
  amount        NUMERIC(18,2) DEFAULT 0,
  currency      VARCHAR(8) DEFAULT 'INR',
  is_billable   BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, expense_id)
);

CREATE TABLE IF NOT EXISTS zohobooks_domain.fact_credit_notes (
  credit_note_sk    BIGSERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL,
  creditnote_id     VARCHAR(64) NOT NULL,
  creditnote_number VARCHAR(64),
  customer_id       VARCHAR(64),
  customer_name     TEXT,
  transaction_date  DATE,
  amount            NUMERIC(18,2) DEFAULT 0,
  balance           NUMERIC(18,2) DEFAULT 0,
  status            VARCHAR(16),
  currency          VARCHAR(8) DEFAULT 'INR',
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, creditnote_id)
);

CREATE TABLE IF NOT EXISTS zohobooks_domain.fact_estimates (
  estimate_sk     BIGSERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL,
  estimate_id     VARCHAR(64) NOT NULL,
  estimate_number VARCHAR(64),
  customer_id     VARCHAR(64),
  customer_name   TEXT,
  transaction_date DATE,
  expiry_date      DATE,
  amount           NUMERIC(18,2) DEFAULT 0,
  status           VARCHAR(16),
  currency         VARCHAR(8) DEFAULT 'INR',
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, estimate_id)
);

-- new shopify_domain tables (Location, Collect, AbandonedCheckout, TenderTransaction, GiftCard)

CREATE TABLE IF NOT EXISTS shopify_domain.dim_locations (
  location_sk  BIGSERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL,
  location_id  VARCHAR(64) NOT NULL,
  name         TEXT,
  address1     TEXT,
  city         VARCHAR(128),
  province     VARCHAR(64),
  country      VARCHAR(64),
  zip          VARCHAR(32),
  phone        VARCHAR(32),
  is_active    BOOLEAN DEFAULT TRUE,
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, location_id)
);

CREATE TABLE IF NOT EXISTS shopify_domain.fact_collects (
  collect_sk    BIGSERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL,
  collect_id    VARCHAR(64) NOT NULL,
  collection_id VARCHAR(64),
  product_id    VARCHAR(64),
  position      BIGINT DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, collect_id)
);

CREATE TABLE IF NOT EXISTS shopify_domain.fact_abandoned_checkouts (
  checkout_sk    BIGSERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL,
  checkout_id    VARCHAR(128) NOT NULL,
  cart_token     VARCHAR(128),
  customer_email VARCHAR(256),
  total_price    NUMERIC(18,2) DEFAULT 0,
  currency       VARCHAR(8) DEFAULT 'USD',
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, checkout_id)
);

CREATE TABLE IF NOT EXISTS shopify_domain.fact_tender_transactions (
  tender_sk      BIGSERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL,
  tender_id      VARCHAR(64) NOT NULL,
  order_id       VARCHAR(64),
  amount         NUMERIC(18,2) DEFAULT 0,
  currency       VARCHAR(8) DEFAULT 'USD',
  payment_method TEXT,
  processed_at   DATE,
  UNIQUE (company_id, tender_id)
);

CREATE TABLE IF NOT EXISTS shopify_domain.dim_gift_cards (
  gift_card_sk  BIGSERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL,
  gift_card_id  VARCHAR(64) NOT NULL,
  initial_value NUMERIC(18,2) DEFAULT 0,
  balance       NUMERIC(18,2) DEFAULT 0,
  currency      VARCHAR(8) DEFAULT 'USD',
  status        VARCHAR(16),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  expires_on    DATE,
  UNIQUE (company_id, gift_card_id)
);

-- new zohobooks_domain tables (ChartOfAccount, JournalEntry, Tax, RecurringInvoice,
--   BankAccount, BankTransaction, Project, PriceList, RetainerInvoice)

CREATE TABLE IF NOT EXISTS zohobooks_domain.dim_chart_of_accounts (
  account_sk   BIGSERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL,
  account_id   VARCHAR(64) NOT NULL,
  account_name TEXT,
  account_type TEXT,
  account_code VARCHAR(64),
  is_active    BOOLEAN DEFAULT TRUE,
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, account_id)
);

CREATE TABLE IF NOT EXISTS zohobooks_domain.fact_journal_entries (
  journal_sk       BIGSERIAL PRIMARY KEY,
  company_id       INTEGER NOT NULL,
  journal_id       VARCHAR(64) NOT NULL,
  journal_date     DATE,
  reference_number VARCHAR(64),
  notes            TEXT,
  total            NUMERIC(18,2) DEFAULT 0,
  currency         VARCHAR(8) DEFAULT 'INR',
  status           VARCHAR(16),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, journal_id)
);

CREATE TABLE IF NOT EXISTS zohobooks_domain.dim_taxes (
  tax_sk         BIGSERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL,
  tax_id         VARCHAR(64) NOT NULL,
  tax_name       TEXT,
  tax_type       TEXT,
  tax_percentage NUMERIC(8,4) DEFAULT 0,
  is_active      BOOLEAN DEFAULT TRUE,
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, tax_id)
);

CREATE TABLE IF NOT EXISTS zohobooks_domain.fact_recurring_invoices (
  recur_sk             BIGSERIAL PRIMARY KEY,
  company_id           INTEGER NOT NULL,
  recurrence_id        VARCHAR(64) NOT NULL,
  customer_id          VARCHAR(64),
  customer_name        TEXT,
  amount               NUMERIC(18,2) DEFAULT 0,
  recurrence_frequency TEXT,
  status               VARCHAR(16),
  currency             VARCHAR(8) DEFAULT 'INR',
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, recurrence_id)
);

CREATE TABLE IF NOT EXISTS zohobooks_domain.dim_bank_accounts (
  bank_account_sk BIGSERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL,
  account_id      VARCHAR(64) NOT NULL,
  account_name    TEXT,
  account_type    TEXT,
  bank_name       TEXT,
  currency_code   VARCHAR(8) DEFAULT 'INR',
  current_balance NUMERIC(18,2) DEFAULT 0,
  is_active       BOOLEAN DEFAULT TRUE,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, account_id)
);

CREATE TABLE IF NOT EXISTS zohobooks_domain.fact_bank_transactions (
  bank_txn_sk      BIGSERIAL PRIMARY KEY,
  company_id       INTEGER NOT NULL,
  transaction_id   VARCHAR(64) NOT NULL,
  account_id       VARCHAR(64),
  transaction_date DATE,
  amount           NUMERIC(18,2) DEFAULT 0,
  transaction_type TEXT,
  description      TEXT,
  currency         VARCHAR(8) DEFAULT 'INR',
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, transaction_id)
);

CREATE TABLE IF NOT EXISTS zohobooks_domain.dim_projects (
  project_sk    BIGSERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL,
  project_id    VARCHAR(64) NOT NULL,
  project_name  TEXT,
  customer_id   VARCHAR(64),
  customer_name TEXT,
  status        VARCHAR(16),
  billing_type  TEXT,
  rate          NUMERIC(18,2) DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, project_id)
);

CREATE TABLE IF NOT EXISTS zohobooks_domain.dim_price_lists (
  pricelist_sk   BIGSERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL,
  pricelist_id   VARCHAR(64) NOT NULL,
  name           TEXT,
  pricebook_type TEXT,
  discount       NUMERIC(8,4) DEFAULT 0,
  currency_code  VARCHAR(8) DEFAULT 'INR',
  is_active      BOOLEAN DEFAULT TRUE,
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, pricelist_id)
);

CREATE TABLE IF NOT EXISTS zohobooks_domain.fact_retainer_invoices (
  retainer_sk         BIGSERIAL PRIMARY KEY,
  company_id          INTEGER NOT NULL,
  retainerinvoice_id  VARCHAR(64) NOT NULL,
  customer_id         VARCHAR(64),
  customer_name       TEXT,
  date                DATE,
  amount              NUMERIC(18,2) DEFAULT 0,
  balance             NUMERIC(18,2) DEFAULT 0,
  status              VARCHAR(16),
  currency            VARCHAR(8) DEFAULT 'INR',
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, retainerinvoice_id)
);
