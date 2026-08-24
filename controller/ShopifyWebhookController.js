// controller/ShopifyWebhookController.js
// Shopify webhook entry point.
//
// Security:
//   - HMAC-SHA256 verification using SHOPIFY_WEBHOOK_SECRET against the RAW
//     request body. The /api/webhook/shopify route MUST mount express.raw({...})
//     so we can compute the digest over the unmodified bytes.
//   - Constant-time comparison via crypto.timingSafeEqual.
//
// Behaviour:
//   - Verifies the signature.
//   - Returns 200 immediately (Shopify retries on non-2xx).
//   - Pushes the event onto the `webhooks` BullMQ queue. The worker handles
//     persistence and any downstream transformation.

const crypto = require('crypto');
const { queues } = require('../queues');

const SHOPIFY_TOPIC_HEADER  = 'x-shopify-topic';
const SHOPIFY_SHOP_HEADER   = 'x-shopify-shop-domain';
const SHOPIFY_HMAC_HEADER   = 'x-shopify-hmac-sha256';

// Map Shopify topic strings to internal entity names used by insertRawData.
const TOPIC_TO_ENTITY = Object.freeze({
  'orders/create': 'Order',
  'orders/updated': 'Order',
  'orders/cancelled': 'Order',
  'orders/fulfilled': 'Order',
  'orders/paid': 'Order',
  'products/create': 'Product',
  'products/update': 'Product',
  'products/delete': 'Product',
  'customers/create': 'Customer',
  'customers/update': 'Customer',
  'customers/delete': 'Customer',
});

const verifyHmac = (rawBody, signatureHeader) => {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return false;
  const computed = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('base64');
  // timingSafeEqual requires equal lengths.
  const a = Buffer.from(computed);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

exports.handle = async (req, res) => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    const signature = req.headers[SHOPIFY_HMAC_HEADER];
    const topic     = req.headers[SHOPIFY_TOPIC_HEADER];
    const shop      = req.headers[SHOPIFY_SHOP_HEADER];

    if (!verifyHmac(rawBody, signature)) {
      return res.status(401).send('Invalid signature');
    }
    if (!topic) {
      return res.status(400).send('Missing topic');
    }

    const entityType = TOPIC_TO_ENTITY[topic];
    if (!entityType) {
      // Unknown topic — ack so Shopify stops retrying, but log it.
      console.warn(`[shopify-webhook] unhandled topic: ${topic}`);
      return res.status(200).send('OK');
    }

    let payload;
    try { payload = JSON.parse(rawBody.toString('utf8')); }
    catch { return res.status(400).send('Invalid JSON'); }

    // Resolve tenant. Shopify webhooks are unauthenticated — we resolve the
    // company by shop domain, set up at OAuth-install time. If your install
    // model differs, replace this lookup accordingly.
    const companyId = await resolveCompanyByShop(shop);
    if (!companyId) {
      console.warn(`[shopify-webhook] no company mapped for shop: ${shop}`);
      return res.status(200).send('OK'); // ack; misconfigured tenant
    }

    await queues.webhooks.add(entityType, {
      source: 'shopify',
      topic,
      shop,
      companyId,
      payload,
    });

    return res.status(200).send('OK');
  } catch (err) {
    console.error('[shopify-webhook] error:', err);
    // Return 200 so Shopify doesn't retry indefinitely on our bug;
    // we already logged it. Flip to 500 if you'd rather be retried.
    return res.status(200).send('OK');
  }
};

// ---------- helpers ----------
// Replace this with the lookup that maps a Shopify shop domain to your
// internal company_id. This is intentionally light so it doesn't depend on
// new tables. If a `shopify_shop_domain` column exists on `companies`, use it.
const resolveCompanyByShop = async (shop) => {
  if (!shop) return null;
  try {
    const { Company } = require('../model');
    const row = await Company.findOne({
      where: { shopify_shop_domain: shop },
      attributes: ['id'],
    });
    return row?.id ?? null;
  } catch {
    return null;
  }
};
