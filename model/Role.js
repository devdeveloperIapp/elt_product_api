// model/Role.js
const { DataTypes } = require('sequelize');
const {mainDB} = require('../connection/dbConnection');
const Permission = require('./Permission');

const Role = mainDB.define('Role', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  name: {
    type: DataTypes.STRING(50),
    unique: true,
    allowNull: false
  },
  description: {
    type: DataTypes.TEXT
  },
  is_system_role: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
   isSuperAdmin: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  }
}, {
  tableName: 'roles',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});
Role.belongsToMany(Permission, {
  through: 'role_permissions',
  as: 'permissions', // ← This is the alias name (could be 'Permissions' or something else)
  foreignKey: 'role_id',
  otherKey: 'permission_id'
});
module.exports = Role;