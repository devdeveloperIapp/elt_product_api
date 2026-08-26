// controller/GoogleSheetsController.js
// Full Google Sheets OAuth + sync controller.
//
// ── GOOGLE CLOUD SETUP (one-time, do this before testing) ──────────────────
// 1. Go to https://console.cloud.google.com and create/select a project.
// 2. Enable APIs:  "Google Sheets API"  +  "Google Drive API"
// 3. Go to "APIs & Services > Credentials" → Create OAuth 2.0 Client ID
//    • Application type: Web application
//    • Authorised redirect URIs: <GOOGLE_REDIRECT_URI from .env>
//    • Example: http://localhost:9001/api/source/auth/google-sheets/callback
// 4. Copy the Client ID and Client Secret into .env:
//      GOOGLE_CLIENT_ID=...
//      GOOGLE_CLIENT_SECRET=...
//      GOOGLE_REDIRECT_URI=http://localhost:9001/api/source/auth/google-sheets/callback
//      FRONTEND_URL=http://localhost:3000
// 5. On the OAuth Consent Screen, add your test Google account as a Test User
//    (required while the app is in "Testing" status).
// ───────────────────────────────────────────────────────────────────────────

const { google }    = require('googleapis');
const GoogleSheetsConnection = require('../model/GoogleSheetsConnection');
const Source        = require('../model/sourceModel');
const { insertRawData, transformToDomain } = require('../services/warehouse');
const { DimSpreadsheet } = require('../services/warehouse/transformers/googleSheetsTransformer');
const { Op }        = require('sequelize');
const { buildQuickBooksSyncProgress, emitQuickBooksSyncProgress } = require('../utils/quickbooksSyncProgress');

// ── Max rows synced per sheet tab (prevents DB bloat on huge sheets) ────────
const ROW_LIMIT = 10_000;

// ── Build a reusable OAuth2 client ──────────────────────────────────────────
const buildOAuth2Client = () => new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI,
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

// ── Build an authenticated Google Sheets/Drive client ───────────────────────
const buildAuthClient = async (connection) => {
  const { access_token } = await refreshIfNeeded(connection);
  const auth = buildOAuth2Client();
  auth.setCredentials({ access_token, refresh_token: connection.refresh_token });
  return auth;
};

// ── List spreadsheets the user has access to (via Drive API) ────────────────
const listUserSpreadsheets = async (auth) => {
  const drive  = google.drive({ version: 'v3', auth });
  const sheets = [];
  let pageToken = null;

  do {
    const res = await drive.files.list({
      q:         "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
      fields:    'nextPageToken, files(id, name, webViewLink, owners)',
      pageSize:  100,
      pageToken: pageToken || undefined,
    });
    sheets.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return sheets;
};

// ============================================================================
// 1.  GET /api/source/auth/google-sheets/auth
//     Returns the Google OAuth consent URL. Frontend redirects the browser here.
// ============================================================================
exports.googleSheetsAuth = async (req, res) => {
  try {
    const auth = buildOAuth2Client();
    const url  = auth.generateAuthUrl({
      access_type: 'offline',       // needed to get a refresh_token
      prompt:      'consent',       // force consent so refresh_token is always returned
      scope: [
        'https://www.googleapis.com/auth/spreadsheets.readonly',
        'https://www.googleapis.com/auth/drive.metadata.readonly',
        'https://www.googleapis.com/auth/userinfo.email',
      ],
      state: String(req.user.id),   // pass userId so callback can identify the user
    });

    return res.json({ success: true, url });
  } catch (err) {
    console.error('[GoogleSheets] auth URL error:', err);
    return res.status(500).json({ success: false, message: 'Failed to generate auth URL' });
  }
};

// ============================================================================
// 2.  GET /api/source/auth/google-sheets/callback
//     Google redirects here after user grants consent.
//     Exchanges code → tokens, saves connection, creates source, triggers sync.
// ============================================================================
exports.googleSheetsCallback = async (req, res) => {
  const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

  const { code, state, error } = req.query;

  if (error) {
    console.error('[GoogleSheets] OAuth denied:', error);
    return res.redirect(`${FRONTEND_URL}/?google_sheets=error&message=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return res.redirect(`${FRONTEND_URL}/?google_sheets=error&message=missing_code`);
  }

  // state = userId set in googleSheetsAuth
  const userId = Number(state);

  try {
    // ── Exchange auth code for tokens ──────────────────────────────────────
    const auth       = buildOAuth2Client();
    const { tokens } = await auth.getToken(code);
    auth.setCredentials(tokens);

    // ── Get user's Google email ────────────────────────────────────────────
    const oauth2    = google.oauth2({ version: 'v2', auth });
    const userInfo  = await oauth2.userinfo.get();
    const email     = userInfo.data.email;

    // ── Resolve companyId from user ────────────────────────────────────────
    // Google Sheets has no company concept — so we use the company_id already
    // on the user's account. If company_id is null (user connecting Google Sheets
    // as their FIRST source, no QB/Zoho yet), we auto-create a company record
    // in qb_companies using the user's name/email.
    const { mainDB } = require('../connection/dbConnection');
    const [userRow]  = await mainDB.query(
      'SELECT id, company_id, first_name, last_name, email FROM users WHERE id = :userId LIMIT 1',
      { replacements: { userId }, type: mainDB.QueryTypes.SELECT }
    );

    if (!userRow) {
      return res.redirect(`${FRONTEND_URL}/?google_sheets=error&message=user_not_found`);
    }

    let companyId = userRow.company_id;

    // ── Auto-create company if user has none yet ───────────────────────────
    if (!companyId) {
      console.log(`[GoogleSheets] user ${userId} has no company — auto-creating one`);

      const companyName = email.split('@')[0] || userRow.first_name || 'My Company';

      const [newCompany] = await mainDB.query(
        `INSERT INTO qb_companies (name, is_active, created_at, updated_at)
         VALUES (:name, true, NOW(), NOW())
         RETURNING id`,
        { replacements: { name: companyName }, type: mainDB.QueryTypes.INSERT }
      );

      companyId = newCompany[0]?.id;

      // Link the user to the new company
      await mainDB.query(
        'UPDATE users SET company_id = :companyId WHERE id = :userId',
        { replacements: { companyId, userId }, type: mainDB.QueryTypes.UPDATE }
      );

      console.log(`[GoogleSheets] Auto-created company id=${companyId} for user ${userId}`);
    }

    // ── Upsert GoogleSheetsConnection ──────────────────────────────────────
    // On re-connect, preserve the previous spreadsheet selection and the old
    // refresh_token (Google often omits it on re-auth).
    const existingConn = await GoogleSheetsConnection.findOne({ where: { company_id: companyId } });
    const previousSelection = existingConn?.selected_spreadsheet_ids || [];

    if (!tokens.refresh_token && !existingConn?.refresh_token) {
      console.warn('[GoogleSheets] No refresh_token received and none stored — user may need to re-connect');
    }

    const [connection] = await GoogleSheetsConnection.upsert({
      company_id:   companyId,
      google_email: email,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || existingConn?.refresh_token || null,
      token_expiry: tokens.expiry_date    || null,
      scope:        tokens.scope          || null,
      sync_status:  'pending',
      selected_spreadsheet_ids: previousSelection,
    }, {
      conflictFields: ['company_id'],
      returning: true,
    });

    // ── List all spreadsheets the user owns ───────────────────────────────
    const spreadsheets = await listUserSpreadsheets(auth);

    // ── Upsert Source record ──────────────────────────────────────────────
    let source = await Source.findOne({
      where: {
        company_id:     companyId,
        connector_name: 'google_sheets',
      },
    });

    const connectorSettings = {
      googleEmail:  email,
      spreadsheets: spreadsheets.map(s => ({ id: s.id, name: s.name, url: s.webViewLink })),
      connectedAt:  new Date().toISOString(),
    };

    if (!source) {
      source = await Source.create({
        company_id:              companyId,
        source_name:             `Google Sheets (${email})`,
        connector_name:          'google_sheets',
        connector_settings_json: connectorSettings,
        status:                  'active',
        created_by:              String(userId),
        created_on:              new Date(),
      });
    } else {
      await source.update({ connector_settings_json: connectorSettings, status: 'active' });
    }

    const sourceId = source.id;

    // ── Redirect to frontend with sourceId for the picker ──────────────────
    // We redirect to a special picker page, which calls
    // POST /api/source/auth/google-sheets/select-sheets to save the selection
    // and trigger the sync.
    // Spreadsheet list is NOT embedded in the redirect URL — with many sheets
    // the Location header can exceed nginx's proxy header buffer and the
    // redirect itself 502s. Frontend fetches the list separately via
    // GET /auth/google-sheets/spreadsheets/:sourceId (listGoogleSpreadsheets).
    return res.redirect(
      `${FRONTEND_URL}/?google_sheets=select&sourceId=${sourceId}&companyId=${companyId}`
    );
  } catch (err) {
    console.error('[GoogleSheets] callback error:', err);
    return res.redirect(
      `${FRONTEND_URL}/?google_sheets=error&message=${encodeURIComponent(err.message || 'callback_failed')}`
    );
  }
};

// ============================================================================
// 3.  POST /api/source/auth/google-sheets/select-sheets
//     Called by frontend after user picks which spreadsheets to sync.
//     Body: { sourceId, spreadsheetIds: ["id1", "id2", ...] }
//     Saves selection, then fires background sync.
// ============================================================================
exports.googleSheetsSelectSheets = async (req, res) => {
  // mode: 'replace' (default) = selection becomes exactly spreadsheetIds
  //       'add'               = spreadsheetIds are merged into the existing
  //                             selection (used to re-sync old spreadsheets)
  const { sourceId, spreadsheetIds, mode = 'replace' } = req.body;

  if (!sourceId || !Array.isArray(spreadsheetIds) || spreadsheetIds.length === 0) {
    return res.status(400).json({ success: false, message: 'sourceId and spreadsheetIds[] are required' });
  }

  try {
    const source = await Source.findByPk(sourceId);
    if (!source) return res.status(404).json({ success: false, message: 'Source not found' });

    const companyId = source.company_id;

    const connection = await GoogleSheetsConnection.findOne({ where: { company_id: companyId } });
    if (!connection) return res.status(404).json({ success: false, message: 'Google Sheets connection not found' });

    // Save selected spreadsheet IDs
    const finalIds = mode === 'add'
      ? [...new Set([...(connection.selected_spreadsheet_ids || []), ...spreadsheetIds])]
      : spreadsheetIds;
    await connection.update({ selected_spreadsheet_ids: finalIds, sync_status: 'pending' });

    // Respond immediately — sync runs in background
    res.json({ success: true, message: 'Sheets selected. Sync started in background.' });

    // Fire-and-forget sync
    triggerGoogleSheetsSyncInBackground(source, connection).catch(err =>
      console.error('[GoogleSheets] background sync error:', err)
    );
  } catch (err) {
    console.error('[GoogleSheets] select-sheets error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ============================================================================
// 4.  POST /api/source/auth/google-sheets/sync/:sourceId
//     Manual re-sync trigger (protected, called from dashboard).
// ============================================================================
exports.syncGoogleSheetsData = async (req, res) => {
  const { sourceId } = req.params;
  try {
    const source = await Source.findByPk(sourceId);
    if (!source) return res.status(404).json({ success: false, message: 'Source not found' });

    const companyId  = source.company_id;
    const connection = await GoogleSheetsConnection.findOne({ where: { company_id: companyId } });
    if (!connection) return res.status(404).json({ success: false, message: 'Google Sheets connection not found' });

    res.json({ success: true, message: 'Google Sheets sync started in background' });

    triggerGoogleSheetsSyncInBackground(source, connection).catch(err =>
      console.error('[GoogleSheets] manual sync error:', err)
    );
  } catch (err) {
    console.error('[GoogleSheets] sync trigger error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ============================================================================
// 5.  GET /api/source/auth/google-sheets/spreadsheets/:sourceId
//     Returns the list of all spreadsheets the user's Google account has access to.
//     Used by the sheet-picker UI after OAuth.
// ============================================================================
exports.listGoogleSpreadsheets = async (req, res) => {
  const { sourceId } = req.params;
  try {
    const source = await Source.findByPk(sourceId);
    if (!source) return res.status(404).json({ success: false, message: 'Source not found' });

    const connection = await GoogleSheetsConnection.findOne({ where: { company_id: source.company_id } });
    if (!connection) return res.status(404).json({ success: false, message: 'Google Sheets connection not found' });

    const auth         = await buildAuthClient(connection);
    const spreadsheets = await listUserSpreadsheets(auth);

    let syncedIds = new Set();
    try {
      const dims = await DimSpreadsheet.findAll({
        where: { company_id: source.company_id },
        attributes: ['spreadsheet_id'],
        raw: true,
      });
      syncedIds = new Set(dims.map(d => d.spreadsheet_id));
    } catch (dimErr) {
      console.warn('[GoogleSheets] Could not load synced spreadsheet list:', dimErr.message);
    }

    return res.json({
      success: true,
      data: {
        spreadsheets: spreadsheets.map(s => ({
          id:   s.id,
          name: s.name,
          url:  s.webViewLink,
          selected: (connection.selected_spreadsheet_ids || []).includes(s.id),
          synced:   syncedIds.has(s.id),
        })),
        selectedIds: connection.selected_spreadsheet_ids || [],
      },
    });
  } catch (err) {
    console.error('[GoogleSheets] list spreadsheets error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ============================================================================
// 6.  GET /api/source/auth/google-sheets/synced/:sourceId
//     Returns every spreadsheet that has ever been synced to the warehouse,
//     with is_active (true = in current selection) and last_synced_at.
//     Lets the UI show old spreadsheets' data and offer a re-sync.
// ============================================================================
exports.getSyncedSpreadsheets = async (req, res) => {
  const { sourceId } = req.params;
  try {
    const source = await Source.findByPk(sourceId);
    if (!source) return res.status(404).json({ success: false, message: 'Source not found' });

    const rows = await DimSpreadsheet.findAll({
      where: { company_id: source.company_id },
      attributes: ['spreadsheet_id', 'title', 'owner_email', 'sheet_count', 'drive_url', 'is_active', 'last_synced_at', 'updated_at'],
      order: [['is_active', 'DESC'], ['title', 'ASC']],
      raw: true,
    });

    return res.json({
      success: true,
      data: {
        active:   rows.filter(r => r.is_active),
        inactive: rows.filter(r => !r.is_active),   // old spreadsheets — data still in warehouse
      },
    });
  } catch (err) {
    console.error('[GoogleSheets] synced spreadsheets error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ============================================================================
// INTERNAL — Background sync
// ============================================================================

/**
 * Fetches data for selected spreadsheets and stores in warehouse.
 * Runs entirely in background — caller should not await.
 */
const triggerGoogleSheetsSyncInBackground = async (source, connection) => {
  const companyId  = source.company_id;
  const sourceId   = source.id;

  console.log(`[GoogleSheets] Starting sync for company=${companyId}, source=${sourceId}`);

  // ── Helper: emit progress to frontend via socket ───────────────────────
  const emit = (stage, syncStatus, currentIndex = 0, totalEntities = 1, recordsProcessed = 0) => {
    emitQuickBooksSyncProgress(
      buildQuickBooksSyncProgress({
        companyId, sourceId, stage, syncStatus,
        currentEntity: stage,
        currentIndex, totalEntities, recordsProcessed,
      })
    );
  };

  try {
    await connection.update({ sync_status: 'in_progress', error_message: null });
    emit('Connecting to Google Sheets…', 'in_progress', 0, 4);

    const auth        = await buildAuthClient(connection);
    const sheetsApi   = google.sheets({ version: 'v4', auth });
    const selectedIds = connection.selected_spreadsheet_ids || [];

    if (selectedIds.length === 0) {
      console.warn(`[GoogleSheets] No spreadsheets selected for company=${companyId}. Skipping sync.`);
      await connection.update({ sync_status: 'completed', last_sync_at: new Date() });
      emit('No sheets selected', 'completed', 4, 4);
      return;
    }

    const total          = selectedIds.length;
    let   totalRows      = 0;

    for (let si = 0; si < selectedIds.length; si++) {
      const spreadsheetId = selectedIds[si];
      emit(`Fetching spreadsheet ${si + 1} of ${total}…`, 'in_progress', si + 1, total + 2, totalRows);

      try {
        // ── Fetch spreadsheet metadata ────────────────────────────────────
        const metaRes = await sheetsApi.spreadsheets.get({ spreadsheetId });
        const meta    = metaRes.data;
        meta.owner_email = connection.google_email;

        await insertRawData('googlesheets', 'spreadsheet', [meta], {
          companyId,
          sourceIdField: 'spreadsheetId',
        });

        console.log(`[GoogleSheets] Fetched metadata for "${meta.properties?.title}" (${spreadsheetId})`);

        // ── Fetch each sheet tab's row data ───────────────────────────────
        const sheets = meta.sheets || [];
        for (const sheet of sheets) {
          const sheetName = sheet.properties?.title;
          if (!sheetName) continue;

          try {
            const range  = `'${sheetName}'!A1:ZZ${ROW_LIMIT + 1}`;
            const valRes = await sheetsApi.spreadsheets.values.get({
              spreadsheetId,
              range,
              valueRenderOption: 'FORMATTED_VALUE',
            });

            const allRows = valRes.data.values || [];
            if (allRows.length < 2) {
              console.log(`[GoogleSheets]   Sheet "${sheetName}" has no data rows. Skipping.`);
              continue;
            }

            const headers  = allRows[0].map((h, i) => String(h).trim() || `col_${i}`);
            const dataRows = allRows.slice(1, ROW_LIMIT + 1);

            if (allRows.length > ROW_LIMIT + 1) {
              console.warn(`[GoogleSheets]   Sheet "${sheetName}" exceeds ${ROW_LIMIT} rows — truncated.`);
            }

            const rowRecords = dataRows.map((row, idx) => {
              const rowData = {};
              headers.forEach((header, colIdx) => {
                rowData[header] = row[colIdx] !== undefined ? row[colIdx] : null;
              });
              return {
                Id:             `${spreadsheetId}__${sheetName}__${idx}`,
                spreadsheet_id: spreadsheetId,
                sheet_name:     sheetName,
                row_index:      idx,
                row_data:       rowData,
              };
            });

            await insertRawData('googlesheets', 'sheet_row', rowRecords, {
              companyId,
              sourceIdField: 'Id',
            });

            totalRows += rowRecords.length;
            emit(`Syncing "${sheetName}"…`, 'in_progress', si + 1, total + 2, totalRows);
            console.log(`[GoogleSheets]   Sheet "${sheetName}": ${rowRecords.length} rows synced`);
          } catch (sheetErr) {
            console.error(`[GoogleSheets]   Error fetching sheet "${sheetName}":`, sheetErr.message);
          }
        }
      } catch (spreadsheetErr) {
        console.error(`[GoogleSheets] Error fetching spreadsheet ${spreadsheetId}:`, spreadsheetErr.message);
      }
    }

    // ── Transform raw → domain tables ─────────────────────────────────────
    emit('Transforming data…', 'in_progress', total + 1, total + 2, totalRows);
    console.log(`[GoogleSheets] Running domain transformation for company=${companyId}`);
    const summary = await transformToDomain('googlesheets', { companyId, selectedIds });
    console.log('[GoogleSheets] Transform summary:', summary);

    // ── Mark complete ──────────────────────────────────────────────────────
    const now = new Date();
    await connection.update({ sync_status: 'completed', last_sync_at: now, error_message: null });

    emit('Sync complete', 'completed', total + 2, total + 2, totalRows);
    console.log(`[GoogleSheets] Sync complete for company=${companyId} — ${totalRows} rows`);
  } catch (err) {
    console.error(`[GoogleSheets] Sync failed for company=${companyId}:`, err);
    emit('Sync failed', 'failed');
    await connection.update({ sync_status: 'failed', error_message: err.message }).catch(() => {});
  }
};

// Export for scheduler use
exports.triggerGoogleSheetsSyncInBackground = triggerGoogleSheetsSyncInBackground;
