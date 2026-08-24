const express = require('express');
const route = express.Router();
const reportControl = require('../controller/reportController');
const protect = require('../middleware/authmiddleware');

route.post("/create",              protect, reportControl.create);
route.get("/list",                 protect, reportControl.list);
route.get("/admin/list",           protect, reportControl.adminList);    // ← super-admin: all companies
route.get("/by-nav-slug/:slug",    protect, reportControl.byNavSlug);   // ← Power BI by nav
route.get("/fetch-details/:id",    protect, reportControl.fetchDetails);
route.put("/update/:id",           protect, reportControl.update);
route.delete("/delete/:id",        protect, reportControl.delete);
route.post("/sort",                protect, reportControl.updateOrder);

module.exports = route;