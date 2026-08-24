// model/warehouse/V2FinancialReportModel.js
//
// v2 (warehouse_v2 / quickbooks_domain) counterpart to
// model/warehouse/FinancialReportModel.js. Step 1 of the legacy->v2
// migration (see conversation): dual-write the raw QuickBooks report JSON
// into quickbooks_domain.report_* alongside the existing legacy write, so
// both can be compared before any dashboard read is switched over.
//
// Same shape as the legacy model: stores the raw QB API report payload
// verbatim, not a derived P&L — that's a later step if ever needed.

const { DataTypes } = require('sequelize');
const { defineDomainModel } = require('./DomainModelFactory');

const SOURCE = 'quickbooks';
const modelCache = {};

const getV2FinancialReportModel = (reportType) => {
  const tableName = `report_${reportType}`;
  if (modelCache[tableName]) return modelCache[tableName];

  const model = defineDomainModel(SOURCE, tableName, {
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
    // Indexes owned by scripts/bootstrap_v2_financial_reports.js — kept
    // structural-only here for the same reason as the legacy model (avoid
    // Sequelize re-validating/truncating index names on every boot).
  });

  modelCache[tableName] = model;
  return model;
};

module.exports = getV2FinancialReportModel;
