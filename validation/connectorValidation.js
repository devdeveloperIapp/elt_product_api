const Joi = require("joi");

exports.createConnectorValidation = Joi.object({
    name: Joi.string().required(),
    icon: Joi.string().required(),
    type: Joi.string().required(),
})