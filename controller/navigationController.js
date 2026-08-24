const navigationService = require('../services/navigationService');
const User = require('../model/userModel');
const Role = require('../model/Role');
const Permission = require('../model/Permission');
const NavigationItem = require('../model/NavigationItem');
const UserNavigationOverride = require('../model/UserNavigationOverride');

// @desc    Get user navigation based on role
// @route   GET /api/nav/navigationItem
// @access  Private
exports.getUserNavigation = async (req, res) => {
  try {
    const { userId, roleId, isSuperAdmin } = req.auth;

    // SuperAdmin sees ALL active nav items.
    if (isSuperAdmin) {
      const all = await navigationService.getAllActive();
      return res.json({ success: true, data: all });
    }

    // getUserNavigation now returns the final tree (role + granted − hidden),
    // so we return it directly. Works even when roleId is null (granted-only).
    const tree = await navigationService.getUserNavigation(userId, roleId);
    return res.json({ success: true, data: tree });
  } catch (error) {
    console.error('Error in getUserNavigation:', error);
    res.status(500).json({ success: false, message: error.message || 'Error fetching navigation' });
  }
};

// @desc    Check route permission
// @route   GET /api/nav/navigation/check/:path
// @access  Private
exports.checkRoutePermission = async (req, res) => {
  try {
    const { path } = req.params;
    const { userId, roleId, isSuperAdmin } = req.auth;

    if (isSuperAdmin) return res.json({ success: true, hasPermission: true });
    if (!roleId) return res.json({ success: true, hasPermission: false });

    const hasPermission = await navigationService.checkRoutePermission(userId, roleId, path);
    res.json({ success: true, hasPermission });
  } catch (error) {
    console.error('Error in checkRoutePermission:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get all navigation items (admin only)
// @route   GET /api/navigation/all
// @access  Private
exports.getAllNavigationItems = async (req, res) => {
  try {
    // Check if user is admin (you can add role check here)
    const navigationItems = await NavigationItem.findAll({
      include: [
        {
          model: Permission,
          as: 'navigationPermissions',
          through: { attributes: [] },
          attributes: ['id', 'name', 'code']
        },
        {
          model: NavigationItem,
          as: 'childItems',
          include: [
            {
              model: Permission,
              as: 'navigationPermissions',
              through: { attributes: [] },
              attributes: ['id', 'name', 'code']
            }
          ]
        }
      ],
      where: { parent_id: null },
      order: [['sort_order', 'ASC']]
    });

    res.json({
      success: true,
      data: navigationItems
    });
  } catch (error) {
    console.error('Error in getAllNavigationItems:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
};

// @desc    Create navigation item (admin only)
// @route   POST /api/navigation
// @access  Private
exports.createNavigationItem = async (req, res) => {
  try {
    const { name, icon, path, module, parent_id, sort_order, permission_ids,
            is_super_admin_visible } = req.body;

    const navigationItem = await NavigationItem.create({
      name,
      icon,
      path,
      module,
      parent_id: parent_id || null,
      sort_order: sort_order || 0,
      is_active: true,
      is_super_admin_visible:
        is_super_admin_visible === undefined ? true : !!is_super_admin_visible,
    });

    // Assign permissions if provided
    if (permission_ids && permission_ids.length > 0) {
      await navigationItem.setNavigationPermissions(permission_ids);
    }

    res.status(201).json({
      success: true,
      message: 'Navigation item created successfully',
      data: navigationItem
    });
  } catch (error) {
    console.error('Error in createNavigationItem:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
};

// @desc    Update navigation item (admin only)
// @route   PUT /api/navigation/:id
// @access  Private
exports.updateNavigationItem = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, icon, path, module, parent_id, sort_order, is_active,
            is_super_admin_visible, permission_ids } = req.body;

    const navigationItem = await NavigationItem.findByPk(id);

    if (!navigationItem) {
      return res.status(404).json({
        success: false,
        message: 'Navigation item not found'
      });
    }

    await navigationItem.update({
      name: name || navigationItem.name,
      icon: icon || navigationItem.icon,
      path: path || navigationItem.path,
      module: module || navigationItem.module,
      parent_id: parent_id !== undefined ? parent_id : navigationItem.parent_id,
      sort_order: sort_order !== undefined ? sort_order : navigationItem.sort_order,
      is_active: is_active !== undefined ? is_active : navigationItem.is_active,
      is_super_admin_visible:
        is_super_admin_visible !== undefined
          ? !!is_super_admin_visible
          : navigationItem.is_super_admin_visible,
    });

    // Update permissions only when explicitly provided (array check prevents
    // calling setNavigationPermissions on a simple toggle-active request)
    if (Array.isArray(permission_ids)) {
      await navigationItem.setNavigationPermissions(permission_ids);
    }

    res.json({
      success: true,
      message: 'Navigation item updated successfully',
      data: navigationItem
    });
  } catch (error) {
    console.error('Error in updateNavigationItem:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
};

// @desc    Reorder navigation items (drag-and-drop)
// @route   PATCH /api/nav/navigation/reorder
// @access  Private — Admin+
// @body    { items: [{ id, sort_order, parent_id? }] }
exports.reorderNavigationItems = async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!items || !items.length) {
    return res.status(400).json({
      success: false,
      message: 'items[] is required (array of { id, sort_order, parent_id? })',
    });
  }

  const sequelize = NavigationItem.sequelize;
  const t = await sequelize.transaction();
  try {
    for (const it of items) {
      if (!it?.id || typeof it.sort_order !== 'number') continue;
      const patch = { sort_order: it.sort_order };
      if (Object.prototype.hasOwnProperty.call(it, 'parent_id')) {
        // Coerce empty string / 0 to NULL so items can be promoted to top-level.
        patch.parent_id = it.parent_id || null;
      }
      await NavigationItem.update(patch, { where: { id: it.id }, transaction: t });
    }
    await t.commit();
    return res.json({ success: true, message: 'Order updated', count: items.length });
  } catch (err) {
    await t.rollback();
    console.error('Error in reorderNavigationItems:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Delete navigation item (SuperAdmin only)
// @route   DELETE /api/nav/navigation/:id
// @access  Private — SuperAdmin
exports.deleteNavigationItem = async (req, res) => {
  try {
    const { id } = req.params;

    const navigationItem = await NavigationItem.findByPk(id);

    if (!navigationItem) {
      return res.status(404).json({
        success: false,
        message: 'Navigation item not found'
      });
    }

    await navigationItem.destroy();

    res.json({
      success: true,
      message: 'Navigation item deleted successfully'
    });
  } catch (error) {
    console.error('Error in deleteNavigationItem:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Get a user's navigation access (role nav items + which are hidden)
// @route   GET /api/admin/users/:id/navigation-access
// @access  Private — Super Admin
exports.getUserNavigationAccess = async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const user = await User.findByPk(userId, { attributes: ['id', 'user_name', 'role_id'] });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // ALL active nav items (so admin can grant items outside the user's role)
    const allItems  = await navigationService.getAllNavFlat();
    // Which ids the user's role grants
    const roleNavIds = new Set(await navigationService.getRoleNavIds(user.role_id));
    // User's hide/grant overrides
    const { hiddenIds, grantedIds } = await navigationService.getUserOverrideIds(userId);
    const hiddenSet  = new Set(hiddenIds);
    const grantedSet = new Set(grantedIds);

    // For each item compute: in_role + final visibility
    const items = allItems.map(n => {
      const inRole    = roleNavIds.has(n.id);
      const isVisible = (inRole && !hiddenSet.has(n.id)) || grantedSet.has(n.id);
      return { ...n, in_role: inRole, is_visible: isVisible };
    });

    return res.json({
      success: true,
      data: { user: { id: user.id, user_name: user.user_name }, items },
    });
  } catch (error) {
    console.error('getUserNavigationAccess:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Set exactly which nav items a user can see (hide role items + grant extras)
// @route   PUT /api/admin/users/:id/navigation-access
// @body    { visible_navigation_ids: [20, 21, 99] }   ← full desired visible set
// @access  Private — Super Admin
exports.updateUserNavigationAccess = async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const visibleSet = new Set(
      (Array.isArray(req.body?.visible_navigation_ids) ? req.body.visible_navigation_ids : [])
        .map(Number).filter(Boolean)
    );

    const user = await User.findByPk(userId, { attributes: ['id', 'role_id'] });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const allItems   = await navigationService.getAllNavFlat();
    const roleNavIds = new Set(await navigationService.getRoleNavIds(user.role_id));

    // Rebuild overrides from the desired visible set:
    //   in role + NOT visible  → hide  (is_hidden = true)
    //   NOT in role + visible   → grant (is_hidden = false)
    //   otherwise               → default, no row
    const rows = [];
    for (const n of allItems) {
      const inRole  = roleNavIds.has(n.id);
      const visible = visibleSet.has(n.id);
      if (inRole && !visible)      rows.push({ user_id: userId, navigation_item_id: n.id, is_hidden: true });
      else if (!inRole && visible) rows.push({ user_id: userId, navigation_item_id: n.id, is_hidden: false });
    }

    await UserNavigationOverride.destroy({ where: { user_id: userId } });
    if (rows.length > 0) await UserNavigationOverride.bulkCreate(rows);

    return res.json({
      success: true,
      message: 'Navigation access updated.',
      data: { hidden: rows.filter(r => r.is_hidden).length, granted: rows.filter(r => !r.is_hidden).length },
    });
  } catch (error) {
    console.error('updateUserNavigationAccess:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    List all permissions (for admin nav-builder UI)
// @route   GET /api/nav/permissions
// @access  Private — Admin+
exports.getAllPermissions = async (req, res) => {
  try {
    const permissions = await Permission.findAll({
      attributes: ['id', 'name', 'code', 'module', 'description'],
      order: [['module', 'ASC'], ['name', 'ASC']],
    });
    res.json({ success: true, data: permissions });
  } catch (error) {
    console.error('Error in getAllPermissions:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};