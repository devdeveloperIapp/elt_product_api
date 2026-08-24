'use strict';
// scripts/seed_company_user_role.js
// Creates the default "Company User" role and assigns it the report-viewing
// permissions. Every new signup is auto-assigned this role.
//
// Default navigation this role unlocks:
//   Business Overview, Cash Flow, Balance Sheet, Revenue, P&L Report, Expenses
//
// Safe to run multiple times (idempotent).
// Usage: node scripts/seed_company_user_role.js

require('dotenv').config();
const { Sequelize, QueryTypes } = require('sequelize');

const seq = new Sequelize(
  process.env.POSTGRESQL_DATABASE,
  process.env.POSTGRESQL_USER,
  process.env.POSTGRESQL_PASSWORD,
  { host: process.env.POSTGRESQL_HOST, dialect: 'postgres', logging: false }
);

const ROLE_NAME = 'Company User';

// Permission codes the default role should have (match the report nav items)
const PERMISSION_CODES = [
  'view_dashboard',
  'view_reports',
  'view_business_overview',
  'view_cash_flow',
  'view_balance_sheet',
  'view_revenues',
  'view_pl_report',
  'view_expenses',
];

(async () => {
  try {
    await seq.authenticate();
    console.log('✅  Database connected');

    // 1. Create or find the role
    const [roleRow] = await seq.query(
      `INSERT INTO roles (name, description, is_system_role, "isSuperAdmin", created_at, updated_at)
       VALUES (:name, 'Default role auto-assigned to new company users', true, false, NOW(), NOW())
       ON CONFLICT (name) DO UPDATE SET updated_at = NOW()
       RETURNING id;`,
      { replacements: { name: ROLE_NAME }, type: QueryTypes.SELECT }
    );
    const roleId = roleRow.id;
    console.log(`✅  Role "${ROLE_NAME}" ready (id=${roleId})`);

    // 2. Resolve permission ids from codes
    const perms = await seq.query(
      `SELECT id, code FROM permissions WHERE code IN (:codes);`,
      { replacements: { codes: PERMISSION_CODES }, type: QueryTypes.SELECT }
    );
    console.log(`✅  Found ${perms.length}/${PERMISSION_CODES.length} permissions`);

    const missing = PERMISSION_CODES.filter(c => !perms.find(p => p.code === c));
    if (missing.length) console.warn(`⚠️   Missing permission codes (skipped): ${missing.join(', ')}`);

    // 3. Link each permission to the role (idempotent)
    for (const p of perms) {
      await seq.query(
        `INSERT INTO role_permissions (role_id, permission_id, created_at)
         SELECT :roleId, :permId, NOW()
         WHERE NOT EXISTS (
           SELECT 1 FROM role_permissions WHERE role_id = :roleId AND permission_id = :permId
         );`,
        { replacements: { roleId, permId: p.id }, type: QueryTypes.INSERT }
      );
    }
    console.log(`✅  Linked ${perms.length} permissions to "${ROLE_NAME}"`);

    console.log('\n🎉  Done. New signups will get this role automatically.');
  } catch (err) {
    console.error('❌  Seed failed:', err.message);
    process.exit(1);
  } finally {
    await seq.close();
  }
})();
