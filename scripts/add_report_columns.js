// scripts/add_report_columns.js
// One-time migration: adds nav_slug and is_active columns to the reports table.
// Safe to run multiple times — uses IF NOT EXISTS.
//
// Usage:
//   node scripts/add_report_columns.js

'use strict';

require('dotenv').config();
const { Sequelize, QueryTypes } = require('sequelize');

const seq = new Sequelize(
  process.env.POSTGRESQL_DATABASE,
  process.env.POSTGRESQL_USER,
  process.env.POSTGRESQL_PASSWORD,
  {
    host:    process.env.POSTGRESQL_HOST,
    dialect: 'postgres',
    logging: false,
  }
);

const migrations = [
  {
    name: 'nav_slug',
    sql:  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS nav_slug VARCHAR(100);`,
  },
  {
    name: 'is_active',
    sql:  `ALTER TABLE reports ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;`,
  },
  {
    // Fix sequence out-of-sync: happens when rows were inserted manually.
    // Sets the sequence to MAX(id) so the next INSERT gets id = MAX+1.
    name: 'fix reports id sequence',
    sql:  `SELECT setval(pg_get_serial_sequence('reports', 'id'), COALESCE((SELECT MAX(id) FROM reports), 0) + 1, false);`,
  },
];

(async () => {
  try {
    await seq.authenticate();
    console.log('✅  Database connected');

    for (const m of migrations) {
      await seq.query(m.sql, { type: QueryTypes.RAW });
      console.log(`✅  Column "${m.name}" — OK (added or already existed)`);
    }

    console.log('\n🎉  Migration complete. You can restart the API server now.');
  } catch (err) {
    console.error('❌  Migration failed:', err.message);
    process.exit(1);
  } finally {
    await seq.close();
  }
})();
