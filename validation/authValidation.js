const Joi = require("joi");

exports.signupValidation = Joi.object({
  company_name: Joi.string().trim().min(2).max(100).required(),
  user_name: Joi.string().required(),
  email: Joi.string().email().required(),
  password: Joi.string().required(),
  confirm_password: Joi.string()
    .required()
    .valid(Joi.ref('password'))
    .messages({
      'any.only': 'Confirm password must match password',
    }),
});
