'use strict';
// scripts/add_name_is_custom.js
// Adds name_is_custom to qb_companies.
//   true  → user typed a company name at signup (keep it)
//   false → no name given (e.g. Gmail login) → use QB company name as fallback
//
// Usage: node scripts/add_name_is_custom.js

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
      `ALTER TABLE qb_companies ADD COLUMN IF NOT EXISTS name_is_custom BOOLEAN DEFAULT false;`,
      { type: QueryTypes.RAW }
    );
    console.log('✅  qb_companies.name_is_custom added');

    // Existing companies that already have a QB realm: treat their current name
    // as custom so QB connect won't overwrite it.
    await seq.query(
      `UPDATE qb_companies SET name_is_custom = true WHERE quickbooks_realm_id IS NOT NULL;`,
      { type: QueryTypes.UPDATE }
    );
    console.log('✅  Existing QB-connected companies marked name_is_custom = true');

    console.log('\n🎉  Done. Restart the API server.');
  } catch (err) {
    console.error('❌  Failed:', err.message);
    process.exit(1);
  } finally {
    await seq.close();
  }
})();
