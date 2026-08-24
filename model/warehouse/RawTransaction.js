// model/warehouse/RawTransaction.js  ← RAW layer
const { DataTypes } = require('sequelize');
const { warehouseDB } = require('../../connection/dbConnection');

const RawTransaction = warehouseDB.define('raw_transactions', {
  id:             { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  company_id:     { type: DataTypes.INTEGER, allowNull: false },
  source_type:    { type: DataTypes.STRING, allowNull: false },   // 'quickbooks'
  source_entity:  { type: DataTypes.STRING, allowNull: false },   // 'invoice', 'bill', etc.
  source_id:      { type: DataTypes.STRING, allowNull: false },   // QB entity Id
  raw_payload:    { type: DataTypes.JSONB,  allowNull: false },   // full QB object
  ingested_at:    { type: DataTypes.DATE,   defaultValue: DataTypes.NOW },
  sync_token:     { type: DataTypes.STRING },
}, { timestamps: false, indexes: [{ fields: ['company_id', 'source_type', 'source_id'], unique: true }] });

module.exports = RawTransaction;