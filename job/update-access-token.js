const cron = require("node-cron");
const AirbyteAccessToken = require("../model/airbyteAccessTokenModel");
const { updateAccessToken } = require("../utils/airbyte");
const { getAccessTokenFromDatabase } = require("../utils/helperFuntions");
const jwt = require('jsonwebtoken');
const { globalData } = require("../utils/globalData");
const { updateConfig } = require("../utils/updateConfig");

// schedule: every day at 00:00
cron.schedule("*/10 * * * * *", async () => {
    try {
        console.log("cron is running.....")
        const data = await getAccessTokenFromDatabase();
        if (!data) {
            const accessToken = await updateAccessToken();
            const createAccessToken = await AirbyteAccessToken.create({ access_token: accessToken });
        }
        else {
            // console.log("data", data.dataValues)
            const token_data = jwt.decode(data.dataValues.access_token, { complete: true });
            const tokenExpTime = new Date(token_data.payload.exp * 1000);
            const nowDate = new Date();
            console.log(`token expire time = ${tokenExpTime} and current time = ${nowDate}`);
            if (tokenExpTime.getTime() < nowDate.getTime()) {
                console.log("token has expired")
                const accessToken = await updateAccessToken();
                const updateToken = await AirbyteAccessToken.update({ access_token: accessToken }, {
                    where: { access_token: data.access_token },
                    returning: true
                })
                const updateddata = await getAccessTokenFromDatabase();
                updateConfig(accessToken)
            }
            // else {
            //     // globalData.acccess_token = data.dataValues.access_token;
            //     // updateConfig(data.dataValues.access_token)
            // }
        }

    } catch (error) {
        console.log("error", error);
    }
});

