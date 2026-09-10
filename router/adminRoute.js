// router/adminRoute.js
const express = require('express');
const route = express.Router();
const protect = require('../middleware/authmiddleware');
const { requireRole, requireSuperAdmin } = require('../middleware/requireRole');
const userCtrl    = require('../controller/userController');
const roleCtrl    = require('../controller/roleController');
const companyCtrl = require('../controller/companyController');
const syncCtrl    = require('../controller/syncController');
const navCtrl     = require('../controller/navigationController');

const isAdmin = requireRole('admin', 'superadmin', 'super admin', 'company admin');

// ── Users ────────────────────────────────────────────────────────────────────
route.get   ('/users',        protect, isAdmin,          userCtrl.listUsers);
route.get   ('/users/:id',    protect, isAdmin,          userCtrl.getUser);
route.post  ('/users',        protect, isAdmin,          userCtrl.createUser);
route.put   ('/users/:id',    protect, isAdmin,          userCtrl.updateUser);
route.delete('/users/:id',    protect, isAdmin,          userCtrl.deactivateUser);
// Hard delete — removes the user and their dependent rows. Super admin only.
route.delete('/users/:id/permanent', protect, requireSuperAdmin, userCtrl.deleteUser);

// ── Per-user navigation access (super admin) ──────────────────────────────────
route.get('/users/:id/navigation-access', protect, requireSuperAdmin, navCtrl.getUserNavigationAccess);
route.put('/users/:id/navigation-access', protect, requireSuperAdmin, navCtrl.updateUserNavigationAccess);

// ── Roles & Permissions ───────────────────────────────────────────────────────
route.get   ('/roles',                  protect, isAdmin,          roleCtrl.listRoles);
route.get   ('/permissions',            protect, isAdmin,          roleCtrl.listPermissions);
route.put   ('/roles/:id/permissions',  protect, requireSuperAdmin, roleCtrl.setRolePermissions);

// ── Companies ─────────────────────────────────────────────────────────────────
route.get   ('/companies',                    protect, requireSuperAdmin, companyCtrl.listCompanies);
route.post  ('/companies',                    protect, requireSuperAdmin, companyCtrl.adminCreateCompany);
route.put   ('/companies/:id',                protect, requireSuperAdmin, companyCtrl.updateCompany);
route.delete('/companies/:id',                protect, requireSuperAdmin, companyCtrl.deleteCompany);
route.put   ('/companies/:id/assign-user',    protect, requireSuperAdmin, companyCtrl.assignUser);

// ── Sync Schedules (super admin only) ────────────────────────────────────────
route.get   ('/sync/schedules',          protect, requireSuperAdmin, syncCtrl.listSchedules);
route.post  ('/sync/schedules',          protect, requireSuperAdmin, syncCtrl.createSchedule);
route.put   ('/sync/schedules/:id',      protect, requireSuperAdmin, syncCtrl.updateSchedule);
route.delete('/sync/schedules/:id',      protect, requireSuperAdmin, syncCtrl.deleteSchedule);
route.post  ('/sync/schedules/:id/run',  protect, requireSuperAdmin, syncCtrl.runScheduleNow);

// ── Sync Logs (super admin only) ─────────────────────────────────────────────
route.get   ('/sync/logs',               protect, requireSuperAdmin, syncCtrl.listLogs);

module.exports = route;
