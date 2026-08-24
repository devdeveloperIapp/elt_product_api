// queues/index.js
// Single source of truth for queue names + Queue handles.
// Producers import { queues } and call queues.<name>.add(jobName, payload, opts).
// Workers import these names and create Worker instances against the same Redis.

const { Queue, QueueEvents } = require('bullmq');
const connection = require('./connection');

const QUEUE_NAMES = Object.freeze({
  QUICKBOOKS_SYNC:  'quickbooks-sync',
  ZOHOBOOKS_SYNC:   'zohobooks-sync',
  SHOPIFY_SYNC:     'shopify-sync',
  WEBHOOKS:         'webhooks',
  // Separate queue for raw → domain transforms.
  // Decoupled from ingestion so a burst of 100 webhooks for one company
  // results in exactly ONE transform job (deduplication via jobId in the worker).
  DOMAIN_TRANSFORM: 'domain-transform',
});

// ---------- job option presets ----------

// Ingestion queues: fast, 3 attempts, data must not be lost.
const ingestJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 }, // 5 s → 25 s → 125 s
  removeOnComplete: { count: 1_000, age: 24 * 3600 },
  removeOnFail:     { count: 5_000, age: 7 * 24 * 3600 },
};

// Transform queue: heavier DB work, more retries, longer backoff.
const transformJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 3_000 }, // 3 s → 15 s → 75 s → 375 s → 1875 s
  removeOnComplete: { count: 500,   age: 6  * 3600 },
  removeOnFail:     { count: 2_000, age: 14 * 24 * 3600 },
};

const buildQueue = (name, jobOptions = ingestJobOptions) =>
  new Queue(name, { ...connection, defaultJobOptions: jobOptions });

const queues = Object.freeze({
  quickbooksSync:  buildQueue(QUEUE_NAMES.QUICKBOOKS_SYNC),
  zohobooksSync:   buildQueue(QUEUE_NAMES.ZOHOBOOKS_SYNC),
  shopifySync:     buildQueue(QUEUE_NAMES.SHOPIFY_SYNC),
  webhooks:        buildQueue(QUEUE_NAMES.WEBHOOKS),
  domainTransform: buildQueue(QUEUE_NAMES.DOMAIN_TRANSFORM, transformJobOptions),
});

// Optional: wire QueueEvents listeners centrally (for observability/logging).
const wireEvents = () => {
  for (const name of Object.values(QUEUE_NAMES)) {
    const ev = new QueueEvents(name, connection);
    ev.on('failed', ({ jobId, failedReason }) =>
      console.error(`[queue:${name}] job ${jobId} failed: ${failedReason}`)
    );
    ev.on('completed', ({ jobId }) =>
      console.log(`[queue:${name}] job ${jobId} completed`)
    );
  }
};

module.exports = { queues, QUEUE_NAMES, wireEvents };
