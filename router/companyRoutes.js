// routes/companyRoutes.js
const express = require('express');
const router = express.Router();
const {
  createCompany,
  getAllCompanies,
  getCompanyById,
  updateCompany,
  deleteCompany,
  getCompanyDashboardData,
  getChartData,
  generateReportPDF,
  scheduleReport,
  getRealmIdByUserId
} = require('../controller/QuickBookLogingController');
const protect = require('../middleware/authmiddleware')

// Company routes
router.route('/')
  .post(protect, createCompany)
  .get(protect, getAllCompanies);

router.route('/:companyId')
  .get(protect, getCompanyById)
  .put(protect, updateCompany)
  .delete(protect, deleteCompany);

// Dashboard routes
router.get('/company/:companyId/dashboard', protect, getCompanyDashboardData);
router.get('/:companyId/charts/:chartId', protect, getChartData);

// Report routes
router.get('/:companyId/reports/:reportId/pdf', protect, generateReportPDF);
router.post('/:companyId/reports/schedule', protect, scheduleReport);
router.get('/realm/:userId', protect, getRealmIdByUserId);

module.exports = router;