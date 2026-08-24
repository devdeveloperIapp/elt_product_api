'use strict';
// scripts/add_user_nav_overrides.js
// Creates user_navigation_overrides — per-user "hide this nav item" exceptions.
// Default behavior: user sees everything their role grants.
// An entry here HIDES a specific nav item for a specific user.
//
// Usage: node scripts/add_user_nav_overrides.js

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
    name: 'user_navigation_overrides table',
    sql: `
      CREATE TABLE IF NOT EXISTS user_navigation_overrides (
        id                  SERIAL PRIMARY KEY,
        user_id             INTEGER NOT NULL,
        navigation_item_id  INTEGER NOT NULL,
        is_hidden           BOOLEAN NOT NULL DEFAULT true,
        created_at          TIMESTAMP DEFAULT NOW(),
        updated_at          TIMESTAMP DEFAULT NOW(),
        UNIQUE (user_id, navigation_item_id)
      );
    `,
  },
  {
    name: 'index on user_id',
    sql: `CREATE INDEX IF NOT EXISTS idx_user_nav_overrides_user ON user_navigation_overrides(user_id);`,
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
    console.log('\n🎉  Migration complete.');
  } catch (err) {
    console.error('❌  Migration failed:', err.message);
    process.exit(1);
  } finally {
    await seq.close();
  }
})();
