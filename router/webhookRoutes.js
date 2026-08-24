const express = require('express');
const router  = express.Router();
const { quickBooksWebhook } = require('../controller/WebhookController');
const { handle: shopifyWebhookHandler } = require('../controller/ShopifyWebhookController');

router.get('/quickbooks', (req, res) => {
  res.json({
    success: true,
    message: 'Webhook endpoint is active ✓',
    url: '/api/webhook/quickbooks',
    method: 'POST'
  });
});

// Shopify webhook — RAW body required for HMAC verification.
router.post(
  '/shopify',
  express.raw({ type: '*/*', limit: '5mb' }),
  shopifyWebhookHandler
);

// ⚠️ raw body chahiye signature verify karne ke liye
// router.post(
//   '/quickbooks',
//   express.raw({ type: 'application/json' }),
//   quickBooksWebhook
// );

router.post(
  '/quickbooks',
  (req, res, next) => {
    // ✅ Content-type check hatao
    express.raw({ type: '*/*' })(req, res, next);
  },
  quickBooksWebhook
);

module.exports = router;