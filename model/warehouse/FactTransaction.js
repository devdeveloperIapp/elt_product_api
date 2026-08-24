// model/warehouse/FactTransaction.js  ← GOLD layer
const { DataTypes } = require('sequelize');
const { warehouseDB } = require('../../connection/dbConnection');

// const FactTransaction = warehouseDB.define('fact_transactions', {
//   id: {
//     type: DataTypes.UUID,
//     defaultValue: DataTypes.UUIDV4,
//     primaryKey: true
//   },
//   company_id:       { type: DataTypes.INTEGER, allowNull: false },
//   transaction_date: { type: DataTypes.DATEONLY },
//   amount:           { type: DataTypes.DECIMAL(15, 2) },
//   transaction_type: { type: DataTypes.STRING },
//   account_id:       { type: DataTypes.STRING },
//   customer_id:      { type: DataTypes.STRING },
//   source_type:      { type: DataTypes.STRING },
//   source_ref_id:    { type: DataTypes.STRING },
//   currency:         { type: DataTypes.STRING, defaultValue: 'USD' },
//   is_paid:          { type: DataTypes.BOOLEAN, defaultValue: false },
//   created_at:       { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
// }, {
//   tableName: 'fact_transactions',
//   timestamps: false,
//   indexes: [
//     {
//       unique: true,  // ✅ ye constraint chahiye ON CONFLICT ke liye
//       fields: ['company_id', 'source_type', 'source_ref_id']
//     }
//   ]
// });

// // ✅ await karo — table pehle banega
// const syncFactTransaction = async () => {
//   await FactTransaction.sync({ alter: true });
// };
// syncFactTransaction();

// module.exports = FactTransaction;



const FactTransaction = warehouseDB.define('fact_transactions', {
  id:               { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  company_id:       { type: DataTypes.INTEGER, allowNull: false },
  transaction_date: { type: DataTypes.DATEONLY },
  amount:           { type: DataTypes.DECIMAL(15, 2) },
  transaction_type: { type: DataTypes.STRING },
  account_id:       { type: DataTypes.STRING },
  customer_id:      { type: DataTypes.STRING },
  source_type:      { type: DataTypes.STRING },
  source_ref_id:    { type: DataTypes.STRING },
  currency:         { type: DataTypes.STRING, defaultValue: 'USD' },
  is_paid:          { type: DataTypes.BOOLEAN, defaultValue: false },
  created_at:       { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, {
  tableName: 'fact_transactions',
  schema: 'domain_tables',   // ✅ domain_tables schema
  timestamps: false,
  indexes: [{ unique: true, fields: ['company_id', 'source_type', 'source_ref_id'] }]
});

module.exports = FactTransaction;