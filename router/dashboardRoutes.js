const express = require('express');
const router  = express.Router();
const ctrl        = require('../controller/DashboardController');
const zohoCtrl     = require('../controller/ZohoBooksDashboardController');
const shopifyCtrl  = require('../controller/ShopifyDashboardController');
const sheetCtrl    = require('../controller/SpreadsheetDashboardController');

// QuickBooks (unprefixed — existing routes, unchanged)
router.get('/company/:companyId/dashboard',          ctrl.getOverviewDashboard);
router.get('/company/:companyId/invoices',           ctrl.getInvoiceDashboard);
router.get('/company/:companyId/vendors',            ctrl.getVendorDashboard);
router.get('/company/:companyId/customers',          ctrl.getCustomerDashboard);
router.get('/company/:companyId/revenue',            ctrl.getRevenueDashboard);
router.get('/company/:companyId/profit-loss',        ctrl.getPLDashboard);
router.get('/company/:companyId/cash-flow',          ctrl.getCashFlowDashboard);

// Zoho Books (separate dashboard — its own zohobooks_domain data only)
router.get('/company/:companyId/zohobooks/dashboard', zohoCtrl.getOverviewDashboard);
router.get('/company/:companyId/zohobooks/invoices',  zohoCtrl.getInvoiceDashboard);
router.get('/company/:companyId/zohobooks/vendors',   zohoCtrl.getVendorDashboard);
router.get('/company/:companyId/zohobooks/customers', zohoCtrl.getCustomerDashboard);
router.get('/company/:companyId/zohobooks/revenue',   zohoCtrl.getRevenueDashboard);

// Shopify (separate dashboard — ecommerce shape, its own shopify_domain data only)
router.get('/company/:companyId/shopify/dashboard', shopifyCtrl.getOverviewDashboard);
router.get('/company/:companyId/shopify/orders',    shopifyCtrl.getOrdersDashboard);
router.get('/company/:companyId/shopify/products',  shopifyCtrl.getProductsDashboard);
router.get('/company/:companyId/shopify/customers', shopifyCtrl.getCustomersDashboard);

// Spreadsheet sources (Google Sheets / Google Drive / Excel) — same shape,
// one shared controller, parameterised by :source. Each source's data stays
// in its own schema (google_sheets_domain / google_drive_domain / excel_domain).
// :source is validated inside the controller (validateSource) against
// ['googlesheets', 'googledrive', 'excel'] — Express 5 (path-to-regexp v8)
// dropped support for inline regex constraints like :source(a|b|c).
router.get('/company/:companyId/:source/spreadsheets',
  sheetCtrl.getOverviewDashboard);
router.get('/company/:companyId/:source/spreadsheets/:spreadsheetId/sheets',
  sheetCtrl.getSheetsDashboard);
router.get('/company/:companyId/:source/spreadsheets/:spreadsheetId/sheets/:sheetName/rows',
  sheetCtrl.getRowsDashboard);

module.exports = router;