const express = require('express');
const route = express.Router();
const authControl = require('../controller/authController');
const userControl = require('../controller/userController');
const protect = require('../middleware/authmiddleware');

route.post("/signup", authControl.signup);
route.post("/verify-signup-otp", authControl.verifySignupOtp);   // activate a new account
route.post("/resend-signup-otp", authControl.resendSignupOtp);
route.post("/signin", authControl.login);
route.post("/google", authControl.googleLogin);   // Sign in with Google
route.post("/forget-password", authControl.forgetPassword);
route.post("/validate-otp", authControl.otpValidator);
route.post("/reset-password", protect, authControl.resetPassword);

// Phase 1 — token lifecycle
route.post("/refresh",     authControl.refresh);
route.post("/logout",      authControl.logout);
route.post("/logout-all",  protect, authControl.logoutAll);

// Current-user profile + permissions
route.get("/me",              protect, authControl.me);
route.get("/me/permissions",  protect, authControl.myPermissions);

// Current-user preferences
route.put("/default-dashboard", protect, userControl.setDefaultDashboard);

module.exports = route;
