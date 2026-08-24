// model/FinancialReport.js
const { DataTypes } = require('sequelize');
const {mainDB} = require('../connection/dbConnection');

const FinancialReport = mainDB.define('FinancialReport', {
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
  report_type: {
    type: DataTypes.ENUM('profit_loss', 'balance_sheet', 'cash_flow', 'sales', 'expenses', 'custom'),
    allowNull: false
  },
  report_name: {
    type: DataTypes.STRING(255)
  },
  report_data: {
    type: DataTypes.JSON
  },
  date_range_start: {
    type: DataTypes.DATE
  },
  date_range_end: {
    type: DataTypes.DATE
  },
  comparison_period: {
    type: DataTypes.STRING(50)
  }
}, {
  tableName: 'financial_reports',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = FinancialReport;