// middleware/requireRole.js
// Role-based access control. Always run AFTER the `protect` middleware.
//
// Usage:
//   const protect = require('./authmiddleware');
//   const { requireRole, requireSuperAdmin } = require('./requireRole');
//
//   router.post('/users', protect, requireSuperAdmin, controller.createUser);
//   router.put('/billing', protect, requireRole('admin', 'owner'), controller.updateBilling);

const { Role } = require('../model');

const forbidden = (res, message = 'Forbidden') =>
  res.status(403).json({ success: false, data: null, message });

/**
 * Ensure req.auth.roleId resolves to one of `allowed` role names.
 * Roles are looked up once and cached by id for the lifetime of the process.
 */
const roleNameCache = new Map();

const resolveRoleName = async (roleId) => {
  if (roleId == null) return null;
  if (roleNameCache.has(roleId)) return roleNameCache.get(roleId);
  const role = await Role.findOne({ where: { id: roleId }, attributes: ['name'] });
  const name = role?.name?.toLowerCase() || null;
  roleNameCache.set(roleId, name);
  return name;
};

const requireRole = (...allowed) => {
  const allowedLower = allowed.map((r) => String(r).toLowerCase());
  return async (req, res, next) => {
    if (!req.auth) return forbidden(res, 'Auth context missing');
    if (req.auth.isSuperAdmin) return next(); // super admin bypasses role gates

    const name = await resolveRoleName(req.auth.roleId);
    if (!name) return forbidden(res, 'No role assigned');
    if (!allowedLower.includes(name)) {
      return forbidden(res, `Requires role: ${allowed.join(' | ')}`);
    }
    next();
  };
};

const requireSuperAdmin = (req, res, next) => {
  if (!req.auth) return forbidden(res, 'Auth context missing');
  if (!req.auth.isSuperAdmin) return forbidden(res, 'Super admin only');
  next();
};

module.exports = { requireRole, requireSuperAdmin };
