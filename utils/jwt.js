// utils/jwt.js
// Access + Refresh token helpers.
//
// Access token: short-lived (15m), carries full claims, blacklistable via jti.
// Refresh token: long-lived (7d), opaque random string, hashed at rest in DB.
//
// Claims schema (access token):
//   { sub: userId, cid: companyId, rid: roleId, sa: isSuperAdmin, jti, iat, exp, typ: 'access' }
//
// Backward compat: legacy tokens (no `cid`) continue to verify; the auth
// middleware lazy-loads company_id from DB. Remove the back-compat path
// after a 24-hour rollout window once all clients have re-logged-in.

const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const ACCESS_TTL  = process.env.JWT_ACCESS_TTL  || '15m';
const REFRESH_TTL_DAYS = Number(process.env.JWT_REFRESH_TTL_DAYS || 7);

const ACCESS_SECRET  = process.env.JWT_SECRET_KEY;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || (ACCESS_SECRET + ':refresh');

if (!ACCESS_SECRET) {
  // Fail loud at boot — no JWT secret = nothing else matters.
  throw new Error('JWT_SECRET_KEY env var is required');
}

const newJti = () => crypto.randomBytes(16).toString('hex');

/**
 * Sign an access token. `user` should already have role + company_id resolved.
 *   user = { id, email, company_id, role_id, userRole?: { isSuperAdmin } }
 */
const signAccessToken = (user) => {
  const payload = {
    sub: user.id,
    email: user.email,
    cid: user.company_id ?? null,
    rid: user.role_id ?? null,
    sa: Boolean(user.userRole?.isSuperAdmin || user.isSuperAdmin),
    typ: 'access',
    jti: newJti(),
  };
  return {
    token: jwt.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_TTL }),
    jti: payload.jti,
  };
};

/**
 * Generate a refresh token. The plaintext is returned to the client,
 * the SHA-256 hash should be stored in DB by the caller.
 */
const generateRefreshToken = (userId) => {
  const plaintext = crypto.randomBytes(48).toString('hex'); // 96 chars
  const hash = crypto.createHash('sha256').update(plaintext).digest('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
  return {
    plaintext,
    hash,
    expiresAt,
    userId,
  };
};

const hashRefreshToken = (plaintext) =>
  crypto.createHash('sha256').update(plaintext).digest('hex');

const verifyAccessToken = (token) => {
  try {
    return jwt.verify(token, ACCESS_SECRET);
  } catch {
    return null;
  }
};

// ---- legacy compatibility ----
// The old code called `setUser(user)` and `getUser(token)`. Keep them as
// thin shims so existing controllers/middleware do not break mid-rollout.
const setUser = (user) => signAccessToken(user).token;

const getUser = (token) => {
  const decoded = verifyAccessToken(token);
  if (!decoded) return null;
  // Old shape was { userId, email }. New code reads `sub`. Map both.
  return {
    ...decoded,
    userId: decoded.sub ?? decoded.userId,
    companyId: decoded.cid ?? null,
    roleId: decoded.rid ?? null,
    isSuperAdmin: Boolean(decoded.sa),
    jti: decoded.jti,
  };
};

module.exports = {
  signAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  verifyAccessToken,
  // legacy
  setUser,
  getUser,
};
