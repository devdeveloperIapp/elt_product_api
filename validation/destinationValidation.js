const Joi = require("joi");

exports.createDestinationValidation = Joi.object({
    destinationName: Joi.string().required(),
    workspaceId: Joi.string().required(),
    configuration: Joi.object().required(),
})