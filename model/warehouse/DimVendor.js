// model/warehouse/DimVendor.js
const { DataTypes } = require('sequelize');
const { warehouseDB } = require('../../connection/dbConnection');

const DimVendor = warehouseDB.define('dim_vendors', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  company_id:   { type: DataTypes.INTEGER, allowNull: false },
  vendor_id:    { type: DataTypes.STRING },
  display_name: { type: DataTypes.STRING },
  email:        { type: DataTypes.STRING },
  phone:        { type: DataTypes.STRING },
  balance:      { type: DataTypes.DECIMAL(15, 2), defaultValue: 0 },
  is_active:    { type: DataTypes.BOOLEAN, defaultValue: true },
  updated_at:   { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, {
  tableName:  'dim_vendors',
  schema:     'domain_tables',
  timestamps: false,
  indexes: [{
    unique: true,
    fields: ['company_id', 'vendor_id']
  }]
});

// DDL is owned by SQL migrations; do NOT auto-sync here.

module.exports = DimVendor;