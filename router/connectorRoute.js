const express = require('express');
const route = express.Router();
const connectorControl = require('../controller/connectorController');
const protect = require('../middleware/authmiddleware')

route.post("/create", connectorControl.create);
route.get("/fetch-list", connectorControl.fetchList);
route.put("/update/:connectorName", connectorControl.update);
route.delete("/delete/:connectorName", connectorControl.delete);

module.exports = route;