// workers/index.js
// Standalone process: `node workers/index.js`  (or PM2: `pm2 start workers/index.js --name elt-worker`)
//
// Architecture (high-scale):
//
//   Ingestion workers  ──insertRawData──►  raw tables
//        │
//        └──enqueueTransform()──►  DOMAIN_TRANSFORM queue
//                                        │
//                                 Transform worker  ──transformToDomain──►  domain tables
//
// Why separate transform queue?
//   A burst of 100 webhooks for the same company would cause 100 parallel
//   transformToDomain() calls → DB overload + race conditions.
//   With a dedicated queue + deduplication by jobId, those 100 events
//   produce exactly ONE transform job that runs after the dust settles.
//
// Failure handling:
//   Each queue uses its own retry policy (see queues/index.js).
//   After all attempts the job lands in the queue's "failed" set — that IS the DLQ.

require('dotenv').config();
const { Worker } = require('bullmq');
const connection  = require('../queues/connection');
const { queues, QUEUE_NAMES } = require('../queues');

// Boot warehouse v2 so transformers are registered before any job runs.
require('../services/warehouse');
const { insertRawData, transformToDomain } = require('../services/warehouse');

/* ======================================================================
   HELPERS
====================================================================== */

/**
 * Enqueue a domain-transform job for the given source + company.
 *
 * KEY DESIGN: jobId = `transform:<source>:<companyId>`
 *   BullMQ will NOT add a second job while one with the same ID is already
 *   waiting or delayed. This means 50 rapid-fire webhook events for one
 *   company produce exactly 1 transform job — no DB storm.
 *
 * The transform worker picks it up once and processes all accumulated
 * raw changes in a single pass.
 */
const enqueueTransform = async (source, companyId) => {
  if (!source || !companyId) return; // safety guard
  const jobId = `transform:${source}:${companyId}`;
  await queues.domainTransform.add(
    'run-transform',
    { source, companyId },
    {
      jobId,
      // Small delay so back-to-back inserts can be batched into one transform.
      delay: 500, // ms — adjust up (e.g. 2000) if you want more batching
    }
  );
};

/* ======================================================================
   INGESTION PROCESSORS
====================================================================== */

const quickbooksProcessor = async (job) => {
  const { companyId, entityType, entities } = job.data || {};
  if (!companyId || !entityType) throw new Error('companyId + entityType required');

  await insertRawData('quickbooks', entityType, entities || [], { companyId });
  await enqueueTransform('quickbooks', companyId);

  return { ok: true, count: (entities || []).length };
};

const zohobooksProcessor = async (job) => {
  const { companyId, entityType, entities, sourceIdField = 'id' } = job.data || {};
  if (!companyId || !entityType) throw new Error('companyId + entityType required');

  await insertRawData('zohobooks', entityType, entities || [], { companyId, sourceIdField });
  await enqueueTransform('zohobooks', companyId);

  return { ok: true, count: (entities || []).length };
};

const shopifyProcessor = async (job) => {
  const { companyId, entityType, entities, transform = false } = job.data || {};
  if (!companyId || !entityType) throw new Error('companyId + entityType required');

  await insertRawData('shopify', entityType, entities || [], { companyId, sourceIdField: 'id' });

  // `transform` flag kept for backward compat, but we now always go via queue.
  if (transform) await enqueueTransform('shopify', companyId);

  return { ok: true, count: (entities || []).length };
};

const webhooksProcessor = async (job) => {
  const { source, payload, companyId } = job.data || {};
  if (!source) throw new Error('source required');

  if (source === 'shopify' && payload) {
    const entityType = job.name; // e.g. 'Order', 'Product', 'Customer'
    await insertRawData('shopify', entityType, payload, { companyId, sourceIdField: 'id' });
    await enqueueTransform('shopify', companyId);
    return { ok: true };
  }

  if (source === 'quickbooks' && payload) {
    // QB webhooks are notifications only; the actual entity fetch is done
    // by the QuickBooks sync controller → quickbooks-sync queue.
    return { ok: true, note: 'QB webhook acknowledged' };
  }

  throw new Error(`Unknown webhook source: ${source}`);
};

/* ======================================================================
   TRANSFORM PROCESSOR
====================================================================== */

/**
 * Runs raw → domain transformation for one source + company.
 * Kept at concurrency: 2 because transformToDomain is a heavy multi-table
 * upsert. Higher concurrency would hammer the DB with no speed gain.
 */
const transformProcessor = async (job) => {
  const { source, companyId } = job.data || {};
  if (!source || !companyId) throw new Error('source + companyId required');

  await transformToDomain(source, { companyId });

  return { ok: true, source, companyId };
};

/* ======================================================================
   WORKER INSTANCES
====================================================================== */

const workers = [
  // Ingestion workers — higher concurrency, mostly I/O bound (API + raw insert).
  new Worker(QUEUE_NAMES.QUICKBOOKS_SYNC,  quickbooksProcessor, { ...connection, concurrency: 4 }),
  new Worker(QUEUE_NAMES.ZOHOBOOKS_SYNC,   zohobooksProcessor,  { ...connection, concurrency: 4 }),
  new Worker(QUEUE_NAMES.SHOPIFY_SYNC,     shopifyProcessor,    { ...connection, concurrency: 6 }),
  new Worker(QUEUE_NAMES.WEBHOOKS,         webhooksProcessor,   { ...connection, concurrency: 10 }),

  // Transform worker — lower concurrency, heavy DB work (multi-table upserts).
  new Worker(QUEUE_NAMES.DOMAIN_TRANSFORM, transformProcessor,  { ...connection, concurrency: 2 }),
];

/* ======================================================================
   LOGGING
====================================================================== */

for (const w of workers) {
  w.on('failed', (job, err) => {
    console.error(
      `[worker:${w.name}] job ${job?.id} FAILED ` +
      `(attempt ${job?.attemptsMade}/${job?.opts?.attempts}): ${err.message}`
    );
  });
  w.on('completed', (job) => {
    console.log(`[worker:${w.name}] job ${job.id} completed`);
  });
  w.on('error', (err) => {
    // Worker-level errors (Redis disconnect, etc.) — log but don't crash.
    console.error(`[worker:${w.name}] worker error:`, err.message);
  });
}

/* ======================================================================
   GRACEFUL SHUTDOWN
====================================================================== */

const shutdown = async (signal) => {
  console.log(`[worker] ${signal} received — shutting down gracefully…`);
  // Close all workers; each waits for the active job to finish before stopping.
  await Promise.all(workers.map((w) => w.close()));
  console.log('[worker] all workers stopped');
  process.exit(0);
};

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log(`[worker] booted | queues: ${Object.values(QUEUE_NAMES).join(', ')}`);
