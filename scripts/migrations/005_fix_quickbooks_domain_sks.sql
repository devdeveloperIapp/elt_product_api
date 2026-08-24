-- 005_fix_quickbooks_domain_sks.sql
-- Repairs quickbooks_domain.* tables that were created without their
-- surrogate-key (*_sk) PRIMARY KEY column. Safe to run multiple times.

DO $$
BEGIN
  -- dim_accounts.account_sk
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'quickbooks_domain'
      AND table_name   = 'dim_accounts'
      AND column_name  = 'account_sk'
  ) THEN
    ALTER TABLE quickbooks_domain.dim_accounts
      DROP CONSTRAINT IF EXISTS dim_accounts_pkey;
    ALTER TABLE quickbooks_domain.dim_accounts
      ADD COLUMN account_sk BIGSERIAL PRIMARY KEY;
  END IF;

  -- dim_customers.customer_sk
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'quickbooks_domain'
      AND table_name   = 'dim_customers'
      AND column_name  = 'customer_sk'
  ) THEN
    ALTER TABLE quickbooks_domain.dim_customers
      DROP CONSTRAINT IF EXISTS dim_customers_pkey;
    ALTER TABLE quickbooks_domain.dim_customers
      ADD COLUMN customer_sk BIGSERIAL PRIMARY KEY;
  END IF;

  -- dim_vendors.vendor_sk
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'quickbooks_domain'
      AND table_name   = 'dim_vendors'
      AND column_name  = 'vendor_sk'
  ) THEN
    ALTER TABLE quickbooks_domain.dim_vendors
      DROP CONSTRAINT IF EXISTS dim_vendors_pkey;
    ALTER TABLE quickbooks_domain.dim_vendors
      ADD COLUMN vendor_sk BIGSERIAL PRIMARY KEY;
  END IF;

  -- fact_invoices.invoice_sk
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'quickbooks_domain'
      AND table_name   = 'fact_invoices'
      AND column_name  = 'invoice_sk'
  ) THEN
    ALTER TABLE quickbooks_domain.fact_invoices
      DROP CONSTRAINT IF EXISTS fact_invoices_pkey;
    ALTER TABLE quickbooks_domain.fact_invoices
      ADD COLUMN invoice_sk BIGSERIAL PRIMARY KEY;
  END IF;

  -- fact_bills.bill_sk
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'quickbooks_domain'
      AND table_name   = 'fact_bills'
      AND column_name  = 'bill_sk'
  ) THEN
    ALTER TABLE quickbooks_domain.fact_bills
      DROP CONSTRAINT IF EXISTS fact_bills_pkey;
    ALTER TABLE quickbooks_domain.fact_bills
      ADD COLUMN bill_sk BIGSERIAL PRIMARY KEY;
  END IF;

  -- fact_payments.payment_sk
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'quickbooks_domain'
      AND table_name   = 'fact_payments'
      AND column_name  = 'payment_sk'
  ) THEN
    ALTER TABLE quickbooks_domain.fact_payments
      DROP CONSTRAINT IF EXISTS fact_payments_pkey;
    ALTER TABLE quickbooks_domain.fact_payments
      ADD COLUMN payment_sk BIGSERIAL PRIMARY KEY;
  END IF;

  -- fact_transactions.transaction_sk
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'quickbooks_domain'
      AND table_name   = 'fact_transactions'
      AND column_name  = 'transaction_sk'
  ) THEN
    ALTER TABLE quickbooks_domain.fact_transactions
      DROP CONSTRAINT IF EXISTS fact_transactions_pkey;
    ALTER TABLE quickbooks_domain.fact_transactions
      ADD COLUMN transaction_sk BIGSERIAL PRIMARY KEY;
  END IF;
END$$;
