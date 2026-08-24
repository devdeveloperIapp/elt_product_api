const express = require('express');
const route = express.Router();
const destinationControl = require('../controller/destinationController');
const protect = require('../middleware/authmiddleware');
const upload = require('../middleware/upload');

route.post("/create-destination", protect,upload.single('file'), destinationControl.createDestination);
route.get("/get-destination-list", protect, destinationControl.getDestinationList);
route.get("/get-destination-details/:destinationId", protect, destinationControl.getDestinationDetails);
route.post("/check_for_update-destination/:destinationId", protect, destinationControl.checkForUpdate);
route.put("/update-destination/:destinationId", protect,upload.single('file'), destinationControl.updateDestination);
// Delete a destination
route.delete("/delete-destination/:destinationId", protect, destinationControl.deleteDestination);


module.exports = route;