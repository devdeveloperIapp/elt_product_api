const Joi = require("joi");

exports.createSuggestedquestionValidation = Joi.object({
    question: Joi.string().required(),
    category_id: Joi.number().required(),
    report_id: Joi.number().required(),
})

exports.getSuggestedquestionValidation = Joi.object({
    category_id: Joi.number().required(),
    report_id: Joi.number().required(),
})
