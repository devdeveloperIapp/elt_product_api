const express = require('express');
const route = express.Router();
const protect = require('../middleware/authmiddleware');
const { requireRole, requireSuperAdmin } = require('../middleware/requireRole');
const {
  getUserNavigation,
  checkRoutePermission,
  getAllNavigationItems,
  createNavigationItem,
  updateNavigationItem,
  reorderNavigationItems,
  deleteNavigationItem,
  getAllPermissions,
} = require('../controller/navigationController');

// User-facing nav (any authenticated user)
route.get('/navigationItem', protect, getUserNavigation);
route.get('/navigation/check/*path', protect, checkRoutePermission);

// Admin-only nav management (SuperAdmin or Admin role)
route.get('/navigation/all', protect, requireRole('admin', 'superadmin'), getAllNavigationItems);
route.get('/permissions', protect, requireRole('admin', 'superadmin'), getAllPermissions);
route.post('/navigation', protect, requireRole('admin', 'superadmin'), createNavigationItem);
route.patch('/navigation/reorder', protect, requireRole('admin', 'superadmin'), reorderNavigationItems);
route.put('/navigation/:id', protect, requireRole('admin', 'superadmin'), updateNavigationItem);
route.delete('/navigation/:id', protect, requireSuperAdmin, deleteNavigationItem);

module.exports = route;