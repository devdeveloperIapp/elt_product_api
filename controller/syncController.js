'use strict';
// controller/syncController.js
// Super-admin only — manage sync schedules and view sync logs.

const { Op }         = require('sequelize');
const SyncSchedule   = require('../model/SyncSchedule');
const SyncLog        = require('../model/SyncLog');
const Source         = require('../model/sourceModel');
const { Company }    = require('../model');

/* ══════════════════════════════════════════════════════════════════════════
   SYNC SCHEDULES
   ══════════════════════════════════════════════════════════════════════════ */

// GET /api/admin/sync/schedules
exports.listSchedules = async (req, res) => {
  try {
    const schedules = await SyncSchedule.findAll({
      order: [['created_at', 'DESC']],
    });

    // Enrich with company name + source name
    const enriched = await Promise.all(
      schedules.map(async (s) => {
        const [company, source] = await Promise.all([
          Company.findByPk(s.company_id, { attributes: ['id', 'name'] }),
          Source.findByPk(s.source_id,   { attributes: ['id', 'source_name', 'connector_name'] }),
        ]);
        return {
          ...s.toJSON(),
          company_name: company?.name || `Company #${s.company_id}`,
          source_name:  source?.source_name || source?.connector_name || `Source #${s.source_id}`,
        };
      })
    );

    return res.json({ success: true, data: enriched });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/admin/sync/schedules
// Body: { company_id, source_id, frequency_minutes, is_active? }
exports.createSchedule = async (req, res) => {
  try {
    const { company_id, source_id, frequency_minutes, is_active = true } = req.body;

    if (!company_id || !source_id || !frequency_minutes) {
      return res.status(400).json({ success: false, message: 'company_id, source_id, frequency_minutes are required' });
    }
    if (frequency_minutes < 15) {
      return res.status(400).json({ success: false, message: 'Minimum frequency is 15 minutes' });
    }

    // Prevent duplicate schedules for the same company + source
    const existing = await SyncSchedule.findOne({ where: { company_id, source_id } });
    if (existing) {
      return res.status(409).json({ success: false, message: 'A schedule already exists for this company/source. Edit it instead.' });
    }

    const next_run_at = new Date(Date.now() + frequency_minutes * 60 * 1000);

    const schedule = await SyncSchedule.create({
      company_id,
      source_id,
      source_type:       'quickbooks',
      frequency_minutes,
      is_active,
      next_run_at,
      created_by:        req.auth?.userId,
    });

    return res.status(201).json({ success: true, data: schedule, message: 'Schedule created.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/admin/sync/schedules/:id
// Body: { frequency_minutes?, is_active? }
exports.updateSchedule = async (req, res) => {
  try {
    const schedule = await SyncSchedule.findByPk(req.params.id);
    if (!schedule) return res.status(404).json({ success: false, message: 'Schedule not found' });

    const { frequency_minutes, is_active } = req.body;

    if (frequency_minutes !== undefined && frequency_minutes < 15) {
      return res.status(400).json({ success: false, message: 'Minimum frequency is 15 minutes' });
    }

    const updates = {};
    if (frequency_minutes !== undefined) {
      updates.frequency_minutes = frequency_minutes;
      // Recalculate next_run_at from now
      updates.next_run_at = new Date(Date.now() + frequency_minutes * 60 * 1000);
    }
    if (is_active !== undefined) {
      updates.is_active = is_active;
      // If re-activating, reset next_run_at
      if (is_active && !schedule.is_active) {
        updates.next_run_at = new Date(Date.now() + (frequency_minutes || schedule.frequency_minutes) * 60 * 1000);
      }
    }

    await schedule.update(updates);
    return res.json({ success: true, data: schedule, message: 'Schedule updated.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/admin/sync/schedules/:id
exports.deleteSchedule = async (req, res) => {
  try {
    const schedule = await SyncSchedule.findByPk(req.params.id);
    if (!schedule) return res.status(404).json({ success: false, message: 'Schedule not found' });
    await schedule.destroy();
    return res.json({ success: true, message: 'Schedule deleted.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/admin/sync/schedules/:id/run  — manually trigger right now
exports.runScheduleNow = async (req, res) => {
  try {
    const schedule = await SyncSchedule.findByPk(req.params.id);
    if (!schedule) return res.status(404).json({ success: false, message: 'Schedule not found' });

    // Fire-and-forget: run in background
    const { runScheduledSync } = require('../services/syncSchedulerService');
    runScheduledSync(schedule).catch(err =>
      console.error('[SYNC SCHEDULER] Manual trigger failed:', err.message)
    );

    return res.json({ success: true, message: 'Sync triggered in background.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   SYNC LOGS
   ══════════════════════════════════════════════════════════════════════════ */

// GET /api/admin/sync/logs?company_id=&status=&limit=&page=
exports.listLogs = async (req, res) => {
  try {
    const { company_id, status, limit = 50, page = 1 } = req.query;
    const where = {};
    if (company_id) where.company_id = company_id;
    if (status)     where.status     = status;

    const offset = (Number(page) - 1) * Number(limit);

    const { count, rows } = await SyncLog.findAndCountAll({
      where,
      order:  [['started_at', 'DESC']],
      limit:  Number(limit),
      offset,
    });

    // Enrich with company name
    const enriched = await Promise.all(
      rows.map(async (log) => {
        const company = await Company.findByPk(log.company_id, { attributes: ['name'] });
        return { ...log.toJSON(), company_name: company?.name || `Company #${log.company_id}` };
      })
    );

    return res.json({
      success: true,
      data: { logs: enriched, total: count, page: Number(page), limit: Number(limit) },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
