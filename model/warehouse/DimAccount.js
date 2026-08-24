// model/warehouse/DimAccount.js  ← GOLD layer
const { DataTypes } = require('sequelize');
const { warehouseDB } = require('../../connection/dbConnection');

// const DimAccount = warehouseDB.define('dim_accounts', {
//   id:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
//   company_id:   { type: DataTypes.INTEGER, allowNull: false },
//   account_id:   { type: DataTypes.STRING },   // QB Account.Id
//   account_name: { type: DataTypes.STRING },
//   account_type: { type: DataTypes.STRING },   // 'Revenue', 'Expense', 'Asset', etc.
//   account_sub_type: { type: DataTypes.STRING },
//   current_balance:  { type: DataTypes.DECIMAL(15, 2) },
//   currency:     { type: DataTypes.STRING },
//   is_active:    { type: DataTypes.BOOLEAN },
//   updated_at:   { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
// }, { timestamps: false, indexes: [{ fields: ['company_id', 'account_id'], unique: true }] });

// module.exports = DimAccount;


const DimAccount = warehouseDB.define('dim_accounts', {
  id:               { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  company_id:       { type: DataTypes.INTEGER, allowNull: false },
  account_id:       { type: DataTypes.STRING },
  account_name:     { type: DataTypes.STRING },
  account_type:     { type: DataTypes.STRING },
  account_sub_type: { type: DataTypes.STRING },
  current_balance:  { type: DataTypes.DECIMAL(15, 2) },
  currency:         { type: DataTypes.STRING },
  is_active:        { type: DataTypes.BOOLEAN },
  updated_at:       { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, {
  tableName: 'dim_accounts',
  schema: 'domain_tables',   // ✅ domain_tables schema
  timestamps: false,
  indexes: [{ unique: true, fields: ['company_id', 'account_id'] }]
});

module.exports = DimAccount;