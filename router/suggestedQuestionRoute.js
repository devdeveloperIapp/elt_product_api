const express = require('express');
const route = express.Router();
const suggesstedQuestionControl = require('../controller/suggesstedQuestionController');
const protect = require('../middleware/authmiddleware')

route.post("/create", protect, suggesstedQuestionControl.create);
route.get("/list",protect, suggesstedQuestionControl.List);
// route.get("/get-destination-details/:destinationId", chatControl.getDestinationDetails);
// route.post("/check_for_update-destination/:destinationId", protect, destinationControl.checkForUpdate);
// route.put("/update-destination/:destinationId", protect, chatControl.updateDestination);
module.exports = route;