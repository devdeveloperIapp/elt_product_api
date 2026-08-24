-- =============================================================
-- 002_refresh_tokens.sql
-- Phase 1 — Auth core hardening.
-- Run once against database `elt_product`.
-- =============================================================

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id           BIGSERIAL PRIMARY KEY,
  user_id      INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   VARCHAR(64) NOT NULL UNIQUE,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  replaced_by  VARCHAR(64),
  user_agent   VARCHAR(512),
  ip           VARCHAR(64),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_refresh_tokens_user_id    ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS ix_refresh_tokens_expires_at ON refresh_tokens (expires_at);

-- A short reaper to keep the table small. Run as a daily cron job.
-- DELETE FROM refresh_tokens WHERE expires_at < NOW() - INTERVAL '7 days';
