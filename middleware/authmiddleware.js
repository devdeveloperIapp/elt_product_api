// middleware/authmiddleware.js
// Phase 1 — Auth core hardening.
//
// Side effects on success:
//   - req.auth = { userId, companyId, roleId, isSuperAdmin, jti, exp }
//   - req.user = User instance (kept for back-compat with existing controllers
//                that read req.user.email etc.)
//
// Failure modes return 401 with a consistent shape.

const { verifyAccessToken } = require('../utils/jwt');
const { isRevoked } = require('../utils/tokenBlacklist');
const User = require('../model/userModel');
const { Role } = require('../model');

const unauthorized = (res, message = 'Unauthorized') =>
  res.status(401).json({ success: false, data: null, message });

const protect = async (req, res, next) => {
  try {
    const header = req.headers?.authorization || '';
    if (!header.startsWith('Bearer ')) return unauthorized(res, 'Token Not Found');

    const token = header.slice(7).trim();
    if (!token) return unauthorized(res, 'Token Not Found');

    const decoded = verifyAccessToken(token);
    if (!decoded) return unauthorized(res, 'Invalid or expired token');

    // Blacklist check (logout, password reset, force-revoke).
    if (decoded.jti && (await isRevoked(decoded.jti))) {
      return unauthorized(res, 'Token revoked');
    }

    const userId = decoded.sub ?? decoded.userId;
    if (!userId) return unauthorized(res, 'Malformed token');

    let companyId   = decoded.cid ?? null;
    let roleId      = decoded.rid ?? null;
    let isSuperAdmin = Boolean(decoded.sa);

    // Back-compat shim: tokens issued before Phase 1 had only { userId, email }.
    // Lazy-load missing claims from the DB. After the 24-hour rollout window
    // this branch can be deleted.
    //
    // 🟢 IMPORTANT: We ALWAYS read role_id / company_id / isSuperAdmin from the
    // DB (not from the JWT claims). The JWT is issued at login and becomes stale
    // the moment an admin changes the user's role or permissions. Reading fresh
    // from the DB makes role/permission changes take effect immediately — the
    // user does NOT have to log out and back in.
    const user = await User.findOne({
      where: { id: userId },
      include: [{ model: Role, as: 'userRole', attributes: ['id', 'name', 'isSuperAdmin'] }],
    });
    if (!user) return unauthorized(res, 'User not exist');
    if (user.is_active === false) return unauthorized(res, 'Account disabled');

    companyId    = user.company_id ?? companyId ?? null;
    roleId       = user.role_id ?? null;
    isSuperAdmin = Boolean(user.userRole?.isSuperAdmin);

    req.auth = {
      userId,
      companyId,
      roleId,
      isSuperAdmin,
      jti: decoded.jti || null,
      exp: decoded.exp,
    };
    req.user = user; // back-compat
    next();
  } catch (err) {
    console.error('[authmiddleware] error:', err);
    return res.status(500).json({ success: false, data: null, message: 'Something went wrong' });
  }
};

module.exports = protect;
