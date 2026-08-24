const Joi = require("joi");

exports.createConnectionStatusValidation = Joi.object({
    sourceId:Joi.string().required(),
    destinationId:Joi.string().required(),
    name: Joi.string().required()
})


exports.updateConnectionStatusValidation = Joi.object({
    connectionId:Joi.number().required(),
    status: Joi.string().valid('active', 'inactive').required()
})

