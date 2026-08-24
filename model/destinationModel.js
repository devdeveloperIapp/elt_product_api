const { DataTypes } = require('sequelize');
const {mainDB} = require('../connection/dbConnection');

const Destination = mainDB.define('Destination', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  destination_name: {
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
    allowNull: true,
    references: { model: 'companies', key: 'id' },
  },
  created_by: { type: DataTypes.STRING, allowNull: true },
  created_on: { type: DataTypes.DATE, allowNull: true },

}, {
  tableName: 'destination',
  timestamps: false, // Adds createdAt and updatedAt fields
  
  
});

module.exports = Destination;