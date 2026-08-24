// models/ConnectionSyncRun.js
const { DataTypes } = require('sequelize');
const {mainDB} = require('../connection/dbConnection'); // Adjust path

const ConnectionSyncRun = mainDB.define('ConnectionSyncRun', {
  sync_id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  connection_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'connections', // or 'connections' based on your table name
      key: 'connection_id'
    }
  },
  started_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  ended_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false
  },
  rows_processed: {
    type: DataTypes.BIGINT,
    defaultValue: 0
  },
  error_message: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  duration_seconds: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  company_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: 'companies', key: 'id' },
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'connection_sync_runs',
  timestamps: false,
  underscored: true
});

module.exports = ConnectionSyncRun;