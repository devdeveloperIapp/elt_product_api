/**
 * Schema Tool
 *
 * Describes ONLY the tables in the TENANT_TABLES allowlist (see ../security.js),
 * always under their bare name — never schema-qualified. That matters: the query
 * tool shadows each bare name with a company-scoped CTE, and rejects any
 * schema-qualified reference (which would escape the shadow). So the names the
 * model is shown here are exactly the names it is allowed to use.
 *
 * Tables holding credentials, tokens or user records are simply absent from the
 * allowlist, so they are never described and cannot be queried.
 */

const { mainDB, warehouseV2DB } = require('../../connection/dbConnection');
const { QueryTypes } = require('sequelize');
const { TENANT_TABLES, BLOCKED_COLUMNS } = require('../security');

const CONNECTIONS = { warehouse: warehouseV2DB, main: mainDB };

// Keywords in the user's question -> tables likely relevant, to keep the prompt small.
const TABLE_KEYWORDS = {
    revenue:     ['fact_invoices', 'fact_transactions', 'agg_revenue_monthly', 'vw_revenue_monthly', 'report_profit_loss'],
    income:      ['fact_transactions', 'fact_invoices', 'report_profit_loss'],
    profit:      ['report_profit_loss', 'fact_transactions'],
    invoice:     ['fact_invoices', 'dim_customers'],
    bill:        ['fact_bills', 'dim_vendors'],
    payment:     ['fact_payments', 'dim_customers'],
    paid:        ['fact_invoices', 'fact_bills'],
    unpaid:      ['fact_invoices', 'vw_ar_aging'],
    overdue:     ['fact_invoices', 'vw_ar_aging'],
    aging:       ['vw_ar_aging'],
    status:      ['fact_invoices', 'fact_bills', 'fact_payments'],
    expense:     ['fact_bills', 'fact_transactions', 'report_profit_loss'],
    transaction: ['fact_transactions'],
    cash:        ['report_cash_flow', 'fact_payments'],
    balance:     ['report_balance_sheet'],
    customer:    ['dim_customers', 'fact_invoices'],
    vendor:      ['dim_vendors', 'fact_bills'],
    account:     ['dim_accounts'],
    dashboard:   ['vw_dashboard', 'dashboard_configs', 'chart_configs'],
    report:      ['reports', 'financial_reports', 'scheduled_reports'],
    schedule:    ['scheduled_reports', 'sync_schedules'],
    sync:        ['sync_logs', 'sync_schedules', 'connection_sync_runs'],
    connection:  ['connection_sync_runs', 'sync_logs'],
    source:      ['source', 'excel_connections'],
    excel:       ['excel_connections', 'source'],
    category:    ['categories'],
};

// Built once per process — the allowlist is static, so the column catalog is too.
let catalogCache = null;

const columnsFor = async (def) => {
    if (def.columns) return def.columns;
    const [schema, table] = def.ref.split('.');
    const db = CONNECTIONS[def.db];
    const rows = await db.query(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = :schema AND table_name = :table
          ORDER BY ordinal_position`,
        { replacements: { schema, table }, type: QueryTypes.SELECT }
    );
    return rows
        .map((r) => r.column_name)
        .filter((c) => !BLOCKED_COLUMNS.includes(String(c).toLowerCase()));
};

const buildCatalog = async () => {
    if (catalogCache) return catalogCache;

    const entries = await Promise.all(
        Object.entries(TENANT_TABLES).map(async ([name, def]) => {
            try {
                const cols = await columnsFor(def);
                return cols.length ? [name, cols] : null;
            } catch (err) {
                console.warn(`[schemaTool] skipping ${name}: ${err.message}`);
                return null;
            }
        })
    );

    catalogCache = Object.fromEntries(entries.filter(Boolean));
    console.log(`[schemaTool] catalog built: ${Object.keys(catalogCache).length} allowed tables`);
    return catalogCache;
};

const getRelevantTables = (question, allNames) => {
    const lower = (question || '').toLowerCase();
    const matched = new Set();

    for (const [keyword, tables] of Object.entries(TABLE_KEYWORDS)) {
        if (lower.includes(keyword)) tables.forEach((t) => matched.add(t));
    }

    if (matched.size === 0) return allNames.slice(0, 20);

    const relevant = allNames.filter((t) => matched.has(t));
    const others   = allNames.filter((t) => !matched.has(t)).slice(0, 8);
    return [...relevant, ...others];
};

const getSchema = async (question = '') => {
    try {
        const catalog = await buildCatalog();
        const names   = Object.keys(catalog);
        const chosen  = getRelevantTables(question, names);

        const lines = chosen
            .filter((n) => catalog[n])
            .map((n) => `${n}(${catalog[n].join(', ')})`)
            .join('\n');

        return lines || 'No schema available.';
    } catch (err) {
        console.error('[schemaTool] error:', err.message);
        return 'Schema unavailable.';
    }
};

module.exports = { getSchema };
