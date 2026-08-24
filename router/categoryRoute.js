const express = require('express');
const route = express.Router();
const categoryControl = require('../controller/categoryController');
const protect = require('../middleware/authmiddleware')

route.post("/create", protect, categoryControl?.create);
route.get("/list", protect, categoryControl?.list);
route.get("/fetch-details/:id", protect, categoryControl?.fetchDetails);
route.put("/update/:id", protect, categoryControl?.update);
route.delete("/delete/:id", protect, categoryControl?.delete);
route.post("/sort", protect, categoryControl?.reorderCategories);
module.exports = route;