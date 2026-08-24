'use strict';
// scripts/add_qbc_name.js
// Adds qbc_name to qb_companies — stores the QuickBooks company name separately
// from `name` (which stays as the name the user typed at signup).
//
// Usage: node scripts/add_qbc_name.js

require('dotenv').config();
const { Sequelize, QueryTypes } = require('sequelize');

const seq = new Sequelize(
  process.env.POSTGRESQL_DATABASE,
  process.env.POSTGRESQL_USER,
  process.env.POSTGRESQL_PASSWORD,
  { host: process.env.POSTGRESQL_HOST, dialect: 'postgres', logging: false }
);

(async () => {
  try {
    await seq.authenticate();
    console.log('✅  Database connected');
    await seq.query(
      `ALTER TABLE qb_companies ADD COLUMN IF NOT EXISTS qbc_name VARCHAR(255) DEFAULT NULL;`,
      { type: QueryTypes.RAW }
    );
    console.log('✅  qb_companies.qbc_name added');
    console.log('\n🎉  Done. Restart the API server.');
  } catch (err) {
    console.error('❌  Failed:', err.message);
    process.exit(1);
  } finally {
    await seq.close();
  }
})();
