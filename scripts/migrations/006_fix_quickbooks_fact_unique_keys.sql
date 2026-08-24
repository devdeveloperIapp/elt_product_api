-- 006_fix_quickbooks_fact_unique_keys.sql
-- The QuickBooks fact tables were originally bootstrapped with a legacy
-- 3-column unique index `(company_id, source_type, *_id)`. The current
-- transformer no longer carries `source_type`, so Sequelize emits
--   ON CONFLICT (company_id, *_id)
-- which Postgres rejects (42P10 - no unique constraint matching
-- the ON CONFLICT specification). This migration replaces the stale
-- indexes with the 2-column variants the transformer expects.
--
-- Idempotent; safe to run multiple times.

BEGIN;

-- fact_invoices ------------------------------------------------------------
DROP INDEX IF EXISTS quickbooks_domain.fact_invoices_company_id_source_type_invoice_id_idx;
ALTER TABLE quickbooks_domain.fact_invoices
  DROP CONSTRAINT IF EXISTS fact_invoices_company_id_invoice_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS fact_invoices_company_id_invoice_id_key
  ON quickbooks_domain.fact_invoices (company_id, invoice_id);

-- fact_bills ---------------------------------------------------------------
DROP INDEX IF EXISTS quickbooks_domain.fact_bills_company_id_source_type_bill_id_idx;
ALTER TABLE quickbooks_domain.fact_bills
  DROP CONSTRAINT IF EXISTS fact_bills_company_id_bill_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS fact_bills_company_id_bill_id_key
  ON quickbooks_domain.fact_bills (company_id, bill_id);

-- fact_payments ------------------------------------------------------------
DROP INDEX IF EXISTS quickbooks_domain.fact_payments_company_id_source_type_payment_id_idx;
ALTER TABLE quickbooks_domain.fact_payments
  DROP CONSTRAINT IF EXISTS fact_payments_company_id_payment_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS fact_payments_company_id_payment_id_key
  ON quickbooks_domain.fact_payments (company_id, payment_id);

-- fact_transactions --------------------------------------------------------
DROP INDEX IF EXISTS quickbooks_domain.fact_transactions_company_id_source_type_source_ref_id_idx;
ALTER TABLE quickbooks_domain.fact_transactions
  DROP CONSTRAINT IF EXISTS fact_transactions_company_id_source_ref_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS fact_transactions_company_id_source_ref_id_key
  ON quickbooks_domain.fact_transactions (company_id, source_ref_id);

COMMIT;
