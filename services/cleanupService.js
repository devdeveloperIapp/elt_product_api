'use strict';
// services/cleanupService.js
// Scheduled cleanup — hard-deletes QB records that have been soft-deleted
// for more than 30 days (i.e., deactivated_at < NOW() - 30 days).
//
// Schedule: every Sunday at 03:00 AM server time.
// Can also be triggered manually via cleanupOldInactiveRecords().

const cron        = require('node-cron');
const { Op }      = require('sequelize');
const QuickBooksData = require('../model/QuickBooksData');

const RETENTION_DAYS = 30; // how long to keep soft-deleted records before hard-deleting

// ── Core cleanup function ────────────────────────────────────────────────────
const cleanupOldInactiveRecords = async () => {
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

    const deleted = await QuickBooksData.destroy({
      where: {
        is_active:      false,
        deactivated_at: { [Op.lt]: cutoff },
      },
    });

    const msg = `[CLEANUP] Hard-deleted ${deleted} QB records inactive for > ${RETENTION_DAYS} days`;
    console.log(msg);
    return { deleted, cutoff };

  } catch (err) {
    console.error('[CLEANUP] Failed:', err.message);
    return { deleted: 0, error: err.message };
  }
};

// ── Schedule: every Sunday at 03:00 AM ──────────────────────────────────────
// Cron syntax: second(opt) minute hour day-of-month month day-of-week
//   '0 3 * * 0' = minute=0, hour=3, every day-of-month, every month, Sunday(0)
const startCleanupScheduler = () => {
  cron.schedule('0 3 * * 0', async () => {
    console.log('[CLEANUP] Weekly cleanup job started (Sunday 03:00 AM)');
    await cleanupOldInactiveRecords();
  });

  console.log('✅  QB cleanup scheduler registered (Sundays 03:00 AM)');
};

module.exports = { startCleanupScheduler, cleanupOldInactiveRecords };
