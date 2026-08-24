/**
 * MCP Security Layer
 *
 * TENANT ISOLATION — how it works, and why it changed
 * ---------------------------------------------------
 * The old approach appended " AND company_id = N" to the model's SQL. That is
 * not safe, and leaked in practice:
 *
 *   WHERE status='Paid' OR status='Overdue'   +   AND company_id = 1
 *     => WHERE status='Paid' OR (status='Overdue' AND company_id = 1)
 *   ...because AND binds tighter than OR, the first branch stayed unscoped and
 *   returned every tenant's rows. It also skipped scoping entirely whenever the
 *   SQL merely mentioned "company_id" (e.g. GROUP BY company_id), and it could
 *   not scope JOINs or subqueries.
 *
 * You cannot enforce tenant isolation by editing SQL text. So instead we now
 * SHADOW each allowed table with a CTE that is already filtered to the caller's
 * company:
 *
 *   WITH fact_invoices AS (
 *     SELECT * FROM quickbooks_domain.fact_invoices WHERE company_id = 1
 *   )
 *   SELECT ... FROM fact_invoices WHERE status='Paid' OR status='Overdue'
 *
 * A CTE name takes precedence over a base table of the same name, so every
 * reference the model writes — in a JOIN, a subquery, a GROUP BY, behind an OR,
 * anywhere — resolves to the pre-filtered rows. Operator precedence stops
 * mattering because the other tenants' rows are not in scope to begin with.
 *
 * Two further consequences of the allowlist below:
 *   • Tables that are not listed cannot be read at all (users, OAuth token
 *     tables, destinations...) — enforced before the query ever runs.
 *   • A table may expose a subset of columns (see `columns`). Secrets are not in
 *     the CTE, so "SELECT refresh_token AS notes" fails instead of leaking.
 */

// ─── Allowlist: bare name the model writes -> where it really lives ──────────
// `db`      : which connection to run on ('warehouse' | 'main')
// `ref`     : the real, schema-qualified relation
// `columns` : optional projection. Omit to expose all columns.
// Every table here MUST have a company_id column — scoping depends on it.
const TENANT_TABLES = {
  // ── elt_warehouse_v2 / quickbooks_domain ──
  fact_invoices:        { db: 'warehouse', ref: 'quickbooks_domain.fact_invoices' },
  fact_bills:           { db: 'warehouse', ref: 'quickbooks_domain.fact_bills' },
  fact_payments:        { db: 'warehouse', ref: 'quickbooks_domain.fact_payments' },
  fact_transactions:    { db: 'warehouse', ref: 'quickbooks_domain.fact_transactions' },
  fact_salesreceipts:   { db: 'warehouse', ref: 'quickbooks_domain.fact_salesreceipts' },
  dim_customers:        { db: 'warehouse', ref: 'quickbooks_domain.dim_customers' },
  dim_vendors:          { db: 'warehouse', ref: 'quickbooks_domain.dim_vendors' },
  dim_accounts:         { db: 'warehouse', ref: 'quickbooks_domain.dim_accounts' },
  agg_revenue_monthly:  { db: 'warehouse', ref: 'quickbooks_domain.agg_revenue_monthly' },
  report_balance_sheet: { db: 'warehouse', ref: 'quickbooks_domain.report_balance_sheet' },
  report_cash_flow:     { db: 'warehouse', ref: 'quickbooks_domain.report_cash_flow' },
  report_profit_loss:   { db: 'warehouse', ref: 'quickbooks_domain.report_profit_loss' },
  vw_ar_aging:          { db: 'warehouse', ref: 'quickbooks_domain.vw_ar_aging' },
  vw_dashboard:         { db: 'warehouse', ref: 'quickbooks_domain.vw_dashboard' },
  vw_revenue_monthly:   { db: 'warehouse', ref: 'quickbooks_domain.vw_revenue_monthly' },

  // ── elt_product (main) ──
  reports:              { db: 'main', ref: 'public.reports' },
  financial_reports:    { db: 'main', ref: 'public.financial_reports' },
  scheduled_reports:    { db: 'main', ref: 'public.scheduled_reports' },
  categories:           { db: 'main', ref: 'public.categories' },
  chart_configs:        { db: 'main', ref: 'public.chart_configs' },
  dashboard_configs:    { db: 'main', ref: 'public.dashboard_configs' },
  sync_logs:            { db: 'main', ref: 'public.sync_logs' },
  sync_schedules:       { db: 'main', ref: 'public.sync_schedules' },
  connection_sync_runs: { db: 'main', ref: 'public.connection_sync_runs' },
  excel_connections:    { db: 'main', ref: 'public.excel_connections' },
  suggested_question:   { db: 'main', ref: 'public.suggested_question' },
  // connector_settings_json can hold OAuth tokens — never expose it.
  source: {
    db: 'main',
    ref: 'public.source',
    columns: ['id', 'source_name', 'connector_name', 'status', 'created_on', 'company_id'],
  },
};

// Deliberately NOT in the allowlist (and therefore unreadable):
//   users, refresh_tokens, roles/permissions, airbyte_access_tokens,
//   quickbooks_connections, google_sheets_connections, google_drive_connections,
//   destination, connections, quickbooks_data, user_qb_companies
// Kept for the schema tool / callers that still import it.
const BLOCKED_TABLES = [
  'users', 'user', 'refresh_tokens', 'refreshtoken',
  'airbyte_access_tokens', 'airbyteaccesstoken',
  'roles', 'permissions', 'role_permissions',
  'rolePermission', 'navigationpermission',
];

// ─── Columns always stripped from results (defence in depth) ─────────────────
const BLOCKED_COLUMNS = [
  'password', 'password_hash', 'token', 'refresh_token',
  'access_token', 'secret', 'api_key', 'private_key',
  'client_secret', 'otp', 'pin',
];

// ─── Only SELECT is allowed — all write/admin keywords are banned ────────────
// Matched on WORD boundaries: a plain substring match would reject ordinary
// columns like created_at / updated_at / deleted_at (they contain "create",
// "update", "delete") and break legitimate queries.
const BLOCKED_SQL_WORDS = [
  'drop', 'delete', 'update', 'insert', 'alter', 'truncate',
  'create', 'exec', 'execute', 'grant', 'revoke', 'call',
  'load_file', 'pg_sleep', 'pg_read_file', 'pg_ls_dir', 'pg_stat',
  'information_schema', 'pg_catalog', 'pg_shadow', 'pg_user',
  'xp_cmdshell', 'waitfor', 'union',
];

// Multi-token / punctuation patterns — matched as plain substrings.
const BLOCKED_SQL_FRAGMENTS = [
  'into outfile', 'load data', 'copy ', '--', '/*', '*/',
];

// A schema-qualified name would bypass the CTE shadow, so it is rejected.
const SCHEMA_PREFIX_RE = new RegExp(
  '\\b(?:quickbooks_domain|quickbooks_raw|zohobooks_domain|zohobooks_raw|' +
  'shopify_domain|shopify_raw|google_sheets_domain|google_sheets_raw|' +
  'google_drive_domain|google_drive_raw|excel_domain|excel_raw|' +
  'public|pg_catalog|pg_temp|information_schema)\\s*\\.',
  'i'
);

/**
 * Sanitise the user's raw chat input before it ever reaches the model.
 */
const sanitizeUserInput = (input) => {
  if (typeof input !== 'string') throw new Error('Invalid input type.');
  if (input.length > 500) throw new Error('Message too long. Maximum 500 characters.');

  let clean = input.replace(/<[^>]*>/g, '');
  clean = clean.replace(/\x00/g, '');
  clean = clean.replace(/\s+/g, ' ').trim();

  if (clean.length === 0) throw new Error('Empty message.');
  return clean;
};

/**
 * Some SQL functions use FROM as an argument separator, not to introduce a
 * table: EXTRACT(YEAR FROM due_date), SUBSTRING(x FROM 1 FOR 2),
 * TRIM(BOTH ' ' FROM name), OVERLAY(x PLACING y FROM 2).
 * Those FROMs must not be mistaken for table references.
 *
 * We blank out ONLY the FROM keyword in those specific syntaxes, and only for
 * analysis — the SQL actually executed is always the untouched original.
 * A table reference can never appear in these positions (they are expressions),
 * so no real table can hide behind this transform.
 */
const analysableSQL = (sql) =>
  sql
    .replace(/\b(extract\s*\(\s*\w+)\s+from\b/gi, '$1 __arg__')
    .replace(/\b(substring|trim|overlay)(\s*\([^()]*?)\bfrom\b/gi, '$1$2__arg__');

/** Every relation the SQL reads from (FROM / JOIN targets), lower-cased. */
const referencedRelations = (sql) => {
  const re = /\b(?:from|join)\s+([a-zA-Z_][\w$]*)/gi;
  const found = new Set();
  let m;
  const scannable = analysableSQL(sql);
  while ((m = re.exec(scannable)) !== null) found.add(m[1].toLowerCase());
  return [...found];
};

/**
 * Validate model-generated SQL. Throws on anything we cannot prove is safe.
 * @returns {{ relations: string[], db: 'warehouse'|'main' }}
 */
const validateSQL = (sql) => {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new Error('Empty SQL query.');
  }

  const trimmed = sql.trim();
  const lower   = trimmed.toLowerCase();

  if (!lower.startsWith('select')) {
    throw new Error('Only SELECT queries are permitted.');
  }

  // The WITH clause is reserved for tenant scoping — the model must not supply one.
  if (/\bwith\b/i.test(trimmed)) {
    throw new Error('WITH/CTE clauses are not permitted.');
  }

  // At most one trailing semicolon (no stacked statements).
  if (trimmed.replace(/;\s*$/, '').includes(';')) {
    throw new Error('Multiple statements are not permitted.');
  }

  for (const fragment of BLOCKED_SQL_FRAGMENTS) {
    if (lower.includes(fragment)) {
      throw new Error(`Blocked pattern detected: "${fragment.trim()}".`);
    }
  }

  for (const word of BLOCKED_SQL_WORDS) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(lower)) {
      throw new Error(`Blocked keyword detected: "${word}".`);
    }
  }

  // Would escape the CTE shadow and read unscoped rows.
  if (SCHEMA_PREFIX_RE.test(trimmed)) {
    throw new Error('Schema-qualified table names are not permitted — use the bare table names from the schema.');
  }

  const relations = referencedRelations(trimmed);
  if (relations.length === 0) {
    throw new Error('Query must read from at least one known table.');
  }

  for (const rel of relations) {
    if (!TENANT_TABLES[rel]) {
      throw new Error(`Table "${rel}" is not available.`);
    }
  }

  const dbs = new Set(relations.map((r) => TENANT_TABLES[r].db));
  if (dbs.size > 1) {
    throw new Error('Cannot combine QuickBooks warehouse tables with application tables in one query.');
  }

  return { relations, db: [...dbs][0] };
};

/**
 * Wrap the model's SQL so every table it reads is pre-filtered to `companyId`.
 * @returns {{ sql: string, db: 'warehouse'|'main' }}
 */
const buildScopedQuery = (sql, companyId) => {
  const cid = Number.parseInt(companyId, 10);
  if (!Number.isInteger(cid) || cid <= 0) {
    throw new Error('Company ID missing — cannot scope query.');
  }

  const { relations, db } = validateSQL(sql);

  const ctes = relations.map((name) => {
    const def  = TENANT_TABLES[name];
    const cols = def.columns ? def.columns.join(', ') : '*';
    return `${name} AS (SELECT ${cols} FROM ${def.ref} WHERE company_id = ${cid})`;
  });

  const body = sql.trim().replace(/;\s*$/, '');
  return { sql: `WITH ${ctes.join(', ')} ${body}`, db };
};

/**
 * Force a LIMIT on the result set so the model can never dump a whole table.
 */
const enforceLimitCap = (sql, cap = 100) => {
  if (/\blimit\b/i.test(sql)) return sql;
  return sql.replace(/;?\s*$/, '') + ` LIMIT ${cap}`;
};

/**
 * Strip sensitive columns from results before they reach the frontend.
 */
const stripSensitiveFields = (rows) => {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => {
    const clean = { ...row };
    for (const col of BLOCKED_COLUMNS) {
      delete clean[col];
    }
    return clean;
  });
};

module.exports = {
  sanitizeUserInput,
  validateSQL,
  buildScopedQuery,
  enforceLimitCap,
  stripSensitiveFields,
  TENANT_TABLES,
  BLOCKED_TABLES,
  BLOCKED_COLUMNS,
  BLOCKED_SQL_WORDS,
  BLOCKED_SQL_FRAGMENTS,
};
