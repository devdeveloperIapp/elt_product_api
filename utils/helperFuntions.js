const nodemailer = require('nodemailer');
const AirbyteAccessToken = require('../model/airbyteAccessTokenModel');
const { updateConfig } = require('./updateConfig');
// const { updateEnv } = require('./updateConfig');

exports.token;

exports.promisePool = async (items, poolLimit, fn) => {
    const ret = [];               // all results
    const executing = [];         // currently running promises

    for (const item of items) {
        const p = Promise.resolve().then(() => fn(item));
        ret.push(p);

        if (poolLimit <= items.length) {
            const e = p.then(() => {
                executing.splice(executing.indexOf(e), 1);
            });
            executing.push(e);

            if (executing.length >= poolLimit) {
                await Promise.race(executing);
            }
        }
    }

    return Promise.all(ret);
}

exports.otpGenerator = () => {
    try {
        // Never log the code — it would let anyone with log access take over
        // an account through the reset/verification flow.
        const randomSixDigit = Math.floor(100000 + Math.random() * 900000);
        return randomSixDigit;
    } catch (error) {
        return null;
    }
}

// One transport for every mail we send. Gmail shows app passwords in
// space-separated groups, so strip whitespace before authenticating.
const mailTransport = () => nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 465,
    secure: true, // true for 465, false for other ports
    auth: {
        user: (process.env.SMTP_USER || '').trim(),
        pass: (process.env.SMTP_PASS || '').replace(/\s/g, ''),
    },
});

exports.emailSender = async (email, display_name, OTP_CODE) => {
    try {
        const transporter = mailTransport();
        // Callers may have no name on file — never greet someone as "null".
        const name = display_name || (email || '').split('@')[0] || 'there';
        // Wrap in an async IIFE so we can use await.
        const info = await transporter.sendMail({
            from: `"ScriptStory Elt" <${process.env.SMTP_USER}>`,
            to: email,
            subject: "Forgot Password",
            text: `Dear ${name},

We received a request to reset your password for your Elt account.

Please use the following One-Time Password (OTP) to proceed:

🔐 OTP: ${OTP_CODE}

Enter this code on the password reset page to verify your identity and set a new password.

If you did not request this change, please ignore this email or contact our support team immediately.

Thank you,
Elt Team
`,
        });
        // [www.elt.com]
        // Support: support@elt.com

        console.log("Message sent:", info.messageId);
        return true;
    } catch (error) {
        console.log("smtp error: ", error)
        return false;
    }
}


// Signup e-mail verification code. Sent right after the account row is
// created — the user cannot log in until this code is confirmed.
exports.verificationEmailSender = async (email, display_name, OTP_CODE) => {
    try {
        const transporter = mailTransport();
        const name = display_name || (email || '').split('@')[0] || 'there';
        const info = await transporter.sendMail({
            from: `"ScriptStory Elt" <${process.env.SMTP_USER}>`,
            to: email,
            subject: "Verify your email address",
            html: `
      <h2>Hi ${name} 👋</h2>
      <p>Thanks for signing up for the ELT platform. Please confirm your email address to activate your account.</p>
      <p style="font-size:20px;letter-spacing:4px;"><strong>🔐 ${OTP_CODE}</strong></p>
      <p>This code expires in 10 minutes.</p>
      <p>If you did not create this account, you can safely ignore this email.</p>
    `
        });

        console.log("Message sent:", info.messageId);
        return true;
    } catch (error) {
        console.log("smtp error: ", error)
        return false;
    }
}

exports.getAccessTokenFromDatabase = async () => {
    const data = await AirbyteAccessToken.findAll();
    if (data?.length > 0) {
        // updateConfig("AIRBYTE_API_TOKEN", data[0].access_token);
        return data[0];
    }
    return null;
}

exports.welcomeEmailSender = async (email, user_name) => {
    try {
        const transporter = mailTransport();
        const name = user_name || (email || '').split('@')[0] || 'there';
        // Wrap in an async IIFE so we can use await.
        const info = await transporter.sendMail({
            from: `"ScriptStory Elt" <${process.env.SMTP_USER}>`,
            to: email,
            subject: "Welcome to Our Platform!",
            html: `
      <h2>Welcome, ${name} 👋</h2>
      <p>Thanks for signing up for our ELT platform!</p>
      <p>We're excited to have you onboard.</p>
    `
        });
        // [www.elt.com]
        // Support: support@elt.com

        console.log("Message sent:", info.messageId);
        return true;
    } catch (error) {
        console.log("smtp error: ", error)
        return false;
    }
}