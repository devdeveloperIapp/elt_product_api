// controller/SpreadsheetDashboardController.js
//
// Shared dashboard for the three spreadsheet-shaped sources — Google Sheets,
// Google Drive, and Excel — which all use the identical warehouse v2 domain
// shape (dim_spreadsheets / dim_sheets / fact_sheet_rows), unlike the
// accounting (QuickBooks/Zoho) or ecommerce (Shopify) sources. One
// parameterised controller instead of three near-duplicate files.
//
// `source` comes from the route (:source) and must be one of the values
// below — each is its own schema in elt_warehouse_v2, never mixed.

const { getDomainModel } = require('../model/warehouse/DomainModelFactory');
require('../services/warehouse/transformers/googleSheetsTransformer');
require('../services/warehouse/transformers/googleDriveTransformer');
require('../services/warehouse/transformers/excelTransformer');

const VALID_SOURCES = ['googlesheets', 'googledrive', 'excel'];

const modelsFor = (source) => ({
  DimSpreadsheet: getDomainModel(source, 'dim_spreadsheets'),
  DimSheet:       getDomainModel(source, 'dim_sheets'),
  FactSheetRow:   getDomainModel(source, 'fact_sheet_rows'),
});

const validateSource = (req, res) => {
  const { source } = req.params;
  if (!VALID_SOURCES.includes(source)) {
    res.status(400).json({ success: false, message: `Unknown source "${source}". Expected one of: ${VALID_SOURCES.join(', ')}` });
    return null;
  }
  return source;
};

/* ====================================================================== */
/*                1. OVERVIEW — list spreadsheets                         */
/* ====================================================================== */
exports.getOverviewDashboard = async (req, res) => {
  try {
    const source = validateSource(req, res);
    if (!source) return;
    const { companyId } = req.params;
    const { DimSpreadsheet, DimSheet, FactSheetRow } = modelsFor(source);

    const [spreadsheets, sheetCount, rowCount] = await Promise.all([
      DimSpreadsheet.findAll({
        where: { company_id: companyId },
        order: [['updated_at', 'DESC']],
        raw: true
      }),
      DimSheet.count({ where: { company_id: companyId } }),
      FactSheetRow.count({ where: { company_id: companyId } })
    ]);

    res.json({
      success: true,
      source,
      lastUpdated: new Date(),
      metrics: {
        totalSpreadsheets: spreadsheets.length,
        activeSpreadsheets: spreadsheets.filter(s => s.is_active !== false).length,
        totalSheets: sheetCount,
        totalRows:   rowCount
      },
      spreadsheets: spreadsheets.map(s => ({
        id:           s.spreadsheet_id,
        title:        s.title,
        sheetCount:   s.sheet_count,
        isActive:     s.is_active !== false,
        updatedAt:    s.updated_at,
        // source-specific extras, present only where applicable
        ownerEmail:   s.owner_email,
        fileType:     s.file_type,
        totalRows:    s.total_rows,
        driveUrl:     s.drive_url
      }))
    });

  } catch (error) {
    console.error(`[SPREADSHEET OVERVIEW] Error:`, error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

/* ====================================================================== */
/*                2. SHEETS — worksheets inside one spreadsheet           */
/* ====================================================================== */
exports.getSheetsDashboard = async (req, res) => {
  try {
    const source = validateSource(req, res);
    if (!source) return;
    const { companyId, spreadsheetId } = req.params;
    const { DimSpreadsheet, DimSheet } = modelsFor(source);

    const [spreadsheet, sheets] = await Promise.all([
      DimSpreadsheet.findOne({
        where: { company_id: companyId, spreadsheet_id: spreadsheetId },
        raw: true
      }),
      DimSheet.findAll({
        where: { company_id: companyId, spreadsheet_id: spreadsheetId },
        order: [['sheet_index', 'ASC']],
        raw: true
      })
    ]);

    if (!spreadsheet) {
      return res.status(404).json({ success: false, message: 'Spreadsheet not found' });
    }

    res.json({
      success: true,
      source,
      spreadsheet: {
        id:    spreadsheet.spreadsheet_id,
        title: spreadsheet.title
      },
      sheets: sheets.map(s => ({
        name:        s.sheet_name,
        index:       s.sheet_index,
        rowCount:    s.row_count,
        columnCount: s.column_count,
        updatedAt:   s.updated_at
      }))
    });

  } catch (error) {
    console.error(`[SPREADSHEET SHEETS] Error:`, error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

/* ====================================================================== */
/*                3. ROWS — paginated data rows for one sheet             */
/* ====================================================================== */
exports.getRowsDashboard = async (req, res) => {
  try {
    const source = validateSource(req, res);
    if (!source) return;
    const { companyId, spreadsheetId, sheetName } = req.params;
    const { page = 1, limit = 100 } = req.query;
    const { FactSheetRow } = modelsFor(source);

    const whereClause = {
      company_id: companyId,
      spreadsheet_id: spreadsheetId,
      sheet_name: sheetName
    };

    const [totalRows, rows] = await Promise.all([
      FactSheetRow.count({ where: whereClause }),
      FactSheetRow.findAll({
        where: whereClause,
        order: [['row_index', 'ASC']],
        limit:  parseInt(limit),
        offset: (parseInt(page) - 1) * parseInt(limit),
        raw: true
      })
    ]);

    res.json({
      success: true,
      source,
      spreadsheetId,
      sheetName,
      pagination: {
        page:  parseInt(page),
        limit: parseInt(limit),
        total: totalRows
      },
      rows: rows.map(r => ({
        rowIndex: r.row_index,
        data:     r.row_data
      }))
    });

  } catch (error) {
    console.error(`[SPREADSHEET ROWS] Error:`, error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};
