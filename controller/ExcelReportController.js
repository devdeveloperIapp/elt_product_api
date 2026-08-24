// controller/ExcelReportController.js
// Serves Excel warehouse data and text-to-SQL AI queries for the Excel Report Viewer.
//
// Endpoints:
//   GET  /api/source/excel-report/:sourceId/sheets    → list sheets + columns
//   GET  /api/source/excel-report/:sourceId/data      → paginated row data
//   POST /api/source/excel-report/:sourceId/query     → AI text-to-SQL

const axios = require('axios');
const Source = require('../model/sourceModel');
const { warehouseV2DB } = require('../connection/dbConnection');
const { tenantId, sendAuthError } = require('../utils/tenantScope');

// Lazy-load transformer exports (transformer is registered at server boot)
const getModels = () => {
  const { FactSheetRow, DimSheet, DimSpreadsheet } = require('../services/warehouse/transformers/excelTransformer');
  return { FactSheetRow, DimSheet, DimSpreadsheet };
};

// ── Resolve spreadsheet_id from a Source row ─────────────────────────────────
const resolveSpreadsheetId = async (sourceId, companyId) => {
  const source = await Source.findOne({ where: { id: sourceId, company_id: companyId } });
  if (!source) throw new Error('Source not found');
  const connectionId = source.connector_settings_json?.connectionId;
  if (!connectionId) throw new Error('Excel connection metadata missing. Re-upload the file to fix this.');
  return String(connectionId);
};

// ── GET /api/source/excel-report/:sourceId/sheets ────────────────────────────
exports.getSheets = async (req, res) => {
  try {
    let companyId;
    try { companyId = tenantId(req); } catch (e) { return sendAuthError(res, e); }

    const { FactSheetRow, DimSheet, DimSpreadsheet } = getModels();
    const { sourceId } = req.params;
    const spreadsheetId = await resolveSpreadsheetId(sourceId, companyId);

    const [spreadsheet, sheets] = await Promise.all([
      DimSpreadsheet.findOne({ where: { company_id: companyId, spreadsheet_id: spreadsheetId }, raw: true }),
      DimSheet.findAll({
        where: { company_id: companyId, spreadsheet_id: spreadsheetId },
        order: [['sheet_index', 'ASC']],
        raw: true,
      }),
    ]);

    const sheetsWithColumns = await Promise.all(sheets.map(async (sheet) => {
      const firstRow = await FactSheetRow.findOne({
        where: { company_id: companyId, spreadsheet_id: spreadsheetId, sheet_name: sheet.sheet_name, row_index: 0 },
        raw: true,
      });
      return { ...sheet, columns: firstRow ? Object.keys(firstRow.row_data) : [] };
    }));

    return res.json({ success: true, data: { spreadsheetId, spreadsheet, sheets: sheetsWithColumns } });
  } catch (err) {
    console.error('[ExcelReport] getSheets error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/source/excel-report/:sourceId/data?sheet=Name&page=1&limit=200 ──
exports.getData = async (req, res) => {
  try {
    let companyId;
    try { companyId = tenantId(req); } catch (e) { return sendAuthError(res, e); }

    const { FactSheetRow } = getModels();
    const { sourceId } = req.params;
    const { sheet, page = 1, limit = 200 } = req.query;

    if (!sheet) return res.status(400).json({ success: false, message: 'sheet query param is required' });

    const spreadsheetId = await resolveSpreadsheetId(sourceId, companyId);
    const pageNum  = parseInt(page);
    const limitNum = Math.min(parseInt(limit) || 200, 500);
    const offset   = (pageNum - 1) * limitNum;

    const { count, rows } = await FactSheetRow.findAndCountAll({
      where: { company_id: companyId, spreadsheet_id: spreadsheetId, sheet_name: sheet },
      order: [['row_index', 'ASC']],
      limit: limitNum,
      offset,
      raw: true,
    });

    const dataRows = rows.map(r => r.row_data);
    const headers  = dataRows.length > 0 ? Object.keys(dataRows[0]) : [];

    return res.json({ success: true, data: { headers, rows: dataRows, total: count, page: pageNum, limit: limitNum } });
  } catch (err) {
    console.error('[ExcelReport] getData error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/source/excel-report/:sourceId/query ────────────────────────────
// Body: { question: string, sheet: string }
exports.queryData = async (req, res) => {
  try {
    let companyId;
    try { companyId = tenantId(req); } catch (e) { return sendAuthError(res, e); }

    const { FactSheetRow } = getModels();
    const { sourceId } = req.params;
    const { question, sheet } = req.body;

    if (!question?.trim()) return res.status(400).json({ success: false, message: 'question is required' });
    if (!sheet?.trim())    return res.status(400).json({ success: false, message: 'sheet is required' });

    const spreadsheetId = await resolveSpreadsheetId(sourceId, companyId);

    // Fetch 3 sample rows to understand schema
    const sampleRows = await FactSheetRow.findAll({
      where: { company_id: companyId, spreadsheet_id: spreadsheetId, sheet_name: sheet },
      order: [['row_index', 'ASC']],
      limit: 3,
      raw: true,
    });

    if (!sampleRows.length) {
      return res.status(404).json({ success: false, message: 'No data found for this sheet. Upload or sync the file first.' });
    }

    const columns    = Object.keys(sampleRows[0].row_data);
    const sampleData = sampleRows.map(r => r.row_data);

    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ success: false, message: 'AI not configured. Set ANTHROPIC_API_KEY in .env' });
    }

    const systemPrompt = `You are a PostgreSQL expert. Convert user questions to SQL SELECT queries against an Excel warehouse table.

Table: excel_domain.fact_sheet_rows
Schema: company_id INTEGER, spreadsheet_id TEXT, sheet_name TEXT, row_index INTEGER, row_data JSONB, ingested_at TIMESTAMP

The sheet "${sheet}" has these JSONB fields: ${columns.map(c => `"${c}"`).join(', ')}

Sample data:
${JSON.stringify(sampleData, null, 2)}

Rules:
1. ALWAYS include: WHERE company_id = ${companyId} AND spreadsheet_id = '${spreadsheetId}' AND sheet_name = '${sheet}'
2. Access fields: row_data->>'FieldName'
3. Numeric operations: (row_data->>'Field')::numeric
4. Date operations: (row_data->>'Field')::date
5. Limit to 100 rows unless aggregating
6. Return ONLY the raw SQL query — no markdown, no explanation`;

    const aiResp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: 'user', content: question }],
      },
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeout: 30_000,
      }
    );

    let sql = aiResp.data?.content?.[0]?.text?.trim() || '';
    sql = sql.replace(/^```sql\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();

    if (!sql.toLowerCase().startsWith('select')) {
      return res.status(400).json({ success: false, message: 'AI returned an invalid query. Try rephrasing.', sql });
    }

    const results = await warehouseV2DB.query(sql, { type: warehouseV2DB.QueryTypes.SELECT });
    const resultColumns = results?.length ? Object.keys(results[0]) : [];

    return res.json({ success: true, data: { sql, columns: resultColumns, rows: results, question } });
  } catch (err) {
    console.error('[ExcelReport] queryData error:', err);
    const aiMsg = err.response?.data?.error?.message;
    return res.status(500).json({ success: false, message: aiMsg || err.message });
  }
};
