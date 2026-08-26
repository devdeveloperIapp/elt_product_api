// controller/GoogleDriveController.js
// Google Drive OAuth + folder-scoped sync controller.
//
// How it differs from GoogleSheetsController:
//   • Google Sheets ingests EVERY native spreadsheet in the whole Drive.
//   • Google Drive ingests only the files inside the FOLDER(S) the user picks,
//     and supports native Google Sheets AND uploaded .xlsx/.xls/.csv files.
//
// ── GOOGLE CLOUD SETUP (one-time) ──────────────────────────────────────────
// Reuses the same GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET as Google Sheets.
// You must register a SEPARATE redirect URI for Drive in the OAuth client:
//   <GOOGLE_DRIVE_REDIRECT_URI>, e.g.
//   http://localhost:9001/api/source/auth/google-drive/callback
// If GOOGLE_DRIVE_REDIRECT_URI is not set, it is derived from
// GOOGLE_REDIRECT_URI by swapping "google-sheets" → "google-drive".
// APIs to enable: "Google Drive API" + "Google Sheets API".
// ───────────────────────────────────────────────────────────────────────────

const { google } = require('googleapis');
const xlsx = require('xlsx');
const GoogleDriveConnection = require('../model/GoogleDriveConnection');
const Source = require('../model/sourceModel');
const { insertRawData, transformToDomain } = require('../services/warehouse');
const { DimSpreadsheet } = require('../services/warehouse/transformers/googleDriveTransformer');
const { buildQuickBooksSyncProgress, emitQuickBooksSyncProgress } = require('../utils/quickbooksSyncProgress');

// ── Max rows synced per sheet tab (prevents DB bloat on huge files) ─────────
const ROW_LIMIT = 10_000;

// ── Supported Drive mime types ───────────────────────────────────────────────
const MIME = {
  FOLDER:      'application/vnd.google-apps.folder',
  GOOGLE_SHEET:'application/vnd.google-apps.spreadsheet',
  XLSX:        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  XLS:         'application/vnd.ms-excel',
  CSV:         'text/csv',
};
const INGESTIBLE_MIMES = [MIME.GOOGLE_SHEET, MIME.XLSX, MIME.XLS, MIME.CSV];

// ── Resolve the Drive redirect URI (own URI, falls back to sheets-derived) ──
const driveRedirectUri = () =>
  process.env.GOOGLE_DRIVE_REDIRECT_URI ||
  (process.env.GOOGLE_REDIRECT_URI || '').replace('google-sheets', 'google-drive');

// ── Build a reusable OAuth2 client ──────────────────────────────────────────
const buildOAuth2Client = () => new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  driveRedirectUri(),
);

// ── Refresh access token if expired (60s safety buffer) ─────────────────────
const refreshIfNeeded = async (connection) => {
  const BUFFER_MS = 60_000;
  const now       = Date.now();

  if (connection.token_expiry && Number(connection.token_expiry) > now + BUFFER_MS) {
    return { access_token: connection.access_token };
  }

  const auth = buildOAuth2Client();
  auth.setCredentials({ refresh_token: connection.refresh_token });

  const { credentials } = await auth.refreshAccessToken();
  await connection.update({
    access_token: credentials.access_token,
    token_expiry: credentials.expiry_date,
  });
  return { access_token: credentials.access_token };
};

// ── Build an authenticated Google client ─────────────────────────────────────
const buildAuthClient = async (connection) => {
  const { access_token } = await refreshIfNeeded(connection);
  const auth = buildOAuth2Client();
  auth.setCredentials({ access_token, refresh_token: connection.refresh_token });
  return auth;
};

// ── List the user's Drive folders (for the folder picker) ───────────────────
const listUserFolders = async (auth) => {
  const drive   = google.drive({ version: 'v3', auth });
  const folders = [];
  let pageToken = null;

  do {
    const res = await drive.files.list({
      q:        `mimeType='${MIME.FOLDER}' and trashed=false`,
      fields:   'nextPageToken, files(id, name, webViewLink)',
      pageSize: 100,
      pageToken: pageToken || undefined,
      orderBy:  'name',
    });
    folders.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return folders;
};

// ── List ingestible files inside a folder ───────────────────────────────────
const listFilesInFolder = async (auth, folderId) => {
  const drive   = google.drive({ version: 'v3', auth });
  const files   = [];
  let pageToken = null;

  const mimeClause = INGESTIBLE_MIMES.map(m => `mimeType='${m}'`).join(' or ');

  do {
    const res = await drive.files.list({
      q:        `'${folderId}' in parents and trashed=false and (${mimeClause})`,
      fields:   'nextPageToken, files(id, name, mimeType, webViewLink)',
      pageSize: 100,
      pageToken: pageToken || undefined,
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return files;
};

// ── Count ingestible files per folder in ONE pass ───────────────────────────
// Lists every Sheet/Excel/CSV in the Drive once and buckets by parent folder.
// Far cheaper than scanning each folder separately (1 paginated call vs N).
// Counts are non-recursive (a file counts toward its direct parent folder),
// which matches exactly what the sync ingests.
const countIngestibleFilesByFolder = async (auth) => {
  const drive = google.drive({ version: 'v3', auth });
  const counts = {};
  let pageToken = null;
  const mimeClause = INGESTIBLE_MIMES.map(m => `mimeType='${m}'`).join(' or ');

  do {
    const res = await drive.files.list({
      q:        `(${mimeClause}) and trashed=false`,
      fields:   'nextPageToken, files(id, parents)',
      pageSize: 1000,
      pageToken: pageToken || undefined,
    });
    for (const f of (res.data.files || [])) {
      for (const parent of (f.parents || [])) {
        counts[parent] = (counts[parent] || 0) + 1;
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return counts;
};

// ============================================================================
// 1.  GET /api/source/auth/google-drive/auth
// ============================================================================
exports.googleDriveAuth = async (req, res) => {
  try {
    const auth = buildOAuth2Client();
    const url  = auth.generateAuthUrl({
      access_type: 'offline',
      prompt:      'consent',
      scope: [
        'https://www.googleapis.com/auth/drive.readonly',      // read files + contents
        'https://www.googleapis.com/auth/spreadsheets.readonly',
        'https://www.googleapis.com/auth/userinfo.email',
      ],
      state: String(req.user.id),
    });

    return res.json({ success: true, url });
  } catch (err) {
    console.error('[GoogleDrive] auth URL error:', err);
    return res.status(500).json({ success: false, message: 'Failed to generate auth URL' });
  }
};

// ============================================================================
// 2.  GET /api/source/auth/google-drive/callback
//     Google redirects here. Exchange code → tokens, save connection + source,
//     redirect to the frontend folder picker.
// ============================================================================
exports.googleDriveCallback = async (req, res) => {
  const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
  const { code, state, error } = req.query;

  if (error) {
    console.error('[GoogleDrive] OAuth denied:', error);
    return res.redirect(`${FRONTEND_URL}/?google_drive=error&message=${encodeURIComponent(error)}`);
  }
  if (!code) {
    return res.redirect(`${FRONTEND_URL}/?google_drive=error&message=missing_code`);
  }

  const userId = Number(state);

  try {
    // ── Exchange auth code for tokens ──────────────────────────────────────
    const auth       = buildOAuth2Client();
    const { tokens } = await auth.getToken(code);
    auth.setCredentials(tokens);

    // ── Get user's Google email ────────────────────────────────────────────
    const oauth2   = google.oauth2({ version: 'v2', auth });
    const userInfo = await oauth2.userinfo.get();
    const email    = userInfo.data.email;

    // ── Resolve companyId from user (auto-create if user has none yet) ─────
    const { mainDB } = require('../connection/dbConnection');
    const [userRow]  = await mainDB.query(
      'SELECT id, company_id, first_name, last_name, email FROM users WHERE id = :userId LIMIT 1',
      { replacements: { userId }, type: mainDB.QueryTypes.SELECT }
    );

    if (!userRow) {
      return res.redirect(`${FRONTEND_URL}/?google_drive=error&message=user_not_found`);
    }

    let companyId = userRow.company_id;

    if (!companyId) {
      console.log(`[GoogleDrive] user ${userId} has no company — auto-creating one`);
      const companyName = email.split('@')[0] || userRow.first_name || 'My Company';
      const [newCompany] = await mainDB.query(
        `INSERT INTO qb_companies (name, is_active, created_at, updated_at)
         VALUES (:name, true, NOW(), NOW())
         RETURNING id`,
        { replacements: { name: companyName }, type: mainDB.QueryTypes.INSERT }
      );
      companyId = newCompany[0]?.id;
      await mainDB.query(
        'UPDATE users SET company_id = :companyId WHERE id = :userId',
        { replacements: { companyId, userId }, type: mainDB.QueryTypes.UPDATE }
      );
      console.log(`[GoogleDrive] Auto-created company id=${companyId} for user ${userId}`);
    }

    // ── Upsert GoogleDriveConnection (preserve prior selection + refresh_token) ─
    const existingConn = await GoogleDriveConnection.findOne({ where: { company_id: companyId } });
    const previousSelection = existingConn?.selected_folder_ids || [];

    if (!tokens.refresh_token && !existingConn?.refresh_token) {
      console.warn('[GoogleDrive] No refresh_token received and none stored — user may need to re-connect');
    }

    await GoogleDriveConnection.upsert({
      company_id:   companyId,
      google_email: email,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || existingConn?.refresh_token || null,
      token_expiry: tokens.expiry_date    || null,
      scope:        tokens.scope          || null,
      sync_status:  'pending',
      selected_folder_ids: previousSelection,
    }, { conflictFields: ['company_id'] });

    // ── List the user's folders (for connector_settings_json only — the
    //    picker's folder+count list is fetched separately via
    //    GET /auth/google-drive/folders/:sourceId, so no need to compute
    //    file counts here) ───────────────────────────────────────────────
    const folders = await listUserFolders(auth);

    // ── Upsert Source record ──────────────────────────────────────────────
    let source = await Source.findOne({
      where: { company_id: companyId, connector_name: 'google_drive' },
    });

    const connectorSettings = {
      googleEmail: email,
      folders:     folders.map(f => ({ id: f.id, name: f.name, url: f.webViewLink })),
      connectedAt: new Date().toISOString(),
    };

    if (!source) {
      source = await Source.create({
        company_id:              companyId,
        source_name:             `Google Drive (${email})`,
        connector_name:          'google_drive',
        connector_settings_json: connectorSettings,
        status:                  'active',
        created_by:              String(userId),
        created_on:              new Date(),
      });
    } else {
      await source.update({ connector_settings_json: connectorSettings, status: 'active' });
    }

    const sourceId = source.id;

    // Folder list is NOT embedded in the redirect URL — with many folders
    // the Location header can exceed nginx's proxy header buffer and the
    // redirect itself 502s. Frontend fetches the list separately via
    // GET /auth/google-drive/folders/:sourceId (listGoogleDriveFolders).
    return res.redirect(
      `${FRONTEND_URL}/?google_drive=select&sourceId=${sourceId}&companyId=${companyId}`
    );
  } catch (err) {
    console.error('[GoogleDrive] callback error:', err);
    return res.redirect(
      `${FRONTEND_URL}/?google_drive=error&message=${encodeURIComponent(err.message || 'callback_failed')}`
    );
  }
};

// ============================================================================
// 3.  POST /api/source/auth/google-drive/select-folders
//     Body: { sourceId, folderIds: ["id1", ...], mode?: 'replace' | 'add' }
// ============================================================================
exports.googleDriveSelectFolders = async (req, res) => {
  const { sourceId, folderIds, mode = 'replace' } = req.body;

  if (!sourceId || !Array.isArray(folderIds) || folderIds.length === 0) {
    return res.status(400).json({ success: false, message: 'sourceId and folderIds[] are required' });
  }

  try {
    const source = await Source.findByPk(sourceId);
    if (!source) return res.status(404).json({ success: false, message: 'Source not found' });

    const companyId  = source.company_id;
    const connection = await GoogleDriveConnection.findOne({ where: { company_id: companyId } });
    if (!connection) return res.status(404).json({ success: false, message: 'Google Drive connection not found' });

    const finalIds = mode === 'add'
      ? [...new Set([...(connection.selected_folder_ids || []), ...folderIds])]
      : folderIds;
    await connection.update({ selected_folder_ids: finalIds, sync_status: 'pending' });

    res.json({ success: true, message: 'Folders selected. Sync started in background.' });

    triggerGoogleDriveSyncInBackground(source, connection).catch(err =>
      console.error('[GoogleDrive] background sync error:', err)
    );
  } catch (err) {
    console.error('[GoogleDrive] select-folders error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ============================================================================
// 4.  POST /api/source/auth/google-drive/sync/:sourceId  — manual re-sync
// ============================================================================
exports.syncGoogleDriveData = async (req, res) => {
  const { sourceId } = req.params;
  try {
    const source = await Source.findByPk(sourceId);
    if (!source) return res.status(404).json({ success: false, message: 'Source not found' });

    const connection = await GoogleDriveConnection.findOne({ where: { company_id: source.company_id } });
    if (!connection) return res.status(404).json({ success: false, message: 'Google Drive connection not found' });

    res.json({ success: true, message: 'Google Drive sync started in background' });

    triggerGoogleDriveSyncInBackground(source, connection).catch(err =>
      console.error('[GoogleDrive] manual sync error:', err)
    );
  } catch (err) {
    console.error('[GoogleDrive] sync trigger error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ============================================================================
// 5.  GET /api/source/auth/google-drive/folders/:sourceId
//     Returns the user's Drive folders for the picker UI.
// ============================================================================
exports.listGoogleDriveFolders = async (req, res) => {
  const { sourceId } = req.params;
  try {
    const source = await Source.findByPk(sourceId);
    if (!source) return res.status(404).json({ success: false, message: 'Source not found' });

    const connection = await GoogleDriveConnection.findOne({ where: { company_id: source.company_id } });
    if (!connection) return res.status(404).json({ success: false, message: 'Google Drive connection not found' });

    const auth    = await buildAuthClient(connection);
    const folders = await listUserFolders(auth);
    let fileCounts = {};
    try {
      fileCounts = await countIngestibleFilesByFolder(auth);
    } catch (countErr) {
      console.warn('[GoogleDrive] file-count skipped:', countErr.message);
    }

    return res.json({
      success: true,
      data: {
        folders: folders.map(f => ({
          id:       f.id,
          name:     f.name,
          url:      f.webViewLink,
          selected: (connection.selected_folder_ids || []).includes(f.id),
          count:    fileCounts[f.id] || 0,
        })),
        selectedIds: connection.selected_folder_ids || [],
      },
    });
  } catch (err) {
    console.error('[GoogleDrive] list folders error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ============================================================================
// 6.  GET /api/source/auth/google-drive/synced/:sourceId
//     Every file ever synced to the warehouse (active + old).
// ============================================================================
exports.getSyncedGoogleDriveFiles = async (req, res) => {
  const { sourceId } = req.params;
  try {
    const source = await Source.findByPk(sourceId);
    if (!source) return res.status(404).json({ success: false, message: 'Source not found' });

    const rows = await DimSpreadsheet.findAll({
      where: { company_id: source.company_id },
      attributes: ['spreadsheet_id', 'title', 'owner_email', 'file_type', 'sheet_count', 'drive_url', 'is_active', 'last_synced_at', 'updated_at'],
      order: [['is_active', 'DESC'], ['title', 'ASC']],
      raw: true,
    });

    return res.json({
      success: true,
      data: {
        active:   rows.filter(r => r.is_active),
        inactive: rows.filter(r => !r.is_active),
      },
    });
  } catch (err) {
    console.error('[GoogleDrive] synced files error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ============================================================================
// INTERNAL — Background sync
// ============================================================================

// Parse an xlsx/xls/csv buffer into { sheets:[{name,row_count,column_count}], rowRecords:[] }
const parseWorkbookBuffer = (buffer, fileId) => {
  const workbook   = xlsx.read(buffer, { type: 'buffer', cellDates: true });
  const sheetNames = workbook.SheetNames || [];
  const sheetsMeta = [];
  const rowRecords = [];

  for (const sheetName of sheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    const jsonRows  = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: null, blankrows: false });

    if (jsonRows.length < 2) {
      sheetsMeta.push({ name: sheetName, row_count: 0, column_count: 0 });
      continue;
    }

    const rawHeaders = jsonRows[0];
    const headers    = rawHeaders.map((h, i) => (h != null ? String(h).trim() : `col_${i}`) || `col_${i}`);
    const dataRows   = jsonRows.slice(1, ROW_LIMIT + 1);

    dataRows.forEach((row, idx) => {
      const rowData = {};
      headers.forEach((header, colIdx) => {
        let val = row[colIdx];
        if (val instanceof Date) val = val.toISOString();
        rowData[header] = val !== undefined ? val : null;
      });
      rowRecords.push({
        Id:             `${fileId}__${sheetName}__${idx}`,
        spreadsheet_id: fileId,
        sheet_name:     sheetName,
        row_index:      idx,
        row_data:       rowData,
      });
    });

    sheetsMeta.push({ name: sheetName, row_count: dataRows.length, column_count: headers.length });
  }

  return { sheets: sheetsMeta, rowRecords };
};

/**
 * Ingest every supported file inside the selected folders into the warehouse.
 * Runs entirely in background — caller should not await.
 */
const triggerGoogleDriveSyncInBackground = async (source, connection) => {
  const companyId = source.company_id;
  const sourceId  = source.id;

  console.log(`[GoogleDrive] Starting sync for company=${companyId}, source=${sourceId}`);

  const emit = (stage, syncStatus, currentIndex = 0, totalEntities = 1, recordsProcessed = 0) => {
    emitQuickBooksSyncProgress(
      buildQuickBooksSyncProgress({
        companyId, sourceId, stage, syncStatus,
        currentEntity: stage, currentIndex, totalEntities, recordsProcessed,
      })
    );
  };

  try {
    await connection.update({ sync_status: 'in_progress', error_message: null });
    emit('Connecting to Google Drive…', 'in_progress', 0, 4);

    const auth        = await buildAuthClient(connection);
    const drive       = google.drive({ version: 'v3', auth });
    const sheetsApi   = google.sheets({ version: 'v4', auth });
    const folderIds   = connection.selected_folder_ids || [];

    if (folderIds.length === 0) {
      console.warn(`[GoogleDrive] No folders selected for company=${companyId}. Skipping sync.`);
      await connection.update({ sync_status: 'completed', last_sync_at: new Date() });
      emit('No folders selected', 'completed', 4, 4);
      return;
    }

    // ── Gather all ingestible files across the selected folders ────────────
    const allFiles = [];
    for (const folderId of folderIds) {
      const files = await listFilesInFolder(auth, folderId);
      files.forEach(f => allFiles.push({ ...f, folder_id: folderId }));
    }

    // De-dupe (a file could theoretically match twice)
    const seen = new Set();
    const files = allFiles.filter(f => (seen.has(f.id) ? false : seen.add(f.id)));

    const selectedFileIds = files.map(f => f.id);
    const total = files.length;
    let totalRows = 0;

    if (total === 0) {
      console.warn(`[GoogleDrive] No ingestible files found in selected folders for company=${companyId}.`);
      await connection.update({ sync_status: 'completed', last_sync_at: new Date() });
      emit('No files found in selected folders', 'completed', 4, 4);
      return;
    }

    for (let fi = 0; fi < files.length; fi++) {
      const file = files[fi];
      emit(`Reading file ${fi + 1} of ${total}…`, 'in_progress', fi + 1, total + 2, totalRows);

      try {
        let sheetsMeta = [];
        let rowRecords = [];
        let fileType   = 'excel';

        if (file.mimeType === MIME.GOOGLE_SHEET) {
          // ── Native Google Sheet → Sheets API ──────────────────────────────
          fileType = 'google_sheet';
          const metaRes = await sheetsApi.spreadsheets.get({ spreadsheetId: file.id });
          const tabs    = metaRes.data.sheets || [];

          for (const tab of tabs) {
            const sheetName = tab.properties?.title;
            if (!sheetName) continue;
            try {
              const range  = `'${sheetName}'!A1:ZZ${ROW_LIMIT + 1}`;
              const valRes = await sheetsApi.spreadsheets.values.get({
                spreadsheetId: file.id, range, valueRenderOption: 'FORMATTED_VALUE',
              });
              const allRows = valRes.data.values || [];
              if (allRows.length < 2) { sheetsMeta.push({ name: sheetName, row_count: 0, column_count: 0 }); continue; }

              const headers  = allRows[0].map((h, i) => String(h).trim() || `col_${i}`);
              const dataRows = allRows.slice(1, ROW_LIMIT + 1);
              dataRows.forEach((row, idx) => {
                const rowData = {};
                headers.forEach((header, colIdx) => { rowData[header] = row[colIdx] !== undefined ? row[colIdx] : null; });
                rowRecords.push({
                  Id: `${file.id}__${sheetName}__${idx}`,
                  spreadsheet_id: file.id, sheet_name: sheetName, row_index: idx, row_data: rowData,
                });
              });
              sheetsMeta.push({ name: sheetName, row_count: dataRows.length, column_count: headers.length });
            } catch (tabErr) {
              console.error(`[GoogleDrive]   Error reading tab "${sheetName}" of ${file.name}:`, tabErr.message);
            }
          }
        } else {
          // ── Uploaded .xlsx / .xls / .csv → download bytes → parse ─────────
          fileType = file.mimeType === MIME.CSV ? 'csv' : 'excel';
          const dl = await drive.files.get(
            { fileId: file.id, alt: 'media' },
            { responseType: 'arraybuffer' }
          );
          const buffer = Buffer.from(dl.data);
          const parsed = parseWorkbookBuffer(buffer, file.id);
          sheetsMeta   = parsed.sheets;
          rowRecords   = parsed.rowRecords;
        }

        // ── Store raw file metadata ───────────────────────────────────────
        await insertRawData('googledrive', 'spreadsheet', [{
          Id:          file.id,
          spreadsheetId: file.id,
          name:        file.name,
          title:       file.name,
          file_type:   fileType,
          folder_id:   file.folder_id,
          owner_email: connection.google_email,
          drive_url:   file.webViewLink || null,
          sheets:      sheetsMeta,
        }], { companyId, sourceIdField: 'Id' });

        // ── Store raw rows ────────────────────────────────────────────────
        if (rowRecords.length > 0) {
          await insertRawData('googledrive', 'sheet_row', rowRecords, { companyId, sourceIdField: 'Id' });
          totalRows += rowRecords.length;
        }

        emit(`Synced "${file.name}"…`, 'in_progress', fi + 1, total + 2, totalRows);
        console.log(`[GoogleDrive]   "${file.name}" (${fileType}): ${rowRecords.length} rows`);
      } catch (fileErr) {
        console.error(`[GoogleDrive] Error ingesting file ${file.name} (${file.id}):`, fileErr.message);
      }
    }

    // ── Transform raw → domain ────────────────────────────────────────────
    emit('Transforming data…', 'in_progress', total + 1, total + 2, totalRows);
    const summary = await transformToDomain('googledrive', { companyId, selectedFileIds });
    console.log('[GoogleDrive] Transform summary:', summary);

    const now = new Date();
    await connection.update({ sync_status: 'completed', last_sync_at: now, error_message: null });
    emit('Sync complete', 'completed', total + 2, total + 2, totalRows);
    console.log(`[GoogleDrive] Sync complete for company=${companyId} — ${totalRows} rows`);
  } catch (err) {
    console.error(`[GoogleDrive] Sync failed for company=${companyId}:`, err);
    emit('Sync failed', 'failed');
    await connection.update({ sync_status: 'failed', error_message: err.message }).catch(() => {});
  }
};

// Export for scheduler use
exports.triggerGoogleDriveSyncInBackground = triggerGoogleDriveSyncInBackground;
