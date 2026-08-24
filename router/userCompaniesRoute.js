// router/userCompaniesRoute.js
const express = require('express');
const router = express.Router();
const protect = require('../middleware/authmiddleware');
const {
  listMyCompanies,
  switchActiveCompany,
} = require('../controller/userCompaniesController');

router.get('/mine',           protect, listMyCompanies);
router.post('/switch/:companyId', protect, switchActiveCompany);

module.exports = router;
