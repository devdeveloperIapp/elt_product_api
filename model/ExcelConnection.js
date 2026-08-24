// model/ExcelConnection.js
// Stores metadata for uploaded Excel files.
// One row per upload — a company can upload multiple files over time.

const { DataTypes } = require('sequelize');
const { mainDB } = require('../connection/dbConnection');

const ExcelConnection = mainDB.define('ExcelConnection', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  company_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  original_filename: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
  file_size_bytes: {
    type: DataTypes.INTEGER,
  },
  sheet_count: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  total_rows: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  sync_status: {
    type: DataTypes.ENUM('pending', 'in_progress', 'completed', 'failed'),
    defaultValue: 'pending',
  },
  error_message: {
    type: DataTypes.TEXT,
  },
  last_sync_at: {
    type: DataTypes.DATE,
  },
}, {
  tableName: 'excel_connections',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = ExcelConnection;
