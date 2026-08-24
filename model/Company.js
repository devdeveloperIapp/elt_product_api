// model/Company.js
const { DataTypes } = require('sequelize');
const {mainDB} = require('../connection/dbConnection');

const Company = mainDB.define('Company', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  name: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  // QuickBooks' actual company name (e.g. "Sandbox Company_US_1").
  // Stored for reference; shown as a secondary label in the UI.
  qbc_name: {
    type: DataTypes.STRING(255),
    allowNull: true,
    defaultValue: null,
  },
  // true  → user typed a company name at signup (never overwrite `name`)
  // false → no name given (Gmail login etc.) → QB connect fills `name` from QB
  name_is_custom: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  logo: {
    type: DataTypes.STRING(255)
  },
  domain: {
    type: DataTypes.STRING(255),
    unique: true
  },
  quickbooks_realm_id: {
    type: DataTypes.STRING(255),
    unique: true
  },
  subscription_plan: {
    type: DataTypes.ENUM('basic', 'professional', 'enterprise'),
    defaultValue: 'basic'
  },
  subscription_status: {
    type: DataTypes.ENUM('active', 'trial', 'expired', 'cancelled'),
    defaultValue: 'trial'
  },
  subscription_expiry: {
    type: DataTypes.DATE
  },
  timezone: {
    type: DataTypes.STRING(50),
    defaultValue: 'UTC'
  },
  currency: {
    type: DataTypes.STRING(10),
    defaultValue: 'USD'
  },
  fiscal_year_start: {
    type: DataTypes.DATE
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  }
}, {
  tableName: 'qb_companies',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = Company;