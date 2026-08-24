// model/warehouse/DomainModelFactory.js
// Dynamic factory for domain (dim_* / fact_* / agg_*) models.
// Each transformer registers its entity definitions; the factory hands back
// a cached Sequelize model bound to <source>_domain.<table>.

const { warehouseV2DB } = require('../../connection/dbConnection');
const { getSchemas, normaliseSource } = require('./schemaMap');

const cache = new Map();
const buildKey = (source, table) => `${source}::${table}`;

/**
 * Define (or fetch from cache) a domain table model.
 *
 * @param {string} source  e.g. 'quickbooks' | 'zohobooks' | 'shopify'
 * @param {string} table   e.g. 'dim_customers', 'fact_invoices'
 * @param {object} attributes  Sequelize attributes definition
 * @param {object} [options]   Sequelize options (indexes, timestamps, ...). schema/tableName are forced.
 */
const defineDomainModel = (source, table, attributes, options = {}) => {
  const canonical = normaliseSource(source);
  const { domain: schema } = getSchemas(canonical);
  const key = buildKey(canonical, table);

  if (cache.has(key)) return cache.get(key);

  const modelName = `${canonical}_${table}`;

  const model = warehouseV2DB.define(
    modelName,
    attributes,
    {
      timestamps: false,
      ...options,
      tableName: table,
      schema,
    }
  );

  cache.set(key, model);
  return model;
};

const getDomainModel = (source, table) => {
  const canonical = normaliseSource(source);
  const key = buildKey(canonical, table);
  if (!cache.has(key)) {
    throw new Error(`Domain model not registered: ${source}.${table}. Did you load the transformer?`);
  }
  return cache.get(key);
};

module.exports = { defineDomainModel, getDomainModel };
