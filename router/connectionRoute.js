const express = require('express');
const route = express.Router();
const connectionControl = require('../controller/connectionController');
const protect = require('../middleware/authmiddleware')

route.post("/create-connection", protect, connectionControl.createConnection);
route.get("/get-connection-list", protect, connectionControl.getConnections);
route.get("/get-connection-details/:connectionId", protect, connectionControl.getConnectionDetails);
route.put("/update-connection/:connectionId", protect, connectionControl.updateConnection);
route.get("/get-last-job/:connectionId", protect, connectionControl.getLastJobDetails);
route.put("/update-connection-status", protect, connectionControl.updateConnectionStatus);
// In your backend routes
route.post('/sync-connection/:connectionId', protect, connectionControl.syncConnection);
// Delete a connection
route.delete('/delete-connection/:connectionId',protect, connectionControl.deleteConnection);
module.exports = route;