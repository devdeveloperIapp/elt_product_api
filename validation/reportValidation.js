const Joi = require("joi");

exports.createReportValidation = Joi.object({
    name: Joi.string().required(),
    embeded_url: Joi.string().required(),
    // Optional — companies without categories can still have nav_slug reports.
    category_id: Joi.number().optional().allow(null, ''),
    // Optional slug that links this report to a sidebar navigation item.
    // e.g. nav item path = /reports/cash-flow  →  nav_slug = 'cash-flow'
    nav_slug: Joi.string()
        .pattern(/^[a-z0-9-]*$/)
        .max(100)
        .allow('', null)
        .optional(),
    is_active: Joi.boolean().optional(),
})
