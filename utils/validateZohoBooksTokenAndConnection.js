const axios = require("axios");

async function generateZohoAccessToken({ client_id, client_secret, refresh_token, base_url }) {
  const url = `${base_url}/oauth/v2/token`;

  const params = new URLSearchParams({
    refresh_token,
    client_id,
    client_secret,
    grant_type: "refresh_token"
  });

  const response = await axios.post(url, params);

  if (!response.data.access_token) {
    throw new Error("Failed to generate Zoho access token");
  }

  return response.data.access_token;
}

async function getZohoOrganizations(access_token, region) {
  const url = `https://books.zoho.${region}/api/v3/organizations`;

  const response = await axios.get(url, {
    headers: { Authorization: `Zoho-oauthtoken ${access_token}` }
  });

  if (!response.data.organizations?.length) {
    throw new Error("No Zoho Books organizations found");
  }

  const org = response.data.organizations[0];
  return {
    organization_id: org.organization_id,
    organization_name: org.name
  };
}

module.exports = { generateZohoAccessToken, getZohoOrganizations };
