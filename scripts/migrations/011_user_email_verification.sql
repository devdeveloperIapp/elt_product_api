-- 011_user_email_verification.sql
-- Signup e-mail (OTP) verification.
--   email_otp             - 6-digit code sent on signup / forget-password
--   email_otp_expires_at  - code expiry (10 minutes)
--   is_email_verified     - login is blocked while this is false
--
-- Safe to run more than once. Existing accounts are back-filled to verified
-- so nobody already using the product gets locked out.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_otp VARCHAR(10) DEFAULT NULL;

-- Older databases already had email_otp as INTEGER (forget-password flow).
-- The model treats the code as a string, so line the column up with it.
-- int -> varchar is lossless, and the values are throwaway OTPs anyway.
ALTER TABLE users
  ALTER COLUMN email_otp TYPE VARCHAR(10) USING email_otp::varchar;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_otp_expires_at TIMESTAMPTZ DEFAULT NULL;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_email_verified BOOLEAN NOT NULL DEFAULT false;

-- `email_otp IS NULL` keeps a signup that is still awaiting its code
-- unverified if this file is re-run later.
UPDATE users
   SET is_email_verified = true
 WHERE is_email_verified = false
   AND email_otp IS NULL;

COMMIT;
