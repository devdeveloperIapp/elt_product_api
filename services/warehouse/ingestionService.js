// services/warehouse/ingestionService.js
// Reusable ingestion + transformation API for the v2 warehouse.
//
// Public API:
//   insertRawData(source, entity, payload, opts)   - upserts API payloads into <source>_raw.raw_<entity>
//   transformToDomain(source, opts)                - runs the registered transformer for that source
//   registerTransformer(source, transformerFn)     - used by transformer modules at boot
//
// All schema routing is handled via schemaMap. Controllers should never
// touch schemas, table names, or warehouse models directly.

const { getRawModel } = require('../../model/warehouse/RawModelFactory');
const { normaliseSource, supportedSources } = require('../../model/warehouse/schemaMap');

// ---- transformer registry (populated by transformer modules) ----
const transformerRegistry = new Map();

// ---- raw model sync cache ----
// Tracks which raw tables have been confirmed to exist this process lifetime.
// On first insert into a table, Model.sync({ force: false }) is awaited to
// auto-create it if missing (e.g. newly added entities not yet in bootstrap SQL).
// Subsequent inserts skip the check for speed.
const syncedRawModels = new Set();

const registerTransformer = (source, fn) => {
  if (typeof fn !== 'function') throw new Error('transformer must be a function');
  transformerRegistry.set(normaliseSource(source), fn);
};

// ---- helpers ----
const chunk = (arr, size = 500) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const toArray = (payload) => (Array.isArray(payload) ? payload : [payload]);

/**
 * Bulk-upsert raw API payloads.
 *
 *   insertRawData('quickbooks', 'Invoice', invoicesArray, { companyId, sourceIdField: 'Id' })
 *
 * @param {string} source            'quickbooks' | 'zohobooks' | 'shopify'
 * @param {string} entity            entity name, e.g. 'Invoice', 'Bill', 'Order', 'Customer'
 * @param {object|object[]} payload  one or many raw API objects
 * @param {object} opts
 * @param {number} opts.companyId    REQUIRED — multi-tenant key
 * @param {string} [opts.sourceIdField='Id']  field on the payload that holds the natural key
 * @param {string} [opts.syncTokenField='SyncToken']
 *
 * @returns {Promise<{inserted: number}>}
 */
const insertRawData = async (source, entity, payload, opts = {}) => {
  const canonical = normaliseSource(source);
  if (!entity) throw new Error('entity is required');

  const {
    companyId,
    sourceIdField = 'Id',
    syncTokenField = 'SyncToken',
  } = opts;

  if (!companyId && companyId !== 0) {
    throw new Error('opts.companyId is required for insertRawData');
  }

  // Auto-create the raw table if it doesn't exist yet (idempotent).
  // Must run BEFORE the empty-records check so tables are always created
  // even when a source has zero records for an entity (e.g. no smart collections).
  // Only runs once per (source, entity) pair per process lifetime.
  const RawModel = getRawModel(canonical, entity);
  const syncKey  = `${canonical}::${entity.toLowerCase()}`;
  if (!syncedRawModels.has(syncKey)) {
    await RawModel.sync({ force: false });
    syncedRawModels.add(syncKey);
  }

  const records = toArray(payload).filter(Boolean);
  if (records.length === 0) return { inserted: 0 };

  let inserted = 0;

  for (const batch of chunk(records, 500)) {
    const rows = batch
      .map((entityRecord) => {
        const sourceId = entityRecord?.[sourceIdField];
        if (sourceId === undefined || sourceId === null) return null;
        return {
          company_id:  companyId,
          source_type: canonical,
          source_id:   String(sourceId),
          raw_payload: entityRecord,
          sync_token:  entityRecord?.[syncTokenField] ?? null,
          ingested_at: new Date(),
          is_deleted:  Boolean(entityRecord?.is_deleted),
        };
      })
      .filter(Boolean);

    if (rows.length === 0) continue;

    await RawModel.bulkCreate(rows, {
      updateOnDuplicate: ['raw_payload', 'sync_token', 'ingested_at', 'is_deleted'],
    });
    inserted += rows.length;
  }

  return { inserted };
};

/**
 * Run the registered transformer for a source. Transformers move records
 * from <source>_raw.* into <source>_domain.* (dim_*, fact_*, agg_*).
 *
 * @param {string} source
 * @param {object} opts
 * @param {number} opts.companyId  REQUIRED — only this tenant is transformed
 * @param {string[]} [opts.entities] subset of entities to transform (default: all)
 * @returns {Promise<object>} transformer-specific summary
 */
const transformToDomain = async (source, opts = {}) => {
  const canonical = normaliseSource(source);
  const transformer = transformerRegistry.get(canonical);
  if (!transformer) {
    throw new Error(
      `No transformer registered for "${canonical}". Loaded sources: [${[...transformerRegistry.keys()].join(', ')}]. Supported: [${supportedSources().join(', ')}]`
    );
  }
  if (!opts.companyId && opts.companyId !== 0) {
    throw new Error('opts.companyId is required for transformToDomain');
  }
  return transformer(opts);
};

module.exports = {
  insertRawData,
  transformToDomain,
  registerTransformer,
};
