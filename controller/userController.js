// controller/userController.js
// Admin user management — SuperAdmin + Company Admin only.
// All writes are tenant-scoped (company_id from req.auth).

const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const User = require('../model/userModel');
const { Role } = require('../model');

// GET /api/admin/users
exports.listUsers = async (req, res) => {
  try {
    const { isSuperAdmin, companyId } = req.auth;
    const where = isSuperAdmin ? {} : { company_id: companyId };

    const users = await User.findAll({
      where,
      attributes: { exclude: ['password', 'email_otp', 'email_otp_expires_at'] },
      include: [{ model: Role, as: 'userRole', attributes: ['id', 'name'] }],
      order: [['id', 'DESC']],
    });
    return res.json({ success: true, data: users });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/users/:id
exports.getUser = async (req, res) => {
  try {
    const { isSuperAdmin, companyId } = req.auth;
    const where = { id: req.params.id };
    if (!isSuperAdmin) where.company_id = companyId;

    const user = await User.findOne({
      where,
      attributes: { exclude: ['password', 'email_otp', 'email_otp_expires_at'] },
      include: [{ model: Role, as: 'userRole', attributes: ['id', 'name'] }],
    });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.json({ success: true, data: user });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/admin/users
exports.createUser = async (req, res) => {
  try {
    const { isSuperAdmin, companyId } = req.auth;
    const { email, user_name, first_name, last_name, display_name, password, role_id, company_id } = req.body;

    if (!email || !user_name || !password) {
      return res.status(400).json({ success: false, message: 'email, user_name and password are required' });
    }

    const exists = await User.findOne({ where: { [Op.or]: [{ email }, { user_name }] } });
    if (exists) return res.status(400).json({ success: false, message: 'Email or username already taken' });

    const hashed = await bcrypt.hash(password + process.env.SALT_KEY, 10);
    const newCompanyId = isSuperAdmin ? (company_id || companyId) : companyId;

    const user = await User.create({
      email, user_name, first_name, last_name, display_name,
      password: hashed,
      role_id: role_id || null,
      company_id: newCompanyId,
      is_active: true,
      // Admin-provisioned accounts skip the signup OTP — the admin already
      // vouched for the address and set the password out of band.
      is_email_verified: true,
    });

    const created = await User.findByPk(user.id, {
      attributes: { exclude: ['password', 'email_otp', 'email_otp_expires_at'] },
      include: [{ model: Role, as: 'userRole', attributes: ['id', 'name'] }],
    });
    return res.status(201).json({ success: true, data: created, message: 'User created successfully' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/admin/users/:id
exports.updateUser = async (req, res) => {
  try {
    const { isSuperAdmin, companyId } = req.auth;
    const where = { id: req.params.id };
    if (!isSuperAdmin) where.company_id = companyId;

    const user = await User.findOne({ where });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const { first_name, last_name, display_name, role_id, is_active, password } = req.body;
    const updates = {};
    if (first_name  !== undefined) updates.first_name  = first_name;
    if (last_name   !== undefined) updates.last_name   = last_name;
    if (display_name!== undefined) updates.display_name= display_name;
    if (role_id     !== undefined) updates.role_id     = role_id;
    if (is_active   !== undefined) updates.is_active   = is_active;
    if (password) updates.password = await bcrypt.hash(password + process.env.SALT_KEY, 10);
    if (isSuperAdmin && req.body.company_id !== undefined) updates.company_id = req.body.company_id;

    await user.update(updates);
    const updated = await User.findByPk(user.id, {
      attributes: { exclude: ['password', 'email_otp', 'email_otp_expires_at'] },
      include: [{ model: Role, as: 'userRole', attributes: ['id', 'name'] }],
    });
    return res.json({ success: true, data: updated, message: 'User updated successfully' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/auth/default-dashboard
// Sets (or clears) the calling user's default Power BI dashboard slug.
// Body: { slug: "cash-flow" }  — pass null / "" to clear.
exports.setDefaultDashboard = async (req, res) => {
  try {
    const { userId } = req.auth;
    const slug = req.body.slug ?? null;

    // Validate: only lowercase letters, digits, hyphens (same as nav_slug pattern)
    if (slug && !/^[a-z0-9-]+$/.test(slug)) {
      return res.status(400).json({ success: false, message: 'Invalid slug format' });
    }

    await User.update(
      { default_dashboard_slug: slug || null },
      { where: { id: userId } }
    );

    return res.json({
      success: true,
      data: { default_dashboard_slug: slug || null },
      message: slug ? 'Default dashboard saved.' : 'Default dashboard cleared.',
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/admin/users/:id  (soft-delete: set is_active = false)
exports.deactivateUser = async (req, res) => {
  try {
    const { isSuperAdmin, companyId, userId } = req.auth;
    if (Number(req.params.id) === userId) {
      return res.status(400).json({ success: false, message: 'Cannot deactivate your own account' });
    }
    const where = { id: req.params.id };
    if (!isSuperAdmin) where.company_id = companyId;

    const user = await User.findOne({ where });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    await user.update({ is_active: false });
    return res.json({ success: true, message: 'User deactivated' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
