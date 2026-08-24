const Joi = require("joi");

exports.createSourceValidation= Joi.object({
    sourceName:Joi.string().required(),
    // workspaceId:Joi.string().required(),
    // configuration:Joi.string().required(),
})
