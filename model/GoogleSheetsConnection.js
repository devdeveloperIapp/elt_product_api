// model/GoogleSheetsConnection.js
// Stores OAuth tokens and sync metadata for a company's Google Sheets connection.
// One row per company — a company can connect one Google account.

const { DataTypes } = require('sequelize');
const { mainDB } = require('../connection/dbConnection');

const GoogleSheetsConnection = mainDB.define('GoogleSheetsConnection', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  company_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    unique: true,
  },
  // Google account that granted access
  google_email: {
    type: DataTypes.STRING(255),
  },
  // Short-lived access token (~1 hour)
  access_token: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  // Long-lived refresh token (does not expire unless revoked)
  refresh_token: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  // Unix ms timestamp when access_token expires
  token_expiry: {
    type: DataTypes.BIGINT,
  },
  // Comma-separated OAuth scopes granted
  scope: {
    type: DataTypes.TEXT,
  },
  // JSON array of spreadsheet IDs the user selected to sync
  // e.g. ["1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms", ...]
  selected_spreadsheet_ids: {
    type: DataTypes.JSONB,
    defaultValue: [],
  },
  sync_status: {
    type: DataTypes.ENUM('pending', 'in_progress', 'completed', 'failed'),
    defaultValue: 'pending',
  },
  error_message: {
    type: DataTypes.TEXT,
  },
  last_sync_at: {
    type: DataTypes.DATE,
  },
}, {
  tableName: 'google_sheets_connections',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = GoogleSheetsConnection;
