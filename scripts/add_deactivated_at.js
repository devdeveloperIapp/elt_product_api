// scripts/add_deactivated_at.js
// Adds deactivated_at column to quickbooks_data table.
// Safe to run multiple times — uses IF NOT EXISTS.
//
// Usage:
//   node scripts/add_deactivated_at.js

'use strict';

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
    name: 'deactivated_at column',
    sql: `ALTER TABLE quickbooks_data
            ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMP DEFAULT NULL;`,
  },
  {
    name: 'index on is_active + deactivated_at (speeds up cleanup query)',
    sql: `CREATE INDEX IF NOT EXISTS idx_qbdata_cleanup
            ON quickbooks_data (is_active, deactivated_at)
            WHERE is_active = false;`,
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

    console.log('\n🎉  Migration complete. Restart the API server now.');
  } catch (err) {
    console.error('❌  Migration failed:', err.message);
    process.exit(1);
  } finally {
    await seq.close();
  }
})();
