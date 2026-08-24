const express = require('express');
const route = express.Router();
const chatControl = require('../controller/chatController');
const protect = require('../middleware/authmiddleware')

route.post("/generate-answer", protect, chatControl.generateAnswer);
route.get("/get-chat-history", protect, chatControl.fetchChatHistory);
// route.get("/get-destination-details/:destinationId", chatControl.getDestinationDetails);
// route.post("/check_for_update-destination/:destinationId", protect, destinationControl.checkForUpdate);
// route.put("/update-destination/:destinationId", protect, chatControl.updateDestination);
module.exports = route;