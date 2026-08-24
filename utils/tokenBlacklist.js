// utils/tokenBlacklist.js
// Redis-backed JWT denylist. Stores `revoked:<jti>` with TTL = remaining
// access-token lifetime. Verification path is one round-trip Redis GET.

const { client } = require('./redis');

const KEY = (jti) => `jwt:revoked:${jti}`;

/**
 * Mark a jti as revoked until the original token's natural expiry.
 *
 * @param {string} jti
 * @param {number} expSeconds  Unix epoch (seconds) — pass decoded.exp from the token.
 */
const revoke = async (jti, expSeconds) => {
  if (!jti) return;
  const ttl = Math.max(1, expSeconds - Math.floor(Date.now() / 1000));
  try {
    await client.set(KEY(jti), '1', { EX: ttl });
  } catch (err) {
    // If Redis is down we fail open — alternative is locking everyone out.
    // Emit a loud log so monitoring can pick it up.
    console.error('[tokenBlacklist] Redis SET failed:', err.message);
  }
};

const isRevoked = async (jti) => {
  if (!jti) return false;
  try {
    const v = await client.get(KEY(jti));
    return v === '1';
  } catch (err) {
    console.error('[tokenBlacklist] Redis GET failed:', err.message);
    return false; // fail open
  }
};

module.exports = { revoke, isRevoked };
