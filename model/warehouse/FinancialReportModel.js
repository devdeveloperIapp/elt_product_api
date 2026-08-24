// model/warehouse/FinancialReportModel.js
//
// Lazy factory for the three financial-report tables that live in the legacy
// warehouse DB under schema `domain_tables`:
//   - report_profit_loss
//   - report_balance_sheet
//   - report_cash_flow
//
// DDL for these tables is owned by the bootstrap migration — we deliberately
// do NOT call Model.sync({ alter: true }) here. The previous version did, and
// every boot logged:
//     relation "report_profit_loss_company_id_report_type_date_range_start_date"
//     already exists
// because Sequelize auto-truncates long index names (63-char Postgres limit),
// hits the existing index, and tries to recreate it.
//
// If you ever need to change the shape of these tables, do it in a SQL
// migration and let this factory stay structural-only.

const { DataTypes } = require('sequelize');
const { warehouseDB } = require('../../connection/dbConnection');

const modelCache = {};

const getFinancialReportModel = async (reportType) => {
  const tableName = `report_${reportType}`;
  if (modelCache[tableName]) return modelCache[tableName];

  const model = warehouseDB.define(tableName, {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    company_id:       { type: DataTypes.INTEGER, allowNull: false },
    report_type:      { type: DataTypes.STRING },
    report_name:      { type: DataTypes.STRING },
    report_data:      { type: DataTypes.JSONB },
    date_range_start: { type: DataTypes.DATEONLY },
    date_range_end:   { type: DataTypes.DATEONLY },
    generated_at:     { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName,
    schema: 'domain_tables',
    timestamps: false,
    // Indexes are owned by the migration — listing them here would force
    // Sequelize to validate (and re-create) them on every sync. Keep the
    // model purely structural.
  });

  modelCache[tableName] = model;
  return model;
};

module.exports = getFinancialReportModel;
