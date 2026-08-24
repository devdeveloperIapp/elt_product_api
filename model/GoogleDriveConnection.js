// model/GoogleDriveConnection.js
// Stores OAuth tokens and sync metadata for a company's Google Drive connection.
// One row per company — a company can connect one Google account for Drive.
//
// Difference vs GoogleSheetsConnection: Google Drive is folder-scoped. The user
// picks one or more Drive FOLDERS; on sync we ingest every supported spreadsheet
// file (native Google Sheets + uploaded .xlsx/.xls/.csv) inside those folders.

const { DataTypes } = require('sequelize');
const { mainDB } = require('../connection/dbConnection');

const GoogleDriveConnection = mainDB.define('GoogleDriveConnection', {
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
  // Space-separated OAuth scopes granted
  scope: {
    type: DataTypes.TEXT,
  },
  // JSON array of Drive folder IDs the user selected to sync
  // e.g. ["1AbcFolderId", "1XyzFolderId"]
  selected_folder_ids: {
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
  tableName: 'google_drive_connections',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = GoogleDriveConnection;
