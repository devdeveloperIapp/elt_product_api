const Joi = require("joi");

exports.genrateAnswerValidation= Joi.object({
    question:Joi.string().required(),
    report_id:Joi.number().required(),
    category_id:Joi.number().required(),
})
