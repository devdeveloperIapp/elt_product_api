/**
 * Query Tool
 * Runs model-generated SQL after it has been validated against the table
 * allowlist and rewritten so every table it reads is pre-filtered to the
 * caller's company (see ../security.js for how tenant isolation works).
 */

const { mainDB, warehouseV2DB } = require('../../connection/dbConnection');
const { QueryTypes } = require('sequelize');
const {
    buildScopedQuery,
    enforceLimitCap,
    stripSensitiveFields,
} = require('../security');

const CONNECTIONS = { warehouse: warehouseV2DB, main: mainDB };

/**
 * Execute a SQL query safely.
 * @param {string} sql        - SQL written by the model (bare table names only)
 * @param {number} companyId  - from req.auth.companyId (JWT verified)
 * @returns {{ rows: object[], rowCount: number, sql: string }}
 */
const runQuery = async (sql, companyId) => {
    // Validates + wraps the query in company-scoped CTEs, and tells us which DB
    // the referenced tables live in. Throws if anything cannot be proven safe.
    const { sql: scopedSQL, db } = buildScopedQuery(sql, companyId);
    const finalSQL = enforceLimitCap(scopedSQL, 100);

    const connection = CONNECTIONS[db];
    if (!connection) throw new Error(`Unknown database target "${db}".`);

    const rows = await connection.query(finalSQL, { type: QueryTypes.SELECT });

    // Defence in depth — the allowlist already keeps secret columns out of scope.
    const safeRows = stripSensitiveFields(Array.isArray(rows) ? rows : [rows]);

    return {
        rows: safeRows,
        rowCount: safeRows.length,
        sql: finalSQL,         // returned so the model can explain what it ran
    };
};

module.exports = { runQuery };
