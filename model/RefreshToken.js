// model/RefreshToken.js
// One row per issued refresh token. Plaintext is never stored — only
// SHA-256 hash. On rotation the old row is marked revoked and a new
// row is inserted (chained via `replaced_by`).

const { DataTypes } = require('sequelize');
const { mainDB } = require('../connection/dbConnection');

const RefreshToken = mainDB.define('RefreshToken', {
  id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  user_id:    { type: DataTypes.INTEGER, allowNull: false },
  token_hash: { type: DataTypes.STRING(64), allowNull: false, unique: true },
  expires_at: { type: DataTypes.DATE, allowNull: false },
  revoked_at: { type: DataTypes.DATE },
  replaced_by:{ type: DataTypes.STRING(64) },
  user_agent: { type: DataTypes.STRING(512) },
  ip:         { type: DataTypes.STRING(64) },
  created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  tableName: 'refresh_tokens',
  timestamps: false,
  indexes: [
    { fields: ['user_id'] },
    { fields: ['expires_at'] },
  ],
});

module.exports = RefreshToken;
