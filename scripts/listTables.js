require('dotenv').config();
const { mainDB, warehouseV2DB } = require('../connection/dbConnection');
const { QueryTypes } = require('sequelize');

const query = `SELECT table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE' ORDER BY table_name`;

Promise.all([
  mainDB.query(query, { type: QueryTypes.SELECT }),
  warehouseV2DB.query(query, { type: QueryTypes.SELECT }),
])
  .then(([mainRows, whRows]) => {
    console.log('\n=== MAIN DB ===');
    console.log('first row keys:', JSON.stringify(mainRows[0]));
    mainRows.slice(0, 5).forEach(r => console.log(JSON.stringify(r)));
    console.log('\n=== WAREHOUSE V2 DB ===');
    whRows.forEach(r => console.log(r.table_name));
    process.exit(0);
  })
  .catch(e => { console.error(e.message); process.exit(1); });
