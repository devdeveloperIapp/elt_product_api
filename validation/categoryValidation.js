const Joi = require("joi");

exports.createCategoryValidation = Joi.object({
    name: Joi.string().required()
})

