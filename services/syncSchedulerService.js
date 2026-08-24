'use strict';
// services/syncSchedulerService.js
// Runs QB syncs on schedule. Checks every minute for due schedules.

const cron          = require('node-cron');
const { Op }        = require('sequelize');
const SyncSchedule  = require('../model/SyncSchedule');
const Source        = require('../model/sourceModel');
const { refreshSourceQuickBooksToken } = require('../utils/tokenHelper');

// ── Run one scheduled sync ───────────────────────────────────────────────────
const runScheduledSync = async (schedule) => {
  const { id, company_id, source_id, frequency_minutes } = schedule;

  // Find the source to get access_token + realmId
  const source = await Source.findByPk(source_id);
  if (!source) {
    console.error(`[SCHEDULER] Source #${source_id} not found for schedule #${id}`);
    return;
  }

  let settings = source.connector_settings_json;

  // Refresh token if expired
  const TOKEN_BUFFER_MS = 60 * 1000;
  if (!settings?.expires_at || settings.expires_at < (Date.now() + TOKEN_BUFFER_MS)) {
    console.log(`[SCHEDULER] Refreshing token for schedule #${id}...`);
    const refreshed = await refreshSourceQuickBooksToken(source);
    if (!refreshed) {
      console.error(`[SCHEDULER] Token refresh failed for schedule #${id} — skipping`);
      await SyncSchedule.update(
        { next_run_at: new Date(Date.now() + frequency_minutes * 60 * 1000) },
        { where: { id } }
      );
      return;
    }
    settings = refreshed;
  }

  const { access_token, realmId, companyId: settingsCompanyId } = settings;
  const effectiveCompanyId = settingsCompanyId || company_id;

  console.log(`[SCHEDULER] Starting sync for company #${effectiveCompanyId} (schedule #${id})`);

  try {
    // triggerQuickBooksSync writes its OWN sync log (triggered_by='scheduled') —
    // no separate log here to avoid duplicate rows.
    const { triggerQuickBooksSyncForScheduler } = require('../controller/QuickBookLogingController');
    await triggerQuickBooksSyncForScheduler(effectiveCompanyId, source_id, access_token, realmId);
    console.log(`[SCHEDULER] Sync for company #${effectiveCompanyId} done`);
  } catch (err) {
    console.error(`[SCHEDULER] Sync for company #${effectiveCompanyId} failed:`, err.message);
  }

  // Update next_run_at for this schedule
  await SyncSchedule.update(
    {
      last_run_at: new Date(),
      next_run_at: new Date(Date.now() + frequency_minutes * 60 * 1000),
    },
    { where: { id } }
  );
};

// ── Cron: check every 2 minutes for due schedules ───────────────────────────
// IMPORTANT: the cron tick must stay FAST. We do NOT await the heavy sync inside
// the tick — otherwise a long-running sync blocks the event loop and node-cron
// logs "missed execution" warnings. Instead we:
//   1. bump next_run_at immediately (so the next tick won't re-pick the same one)
//   2. fire runScheduledSync in the background (fire-and-forget)
const startSyncScheduler = () => {
  cron.schedule('*/2 * * * *', async () => {
    try {
      const due = await SyncSchedule.findAll({
        where: {
          is_active:   true,
          next_run_at: { [Op.lte]: new Date() },
        },
      });

      if (due.length === 0) return;

      console.log(`[SCHEDULER] ${due.length} schedule(s) due — dispatching...`);

      for (const schedule of due) {
        // 1. Bump next_run_at NOW so the next tick won't run it again while it's in progress
        await SyncSchedule.update(
          { next_run_at: new Date(Date.now() + schedule.frequency_minutes * 60 * 1000) },
          { where: { id: schedule.id } }
        );

        // 2. Fire-and-forget — do NOT await; keeps the cron tick fast
        runScheduledSync(schedule).catch(err =>
          console.error(`[SCHEDULER] schedule #${schedule.id} failed:`, err.message)
        );
      }
    } catch (err) {
      console.error('[SCHEDULER] Cron check failed:', err.message);
    }
  });

  console.log('✅  Sync scheduler started (checks every 2 minutes)');
};

module.exports = { startSyncScheduler, runScheduledSync };
