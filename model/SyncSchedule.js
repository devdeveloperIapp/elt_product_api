'use strict';
const { DataTypes } = require('sequelize');
const { mainDB }    = require('../connection/dbConnection');

const SyncSchedule = mainDB.define('SyncSchedule', {
  id:                { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  company_id:        { type: DataTypes.INTEGER, allowNull: false },
  source_id:         { type: DataTypes.INTEGER, allowNull: false },
  source_type:       { type: DataTypes.STRING(50), defaultValue: 'quickbooks' },
  // How often to sync in minutes (e.g. 60 = every hour)
  frequency_minutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 360 },
  is_active:         { type: DataTypes.BOOLEAN, defaultValue: true },
  next_run_at:       { type: DataTypes.DATE, allowNull: true },
  last_run_at:       { type: DataTypes.DATE, allowNull: true },
  created_by:        { type: DataTypes.INTEGER, allowNull: true },
}, {
  tableName:  'sync_schedules',
  timestamps: true,
  createdAt:  'created_at',
  updatedAt:  'updated_at',
});

module.exports = SyncSchedule;
