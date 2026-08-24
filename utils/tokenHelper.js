// utils/tokenHelper.js — NAYA BANAO
const axios = require('axios');
const { QuickBooksConnection } = require('../model/index');

const isTokenExpired = (connection) => {
  if (!connection?.expires_in || !connection?.updated_at) return true;
  const expiryTime = new Date(connection.updated_at);
  expiryTime.setSeconds(expiryTime.getSeconds() + connection.expires_in);
  return new Date() > expiryTime;
};

const refreshQuickBooksToken = async (connection) => {
  try {
    const response = await axios.post(
      'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: connection.refresh_token
      }),
      {
        headers: {
          Authorization: 'Basic ' + Buffer.from(
            `${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`
          ).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    await connection.update({
      access_token:  response.data.access_token,
      refresh_token: response.data.refresh_token,
      expires_in:    response.data.expires_in,
      updated_at:    new Date()
    });

    return true;
  } catch (error) {
    console.error('[TOKEN] Refresh failed:', error.message);
    return false;
  }
};

/**
 * Refresh the QuickBooks tokens stored on a `source` row's
 * connector_settings_json blob (NOT the QuickBooksConnection row).
 * Returns true on success and mutates+saves the source.
 *
 * Also mirrors the refreshed tokens onto the matching QuickBooksConnection
 * row so the rest of the app stays in sync.
 */
const refreshSourceQuickBooksToken = async (source) => {
  try {
    const settings = source.connector_settings_json || {};
    if (!settings.refresh_token) {
      console.warn('[TOKEN] Source has no refresh_token — cannot refresh.');
      return false;
    }

    const response = await axios.post(
      'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: settings.refresh_token,
      }),
      {
        headers: {
          Authorization:
            'Basic ' +
            Buffer.from(
              `${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`
            ).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 15000,
      }
    );

    const { access_token, refresh_token, expires_in } = response.data;

    const refreshedSettings = {
      ...settings,
      access_token,
      refresh_token,
      expires_at: Date.now() + (expires_in * 1000),
    };

    // Persist on the source row.
    await source.update({ connector_settings_json: refreshedSettings });

    // Mirror onto QuickBooksConnection (so other code paths that read from
    // that table also get the fresh tokens).
    try {
      const connection = await QuickBooksConnection.findOne({
        where: { company_id: settings.companyId, realm_id: settings.realmId },
      });
      if (connection) {
        await connection.update({
          access_token,
          refresh_token,
          expires_in,
          sync_status: connection.sync_status === 'failed' ? 'pending' : connection.sync_status,
          error_message: null,
          updated_at: new Date(),
        });
      }
    } catch (e) {
      console.warn('[TOKEN] Mirror to QuickBooksConnection failed:', e.message);
    }

    return refreshedSettings;
  } catch (error) {
    const detail = error.response?.data || error.message;
    console.error('[TOKEN] Source refresh failed:', detail);
    return false;
  }
};

module.exports = { isTokenExpired, refreshQuickBooksToken, refreshSourceQuickBooksToken };