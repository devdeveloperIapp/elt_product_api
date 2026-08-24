// scripts/add_user_default_dashboard.js
// One-time migration: adds default_dashboard_slug column to the users table.
// Safe to run multiple times — uses IF NOT EXISTS.
//
// Usage:
//   node scripts/add_user_default_dashboard.js

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
    name: 'default_dashboard_slug',
    sql: `ALTER TABLE users
            ADD COLUMN IF NOT EXISTS default_dashboard_slug VARCHAR(100) DEFAULT NULL;`,
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

    console.log('\n🎉  Migration complete. Restart the API server now.');
  } catch (err) {
    console.error('❌  Migration failed:', err.message);
    process.exit(1);
  } finally {
    await seq.close();
  }
})();
