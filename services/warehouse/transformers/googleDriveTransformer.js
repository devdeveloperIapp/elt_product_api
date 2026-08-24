// services/warehouse/transformers/googleDriveTransformer.js
// Registers Google Drive domain models and the transformation pipeline.
// Raw tables  : google_drive_raw.raw_spreadsheet, raw_sheet_row
// Domain tables: google_drive_domain.dim_spreadsheets, dim_sheets, fact_sheet_rows
//
// Google Drive files (native Google Sheets + uploaded .xlsx/.xls/.csv found inside
// the selected folders) are all normalised to the same spreadsheet/sheet/row shape
// as the Excel and Google Sheets connectors, so downstream reporting/AI querying
// works identically.

const { DataTypes, Op } = require('sequelize');
const { defineDomainModel } = require('../../../model/warehouse/DomainModelFactory');
const { getRawModel }       = require('../../../model/warehouse/RawModelFactory');
const { registerTransformer } = require('../ingestionService');

const SOURCE = 'googledrive';

// ---------------------------------------------------------------------------
// Domain model definitions (all in `google_drive_domain` schema)
// ---------------------------------------------------------------------------

// dim_spreadsheets — one row per file ingested from Drive
const DimSpreadsheet = defineDomainModel(SOURCE, 'dim_spreadsheets', {
  spreadsheet_sk: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:     { type: DataTypes.INTEGER, allowNull: false },
  spreadsheet_id: { type: DataTypes.STRING,  allowNull: false },  // Drive file ID
  title:          { type: DataTypes.STRING },
  owner_email:    { type: DataTypes.STRING },
  file_type:      { type: DataTypes.STRING },   // 'google_sheet' | 'excel' | 'csv'
  folder_id:      { type: DataTypes.STRING },
  sheet_count:    { type: DataTypes.INTEGER, defaultValue: 0 },
  drive_url:      { type: DataTypes.TEXT },
  is_active:      { type: DataTypes.BOOLEAN, defaultValue: true },  // true = in a currently-selected folder
  last_synced_at: { type: DataTypes.DATE },
  updated_at:     { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'spreadsheet_id'] }],
});

// dim_sheets — one row per worksheet tab inside a file
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

// fact_sheet_rows — one row per data row in a worksheet (up to ROW_LIMIT per sheet)
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
    title:          d.title || d.name || null,
    owner_email:    d.owner_email || null,
    file_type:      d.file_type || null,
    folder_id:      d.folder_id || null,
    sheet_count:    Array.isArray(d.sheets) ? d.sheets.length : 0,
    drive_url:      d.drive_url || d.webViewLink || null,
    updated_at:     new Date(),
  }));

  await DimSpreadsheet.bulkCreate(mapped, {
    updateOnDuplicate: ['title', 'owner_email', 'file_type', 'folder_id', 'sheet_count', 'drive_url', 'updated_at'],
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

  const CHUNK = 500;
  for (let i = 0; i < mapped.length; i += CHUNK) {
    await FactSheetRow.bulkCreate(mapped.slice(i, i + CHUNK), {
      updateOnDuplicate: ['row_data', 'ingested_at'],
    });
  }
  return mapped.length;
};

// Mark files inside currently-selected folders active; previously synced ones inactive.
// Old data stays in the warehouse so users can still view it (is_active = false).
// selectedFileIds = the file IDs found inside the currently-selected folders this sync.
const updateActiveFlags = async (companyId, selectedFileIds) => {
  if (!Array.isArray(selectedFileIds)) return;   // unknown — leave flags untouched
  const now = new Date();

  if (selectedFileIds.length > 0) {
    await DimSpreadsheet.update(
      { is_active: true, last_synced_at: now },
      { where: { company_id: companyId, spreadsheet_id: { [Op.in]: selectedFileIds } } }
    );
  }
  await DimSpreadsheet.update(
    { is_active: false },
    { where: { company_id: companyId, spreadsheet_id: { [Op.notIn]: selectedFileIds.length ? selectedFileIds : [''] } } }
  );
};

// ---------------------------------------------------------------------------
// Main transformer — called by transformToDomain('googledrive', { companyId, selectedFileIds })
// ---------------------------------------------------------------------------
const googleDriveTransformer = async ({ companyId, selectedFileIds }) => {
  const [spreadsheetCount, sheetCount, rowCount] = await Promise.all([
    transformDimSpreadsheets(companyId),
    transformDimSheets(companyId),
    transformFactSheetRows(companyId),
  ]);

  await updateActiveFlags(companyId, selectedFileIds);

  return {
    source: SOURCE,
    companyId,
    dim_spreadsheets: spreadsheetCount,
    dim_sheets:       sheetCount,
    fact_sheet_rows:  rowCount,
  };
};

// Register with the warehouse ingestion service
registerTransformer(SOURCE, googleDriveTransformer);

module.exports = { googleDriveTransformer, DimSpreadsheet, DimSheet, FactSheetRow };
