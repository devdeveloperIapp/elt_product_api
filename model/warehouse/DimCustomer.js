// model/warehouse/DimCustomer.js  ← GOLD layer
const { DataTypes } = require('sequelize');
const { warehouseDB } = require('../../connection/dbConnection');

// const DimCustomer = warehouseDB.define('dim_customers', {
//   id:            { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
//   company_id:    { type: DataTypes.INTEGER, allowNull: false },
//   customer_id:   { type: DataTypes.STRING },    // QB Customer.Id
//   display_name:  { type: DataTypes.STRING },
//   email:         { type: DataTypes.STRING },
//   balance:       { type: DataTypes.DECIMAL(15, 2) },
//   is_active:     { type: DataTypes.BOOLEAN },
//   updated_at:    { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
// }, { timestamps: false, indexes: [{ fields: ['company_id', 'customer_id'], unique: true }] });

// module.exports = DimCustomer;

const DimCustomer = warehouseDB.define('dim_customers', {
  id:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  company_id:   { type: DataTypes.INTEGER, allowNull: false },
  customer_id:  { type: DataTypes.STRING },
  display_name: { type: DataTypes.STRING },
  email:        { type: DataTypes.STRING },
  balance:      { type: DataTypes.DECIMAL(15, 2) },
  is_active:    { type: DataTypes.BOOLEAN },
  updated_at:   { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, {
  tableName: 'dim_customers',
  schema: 'domain_tables',   // ✅ domain_tables schema
  timestamps: false,
  indexes: [{ unique: true, fields: ['company_id', 'customer_id'] }]
});

module.exports = DimCustomer;