const { Airbyte, AirbytePublic } = require("../connection/airByteConnection")
const AirbyteAccessToken = require("../model/airbyteAccessTokenModel")


exports.updateAccessToken = async () => {
    try {
        const payload = { client_id: process.env.AIRBYTE_CLIENT_ID, client_secret: process.env.AIRBYTE_CLIENT_SECRET }
        const data = await AirbytePublic.post("/applications/token", payload);
        // console.log("data.access_token", data.data.access_token);
        return data.data.access_token;
    } catch (error) {
        console.error("error", error)
    }
}
