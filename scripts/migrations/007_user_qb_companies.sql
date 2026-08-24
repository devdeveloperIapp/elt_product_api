-- 007_user_qb_companies.sql
-- Adds a join table so a user can manage multiple QuickBooks companies.
-- Idempotent: safe to run multiple times.

BEGIN;

CREATE TABLE IF NOT EXISTS user_qb_companies (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id)        ON DELETE CASCADE,
  company_id  INTEGER NOT NULL REFERENCES qb_companies(id) ON DELETE CASCADE,
  role        VARCHAR(16) NOT NULL DEFAULT 'owner'
              CHECK (role IN ('owner','admin','member','viewer')),
  is_default  BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT  user_qb_companies_unique UNIQUE (user_id, company_id)
);

CREATE INDEX IF NOT EXISTS ix_uqc_user_id    ON user_qb_companies (user_id);
CREATE INDEX IF NOT EXISTS ix_uqc_company_id ON user_qb_companies (company_id);

-- Repair: if the table was auto-created by Sequelize (no timestamp defaults),
-- backfill nulls and attach NOW() defaults so future inserts work.
UPDATE user_qb_companies SET created_at = NOW() WHERE created_at IS NULL;
UPDATE user_qb_companies SET updated_at = NOW() WHERE updated_at IS NULL;
ALTER TABLE user_qb_companies ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE user_qb_companies ALTER COLUMN updated_at SET DEFAULT NOW();

-- Backfill: every existing (user.id, user.company_id) pair becomes an 'owner'
-- link and is marked is_default=true so users keep accessing their current
-- company after deploy.
INSERT INTO user_qb_companies (user_id, company_id, role, is_default, created_at, updated_at)
SELECT  u.id, u.company_id, 'owner', TRUE, NOW(), NOW()
FROM    users u
WHERE   u.company_id IS NOT NULL
ON CONFLICT (user_id, company_id) DO NOTHING;

COMMIT;
