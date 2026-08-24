// model/warehouse/RawChartOfAccounts.js  ← RAW layer
const { DataTypes } = require('sequelize');
const { warehouseDB } = require('../../connection/dbConnection');

const RawChartOfAccounts = warehouseDB.define('raw_chart_of_accounts', {
  id:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  company_id:   { type: DataTypes.INTEGER, allowNull: false },
  source_type:  { type: DataTypes.STRING },
  account_id:   { type: DataTypes.STRING, allowNull: false },
  raw_payload:  { type: DataTypes.JSONB, allowNull: false },
  ingested_at:  { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, { timestamps: false, indexes: [{ fields: ['company_id', 'account_id'], unique: true }] });

module.exports = RawChartOfAccounts;