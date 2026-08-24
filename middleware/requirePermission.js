// middleware/requirePermission.js
// Fine-grained permission check. Run AFTER `protect`.
//
// Usage:
//   router.delete('/nav/:id', protect, requirePermission('nav:manage'), controller.delete);
//
// SuperAdmin bypasses all permission gates.
// Permission names are loaded from the DB via the role → role_permissions join.
// Results are cached per (roleId, code) pair for the process lifetime.

const { Role, Permission } = require('../model');

const forbidden = (res, msg = 'Forbidden') =>
  res.status(403).json({ success: false, data: null, message: msg });

// Map roleId → Set<permissionCode>
const permCache = new Map();

const loadPerms = async (roleId) => {
  if (permCache.has(roleId)) return permCache.get(roleId);
  const role = await Role.findByPk(roleId, {
    include: [{
      model: Permission,
      as: 'rolePermissions',
      through: { attributes: [] },
      attributes: ['code'],
    }],
  });
  const codes = new Set((role?.rolePermissions || []).map((p) => p.code));
  permCache.set(roleId, codes);
  return codes;
};

// Export so auth flows can bust cache on role change.
const bustPermCache = (roleId) => permCache.delete(roleId);

const requirePermission = (...codes) =>
  async (req, res, next) => {
    if (!req.auth) return forbidden(res, 'Auth context missing');
    if (req.auth.isSuperAdmin) return next();

    const { roleId } = req.auth;
    if (!roleId) return forbidden(res, 'No role assigned');

    const granted = await loadPerms(roleId);
    const ok = codes.some((c) => granted.has(c));
    if (!ok) return forbidden(res, `Requires permission: ${codes.join(' | ')}`);
    next();
  };

module.exports = { requirePermission, bustPermCache };
