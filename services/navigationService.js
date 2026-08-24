// backend/services/navigationService.js - Updated with new aliases
const { NavigationItem, Permission, Role, UserNavigationOverride } = require('../model');
const { Op } = require('sequelize');

class NavigationService {
  // Final navigation for a user:
  //   visible = (role-granted items − hidden overrides) + granted overrides
  //   • role items   → what the user's role permissions unlock
  //   • hidden        → admin turned OFF a role item for this user
  //   • granted       → admin turned ON an extra item not in the user's role
  async getUserNavigation(userId, roleId) {
    try {
      // 1. Role-granted nav item ids
      const roleNavIds = await this.getRoleNavIds(roleId);

      // 2. Per-user overrides
      const { hiddenIds, grantedIds } = await this.getUserOverrideIds(userId);
      const hiddenSet = new Set(hiddenIds);

      // 3. Compute the visible id set
      const visibleSet = new Set([
        ...roleNavIds.filter(id => !hiddenSet.has(id)), // role items minus hidden
        ...grantedIds,                                   // plus granted extras
      ]);

      if (visibleSet.size === 0) return [];

      // 4. Fetch those nav items (flat) and build the tree
      const items = await NavigationItem.findAll({
        where: { id: { [Op.in]: [...visibleSet] }, is_active: true },
        attributes: ['id', 'name', 'icon', 'path', 'module', 'sort_order', 'parent_id'],
        order: [['sort_order', 'ASC']],
      });

      console.log(`[NAV] user ${userId}: ${roleNavIds.length} role + ${grantedIds.length} granted − ${hiddenIds.length} hidden = ${items.length} visible`);
      return this.buildTreeFromFlat(items.map(i => i.toJSON()));
    } catch (error) {
      console.error('Error in getUserNavigation service:', error);
      throw error;
    }
  }

  // Ids of nav items a role grants (via its permissions). Includes children.
  async getRoleNavIds(roleId) {
    if (!roleId) return [];
    const role = await Role.findByPk(roleId, {
      include: [{ model: Permission, as: 'rolePermissions', through: { attributes: [] }, attributes: ['id'] }],
    });
    const permIds = (role?.rolePermissions || []).map(p => p.id);
    if (permIds.length === 0) return [];

    const items = await NavigationItem.findAll({
      where: { is_active: true },
      include: [{
        model: Permission,
        as: 'navigationPermissions',
        where: { id: { [Op.in]: permIds } },
        through: { attributes: [] },
        required: true,
        attributes: [],
      }],
      attributes: ['id'],
    });
    return items.map(i => i.id);
  }

  // Flat list of ALL nav items a role grants (id+name+path…). Used by the access panel.
  async getRoleNavigationFlat(roleId) {
    const ids = await this.getRoleNavIds(roleId);
    if (ids.length === 0) return [];
    const items = await NavigationItem.findAll({
      where: { id: { [Op.in]: ids }, is_active: true },
      attributes: ['id', 'name', 'path', 'module', 'parent_id'],
      order: [['sort_order', 'ASC']],
    });
    return items.map(i => ({ id: i.id, name: i.name, path: i.path, module: i.module, parent_id: i.parent_id }));
  }

  // EVERY active nav item (no permission filter). Used by the access panel so the
  // admin can grant items that are outside the user's role.
  async getAllNavFlat() {
    const items = await NavigationItem.findAll({
      where: { is_active: true },
      attributes: ['id', 'name', 'path', 'module', 'parent_id', 'sort_order'],
      order: [['sort_order', 'ASC']],
    });
    return items.map(i => ({ id: i.id, name: i.name, path: i.path, module: i.module, parent_id: i.parent_id }));
  }

  // User's overrides split into hidden vs granted id arrays.
  async getUserOverrideIds(userId) {
    if (!userId) return { hiddenIds: [], grantedIds: [] };
    const rows = await UserNavigationOverride.findAll({
      where: { user_id: userId },
      attributes: ['navigation_item_id', 'is_hidden'],
    });
    return {
      hiddenIds:  rows.filter(r => r.is_hidden).map(r => r.navigation_item_id),
      grantedIds: rows.filter(r => !r.is_hidden).map(r => r.navigation_item_id),
    };
  }

  // Build a parent→child tree from a flat list (uses parent_id). Orphans (parent
  // not in the visible set) are promoted to top-level so granted children still show.
  buildTreeFromFlat(flat) {
    const byId = {};
    flat.forEach(i => { byId[i.id] = { ...i, children: [] }; });
    const roots = [];
    flat.forEach(i => {
      const node = byId[i.id];
      if (i.parent_id != null && byId[i.parent_id]) {
        byId[i.parent_id].children.push(node);
      } else {
        roots.push(node);
      }
    });
    const sortRec = (arr) => {
      arr.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
      arr.forEach(n => { if (n.children.length) sortRec(n.children); else delete n.children; });
      return arr;
    };
    return sortRec(roots);
  }

  async checkRoutePermission(userId, roleId, path) {
    try {
      const role = await Role.findByPk(roleId, {
        include: [
          {
            model: Permission,
            as: 'rolePermissions', // 🔄 UPDATED
            through: { attributes: [] }
          }
        ]
      });

      if (!role || !role.rolePermissions) { // 🔄 UPDATED
        return false;
      }

      const permissionIds = role.rolePermissions.map(p => p.id); // 🔄 UPDATED

      const navigationItem = await NavigationItem.findOne({
        where: { 
          path,
          is_active: true 
        },
        include: [
          {
            model: Permission,
            as: 'navigationPermissions', // 🔄 UPDATED
            where: { id: { [Op.in]: permissionIds } },
            through: { attributes: [] },
            required: true
          }
        ]
      });

      return !!navigationItem;
    } catch (error) {
      console.error('Error in checkRoutePermission service:', error);
      return false;
    }
  }

  // Return all active top-level items with their children (no permission filter).
  // Used for SuperAdmin. We respect the `is_super_admin_visible` flag so admins
  // can assign company-admin-only items to roles without polluting the
  // SuperAdmin sidebar.
  async getAllActive() {
    const items = await NavigationItem.findAll({
      where: { is_active: true, parent_id: null, is_super_admin_visible: true },
      include: [
        {
          model: NavigationItem,
          as: 'childItems',
          required: false,
          separate: true,
          where: { is_active: true, is_super_admin_visible: true },
          order: [['sort_order', 'ASC']],
        },
      ],
      order: [['sort_order', 'ASC']],
    });
    return this.buildNavigationTree(items);
  }

  // Helper method
  buildNavigationTree(items, parentId = null) {
    const tree = [];
    
    items.forEach(item => {
      if (item.parent_id === parentId) {
        const node = {
          id: item.id,
          name: item.name,
          icon: item.icon,
          path: item.path,
          module: item.module,
          sort_order: item.sort_order
        };

        // Use the updated alias
        if (item.childItems && item.childItems.length > 0) { // 🔄 UPDATED
          node.children = this.buildNavigationTree(item.childItems, item.id);
        }

        tree.push(node);
      }
    });

    return tree.sort((a, b) => a.sort_order - b.sort_order);
  }
}

module.exports = new NavigationService();