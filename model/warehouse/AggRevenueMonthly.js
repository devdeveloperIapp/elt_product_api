// model/warehouse/AggRevenueMonthly.js
const { DataTypes } = require('sequelize');
const { warehouseDB } = require('../../connection/dbConnection');

const AggRevenueMonthly = warehouseDB.define('agg_revenue_monthly', {
  id:            { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  company_id:    { type: DataTypes.INTEGER, allowNull: false },
  year:          { type: DataTypes.INTEGER },
  month:         { type: DataTypes.INTEGER },
  month_label:   { type: DataTypes.STRING },
  revenue:       { type: DataTypes.DECIMAL(15, 2), defaultValue: 0 },
  expenses:      { type: DataTypes.DECIMAL(15, 2), defaultValue: 0 },
  net_profit:    { type: DataTypes.DECIMAL(15, 2), defaultValue: 0 },
  invoice_count: { type: DataTypes.INTEGER,        defaultValue: 0 },
  source_type:   { type: DataTypes.STRING },
  updated_at:    { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, {
  tableName:  'agg_revenue_monthly',
  schema:     'domain_tables',
  timestamps: false,
  indexes: [{
    unique: true,
    fields: ['company_id', 'year', 'month', 'source_type']
  }]
});

// DDL is owned by SQL migrations; do NOT auto-sync here.

module.exports = AggRevenueMonthly;