const https = require('https');
const axios = require('axios');
const { getAccessTokenFromDatabase } = require('../utils/helperFuntions');
const globalData = require('../utils/globalData');

// const AirByteApi = ()=>{
//   getAccessTokenFromDatabase().then((resp)=>console.log("resp",resp.data));
// }
// AirByteApi()
// const data= (async()=> await getAccessTokenFromDatabase());
// console.log("datas",data)


const agent = new https.Agent({
  rejectUnauthorized: false, // ⚠️ Not safe for production
});

const Airbyte = axios.create({
  baseURL: process.env.AIRBYTE_BASE_URL, // use HTTPS here if SSL is enabled
  httpsAgent: agent,
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${globalData.accessToken}`,
  },
});

const AirbytePublic = axios.create({
  baseURL: process.env.AIRBYTE_BASE_PUBLIC_URL, // use HTTPS here if SSL is enabled
  httpsAgent: agent,
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${globalData.accessToken}`,
  },
});

module.exports = { Airbyte, AirbytePublic };