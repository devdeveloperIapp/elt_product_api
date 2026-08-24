'use strict';
const { DataTypes } = require('sequelize');
const { mainDB }    = require('../connection/dbConnection');

// Per-user navigation exception. A row here HIDES a nav item for that user.
// No row = user sees the item normally (inherited from their role).
const UserNavigationOverride = mainDB.define('UserNavigationOverride', {
  id:                 { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  user_id:            { type: DataTypes.INTEGER, allowNull: false },
  navigation_item_id: { type: DataTypes.INTEGER, allowNull: false },
  is_hidden:          { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, {
  tableName:  'user_navigation_overrides',
  timestamps: true,
  createdAt:  'created_at',
  updatedAt:  'updated_at',
});

module.exports = UserNavigationOverride;
