// model/ScheduledReport.js
const { DataTypes } = require('sequelize');
const {mainDB} = require('../connection/dbConnection');

const ScheduledReport = mainDB.define('ScheduledReport', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  company_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'companies',
      key: 'id'
    }
  },
  report_name: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  report_type: {
    type: DataTypes.ENUM('profit_loss', 'balance_sheet', 'cash_flow', 'custom'),
    allowNull: false
  },
  frequency: {
    type: DataTypes.ENUM('daily', 'weekly', 'monthly', 'quarterly', 'yearly'),
    allowNull: false
  },
  recipients: {
    type: DataTypes.JSON
  },
  format: {
    type: DataTypes.ENUM('pdf', 'excel', 'csv'),
    defaultValue: 'pdf'
  },
  last_generated_at: {
    type: DataTypes.DATE
  },
  next_generation_at: {
    type: DataTypes.DATE
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  }
}, {
  tableName: 'scheduled_reports',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false
});

module.exports = ScheduledReport;