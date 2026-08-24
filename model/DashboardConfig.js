// model/DashboardConfig.js
const { DataTypes } = require('sequelize');
const {mainDB} = require('../connection/dbConnection');

const DashboardConfig = mainDB.define('DashboardConfig', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  company_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'companies',
      key: 'id'
    }
  },
  user_id: {
    type: DataTypes.INTEGER,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  config_name: {
    type: DataTypes.STRING(255),
    defaultValue: 'Default Dashboard'
  },
  layout: {
    type: DataTypes.JSON
  },
  widgets: {
    type: DataTypes.JSON
  },
  is_default: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  }
}, {
  tableName: 'dashboard_configs',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = DashboardConfig;