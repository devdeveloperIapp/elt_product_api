// model/NavigationPermission.js
const { DataTypes } = require('sequelize');
const {mainDB} = require('../connection/dbConnection');

const NavigationPermission = mainDB.define('NavigationPermission', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  navigation_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'navigation_items',
      key: 'id'
    }
  },
  permission_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'permissions',
      key: 'id'
    }
  }
}, {
  tableName: 'navigation_permissions',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
  indexes: [
    {
      unique: true,
      fields: ['navigation_id', 'permission_id']
    }
  ]
});

module.exports = NavigationPermission;