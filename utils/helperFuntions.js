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
        const randomSixDigit = Math.floor(100000 + Math.random() * 900000);
        console.log(randomSixDigit);
        return randomSixDigit;
    } catch (error) {
        return null;
    }
}

exports.emailSender = async (email, display_name, OTP_CODE) => {
    try {
        const transporter = await nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: process.env.SMTP_PORT,
            secure: true, // true for 465, false for other ports
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
        });
        // Wrap in an async IIFE so we can use await.
        const info = await transporter.sendMail({
            from: 'ELT',
            to: email,
            subject: "Forget Password",
            text: `Dear [${display_name}],

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
        const transporter = await nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: process.env.SMTP_PORT,
            secure: true, // true for 465, false for other ports
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
        });
        // Wrap in an async IIFE so we can use await.
        const info = await transporter.sendMail({
            from: `<${process.env.SMTP_USER}>`,
            to: email,
            subject: "Welcome to Our Platform!",
            html: `
      <h2>Welcome, ${user_name} 👋</h2>
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