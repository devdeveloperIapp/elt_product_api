// services/shopify/shopifySyncService.js
//
// Fetches all Shopify entities via the REST API and loads them into the
// warehouse pipeline:
//
//   Shopify API  →  shopify_raw.raw_<entity>  →  shopify_domain.*
//
// Entities synced: Order, Customer, Product, CustomCollection,
//                  SmartCollection, DraftOrder, PriceRule
//
// Usage:
//   const { runShopifySync } = require('./shopifySyncService');
//   await runShopifySync({ sourceId, companyId, shop, accessToken });
//
// The function is intentionally synchronous from the caller's perspective —
// wrap in setImmediate() or a BullMQ job to make it non-blocking.

'use strict';

// node-fetch v3 is ESM-only — use Node 18+ global fetch instead
const Source = require('../../model/sourceModel');
const { insertRawData, transformToDomain } = require('../warehouse/ingestionService');

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-01';
const PAGE_SIZE   = 250; // Shopify max per page
const RATE_DELAY  = 500; // ms between pages (2 req/s safety margin)

// ---------- helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch all pages of a Shopify REST resource using cursor-based pagination.
 *
 * @param {string} shop        e.g. "my-store.myshopify.com"
 * @param {string} accessToken Shopify access token
 * @param {string} resource    e.g. "orders", "customers", "products"
 * @param {object} params      extra query params e.g. { status: 'any' }
 * @returns {Promise<object[]>}
 */
async function fetchAllPages(shop, accessToken, resource, params = {}) {
  const query   = new URLSearchParams({ limit: PAGE_SIZE, ...params }).toString();
  let   pageUrl = `https://${shop}/admin/api/${API_VERSION}/${resource}.json?${query}`;
  const all     = [];
  let   page    = 1;

  while (pageUrl) {
    const res = await fetch(pageUrl, {
      headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
    });

    // Respect Shopify rate limit (429 = too many requests)
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') || 1) * 1000;
      console.warn(`[shopify-sync] Rate limited on ${resource} page ${page}. Retrying in ${retryAfter}ms`);
      await sleep(retryAfter);
      continue; // retry same URL
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Shopify ${resource} page ${page}: HTTP ${res.status} — ${body}`);
    }

    const data  = await res.json();
    const items = data[resource] ?? [];
    all.push(...items);

    pageUrl = extractNextPage(res.headers.get('link'));
    page++;
    if (pageUrl) await sleep(RATE_DELAY);
  }

  return all;
}

/**
 * Extract the "next" cursor URL from a Shopify Link header.
 * Link: <https://...?page_info=xxx>; rel="next", <...>; rel="previous"
 */
function extractNextPage(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

/**
 * Safely fetch an entity — returns an empty array and logs a warning if the
 * store hasn't granted the required scope (HTTP 403) instead of aborting
 * the entire sync.
 */
async function safeFetch(label, fetchFn) {
  try {
    return await fetchFn();
  } catch (err) {
    // 403 = scope not approved by merchant; warn and skip this entity
    if (err.message && err.message.includes('HTTP 403')) {
      console.warn(`[shopify-sync] ⚠️  Skipping ${label} — scope not granted: ${err.message}`);
      return [];
    }
    throw err; // re-throw unexpected errors
  }
}

// ---------- entity fetchers ----------

const fetchOrders              = (shop, token) => fetchAllPages(shop, token, 'orders',             { status: 'any' });
const fetchCustomers           = (shop, token) => fetchAllPages(shop, token, 'customers');
const fetchProducts            = (shop, token) => fetchAllPages(shop, token, 'products');
const fetchCustomCollections   = (shop, token) => fetchAllPages(shop, token, 'custom_collections');
const fetchSmartCollections    = (shop, token) => fetchAllPages(shop, token, 'smart_collections');
const fetchDraftOrders         = (shop, token) => fetchAllPages(shop, token, 'draft_orders');
const fetchPriceRules          = (shop, token) => fetchAllPages(shop, token, 'price_rules');
const fetchLocations           = (shop, token) => fetchAllPages(shop, token, 'locations');
const fetchCollects            = (shop, token) => fetchAllPages(shop, token, 'collects');
const fetchAbandonedCheckouts  = (shop, token) => fetchAllPages(shop, token, 'checkouts');
const fetchTenderTransactions  = (shop, token) => fetchAllPages(shop, token, 'tender_transactions');
const fetchGiftCards           = (shop, token) => fetchAllPages(shop, token, 'gift_cards');

// ---------- public API ----------

/**
 * Full sync: raw ingest → domain transform.
 *
 * Runs all entity fetches in parallel for speed, then runs the domain
 * transform once all raw data is committed.
 *
 * @param {object} opts
 * @param {number} opts.sourceId    Source row ID (used for status updates)
 * @param {number} opts.companyId   Tenant ID
 * @param {string} opts.shop        e.g. "my-store.myshopify.com"
 * @param {string} opts.accessToken Shopify access token
 * @returns {Promise<{raw, domain, error?}>}
 */
async function runShopifySync({ sourceId, companyId, shop, accessToken }) {
  const summary = { sourceId, companyId, shop, raw: {}, domain: {} };

  try {
    // -- mark source as syncing --
    await Source.update({ status: 'processing' }, { where: { id: sourceId } });

    console.log(`[shopify-sync] source=${sourceId} company=${companyId} shop=${shop} — starting`);

    // Step 1: fetch all entities from Shopify in parallel
    // safeFetch ensures a single 403 (missing scope) skips that entity instead of aborting
    const [
      orders, customers, products,
      customCollections, smartCollections, draftOrders, priceRules,
      locations, collects, abandonedCheckouts, tenderTransactions, giftCards,
    ] = await Promise.all([
      safeFetch('orders',               () => fetchOrders(shop, accessToken)),
      safeFetch('customers',            () => fetchCustomers(shop, accessToken)),
      safeFetch('products',             () => fetchProducts(shop, accessToken)),
      safeFetch('custom_collections',   () => fetchCustomCollections(shop, accessToken)),
      safeFetch('smart_collections',    () => fetchSmartCollections(shop, accessToken)),
      safeFetch('draft_orders',         () => fetchDraftOrders(shop, accessToken)),
      safeFetch('price_rules',          () => fetchPriceRules(shop, accessToken)),
      safeFetch('locations',            () => fetchLocations(shop, accessToken)),
      safeFetch('collects',             () => fetchCollects(shop, accessToken)),
      safeFetch('checkouts',            () => fetchAbandonedCheckouts(shop, accessToken)),
      safeFetch('tender_transactions',  () => fetchTenderTransactions(shop, accessToken)),
      safeFetch('gift_cards',           () => fetchGiftCards(shop, accessToken)),
    ]);

    console.log(
      `[shopify-sync] fetched — orders:${orders.length} customers:${customers.length} products:${products.length} ` +
      `customCollections:${customCollections.length} smartCollections:${smartCollections.length} ` +
      `draftOrders:${draftOrders.length} priceRules:${priceRules.length} ` +
      `locations:${locations.length} collects:${collects.length} abandonedCheckouts:${abandonedCheckouts.length} ` +
      `tenderTransactions:${tenderTransactions.length} giftCards:${giftCards.length}`
    );

    if (orders.length === 0 && customers.length === 0 && products.length === 0) {
      console.warn(`[shopify-sync] ⚠️  All entity counts are 0 — the store may be empty or the access token lacks read scopes`);
    }

    // Step 2: upsert into raw layer (shopify_raw.raw_*)
    // Shopify uses numeric `id` as the natural key
    const [
      rawOrders, rawCustomers, rawProducts,
      rawCustomCollections, rawSmartCollections, rawDraftOrders, rawPriceRules,
      rawLocations, rawCollects, rawAbandonedCheckouts, rawTenderTransactions, rawGiftCards,
    ] = await Promise.all([
      insertRawData('shopify', 'Order',               orders,               { companyId, sourceIdField: 'id'    }),
      insertRawData('shopify', 'Customer',            customers,            { companyId, sourceIdField: 'id'    }),
      insertRawData('shopify', 'Product',             products,             { companyId, sourceIdField: 'id'    }),
      insertRawData('shopify', 'CustomCollection',    customCollections,    { companyId, sourceIdField: 'id'    }),
      insertRawData('shopify', 'SmartCollection',     smartCollections,     { companyId, sourceIdField: 'id'    }),
      insertRawData('shopify', 'DraftOrder',          draftOrders,          { companyId, sourceIdField: 'id'    }),
      insertRawData('shopify', 'PriceRule',           priceRules,           { companyId, sourceIdField: 'id'    }),
      insertRawData('shopify', 'Location',            locations,            { companyId, sourceIdField: 'id'    }),
      insertRawData('shopify', 'Collect',             collects,             { companyId, sourceIdField: 'id'    }),
      insertRawData('shopify', 'AbandonedCheckout',   abandonedCheckouts,   { companyId, sourceIdField: 'token' }),
      insertRawData('shopify', 'TenderTransaction',   tenderTransactions,   { companyId, sourceIdField: 'id'    }),
      insertRawData('shopify', 'GiftCard',            giftCards,            { companyId, sourceIdField: 'id'    }),
    ]);

    summary.raw = {
      orders:              rawOrders.inserted,
      customers:           rawCustomers.inserted,
      products:            rawProducts.inserted,
      customCollections:   rawCustomCollections.inserted,
      smartCollections:    rawSmartCollections.inserted,
      draftOrders:         rawDraftOrders.inserted,
      priceRules:          rawPriceRules.inserted,
      locations:           rawLocations.inserted,
      collects:            rawCollects.inserted,
      abandonedCheckouts:  rawAbandonedCheckouts.inserted,
      tenderTransactions:  rawTenderTransactions.inserted,
      giftCards:           rawGiftCards.inserted,
    };

    console.log(`[shopify-sync] raw inserted:`, summary.raw);

    // Step 3: transform raw → domain
    summary.domain = await transformToDomain('shopify', { companyId });

    console.log(`[shopify-sync] domain populated:`, summary.domain);

    // -- mark source as completed (merge last_synced_at + record counts into
    //    existing JSON so the frontend can show a "N orders imported" summary
    //    after the OAuth redirect, without a live progress socket) --
    const sourceRow = await Source.findByPk(sourceId);
    await Source.update(
      {
        status: 'completed',
        connector_settings_json: {
          ...(sourceRow?.connector_settings_json || {}),
          last_synced_at: new Date().toISOString(),
          last_sync_summary: summary.raw,
          last_sync_error: null,
        },
      },
      { where: { id: sourceId } }
    );

    console.log(`[shopify-sync] source=${sourceId} — sync complete`);

  } catch (err) {
    summary.error = err.message;
    console.error(`[shopify-sync] source=${sourceId} — sync failed:`, err.message);

    const failedSourceRow = await Source.findByPk(sourceId).catch(() => null);
    await Source.update(
      {
        status: 'failed',
        connector_settings_json: {
          ...(failedSourceRow?.connector_settings_json || {}),
          last_sync_error: err.message,
        },
      },
      { where: { id: sourceId } }
    ).catch(() => {});
  }

  return summary;
}

module.exports = { runShopifySync };
