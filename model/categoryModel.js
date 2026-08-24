const { DataTypes } = require('sequelize');
const {mainDB} = require('../connection/dbConnection');

const Category = mainDB.define('Category', {
  name: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: false
  },
  order: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0
  },
  company_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: 'companies', key: 'id' },
  }
}, {
  tableName: 'categories',
  timestamps: true,
  createdAt: 'created_on',
  updatedAt: 'updated_on',
});

module.exports = Category;
