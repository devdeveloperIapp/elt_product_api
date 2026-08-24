// model/warehouse/RawModelFactory.js
// Dynamic Sequelize model factory for raw layer tables.
// Routes (source, entity) -> <source_raw>.raw_<entity>
// e.g. ('quickbooks','Invoice')  -> quickbooks_raw.raw_invoice
//      ('zohobooks','Bill')      -> zohobooks_raw.raw_bill
//      ('shopify','Order')       -> shopify_raw.raw_order

const { DataTypes } = require('sequelize');
const { warehouseV2DB } = require('../../connection/dbConnection');
const { getSchemas, normaliseSource } = require('./schemaMap');

const cache = new Map();

const buildKey = (source, entity) => `${source}::${entity.toLowerCase()}`;

/**
 * Returns a cached Sequelize model for a (source, entity) pair.
 * Does NOT auto-sync — DDL is owned by migrations (see scripts/migrations/bootstrap_v2.sql).
 */
const getRawModel = (source, entity) => {
  if (!entity) throw new Error('entity is required');
  const canonical = normaliseSource(source);
  const { raw: schema } = getSchemas(canonical);
  const tableName = `raw_${entity.toLowerCase()}`;
  const key = buildKey(canonical, entity);

  if (cache.has(key)) return cache.get(key);

  // Each source uses a unique model name to keep Sequelize's registry clean.
  const modelName = `Raw_${canonical}_${entity.toLowerCase()}`;

  const model = warehouseV2DB.define(
    modelName,
    {
      id:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      company_id:   { type: DataTypes.INTEGER, allowNull: false },
      source_type:  { type: DataTypes.STRING, allowNull: false },
      source_id:    { type: DataTypes.STRING, allowNull: false },
      raw_payload:  { type: DataTypes.JSONB,  allowNull: false },
      sync_token:   { type: DataTypes.STRING },
      ingested_at:  { type: DataTypes.DATE,   defaultValue: DataTypes.NOW },
      is_deleted:   { type: DataTypes.BOOLEAN, defaultValue: false },
    },
    {
      tableName,
      schema,
      timestamps: false,
      indexes: [
        { unique: true, fields: ['company_id', 'source_type', 'source_id'] },
        { fields: ['company_id', 'ingested_at'] },
      ],
    }
  );

  cache.set(key, model);
  return model;
};

module.exports = { getRawModel };
