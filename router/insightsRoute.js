const express = require('express');
const router = express.Router();
const protect = require('../middleware/authmiddleware');
const insights = require('../controller/insightsController');

router.get('/summary', protect, insights.summary);

module.exports = router;
