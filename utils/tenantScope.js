// utils/tenantScope.js
// Phase 3 — tenant enforcement helpers.
// Always pulls company_id from the verified JWT (req.auth), never from the request body/query.

const tenantId = (req) => {
  if (!req?.auth) {
    const err = new Error('Auth context missing — protect middleware not applied');
    err.status = 401;
    throw err;
  }
  if (req.auth.isSuperAdmin && req.headers['x-impersonate-company-id']) {
    // Optional: allow super-admins to scope into a specific tenant via header.
    return Number(req.headers['x-impersonate-company-id']);
  }
  if (req.auth.companyId == null) {
    const err = new Error('User has no company_id assigned');
    err.status = 403;
    throw err;
  }
  return req.auth.companyId;
};

/**
 * Inject company_id into a Sequelize `where` clause.
 *   const where = withTenantScope(req, { status: 'active' });
 */
const withTenantScope = (req, where = {}) => ({
  ...where,
  company_id: tenantId(req),
});

/**
 * Stamp company_id onto a payload before INSERT.
 *   const row = stampTenant(req, { name: 'foo' });
 */
const stampTenant = (req, payload = {}) => ({
  ...payload,
  company_id: tenantId(req),
});

/**
 * Express helper to send a tenant-context-error consistently.
 */
const sendAuthError = (res, err) =>
  res.status(err.status || 500).json({
    success: false,
    data: null,
    message: err.message || 'Auth error',
  });

module.exports = { tenantId, withTenantScope, stampTenant, sendAuthError };
