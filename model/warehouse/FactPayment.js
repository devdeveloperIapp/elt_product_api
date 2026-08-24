// model/warehouse/FactPayment.js
const { DataTypes } = require('sequelize');
const { warehouseDB } = require('../../connection/dbConnection');

const FactPayment = warehouseDB.define('fact_payments', {
  id:               { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  company_id:       { type: DataTypes.INTEGER, allowNull: false },
  payment_id:       { type: DataTypes.STRING },
  customer_id:      { type: DataTypes.STRING },
  customer_name:    { type: DataTypes.STRING },
  transaction_date: { type: DataTypes.DATEONLY },
  amount:           { type: DataTypes.DECIMAL(15, 2), defaultValue: 0 },
  payment_method:   { type: DataTypes.STRING },
  source_type:      { type: DataTypes.STRING },
  currency:         { type: DataTypes.STRING, defaultValue: 'USD' },
  created_at:       { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, {
  tableName:  'fact_payments',
  schema:     'domain_tables',
  timestamps: false,
  indexes: [{
    unique: true,
    fields: ['company_id', 'source_type', 'payment_id']
  }]
});

// DDL is owned by SQL migrations; do NOT auto-sync here.

module.exports = FactPayment;