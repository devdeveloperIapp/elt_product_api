const express = require('express');
const route = express.Router();
const sourceControl = require('../controller/sourceController');
const protect = require('../middleware/authmiddleware')
const upload = require('../middleware/upload');
const { quickBooksAuth, quickBooksCallback, quickBooksRefreshToken, getQuickBooksData, getAllQuickBooksEntities, getQuickBooksEntity, syncQuickBooksData } = require('../controller/QuickBookLogingController');
const { googleSheetsAuth, googleSheetsCallback, googleSheetsSelectSheets, syncGoogleSheetsData, listGoogleSpreadsheets, getSyncedSpreadsheets } = require('../controller/GoogleSheetsController');
const { googleDriveAuth, googleDriveCallback, googleDriveSelectFolders, syncGoogleDriveData, listGoogleDriveFolders, getSyncedGoogleDriveFiles } = require('../controller/GoogleDriveController');
const { uploadExcel } = require('../controller/ExcelController');
const { getSheets, getData, queryData } = require('../controller/ExcelReportController');
// route.post("/create-source", protect, sourceControl.createSource);
route.get("/get-source-list",    protect, sourceControl.getSourceList);
route.get("/has-connected",      protect, sourceControl.hasConnectedSource); // ← onboarding check
route.get("/get-source-details/:sourceId", protect, sourceControl.getSourceDetails);
route.post("/check_for_update-source/:sourceId", protect, sourceControl.checkForUpdate);
route.put("/update-source/:sourceId", protect,upload.single('file'), sourceControl.updateSource);
route.post("/discover-schema", protect, sourceControl.discoverSchema);
// Delete a source (cascade=true deletes related connections as well)
route.delete("/delete-source/:sourceId", protect, sourceControl.deleteSource);

//for  create-excel
route.post("/create-source", protect, upload.single('file'), sourceControl.createSource);

/* ====================================================================== */
/*                              GOOGLE OAUTH                              */
/* ====================================================================== */
route.get('/auth/google/auth', sourceControl.googleAuth);
route.post('/auth/google/callback', sourceControl.googleCallback);
route.post('/auth/google/refresh', sourceControl.googleRefreshToken);
// route.get('/auth/google/callback', sourceControl.googleCallback);


/* ====================================================================== */
/*                              ONEDRIVE OAUTH                              */
/* ====================================================================== */
// OneDrive OAuth routes
route.get("/auth/onedrive/auth", sourceControl.oneDriveAuth);
route.post("/auth/onedrive/callback", sourceControl.oneDriveCallback);
route.post("/auth/onedrive/refresh", sourceControl.oneDriveRefreshToken);
/* ====================================================================== */
/*                              SHOPIFY OAUTH                              */
/* ====================================================================== */

route.post('/scheduler/check_connection',          sourceControl.checkConnection);
// auth-url: protected — needs logged-in user (state = userId)
route.post('/shopify/auth-url',            protect, sourceControl.getShopifyAuthUrl);
// callback: GET — Shopify redirects here after user authorizes
route.get ('/shopify/callback',                    sourceControl.handleShopifyCallback);
route.post('/shopify/test-connection',             sourceControl.testShopifyConnection);
route.get ('/shopify/check-connection/:sourceId',  sourceControl.checkShopifyConnection);
route.post('/shopify/sync/:sourceId',      protect, sourceControl.triggerShopifySync);

/* ====================================================================== */
/*                           ZOHOBOOKS OAUTH                              */
/* ====================================================================== */

// auth-url: protected — needs logged-in user (state = userId_region)
route.post('/zoho/auth-url',               protect, sourceControl.getZohoAuthUrl);
// callback: GET — Zoho redirects here after user authorizes
route.get ('/zoho/callback',                       sourceControl.handleZohoCallback);
// Manual re-sync
route.post('/zoho/sync/:sourceId',         protect, sourceControl.triggerZohoBooksSync);
/* ====================================================================== */
/*                              CONNECTIONS                                */
/* ====================================================================== */

// Get list of connections (optionally by sourceId, with filters/paging)
route.get("/get-connection-list", protect, sourceControl.getConnectionList);

// Delete a connection
route.delete("/delete-connection/:connectionId", protect, sourceControl.deleteConnection);




/* =============================
   USER LOGIN (Simple Demo Auth)
============================= */

/* ====================================================================== */
/*                         EXCEL FILE UPLOAD                              */
/* ====================================================================== */

// Upload .xlsx / .xls / .csv file → parse → store in warehouse (protected)
route.post('/auth/excel/upload', protect, upload.single('file'), uploadExcel);

// Excel report viewer endpoints
route.get('/excel-report/:sourceId/sheets', protect, getSheets);
route.get('/excel-report/:sourceId/data',   protect, getData);
route.post('/excel-report/:sourceId/query', protect, queryData);

/* ====================================================================== */
/*                        GOOGLE SHEETS OAUTH                             */
/* ====================================================================== */

// Get Google OAuth consent URL  (protected — needs logged-in user)
route.get('/auth/google-sheets/auth',                      protect, googleSheetsAuth);

// Google redirects here after user grants consent  (unprotected)
route.get('/auth/google-sheets/callback',                           googleSheetsCallback);

// User selects which spreadsheets to sync  (protected)
route.post('/auth/google-sheets/select-sheets',            protect, googleSheetsSelectSheets);

// List all spreadsheets available in the connected Google account  (protected)
route.get('/auth/google-sheets/spreadsheets/:sourceId',    protect, listGoogleSpreadsheets);

// Manual re-sync trigger  (protected)
route.post('/auth/google-sheets/sync/:sourceId',           protect, syncGoogleSheetsData);

// All spreadsheets ever synced to the warehouse — active + old (protected)
route.get('/auth/google-sheets/synced/:sourceId',          protect, getSyncedSpreadsheets);

/* ====================================================================== */
/*                         GOOGLE DRIVE OAUTH                             */
/* ====================================================================== */

// Get Google OAuth consent URL  (protected — needs logged-in user)
route.get('/auth/google-drive/auth',                       protect, googleDriveAuth);

// Google redirects here after user grants consent  (unprotected)
route.get('/auth/google-drive/callback',                            googleDriveCallback);

// User selects which folders to sync  (protected)
route.post('/auth/google-drive/select-folders',            protect, googleDriveSelectFolders);

// List all folders in the connected Google account  (protected)
route.get('/auth/google-drive/folders/:sourceId',          protect, listGoogleDriveFolders);

// Manual re-sync trigger  (protected)
route.post('/auth/google-drive/sync/:sourceId',            protect, syncGoogleDriveData);

// All files ever synced to the warehouse — active + old (protected)
route.get('/auth/google-drive/synced/:sourceId',           protect, getSyncedGoogleDriveFiles);

/* ====================================================================== */
/*                         QUICKBOOKS OAUTH                               */
/* ====================================================================== */

// Get QuickBooks auth URL
route.get('/auth/quickbooks/auth', protect, quickBooksAuth);

// QuickBooks callback
route.get('/auth/quickbooks/callback', quickBooksCallback);

// Refresh token
route.post('/auth/quickbooks/refresh', protect, quickBooksRefreshToken);

// Fetch all QuickBooks entities
route.get('/auth/quickbooks/data/:sourceId', protect, getQuickBooksData);

// In your routes file, add these routes:

// Get all QuickBooks entities
route.get('/auth/quickbooks/entities/:sourceId', protect, getAllQuickBooksEntities);

// Get specific QuickBooks entity with filters
route.get('/auth/quickbooks/entities/:sourceId/:entityType', protect, getQuickBooksEntity);

// Sync all QuickBooks data (runs in background)
route.post('/auth/quickbooks/sync/:sourceId', protect, syncQuickBooksData);

module.exports = route;
