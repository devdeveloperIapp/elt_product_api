// model/QuickBooksConnection.js
const { DataTypes } = require('sequelize');
const {mainDB} = require('../connection/dbConnection');

const QuickBooksConnection = mainDB.define('QuickBooksConnection', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  company_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    unique: true,
    references: {
      model: 'companies',
      key: 'id'
    }
  },
  realm_id: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  access_token: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  refresh_token: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  token_type: {
    type: DataTypes.STRING(50)
  },
  expires_in: {
    type: DataTypes.INTEGER
  },
  x_refresh_token_expires_in: {
    type: DataTypes.INTEGER
  },
  last_sync_at: {
    type: DataTypes.DATE
  },
  sync_status: {
    type: DataTypes.ENUM('pending', 'in_progress', 'completed', 'failed'),
    defaultValue: 'pending'
  },
  error_message: {
    type: DataTypes.TEXT
  }
}, {
  tableName: 'quickbooks_connections',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = QuickBooksConnection;