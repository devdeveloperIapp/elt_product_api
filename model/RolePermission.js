// model/RolePermission.js
const { DataTypes } = require('sequelize');
const {mainDB} = require('../connection/dbConnection');

const RolePermission = mainDB.define('RolePermission', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  role_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'roles',
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
  tableName: 'role_permissions',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
//   indexes: [
//     {
//       unique: true,
//       fields: ['role_id', 'permission_id']
//     }
//   ]
});

module.exports = RolePermission;