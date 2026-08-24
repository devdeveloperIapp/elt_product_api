'use strict';
const { DataTypes } = require('sequelize');
const { mainDB }    = require('../connection/dbConnection');

const SyncLog = mainDB.define('SyncLog', {
  id:                  { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  company_id:          { type: DataTypes.INTEGER, allowNull: false },
  source_id:           { type: DataTypes.INTEGER, allowNull: true },
  source_type:         { type: DataTypes.STRING(50), defaultValue: 'quickbooks' },
  // 'full' | 'incremental'
  sync_type:           { type: DataTypes.STRING(20), defaultValue: 'full' },
  // 'manual' | 'scheduled' | 'initial'
  triggered_by:        { type: DataTypes.STRING(20), defaultValue: 'manual' },
  // 'running' | 'completed' | 'failed'
  status:              { type: DataTypes.STRING(20), defaultValue: 'running' },
  started_at:          { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  completed_at:        { type: DataTypes.DATE, allowNull: true },
  duration_seconds:    { type: DataTypes.INTEGER, allowNull: true },
  total_records:       { type: DataTypes.INTEGER, defaultValue: 0 },
  records_inserted:    { type: DataTypes.INTEGER, defaultValue: 0 },
  records_updated:     { type: DataTypes.INTEGER, defaultValue: 0 },
  records_deactivated: { type: DataTypes.INTEGER, defaultValue: 0 },
  entities_summary:    { type: DataTypes.JSONB,   allowNull: true },
  error_message:       { type: DataTypes.TEXT,    allowNull: true },
}, {
  tableName:  'sync_logs',
  timestamps: true,
  createdAt:  'created_at',
  updatedAt:  false,
});

module.exports = SyncLog;
