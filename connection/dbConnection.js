// connection/dbConnection.js
const { Sequelize } = require('sequelize');

// Main ELT product DB (Companies, Users, Sources, QuickBooksConnection, etc.)
const mainDB = new Sequelize(
  process.env.POSTGRESQL_DATABASE,
  process.env.POSTGRESQL_USER,
  process.env.POSTGRESQL_PASSWORD,
  {
    host: process.env.POSTGRESQL_HOST,
    dialect: 'postgres',
    logging: false,
  }
);

// Legacy warehouse DB (kept for backward compatibility — old domain_tables.*, public.raw_*).
// Read from WAREHOUSE_DB env. Will be retired once all sources are migrated to v2.
const warehouseDB = new Sequelize(
  process.env.WAREHOUSE_DB,
  process.env.WAREHOUSE_DB_USER,
  process.env.WAREHOUSE_DB_PASSWORD,
  {
    host: process.env.WAREHOUSE_DB_HOST,
    port: process.env.WAREHOUSE_DB_PORT || 5432,
    dialect: 'postgres',
    logging: false,
  }
);

// New per-source warehouse: elt_warehouse_v2.
// Source-specific schemas: quickbooks_raw / quickbooks_domain / zohobooks_raw / zohobooks_domain / shopify_raw / shopify_domain
const warehouseV2DB = new Sequelize(
  process.env.WAREHOUSE_V2_DB || 'elt_warehouse_v2',
  process.env.WAREHOUSE_V2_DB_USER || process.env.WAREHOUSE_DB_USER,
  process.env.WAREHOUSE_V2_DB_PASSWORD || process.env.WAREHOUSE_DB_PASSWORD,
  {
    host: process.env.WAREHOUSE_V2_DB_HOST || process.env.WAREHOUSE_DB_HOST,
    port: process.env.WAREHOUSE_V2_DB_PORT || process.env.WAREHOUSE_DB_PORT || 5432,
    dialect: 'postgres',
    logging: false,
    pool: { max: 20, min: 2, acquire: 60000, idle: 10000 },
  }
);

module.exports = { mainDB, warehouseDB, warehouseV2DB };
