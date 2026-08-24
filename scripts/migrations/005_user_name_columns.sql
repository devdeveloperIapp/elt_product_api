-- 005_user_name_columns.sql
-- Adds first_name, last_name, display_name to the users table.
-- Idempotent — safe to re-run.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS first_name   VARCHAR(100),
  ADD COLUMN IF NOT EXISTS last_name    VARCHAR(100),
  ADD COLUMN IF NOT EXISTS display_name VARCHAR(200);
