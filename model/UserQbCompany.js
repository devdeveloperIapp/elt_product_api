// model/UserQbCompany.js
// Join table linking users <-> qb_companies (many-to-many).
// One user can manage multiple QuickBooks companies; one company can be
// shared by multiple users (admin + accountant + viewer, etc.).
const { DataTypes } = require('sequelize');
const { mainDB } = require('../connection/dbConnection');

const UserQbCompany = mainDB.define('UserQbCompany', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: 'users', key: 'id' },
  },
  company_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: 'qb_companies', key: 'id' },
  },
  role: {
    // Per-company role for this user. 'owner' is the original connector.
    type: DataTypes.ENUM('owner', 'admin', 'member', 'viewer'),
    defaultValue: 'owner',
  },
  is_default: {
    // Marks the user's currently-active company. Exactly one row per user
    // should have is_default=true (enforced softly by the controller).
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
}, {
  tableName: 'user_qb_companies',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { unique: true, fields: ['user_id', 'company_id'] },
    { fields: ['user_id'] },
    { fields: ['company_id'] },
  ],
});

module.exports = UserQbCompany;
