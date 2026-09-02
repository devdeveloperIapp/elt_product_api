// scripts/add_user_email_verification.js
// One-time migration: adds the signup e-mail verification columns to `users`.
//   email_otp             — 6-digit code sent on signup / forget-password
//   email_otp_expires_at  — code expiry (10 minutes)
//   is_email_verified     — login is blocked while this is false
//
// Existing accounts are back-filled to verified so nobody gets locked out.
// Safe to run multiple times — uses IF NOT EXISTS.
//
// Usage:
//   node scripts/add_user_email_verification.js

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
    name: 'email_otp',
    sql: `ALTER TABLE users
            ADD COLUMN IF NOT EXISTS email_otp VARCHAR(10) DEFAULT NULL;`,
  },
  {
    // Older databases already had email_otp as INTEGER (forget-password flow).
    // The model treats the code as a string, so line the column up with it —
    // int -> varchar is lossless, and the values are throwaway OTPs anyway.
    name: 'email_otp -> VARCHAR(10)',
    sql: `ALTER TABLE users
            ALTER COLUMN email_otp TYPE VARCHAR(10) USING email_otp::varchar;`,
  },
  {
    name: 'email_otp_expires_at',
    sql: `ALTER TABLE users
            ADD COLUMN IF NOT EXISTS email_otp_expires_at TIMESTAMPTZ DEFAULT NULL;`,
  },
  {
    name: 'is_email_verified',
    sql: `ALTER TABLE users
            ADD COLUMN IF NOT EXISTS is_email_verified BOOLEAN NOT NULL DEFAULT false;`,
  },
  {
    // `email_otp IS NULL` keeps a signup that is still awaiting its code
    // unverified if this script is re-run later.
    name: 'back-fill existing users as verified',
    sql: `UPDATE users
             SET is_email_verified = true
           WHERE is_email_verified = false
             AND email_otp IS NULL;`,
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
