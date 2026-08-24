// controller/roleController.js
// Role + permission management — SuperAdmin only.

const { Role, Permission, RolePermission } = require('../model');

// GET /api/admin/roles
exports.listRoles = async (req, res) => {
  try {
    const roles = await Role.findAll({
      include: [{
        model: Permission,
        as: 'rolePermissions',
        through: { attributes: [] },
        attributes: ['id', 'name', 'code', 'module'],
      }],
      order: [['id', 'ASC']],
    });
    return res.json({ success: true, data: roles });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/permissions
exports.listPermissions = async (req, res) => {
  try {
    const permissions = await Permission.findAll({
      attributes: ['id', 'name', 'code', 'module', 'description'],
      order: [['module', 'ASC'], ['name', 'ASC']],
    });
    return res.json({ success: true, data: permissions });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/admin/roles/:id/permissions
// Body: { permission_ids: [1, 2, 3, ...] }
exports.setRolePermissions = async (req, res) => {
  try {
    const roleId = Number(req.params.id);
    const { permission_ids } = req.body;
    if (!Array.isArray(permission_ids)) {
      return res.status(400).json({ success: false, message: 'permission_ids array required' });
    }
    const role = await Role.findByPk(roleId);
    if (!role) return res.status(404).json({ success: false, message: 'Role not found' });

    // Replace all permissions for this role
    await RolePermission.destroy({ where: { role_id: roleId } });
    if (permission_ids.length > 0) {
      const rows = permission_ids.map((pid) => ({ role_id: roleId, permission_id: pid }));
      await RolePermission.bulkCreate(rows, { ignoreDuplicates: true });
    }

    // Bust the requireRole/requirePermission middleware cache
    const { bustPermCache } = require('../middleware/requirePermission');
    bustPermCache(roleId);

    const updated = await Role.findByPk(roleId, {
      include: [{
        model: Permission,
        as: 'rolePermissions',
        through: { attributes: [] },
        attributes: ['id', 'name', 'code', 'module'],
      }],
    });
    return res.json({ success: true, data: updated, message: 'Permissions updated' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
