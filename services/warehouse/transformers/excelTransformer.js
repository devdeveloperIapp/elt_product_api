// services/warehouse/transformers/excelTransformer.js
// Registers Excel domain models and the transformation pipeline.
// Raw tables  : excel_raw.raw_spreadsheet, excel_raw.raw_sheet_row
// Domain tables: excel_domain.dim_spreadsheets, dim_sheets, fact_sheet_rows

const { DataTypes } = require('sequelize');
const { defineDomainModel } = require('../../../model/warehouse/DomainModelFactory');
const { getRawModel }       = require('../../../model/warehouse/RawModelFactory');
const { registerTransformer } = require('../ingestionService');

const SOURCE = 'excel';

// ---------------------------------------------------------------------------
// Domain model definitions
// ---------------------------------------------------------------------------

const DimSpreadsheet = defineDomainModel(SOURCE, 'dim_spreadsheets', {
  spreadsheet_sk:  { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:      { type: DataTypes.INTEGER, allowNull: false },
  spreadsheet_id:  { type: DataTypes.STRING,  allowNull: false }, // ExcelConnection id as string
  title:           { type: DataTypes.STRING },                    // original filename
  sheet_count:     { type: DataTypes.INTEGER, defaultValue: 0 },
  total_rows:      { type: DataTypes.INTEGER, defaultValue: 0 },
  file_size_bytes: { type: DataTypes.INTEGER },
  updated_at:      { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'spreadsheet_id'] }],
});

const DimSheet = defineDomainModel(SOURCE, 'dim_sheets', {
  sheet_sk:       { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:     { type: DataTypes.INTEGER, allowNull: false },
  spreadsheet_id: { type: DataTypes.STRING, allowNull: false },
  sheet_name:     { type: DataTypes.STRING },
  sheet_index:    { type: DataTypes.INTEGER },
  row_count:      { type: DataTypes.INTEGER, defaultValue: 0 },
  column_count:   { type: DataTypes.INTEGER, defaultValue: 0 },
  updated_at:     { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'spreadsheet_id', 'sheet_name'] }],
});

const FactSheetRow = defineDomainModel(SOURCE, 'fact_sheet_rows', {
  row_sk:         { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:     { type: DataTypes.INTEGER, allowNull: false },
  spreadsheet_id: { type: DataTypes.STRING, allowNull: false },
  sheet_name:     { type: DataTypes.STRING, allowNull: false },
  row_index:      { type: DataTypes.INTEGER, allowNull: false },
  row_data:       { type: DataTypes.JSONB },
  ingested_at:    { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [
    { unique: true, fields: ['company_id', 'spreadsheet_id', 'sheet_name', 'row_index'] },
    { fields: ['company_id', 'spreadsheet_id'] },
  ],
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fetchRaw = (entity, companyId) => {
  const Model = getRawModel(SOURCE, entity);
  return Model.findAll({
    where: { company_id: companyId, is_deleted: false },
    attributes: ['source_id', 'raw_payload'],
    raw: true,
  });
};

// ---------------------------------------------------------------------------
// Transform functions
// ---------------------------------------------------------------------------

const transformDimSpreadsheets = async (companyId) => {
  const rows = await fetchRaw('spreadsheet', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ source_id, raw_payload: d }) => ({
    company_id:      companyId,
    spreadsheet_id:  source_id,
    title:           d.title || d.filename || null,
    sheet_count:     d.sheet_count || 0,
    total_rows:      d.total_rows  || 0,
    file_size_bytes: d.file_size_bytes || null,
    updated_at:      new Date(),
  }));
  await DimSpreadsheet.bulkCreate(mapped, {
    updateOnDuplicate: ['title', 'sheet_count', 'total_rows', 'file_size_bytes', 'updated_at'],
  });
  return mapped.length;
};

const transformDimSheets = async (companyId) => {
  const rows = await fetchRaw('spreadsheet', companyId);
  if (!rows.length) return 0;
  const mapped = [];
  for (const { source_id, raw_payload: d } of rows) {
    const sheets = Array.isArray(d.sheets) ? d.sheets : [];
    sheets.forEach((s, idx) => {
      mapped.push({
        company_id:     companyId,
        spreadsheet_id: source_id,
        sheet_name:     s.name,
        sheet_index:    idx,
        row_count:      s.row_count    || 0,
        column_count:   s.column_count || 0,
        updated_at:     new Date(),
      });
    });
  }
  if (!mapped.length) return 0;
  await DimSheet.bulkCreate(mapped, {
    updateOnDuplicate: ['sheet_index', 'row_count', 'column_count', 'updated_at'],
  });
  return mapped.length;
};

const transformFactSheetRows = async (companyId) => {
  const rows = await fetchRaw('sheet_row', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:     companyId,
    spreadsheet_id: d.spreadsheet_id,
    sheet_name:     d.sheet_name,
    row_index:      d.row_index,
    row_data:       d.row_data || {},
    ingested_at:    new Date(),
  })).filter(r => r.spreadsheet_id && r.sheet_name != null && r.row_index != null);
  if (!mapped.length) return 0;
  const CHUNK = 500;
  for (let i = 0; i < mapped.length; i += CHUNK) {
    await FactSheetRow.bulkCreate(mapped.slice(i, i + CHUNK), {
      updateOnDuplicate: ['row_data', 'ingested_at'],
    });
  }
  return mapped.length;
};

// ---------------------------------------------------------------------------
// Main transformer
// ---------------------------------------------------------------------------
const excelTransformer = async ({ companyId }) => {
  const [spreadsheetCount, sheetCount, rowCount] = await Promise.all([
    transformDimSpreadsheets(companyId),
    transformDimSheets(companyId),
    transformFactSheetRows(companyId),
  ]);
  return { source: SOURCE, companyId, dim_spreadsheets: spreadsheetCount, dim_sheets: sheetCount, fact_sheet_rows: rowCount };
};

registerTransformer(SOURCE, excelTransformer);

module.exports = { excelTransformer, DimSpreadsheet, DimSheet, FactSheetRow };
