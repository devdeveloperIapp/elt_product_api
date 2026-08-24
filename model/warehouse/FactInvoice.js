// model/warehouse/FactInvoice.js
const { DataTypes } = require('sequelize');
const { warehouseDB } = require('../../connection/dbConnection');


const FactInvoice = warehouseDB.define('fact_invoices', {
  id:               { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  company_id:       { type: DataTypes.INTEGER, allowNull: false },
  invoice_id:       { type: DataTypes.STRING },
  doc_number:       { type: DataTypes.STRING },
  customer_id:      { type: DataTypes.STRING },
  customer_name:    { type: DataTypes.STRING },
  transaction_date: { type: DataTypes.DATEONLY },
  due_date:         { type: DataTypes.DATEONLY },
  amount:           { type: DataTypes.DECIMAL(15, 2), defaultValue: 0 },
  balance:          { type: DataTypes.DECIMAL(15, 2), defaultValue: 0 },
  status:           { type: DataTypes.STRING },
  source_type:      { type: DataTypes.STRING },
  currency:         { type: DataTypes.STRING, defaultValue: 'USD' },
  created_at:       { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, {
  tableName:  'fact_invoices',
  schema:     'domain_tables',
  timestamps: false,
  indexes: [{
    unique: true,
    fields: ['company_id', 'source_type', 'invoice_id']
  }]
});

// DDL is owned by SQL migrations; do NOT auto-sync here (it used to log
// "cannot alter type of a column used by a view or rule" on every boot).

module.exports = FactInvoice;