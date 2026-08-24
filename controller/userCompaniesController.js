// controller/userCompaniesController.js
// Endpoints for the multi-company UX:
//   GET  /api/companies/mine          → list every company the logged-in user can access
//   POST /api/companies/switch/:id    → set that company as user.company_id (the active one)
const { User, Company, UserQbCompany } = require('../model');

/**
 * GET /api/companies/mine
 * Returns every QuickBooks company linked to the requesting user.
 */
exports.listMyCompanies = async (req, res) => {
  try {
    const userId = req.user.id;

    const links = await UserQbCompany.findAll({
      where: { user_id: userId },
      include: [{
        model: Company,
        as: 'company',
        attributes: ['id', 'name', 'quickbooks_realm_id', 'currency', 'timezone'],
      }],
      order: [['is_default', 'DESC'], ['created_at', 'ASC']],
    });

    const user = await User.findByPk(userId, { attributes: ['id', 'company_id'] });

    const companies = links
      .filter(l => l.company)
      .map(l => ({
        id:                 l.company.id,
        name:               l.company.name,
        quickbooks_realm_id: l.company.quickbooks_realm_id,
        currency:           l.company.currency,
        timezone:           l.company.timezone,
        role:               l.role,
        is_default:         l.is_default,
        is_active:          l.company.id === user.company_id,
      }));

    return res.json({
      success: true,
      activeCompanyId: user.company_id,
      companies,
    });
  } catch (err) {
    console.error('listMyCompanies failed:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/companies/switch/:companyId
 * Sets the user's active company. Refuses if the user isn't linked to it.
 */
exports.switchActiveCompany = async (req, res) => {
  try {
    const userId    = req.user.id;
    const companyId = parseInt(req.params.companyId, 10);

    if (!companyId) {
      return res.status(400).json({ success: false, message: 'Valid companyId required' });
    }

    const link = await UserQbCompany.findOne({
      where: { user_id: userId, company_id: companyId },
    });
    if (!link) {
      return res.status(403).json({
        success: false,
        message: 'You do not have access to this company',
      });
    }

    // Flip user.company_id and mark this link as the new default.
    await User.update({ company_id: companyId }, { where: { id: userId } });
    await UserQbCompany.update(
      { is_default: false },
      { where: { user_id: userId } }
    );
    await link.update({ is_default: true });

    const company = await Company.findByPk(companyId, {
      attributes: ['id', 'name', 'quickbooks_realm_id', 'currency', 'timezone'],
    });

    return res.json({
      success: true,
      message: `Switched to ${company?.name || 'company'}.`,
      activeCompanyId: companyId,
      company,
    });
  } catch (err) {
    console.error('switchActiveCompany failed:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
