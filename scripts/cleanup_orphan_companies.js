'use strict';
// scripts/cleanup_orphan_companies.js
// Finds & (optionally) deletes orphan placeholder companies left over from the
// old signup flow — companies that:
//   • have NO quickbooks_realm_id (never connected QB)
//   • have NO user pointing to them (user.company_id)
//   • have NO reports
//
// These are the abandoned signup placeholders (e.g. "PABLO") created before the
// QB company existed. Safe to remove.
//
// Usage:
//   node scripts/cleanup_orphan_companies.js            ← DRY RUN (lists only)
//   node scripts/cleanup_orphan_companies.js --delete   ← actually deletes

require('dotenv').config();
const { Sequelize, QueryTypes } = require('sequelize');

const seq = new Sequelize(
  process.env.POSTGRESQL_DATABASE,
  process.env.POSTGRESQL_USER,
  process.env.POSTGRESQL_PASSWORD,
  { host: process.env.POSTGRESQL_HOST, dialect: 'postgres', logging: false }
);

const DO_DELETE = process.argv.includes('--delete');

(async () => {
  try {
    await seq.authenticate();
    console.log('✅  Database connected\n');

    // Orphan = no realm + no active user + no reports
    const orphans = await seq.query(`
      SELECT c.id, c.name, c.qbc_name
      FROM qb_companies c
      WHERE c.quickbooks_realm_id IS NULL
        AND c.id NOT IN (SELECT company_id FROM users      WHERE company_id IS NOT NULL)
        AND c.id NOT IN (SELECT company_id FROM reports    WHERE company_id IS NOT NULL)
      ORDER BY c.id
    `, { type: QueryTypes.SELECT });

    if (orphans.length === 0) {
      console.log('🎉  No orphan companies found. Nothing to clean.');
      return;
    }

    console.log(`Found ${orphans.length} orphan placeholder companies:`);
    orphans.forEach(o => console.log(`   id ${o.id} | "${o.name}"`));

    if (!DO_DELETE) {
      console.log('\n⚠️   DRY RUN — nothing deleted.');
      console.log('     Run again with  --delete  to remove these.');
      return;
    }

    // Delete: first remove any user_qb_companies links, then the companies
    const ids = orphans.map(o => o.id);
    await seq.query(`DELETE FROM user_qb_companies WHERE company_id IN (:ids)`,
      { replacements: { ids }, type: QueryTypes.DELETE });
    await seq.query(`DELETE FROM qb_companies WHERE id IN (:ids)`,
      { replacements: { ids }, type: QueryTypes.DELETE });

    console.log(`\n🗑️   Deleted ${ids.length} orphan companies (+ their user links).`);
  } catch (err) {
    console.error('❌  Failed:', err.message);
    process.exit(1);
  } finally {
    await seq.close();
  }
})();
