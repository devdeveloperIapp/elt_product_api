// model/ChartConfig.js
const { DataTypes } = require('sequelize');
const {mainDB} = require('../connection/dbConnection');

const ChartConfig = mainDB.define('ChartConfig', {
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
  chart_name: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  chart_type: {
    type: DataTypes.ENUM('line', 'bar', 'pie', 'doughnut', 'area', 'radar', 'funnel'),
    allowNull: false
  },
  data_source: {
    type: DataTypes.ENUM('profit_loss', 'balance_sheet', 'cash_flow', 'sales', 'expenses', 'custom_query'),
    allowNull: false
  },
  configuration: {
    type: DataTypes.JSON
  },
  is_public: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  }
}, {
  tableName: 'chart_configs',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = ChartConfig;