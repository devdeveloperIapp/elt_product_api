// Temporary script — check ZohoBooks row counts across raw + domain schemas
'use strict';

const { Sequelize, QueryTypes } = require('sequelize');

const seq = new Sequelize('elt_warehouse_v2', 'postgres', '!learN@5321@postscript###', {
  host: '154.53.63.157',
  port: 5432,
  dialect: 'postgres',
  logging: false,
  dialectOptions: { connectTimeout: 10000 },
});

(async () => {
  try {
    await seq.authenticate();
    console.log('Connected to elt_warehouse_v2\n');

    const schemas = ['zohobooks_raw', 'zohobooks_domain'];

    for (const schema of schemas) {
      const tables = await seq.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = :schema AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
        { replacements: { schema }, type: QueryTypes.SELECT }
      );

      console.log(`=== ${schema} (${tables.length} tables) ===`);

      if (tables.length === 0) {
        console.log('  (no tables found)');
      }

      for (const row of tables) {
        // Sequelize returns rows as arrays when columns are single-value selects
        const tname = Array.isArray(row) ? row[0] : (row.table_name || Object.values(row)[0]);
        try {
          const [countRow] = await seq.query(
            `SELECT COUNT(*) AS cnt FROM "${schema}"."${tname}"`,
            { type: QueryTypes.SELECT }
          );
          // count row may also be an array
          const count = Array.isArray(countRow) ? countRow[0] : (countRow.cnt || Object.values(countRow)[0]);
          console.log(`  ${String(tname).padEnd(34)} ${String(count).padStart(6)} rows`);
        } catch (e) {
          console.log(`  ${String(tname).padEnd(34)} ERROR: ${e.message}`);
        }
      }
      console.log('');
    }

    // Grand totals
    const [rawTotal] = await seq.query(
      `SELECT COALESCE(SUM(n_live_tup), 0) AS total FROM pg_stat_user_tables WHERE schemaname = 'zohobooks_raw'`,
      { type: QueryTypes.SELECT }
    );
    const [domainTotal] = await seq.query(
      `SELECT COALESCE(SUM(n_live_tup), 0) AS total FROM pg_stat_user_tables WHERE schemaname = 'zohobooks_domain'`,
      { type: QueryTypes.SELECT }
    );

    console.log('=== TOTALS ===');
    const rt = Array.isArray(rawTotal)    ? rawTotal[0]    : (rawTotal.total    || Object.values(rawTotal)[0]);
    const dt = Array.isArray(domainTotal) ? domainTotal[0] : (domainTotal.total || Object.values(domainTotal)[0]);
    console.log(`  zohobooks_raw    total rows  : ${rt}`);
    console.log(`  zohobooks_domain total rows  : ${dt}`);

  } catch (err) {
    console.error('Fatal:', err.message);
  } finally {
    await seq.close();
  }
})();
