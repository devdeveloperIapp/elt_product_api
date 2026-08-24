// model/Permission.js
const { DataTypes } = require('sequelize');
const {mainDB} = require('../connection/dbConnection');

const Permission = mainDB.define('Permission', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  name: {
    type: DataTypes.STRING(100),
    unique: true,
    allowNull: false
  },
  code: {
    type: DataTypes.STRING(50),
    unique: true,
    allowNull: false
  },
  module: {
    type: DataTypes.STRING(50)
  },
  description: {
    type: DataTypes.TEXT
  }
}, {
  tableName: 'permissions',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = Permission;