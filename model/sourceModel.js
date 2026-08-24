const { DataTypes } = require('sequelize');
const {mainDB} = require('../connection/dbConnection');

const Source = mainDB.define('Source', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  source_name: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  connector_name: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  connector_settings_json: {
    type: DataTypes.JSONB,
    allowNull: true
  },
  status: {
    type: DataTypes.STRING('pending', 'processing', 'completed', 'failed'),
    defaultValue: 'pending'
  },
  company_id: {
    type: DataTypes.INTEGER,
    allowNull: true,            // flip to false after 003b migration
    references: { model: 'companies', key: 'id' },
  },
  created_by: { type: DataTypes.STRING, allowNull: true },
  created_on: { type: DataTypes.DATE, allowNull: true },

}, {
  tableName: 'source',
  timestamps: false, // Adds createdAt and updatedAt fields
  
  
});


module.exports = Source;