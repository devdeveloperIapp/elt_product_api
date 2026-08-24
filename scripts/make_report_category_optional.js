'use strict';
// scripts/make_report_category_optional.js
// Makes reports.category_id nullable so reports can be created for companies
// that have no categories (the nav_slug flow doesn't need categories).
//
// Usage: node scripts/make_report_category_optional.js

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
    await seq.query(`ALTER TABLE reports ALTER COLUMN category_id DROP NOT NULL;`, { type: QueryTypes.RAW });
    console.log('✅  reports.category_id is now nullable');
    console.log('\n🎉  Done. Restart the API server.');
  } catch (err) {
    console.error('❌  Failed:', err.message);
    process.exit(1);
  } finally {
    await seq.close();
  }
})();
