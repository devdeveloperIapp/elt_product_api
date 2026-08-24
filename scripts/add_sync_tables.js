'use strict';
// scripts/add_sync_tables.js
// Creates sync_logs and sync_schedules tables.
// Usage: node scripts/add_sync_tables.js

require('dotenv').config();
const { Sequelize, QueryTypes } = require('sequelize');

const seq = new Sequelize(
  process.env.POSTGRESQL_DATABASE,
  process.env.POSTGRESQL_USER,
  process.env.POSTGRESQL_PASSWORD,
  { host: process.env.POSTGRESQL_HOST, dialect: 'postgres', logging: false }
);

const migrations = [
  {
    name: 'sync_logs table',
    sql: `
      CREATE TABLE IF NOT EXISTS sync_logs (
        id                  SERIAL PRIMARY KEY,
        company_id          INTEGER,
        source_id           INTEGER,
        source_type         VARCHAR(50)  NOT NULL DEFAULT 'quickbooks',
        sync_type           VARCHAR(20)  NOT NULL DEFAULT 'full',
        triggered_by        VARCHAR(20)  NOT NULL DEFAULT 'manual',
        status              VARCHAR(20)  NOT NULL DEFAULT 'running',
        started_at          TIMESTAMP    NOT NULL DEFAULT NOW(),
        completed_at        TIMESTAMP,
        duration_seconds    INTEGER,
        total_records       INTEGER      DEFAULT 0,
        records_inserted    INTEGER      DEFAULT 0,
        records_updated     INTEGER      DEFAULT 0,
        records_deactivated INTEGER      DEFAULT 0,
        entities_summary    JSONB,
        error_message       TEXT,
        created_at          TIMESTAMP    DEFAULT NOW()
      );
    `,
  },
  {
    name: 'sync_logs indexes',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_sync_logs_company  ON sync_logs(company_id);
      CREATE INDEX IF NOT EXISTS idx_sync_logs_status   ON sync_logs(status);
      CREATE INDEX IF NOT EXISTS idx_sync_logs_started  ON sync_logs(started_at DESC);
    `,
  },
  {
    name: 'sync_schedules table',
    sql: `
      CREATE TABLE IF NOT EXISTS sync_schedules (
        id                  SERIAL PRIMARY KEY,
        company_id          INTEGER NOT NULL,
        source_id           INTEGER NOT NULL,
        source_type         VARCHAR(50) NOT NULL DEFAULT 'quickbooks',
        frequency_minutes   INTEGER NOT NULL DEFAULT 360,
        is_active           BOOLEAN NOT NULL DEFAULT true,
        next_run_at         TIMESTAMP,
        last_run_at         TIMESTAMP,
        created_by          INTEGER,
        created_at          TIMESTAMP DEFAULT NOW(),
        updated_at          TIMESTAMP DEFAULT NOW()
      );
    `,
  },
  {
    name: 'sync_schedules index',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_sync_schedules_next_run
        ON sync_schedules(next_run_at)
        WHERE is_active = true;
    `,
  },
];

(async () => {
  try {
    await seq.authenticate();
    console.log('✅  Database connected');
    for (const m of migrations) {
      await seq.query(m.sql, { type: QueryTypes.RAW });
      console.log(`✅  "${m.name}" — OK`);
    }
    console.log('\n🎉  Migration complete. Restart the API server.');
  } catch (err) {
    console.error('❌  Migration failed:', err.message);
    process.exit(1);
  } finally {
    await seq.close();
  }
})();
