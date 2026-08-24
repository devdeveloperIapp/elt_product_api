// services/warehouse/transformers/googleSheetsTransformer.js
// Registers Google Sheets domain models and the transformation pipeline.
// Raw tables  : google_sheets_raw.raw_spreadsheet, raw_sheet, raw_sheet_row
// Domain tables: google_sheets_domain.dim_spreadsheets, dim_sheets, fact_sheet_rows

const { DataTypes, Op } = require('sequelize');
const { defineDomainModel } = require('../../../model/warehouse/DomainModelFactory');
const { getRawModel }       = require('../../../model/warehouse/RawModelFactory');
const { registerTransformer } = require('../ingestionService');

const SOURCE = 'googlesheets';

// ---------------------------------------------------------------------------
// Domain model definitions (all in `google_sheets_domain` schema)
// ---------------------------------------------------------------------------

// dim_spreadsheets — one row per Google Spreadsheet file
const DimSpreadsheet = defineDomainModel(SOURCE, 'dim_spreadsheets', {
  spreadsheet_sk: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:     { type: DataTypes.INTEGER, allowNull: false },
  spreadsheet_id: { type: DataTypes.STRING,  allowNull: false },  // Google file ID
  title:          { type: DataTypes.STRING },
  owner_email:    { type: DataTypes.STRING },
  locale:         { type: DataTypes.STRING(16) },
  time_zone:      { type: DataTypes.STRING(64) },
  sheet_count:    { type: DataTypes.INTEGER, defaultValue: 0 },
  drive_url:      { type: DataTypes.TEXT },
  is_active:      { type: DataTypes.BOOLEAN, defaultValue: true },  // true = in current selection, false = previously synced
  last_synced_at: { type: DataTypes.DATE },
  updated_at:     { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'spreadsheet_id'] }],
});

// dim_sheets — one row per worksheet tab inside a spreadsheet
const DimSheet = defineDomainModel(SOURCE, 'dim_sheets', {
  sheet_sk:       { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:     { type: DataTypes.INTEGER, allowNull: false },
  spreadsheet_id: { type: DataTypes.STRING, allowNull: false },
  sheet_id:       { type: DataTypes.INTEGER },   // Google's numeric sheetId
  sheet_name:     { type: DataTypes.STRING },
  sheet_index:    { type: DataTypes.INTEGER },   // 0-based tab order
  row_count:      { type: DataTypes.INTEGER, defaultValue: 0 },
  column_count:   { type: DataTypes.INTEGER, defaultValue: 0 },
  updated_at:     { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'spreadsheet_id', 'sheet_id'] }],
});

// fact_sheet_rows — one row per data row in a worksheet (up to ROW_LIMIT per sheet)
const FactSheetRow = defineDomainModel(SOURCE, 'fact_sheet_rows', {
  row_sk:         { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:     { type: DataTypes.INTEGER, allowNull: false },
  spreadsheet_id: { type: DataTypes.STRING, allowNull: false },
  sheet_name:     { type: DataTypes.STRING, allowNull: false },
  row_index:      { type: DataTypes.INTEGER, allowNull: false },  // 0-based, row 0 = header
  row_data:       { type: DataTypes.JSONB },                       // { col_name: value, ... }
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

const fetchRaw = async (entity, companyId) => {
  const Model = getRawModel(SOURCE, entity);
  return Model.findAll({
    where: { company_id: companyId, is_deleted: false },
    attributes: ['source_id', 'raw_payload'],
    raw: true,
  });
};

// ---------------------------------------------------------------------------
// Transformation functions
// ---------------------------------------------------------------------------

// raw_spreadsheet → dim_spreadsheets
const transformDimSpreadsheets = async (companyId) => {
  const rows = await fetchRaw('spreadsheet', companyId);
  if (!rows.length) return 0;

  const mapped = rows.map(({ source_id, raw_payload: d }) => ({
    company_id:     companyId,
    spreadsheet_id: source_id,
    title:          d.title || d.properties?.title || null,
    owner_email:    d.owner_email || null,
    locale:         d.properties?.locale || null,
    time_zone:      d.properties?.timeZone || null,
    sheet_count:    Array.isArray(d.sheets) ? d.sheets.length : 0,
    drive_url:      d.spreadsheetUrl || null,
    updated_at:     new Date(),
  }));

  await DimSpreadsheet.bulkCreate(mapped, {
    updateOnDuplicate: ['title', 'owner_email', 'locale', 'time_zone', 'sheet_count', 'drive_url', 'updated_at'],
  });
  return mapped.length;
};

// raw_spreadsheet (sheets array inside payload) → dim_sheets
const transformDimSheets = async (companyId) => {
  const rows = await fetchRaw('spreadsheet', companyId);
  if (!rows.length) return 0;

  const mapped = [];
  for (const { source_id, raw_payload: d } of rows) {
    const sheets = Array.isArray(d.sheets) ? d.sheets : [];
    for (const sheet of sheets) {
      const props  = sheet.properties || {};
      const gridProps = props.gridProperties || {};
      mapped.push({
        company_id:     companyId,
        spreadsheet_id: source_id,
        sheet_id:       props.sheetId ?? null,
        sheet_name:     props.title   || null,
        sheet_index:    props.index   ?? null,
        row_count:      gridProps.rowCount    || 0,
        column_count:   gridProps.columnCount || 0,
        updated_at:     new Date(),
      });
    }
  }

  if (!mapped.length) return 0;
  await DimSheet.bulkCreate(mapped, {
    updateOnDuplicate: ['sheet_name', 'sheet_index', 'row_count', 'column_count', 'updated_at'],
  });
  return mapped.length;
};

// raw_sheet_row → fact_sheet_rows
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

  // Batch in chunks of 500
  const CHUNK = 500;
  for (let i = 0; i < mapped.length; i += CHUNK) {
    await FactSheetRow.bulkCreate(mapped.slice(i, i + CHUNK), {
      updateOnDuplicate: ['row_data', 'ingested_at'],
    });
  }
  return mapped.length;
};

// Mark currently-selected spreadsheets active; previously synced ones inactive.
// Old data stays in the warehouse so users can still view it (is_active = false).
const updateActiveFlags = async (companyId, selectedIds) => {
  if (!Array.isArray(selectedIds)) return;   // selection unknown — leave flags untouched
  const now = new Date();

  if (selectedIds.length > 0) {
    await DimSpreadsheet.update(
      { is_active: true, last_synced_at: now },
      { where: { company_id: companyId, spreadsheet_id: { [Op.in]: selectedIds } } }
    );
  }
  await DimSpreadsheet.update(
    { is_active: false },
    { where: { company_id: companyId, spreadsheet_id: { [Op.notIn]: selectedIds } } }
  );
};

// ---------------------------------------------------------------------------
// Main transformer — called by transformToDomain('googlesheets', { companyId, selectedIds })
// ---------------------------------------------------------------------------
const googleSheetsTransformer = async ({ companyId, selectedIds }) => {
  const [spreadsheetCount, sheetCount, rowCount] = await Promise.all([
    transformDimSpreadsheets(companyId),
    transformDimSheets(companyId),
    transformFactSheetRows(companyId),
  ]);

  await updateActiveFlags(companyId, selectedIds);

  return {
    source: SOURCE,
    companyId,
    dim_spreadsheets: spreadsheetCount,
    dim_sheets:       sheetCount,
    fact_sheet_rows:  rowCount,
  };
};

// Register with the warehouse ingestion service
registerTransformer(SOURCE, googleSheetsTransformer);

module.exports = { googleSheetsTransformer, DimSpreadsheet, DimSheet, FactSheetRow };
