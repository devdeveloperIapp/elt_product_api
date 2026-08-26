// services/zoho/zohobooksSyncService.js
//
// Fetches all ZohoBooks entities via the REST API and loads them into the
// warehouse pipeline:
//
//   ZohoBooks API  →  zohobooks_raw.raw_<entity>  →  zohobooks_domain.*
//
// Entities synced: Customer, Vendor, Item, Invoice, Bill, Payment,
//                  VendorPayment, SalesOrder, PurchaseOrder, Expense,
//                  CreditNote, Estimate
//
// Usage:
//   const { runZohoBooksSync } = require('./zohobooksSyncService');
//   await runZohoBooksSync({ sourceId, companyId, accessToken, organizationId, booksBaseUrl });

'use strict';

const Source = require('../../model/sourceModel');
const { insertRawData, transformToDomain } = require('../warehouse/ingestionService');

const PAGE_SIZE  = 200;   // ZohoBooks max per page
const RATE_DELAY = 300;   // ms between pages

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- helpers ----------

/**
 * Fetch all pages of a ZohoBooks list endpoint.
 * ZohoBooks pagination: ?page=1&per_page=200
 * Response shape: { [resourceKey]: [...], page_context: { has_more_page: true/false } }
 */
async function fetchAllPages(booksBase, accessToken, organizationId, resource, resourceKey, params = {}) {
  const all  = [];
  let   page = 1;
  let   hasMore = true;

  while (hasMore) {
    const query = new URLSearchParams({
      organization_id: organizationId,
      page,
      per_page: PAGE_SIZE,
      ...params,
    }).toString();

    const url = `${booksBase}/books/v3/${resource}?${query}`;

    const res = await fetch(url, {
      headers: {
        Authorization:  `Zoho-oauthtoken ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') || 2) * 1000;
      console.warn(`[zoho-sync] Rate limited on ${resource} page ${page}. Retrying in ${retryAfter}ms`);
      await sleep(retryAfter);
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ZohoBooks ${resource} page ${page}: HTTP ${res.status} — ${body}`);
    }

    const data  = await res.json();

    // ZohoBooks returns error code in JSON body even on 200
    if (data.code !== undefined && data.code !== 0) {
      throw new Error(`ZohoBooks API error on ${resource}: ${data.message || data.code}`);
    }

    const items = data[resourceKey] ?? [];
    all.push(...items);

    hasMore = data.page_context?.has_more_page === true;
    page++;

    if (hasMore) await sleep(RATE_DELAY);
  }

  return all;
}

// ---------- safeFetch wrapper ----------
/**
 * Wraps a fetch call and returns [] on HTTP 404 (invalid URL / feature not enabled)
 * or HTTP 403 (scope not granted), so one missing entity never aborts the whole sync.
 */
async function safeFetch(label, fetchFn) {
  try {
    return await fetchFn();
  } catch (err) {
    if (err.message && (err.message.includes('HTTP 404') || err.message.includes('HTTP 403'))) {
      console.warn(`[zoho-sync] ⚠️  Skipping ${label} — endpoint unavailable: ${err.message}`);
      return [];
    }
    throw err;
  }
}

// ---------- entity fetchers ----------
// ZohoBooks contacts API returns both customers and vendors via filter

const fetchCustomers      = (base, token, orgId) =>
  fetchAllPages(base, token, orgId, 'contacts', 'contacts', { contact_type: 'customer', status: 'active' });

const fetchVendors        = (base, token, orgId) =>
  fetchAllPages(base, token, orgId, 'contacts', 'contacts', { contact_type: 'vendor', status: 'active' });

const fetchItems          = (base, token, orgId) =>
  fetchAllPages(base, token, orgId, 'items', 'items');

const fetchInvoices       = (base, token, orgId) =>
  fetchAllPages(base, token, orgId, 'invoices', 'invoices');

const fetchBills          = (base, token, orgId) =>
  fetchAllPages(base, token, orgId, 'bills', 'bills');

const fetchPayments       = (base, token, orgId) =>
  fetchAllPages(base, token, orgId, 'customerpayments', 'customerpayments');

const fetchVendorPayments = (base, token, orgId) =>
  fetchAllPages(base, token, orgId, 'vendorpayments', 'vendorpayments');

const fetchSalesOrders    = (base, token, orgId) =>
  fetchAllPages(base, token, orgId, 'salesorders', 'salesorders');

const fetchPurchaseOrders = (base, token, orgId) =>
  fetchAllPages(base, token, orgId, 'purchaseorders', 'purchaseorders');

const fetchExpenses       = (base, token, orgId) =>
  fetchAllPages(base, token, orgId, 'expenses', 'expenses');

const fetchCreditNotes    = (base, token, orgId) =>
  fetchAllPages(base, token, orgId, 'creditnotes', 'creditnotes');

const fetchEstimates      = (base, token, orgId) =>
  fetchAllPages(base, token, orgId, 'estimates', 'estimates');

// ── settings-module endpoints (live under /settings/*)  ──────────
// Taxes: path is settings/taxes, NOT /taxes (returns 404 otherwise)
const fetchTaxes          = (base, token, orgId) =>
  fetchAllPages(base, token, orgId, 'settings/taxes', 'taxes');

// ── endpoints that may be unavailable depending on plan/scopes ───
const fetchChartOfAccounts   = (base, token, orgId) =>
  fetchAllPages(base, token, orgId, 'chartofaccounts', 'chartofaccounts');

const fetchJournalEntries    = (base, token, orgId) =>
  fetchAllPages(base, token, orgId, 'journals', 'journals');

const fetchRecurringInvoices = (base, token, orgId) =>
  fetchAllPages(base, token, orgId, 'recurringinvoices', 'recurringinvoices');

const fetchBankAccounts      = (base, token, orgId) =>
  fetchAllPages(base, token, orgId, 'bankaccounts', 'bankaccounts');

// Bank transactions are per-account in some Zoho plans; flat endpoint may 404
const fetchBankTransactions  = (base, token, orgId) =>
  fetchAllPages(base, token, orgId, 'banktransactions', 'banktransactions');

const fetchProjects          = (base, token, orgId) =>
  fetchAllPages(base, token, orgId, 'projects', 'projects');

// ZohoBooks API calls these "pricebooks" — resource and response key are both 'pricebooks'
const fetchPriceLists        = (base, token, orgId) =>
  fetchAllPages(base, token, orgId, 'pricebooks', 'pricebooks');

const fetchRetainerInvoices  = (base, token, orgId) =>
  fetchAllPages(base, token, orgId, 'retainerinvoices', 'retainerinvoices');

// ---------- public API ----------

/**
 * Full sync: raw ingest → domain transform.
 *
 * @param {object} opts
 * @param {number} opts.sourceId       Source row ID
 * @param {number} opts.companyId      Tenant ID
 * @param {string} opts.accessToken    ZohoBooks OAuth access token
 * @param {string} opts.organizationId ZohoBooks organisation ID
 * @param {string} opts.booksBaseUrl   e.g. "https://www.zohoapis.in" or "https://www.zohoapis.com"
 * @returns {Promise<{raw, domain, error?}>}
 */
async function runZohoBooksSync({ sourceId, companyId, accessToken, organizationId, booksBaseUrl }) {
  const summary = { sourceId, companyId, raw: {}, domain: {} };

  // Strip trailing slash
  const booksBase = (booksBaseUrl || 'https://www.zohoapis.com').replace(/\/$/, '');

  try {
    // -- mark source as syncing --
    await Source.update({ status: 'processing' }, { where: { id: sourceId } });

    console.log(`[zoho-sync] source=${sourceId} company=${companyId} org=${organizationId} base=${booksBase} — starting`);

    // Step 1: fetch all entities from ZohoBooks sequentially to respect rate limits
    console.log('[zoho-sync] fetching customers...');
    const customers = await fetchCustomers(booksBase, accessToken, organizationId);

    console.log('[zoho-sync] fetching vendors...');
    const vendors = await fetchVendors(booksBase, accessToken, organizationId);

    console.log('[zoho-sync] fetching items...');
    const items = await fetchItems(booksBase, accessToken, organizationId);

    console.log('[zoho-sync] fetching invoices...');
    const invoices = await fetchInvoices(booksBase, accessToken, organizationId);

    console.log('[zoho-sync] fetching bills...');
    const bills = await fetchBills(booksBase, accessToken, organizationId);

    console.log('[zoho-sync] fetching payments...');
    const payments = await fetchPayments(booksBase, accessToken, organizationId);

    console.log('[zoho-sync] fetching vendor payments...');
    const vendorPayments = await safeFetch('vendorPayments',   () => fetchVendorPayments(booksBase, accessToken, organizationId));

    console.log('[zoho-sync] fetching sales orders...');
    const salesOrders = await safeFetch('salesOrders',         () => fetchSalesOrders(booksBase, accessToken, organizationId));

    console.log('[zoho-sync] fetching purchase orders...');
    const purchaseOrders = await safeFetch('purchaseOrders',   () => fetchPurchaseOrders(booksBase, accessToken, organizationId));

    console.log('[zoho-sync] fetching expenses...');
    const expenses = await safeFetch('expenses',               () => fetchExpenses(booksBase, accessToken, organizationId));

    console.log('[zoho-sync] fetching credit notes...');
    const creditNotes = await safeFetch('creditNotes',         () => fetchCreditNotes(booksBase, accessToken, organizationId));

    console.log('[zoho-sync] fetching estimates...');
    const estimates = await safeFetch('estimates',             () => fetchEstimates(booksBase, accessToken, organizationId));

    console.log('[zoho-sync] fetching chart of accounts...');
    const chartOfAccounts = await safeFetch('chartOfAccounts', () => fetchChartOfAccounts(booksBase, accessToken, organizationId));

    console.log('[zoho-sync] fetching journal entries...');
    const journalEntries = await safeFetch('journalEntries',   () => fetchJournalEntries(booksBase, accessToken, organizationId));

    console.log('[zoho-sync] fetching taxes...');
    const taxes = await safeFetch('taxes',                     () => fetchTaxes(booksBase, accessToken, organizationId));

    console.log('[zoho-sync] fetching recurring invoices...');
    const recurringInvoices = await safeFetch('recurringInvoices', () => fetchRecurringInvoices(booksBase, accessToken, organizationId));

    console.log('[zoho-sync] fetching bank accounts...');
    const bankAccounts = await safeFetch('bankAccounts',       () => fetchBankAccounts(booksBase, accessToken, organizationId));

    console.log('[zoho-sync] fetching bank transactions...');
    const bankTransactions = await safeFetch('bankTransactions', () => fetchBankTransactions(booksBase, accessToken, organizationId));

    console.log('[zoho-sync] fetching projects...');
    const projects = await safeFetch('projects',               () => fetchProjects(booksBase, accessToken, organizationId));

    console.log('[zoho-sync] fetching price lists...');
    const priceLists = await safeFetch('priceLists',           () => fetchPriceLists(booksBase, accessToken, organizationId));

    console.log('[zoho-sync] fetching retainer invoices...');
    const retainerInvoices = await safeFetch('retainerInvoices', () => fetchRetainerInvoices(booksBase, accessToken, organizationId));

    console.log(
      `[zoho-sync] fetched — customers:${customers.length} vendors:${vendors.length} items:${items.length} ` +
      `invoices:${invoices.length} bills:${bills.length} payments:${payments.length} ` +
      `vendorPayments:${vendorPayments.length} salesOrders:${salesOrders.length} ` +
      `purchaseOrders:${purchaseOrders.length} expenses:${expenses.length} ` +
      `creditNotes:${creditNotes.length} estimates:${estimates.length} ` +
      `chartOfAccounts:${chartOfAccounts.length} journalEntries:${journalEntries.length} ` +
      `taxes:${taxes.length} recurringInvoices:${recurringInvoices.length} ` +
      `bankAccounts:${bankAccounts.length} bankTransactions:${bankTransactions.length} ` +
      `projects:${projects.length} priceLists:${priceLists.length} retainerInvoices:${retainerInvoices.length}`
    );

    const allEntities = [customers, vendors, items, invoices, bills, payments,
      vendorPayments, salesOrders, purchaseOrders, expenses, creditNotes, estimates,
      chartOfAccounts, journalEntries, taxes, recurringInvoices, bankAccounts,
      bankTransactions, projects, priceLists, retainerInvoices];
    if (allEntities.every(a => a.length === 0)) {
      console.warn('[zoho-sync] ⚠️  All entity counts are 0 — the organisation may be empty or the token lacks scopes');
    }

    // Step 2: upsert into raw layer
    // ZohoBooks uses different id fields per entity
    const [
      rawCustomers, rawVendors, rawItems, rawInvoices, rawBills, rawPayments,
      rawVendorPayments, rawSalesOrders, rawPurchaseOrders, rawExpenses,
      rawCreditNotes, rawEstimates,
      rawChartOfAccounts, rawJournalEntries, rawTaxes, rawRecurringInvoices,
      rawBankAccounts, rawBankTransactions, rawProjects, rawPriceLists, rawRetainerInvoices,
    ] = await Promise.all([
      insertRawData('zohobooks', 'Customer',        customers,        { companyId, sourceIdField: 'contact_id'          }),
      insertRawData('zohobooks', 'Vendor',           vendors,          { companyId, sourceIdField: 'contact_id'          }),
      insertRawData('zohobooks', 'Item',             items,            { companyId, sourceIdField: 'item_id'             }),
      insertRawData('zohobooks', 'Invoice',          invoices,         { companyId, sourceIdField: 'invoice_id'          }),
      insertRawData('zohobooks', 'Bill',             bills,            { companyId, sourceIdField: 'bill_id'             }),
      insertRawData('zohobooks', 'Payment',          payments,         { companyId, sourceIdField: 'payment_id'          }),
      insertRawData('zohobooks', 'VendorPayment',    vendorPayments,   { companyId, sourceIdField: 'payment_id'          }),
      insertRawData('zohobooks', 'SalesOrder',       salesOrders,      { companyId, sourceIdField: 'salesorder_id'       }),
      insertRawData('zohobooks', 'PurchaseOrder',    purchaseOrders,   { companyId, sourceIdField: 'purchaseorder_id'    }),
      insertRawData('zohobooks', 'Expense',          expenses,         { companyId, sourceIdField: 'expense_id'          }),
      insertRawData('zohobooks', 'CreditNote',       creditNotes,      { companyId, sourceIdField: 'creditnote_id'       }),
      insertRawData('zohobooks', 'Estimate',         estimates,        { companyId, sourceIdField: 'estimate_id'         }),
      insertRawData('zohobooks', 'ChartOfAccount',   chartOfAccounts,  { companyId, sourceIdField: 'account_id'          }),
      insertRawData('zohobooks', 'JournalEntry',     journalEntries,   { companyId, sourceIdField: 'journal_id'          }),
      insertRawData('zohobooks', 'Tax',              taxes,            { companyId, sourceIdField: 'tax_id'              }),
      insertRawData('zohobooks', 'RecurringInvoice', recurringInvoices,{ companyId, sourceIdField: 'recurrence_id'       }),
      insertRawData('zohobooks', 'BankAccount',      bankAccounts,     { companyId, sourceIdField: 'account_id'          }),
      insertRawData('zohobooks', 'BankTransaction',  bankTransactions, { companyId, sourceIdField: 'transaction_id'      }),
      insertRawData('zohobooks', 'Project',          projects,         { companyId, sourceIdField: 'project_id'          }),
      insertRawData('zohobooks', 'PriceList',        priceLists,       { companyId, sourceIdField: 'pricebook_id'        }),
      insertRawData('zohobooks', 'RetainerInvoice',  retainerInvoices, { companyId, sourceIdField: 'retainerinvoice_id'  }),
    ]);

    summary.raw = {
      customers:        rawCustomers.inserted,
      vendors:          rawVendors.inserted,
      items:            rawItems.inserted,
      invoices:         rawInvoices.inserted,
      bills:            rawBills.inserted,
      payments:         rawPayments.inserted,
      vendorPayments:   rawVendorPayments.inserted,
      salesOrders:      rawSalesOrders.inserted,
      purchaseOrders:   rawPurchaseOrders.inserted,
      expenses:         rawExpenses.inserted,
      creditNotes:      rawCreditNotes.inserted,
      estimates:        rawEstimates.inserted,
      chartOfAccounts:  rawChartOfAccounts.inserted,
      journalEntries:   rawJournalEntries.inserted,
      taxes:            rawTaxes.inserted,
      recurringInvoices:rawRecurringInvoices.inserted,
      bankAccounts:     rawBankAccounts.inserted,
      bankTransactions: rawBankTransactions.inserted,
      projects:         rawProjects.inserted,
      priceLists:       rawPriceLists.inserted,
      retainerInvoices: rawRetainerInvoices.inserted,
    };

    console.log('[zoho-sync] raw inserted:', summary.raw);

    // Step 3: transform raw → domain
    summary.domain = await transformToDomain('zohobooks', { companyId });

    console.log('[zoho-sync] domain populated:', summary.domain);

    // -- mark source as completed (merge last_synced_at + record counts into
    //    existing JSON so the frontend can show a "N invoices imported"
    //    summary after the OAuth redirect, without a live progress socket) --
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

    console.log(`[zoho-sync] source=${sourceId} — sync complete`);

  } catch (err) {
    summary.error = err.message;
    console.error(`[zoho-sync] source=${sourceId} — sync failed:`, err.message);

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

module.exports = { runZohoBooksSync };
