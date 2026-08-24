// model/NavigationItem.js
const { DataTypes } = require('sequelize');
const {mainDB} = require('../connection/dbConnection');

const NavigationItem = mainDB.define('NavigationItem', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  parent_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'navigation_items',
      key: 'id'
    }
  },
  name: {
    type: DataTypes.STRING(100),
    allowNull: false
  },
  icon: {
    type: DataTypes.STRING(50)
  },
  path: {
    type: DataTypes.STRING(255)
  },
  module: {
    type: DataTypes.STRING(50)
  },
  sort_order: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  // Hides the item from the SuperAdmin sidebar while still letting admins
  // assign it to other roles via the Navigation Manager. Defaults to TRUE
  // so existing items keep their behaviour.
  is_super_admin_visible: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  }
}, {
  tableName: 'navigation_items',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

// Don't define associations here - they should only be in index.js
// Remove any association definitions from this file

module.exports = NavigationItem;