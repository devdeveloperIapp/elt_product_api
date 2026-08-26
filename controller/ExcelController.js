// controller/ExcelController.js
// Handles Excel / CSV file uploads, parsing, and warehouse ingestion.
// No OAuth needed — user uploads file directly.
//
// Flow:
//   POST /api/source/auth/excel/upload  (multipart/form-data, field: "file")
//     → parse file with xlsx
//     → resolve / auto-create company_id
//     → save ExcelConnection record
//     → save Source record
//     → insert raw data into warehouse
//     → transform raw → domain
//     → emit socket progress events
//     → return { success, sourceId, companyId }

const xlsx    = require('xlsx');
const ExcelConnection = require('../model/ExcelConnection');
const Source          = require('../model/sourceModel');
const { insertRawData, transformToDomain } = require('../services/warehouse');
const { buildQuickBooksSyncProgress, emitQuickBooksSyncProgress } = require('../utils/quickbooksSyncProgress');

const ROW_LIMIT = 10_000; // max rows per sheet

// ── Emit helper ──────────────────────────────────────────────────────────────
const emit = (companyId, sourceId, stage, syncStatus, currentIndex = 0, total = 1, recordsProcessed = 0) => {
  emitQuickBooksSyncProgress(
    buildQuickBooksSyncProgress({
      companyId, sourceId, stage, syncStatus,
      currentEntity: stage, currentIndex, totalEntities: total, recordsProcessed,
      connectorLabel: 'Excel',
    })
  );
};

// ── Resolve or auto-create company for the user ──────────────────────────────
const resolveCompanyId = async (userId, mainDB) => {
  const [userRow] = await mainDB.query(
    'SELECT id, company_id, first_name, email FROM users WHERE id = :userId LIMIT 1',
    { replacements: { userId }, type: mainDB.QueryTypes.SELECT }
  );
  if (!userRow) throw new Error('User not found');

  if (userRow.company_id) return userRow.company_id;

  // No company yet — auto-create one
  const companyName = userRow.email?.split('@')[0] || userRow.first_name || 'My Company';
  const [newCompany] = await mainDB.query(
    `INSERT INTO qb_companies (name, is_active, created_at, updated_at)
     VALUES (:name, true, NOW(), NOW()) RETURNING id`,
    { replacements: { name: companyName }, type: mainDB.QueryTypes.INSERT }
  );
  const companyId = newCompany[0]?.id;
  await mainDB.query(
    'UPDATE users SET company_id = :companyId WHERE id = :userId',
    { replacements: { companyId, userId }, type: mainDB.QueryTypes.UPDATE }
  );
  console.log(`[Excel] Auto-created company id=${companyId} for user ${userId}`);
  return companyId;
};

// ============================================================================
// POST /api/source/auth/excel/upload
// Body: multipart/form-data  →  field "file" (.xlsx / .xls / .csv)
// ============================================================================
exports.uploadExcel = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded. Field name must be "file".' });
  }

  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const { mainDB } = require('../connection/dbConnection');

  try {
    // ── Resolve company ──────────────────────────────────────────────────
    const companyId = await resolveCompanyId(userId, mainDB);

    // ── Parse Excel from memory buffer ──────────────────────────────────
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const sheetNames = workbook.SheetNames;

    if (sheetNames.length === 0) {
      return res.status(400).json({ success: false, message: 'Excel file has no sheets.' });
    }

    // ── Create ExcelConnection record ────────────────────────────────────
    const connection = await ExcelConnection.create({
      company_id:        companyId,
      original_filename: req.file.originalname,
      file_size_bytes:   req.file.size,
      sheet_count:       sheetNames.length,
      sync_status:       'pending',
    });

    // ── Create / update Source record ────────────────────────────────────
    let source = await Source.findOne({
      where: { company_id: companyId, connector_name: 'excel' },
    });
    if (!source) {
      source = await Source.create({
        company_id:              companyId,
        source_name:             `Excel (${req.file.originalname})`,
        connector_name:          'excel',
        connector_settings_json: { filename: req.file.originalname, connectionId: connection.id },
        status:                  'active',
        created_by:              String(userId),
        created_on:              new Date(),
      });
    } else {
      await source.update({
        source_name:             `Excel (${req.file.originalname})`,
        connector_settings_json: { filename: req.file.originalname, connectionId: connection.id },
        status: 'active',
      });
    }

    const sourceId = source.id;

    // ── Respond immediately so frontend can show progress screen ─────────
    res.json({ success: true, sourceId, companyId, message: 'File received. Processing in background.' });

    // ── Process in background ────────────────────────────────────────────
    processExcelInBackground(workbook, sheetNames, connection, source, companyId, sourceId, req.file)
      .catch(err => console.error('[Excel] background processing error:', err));

  } catch (err) {
    console.error('[Excel] upload error:', err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
};

// ── Background processing ─────────────────────────────────────────────────────
const processExcelInBackground = async (workbook, sheetNames, connection, source, companyId, sourceId, fileInfo) => {
  console.log(`[Excel] Processing "${fileInfo.originalname}" for company=${companyId}`);

  try {
    await connection.update({ sync_status: 'in_progress', error_message: null });
    emit(companyId, sourceId, 'Reading Excel file…', 'in_progress', 0, sheetNames.length + 2);

    const spreadsheetId = String(connection.id);
    const sheetsMetadata = [];
    let totalRows = 0;

    for (let si = 0; si < sheetNames.length; si++) {
      const sheetName = sheetNames[si];
      emit(companyId, sourceId, `Reading sheet "${sheetName}"…`, 'in_progress', si + 1, sheetNames.length + 2, totalRows);

      try {
        const worksheet = workbook.Sheets[sheetName];

        // Convert sheet to JSON (row 0 = headers, rows 1+ = data)
        const jsonRows = xlsx.utils.sheet_to_json(worksheet, {
          header: 1,          // returns arrays
          defval: null,        // null for empty cells
          blankrows: false,
        });

        if (jsonRows.length < 2) {
          console.log(`[Excel]   Sheet "${sheetName}" is empty or header-only. Skipping.`);
          sheetsMetadata.push({ name: sheetName, row_count: 0, column_count: 0 });
          continue;
        }

        // Row 0 = headers
        const rawHeaders = jsonRows[0];
        const headers    = rawHeaders.map((h, i) => (h != null ? String(h).trim() : `col_${i}`) || `col_${i}`);
        const dataRows   = jsonRows.slice(1, ROW_LIMIT + 1);

        if (jsonRows.length > ROW_LIMIT + 1) {
          console.warn(`[Excel]   Sheet "${sheetName}" has ${jsonRows.length - 1} rows — truncated to ${ROW_LIMIT}.`);
        }

        // Build row records
        const rowRecords = dataRows.map((row, idx) => {
          const rowData = {};
          headers.forEach((header, colIdx) => {
            let val = row[colIdx];
            // Convert Date objects to ISO strings
            if (val instanceof Date) val = val.toISOString();
            rowData[header] = val !== undefined ? val : null;
          });
          return {
            Id:             `${spreadsheetId}__${sheetName}__${idx}`,
            spreadsheet_id: spreadsheetId,
            sheet_name:     sheetName,
            row_index:      idx,
            row_data:       rowData,
          };
        });

        await insertRawData('excel', 'sheet_row', rowRecords, {
          companyId,
          sourceIdField: 'Id',
        });

        totalRows += rowRecords.length;
        sheetsMetadata.push({ name: sheetName, row_count: rowRecords.length, column_count: headers.length });
        console.log(`[Excel]   Sheet "${sheetName}": ${rowRecords.length} rows`);

      } catch (sheetErr) {
        console.error(`[Excel]   Error reading sheet "${sheetName}":`, sheetErr.message);
        sheetsMetadata.push({ name: sheetName, row_count: 0, column_count: 0 });
      }
    }

    // ── Save raw spreadsheet metadata ─────────────────────────────────────
    const spreadsheetMeta = {
      spreadsheetId,
      filename:        fileInfo.originalname,
      title:           fileInfo.originalname,
      file_size_bytes: fileInfo.size,
      sheet_count:     sheetNames.length,
      total_rows:      totalRows,
      sheets:          sheetsMetadata,
    };
    await insertRawData('excel', 'spreadsheet', [spreadsheetMeta], {
      companyId,
      sourceIdField: 'spreadsheetId',
    });

    // ── Transform raw → domain ────────────────────────────────────────────
    emit(companyId, sourceId, 'Transforming data…', 'in_progress', sheetNames.length + 1, sheetNames.length + 2, totalRows);
    const summary = await transformToDomain('excel', { companyId });
    console.log('[Excel] Transform summary:', summary);

    // ── Update connection stats + mark complete ───────────────────────────
    await connection.update({
      sync_status:  'completed',
      total_rows:   totalRows,
      last_sync_at: new Date(),
      error_message: null,
    });

    emit(companyId, sourceId, 'Sync complete', 'completed', sheetNames.length + 2, sheetNames.length + 2, totalRows);
    console.log(`[Excel] Done — ${totalRows} rows processed for company=${companyId}`);

  } catch (err) {
    console.error(`[Excel] Processing failed for company=${companyId}:`, err);
    emit(companyId, sourceId, 'Sync failed', 'failed');
    await connection.update({ sync_status: 'failed', error_message: err.message }).catch(() => {});
  }
};
