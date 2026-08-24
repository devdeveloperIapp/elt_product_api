const https = require('https');
const axios = require('axios');

const agent = new https.Agent({
    rejectUnauthorized: false, // ⚠️ Not safe for production
});

const Chat = axios.create({
    baseURL: process.env.CHAT_BASE_URL, // use HTTPS here if SSL is enabled
    httpsAgent: agent,
    headers: {
        'Content-Type': 'application/json',
    },
});

module.exports = { Chat };