const { where } = require("sequelize");
const Category  = require("../model/categoryModel");
const Report    = require("../model/reportModel");
const { Company } = require("../model");
const { createCategoryValidation } = require("../validation/categoryValidation");
const { createReportValidation } = require("../validation/reportValidation");
const { tenantId, withTenantScope, stampTenant, sendAuthError } = require('../utils/tenantScope');


Report.belongsTo(Category, {
  foreignKey: 'category_id',
  as: 'category'
});

// Defined ONCE at module load (not inside adminList) — re-defining an aliased
// association on every request throws "alias company used in two associations".
Report.belongsTo(Company, {
  foreignKey: 'company_id',
  as: 'company',
  constraints: false,
});

exports.create = async (req, res) => {
  try {
    const { error } = createReportValidation.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({
        success: false,
        data: null,
        message: error.message
      })
    }
    let payload;
    try { payload = stampTenant(req, req.body); }
    catch (e) { return sendAuthError(res, e); }

    await Report.create(payload);
    return res.status(200).json({
      success: true,
      data: null,
      message: "Report created successfully"
    })
  } catch (error) {
    console.log("error", error);
    return res.status(500).json({
      success: false,
      data: null,
      message: "something went wrong"
    })
  }
}

exports.list = async (req, res) => {
  try {
    let scopedWhere;
    try { scopedWhere = withTenantScope(req); }
    catch (e) { return sendAuthError(res, e); }

    const category_id = req.query?.category_id;
    const page = parseInt(req.query?.page) || 1;
    const rawLimit = req.query?.limit;

    const isAll = rawLimit === "all";
    const limit = isAll ? null : parseInt(rawLimit) || 10;
    const offset = isAll ? null : (page - 1) * limit;

    const whereClause = category_id ? { ...scopedWhere, category_id } : scopedWhere;

    const findOptions = {
      where: whereClause,
      include: [
        {
          model: Category,
          as: "category",
          attributes: ["name"],
        },
      ],
      order: [["position", "ASC"]],
    };

    if (!isAll) {
      findOptions.limit = limit;
      findOptions.offset = offset;
    }

    const { count, rows } = await Report.findAndCountAll(findOptions);

    return res.status(200).json({
      success: true,
      data: {
        reports: rows,
        total: count,
        page: isAll ? 1 : page,
        limit: isAll ? count : limit,
      },
      message: "Reports fetched successfully",
    });
  } catch (error) {
    console.error("error", error);
    return res.status(500).json({
      success: false,
      data: null,
      message: "Something went wrong",
    });
  }
};


exports.fetchDetails = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ success: false, data: null, message: "ID is required" });
    }

    let scopedWhere;
    try { scopedWhere = withTenantScope(req, { id }); }
    catch (e) { return sendAuthError(res, e); }

    const report = await Report.findOne({ where: scopedWhere });

    if (!report) {
      return res.status(404).json({ success: false, data: null, message: "Report not found" });
    }

    return res.status(200).json({
      success: true,
      data: report,
      message: "Report details fetched successfully",
    });
  } catch (error) {
    console.log("error", error);
    return res.status(500).json({ success: false, data: null, message: "Something went wrong" });
  }
};

exports.update = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ success: false, data: null, message: "ID is required" });
    }

    let scopedWhere;
    try { scopedWhere = withTenantScope(req, { id }); }
    catch (e) { return sendAuthError(res, e); }

    const report = await Report.findOne({ where: scopedWhere });

    if (!report) {
      return res.status(404).json({ success: false, data: null, message: "Report not found" });
    }

    const allowedFields = ['name', 'embeded_url', 'category_id', 'nav_slug', 'is_active', 'company_id'];
    const updates = {};

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    await report.update(updates);

    return res.status(200).json({
      success: true,
      data: report,
      message: "Report updated successfully",
    });
  } catch (error) {
    console.log("Update Error:", error);
    return res.status(500).json({ success: false, data: null, message: "Something went wrong" });
  }
};

exports.delete = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ success: false, data: null, message: "ID is required" });
    }

    let scopedWhere;
    try { scopedWhere = withTenantScope(req, { id }); }
    catch (e) { return sendAuthError(res, e); }

    const report = await Report.findOne({ where: scopedWhere });

    if (!report) {
      return res.status(404).json({ success: false, data: null, message: "Report not found" });
    }

    await report.destroy();

    return res.status(200).json({
      success: true,
      data: null,
      message: "Report deleted successfully",
    });
  } catch (error) {
    console.log("Delete Error:", error);
    return res.status(500).json({ success: false, data: null, message: "Something went wrong" });
  }
};

// @desc  Get a company's report by nav_slug (for Power BI embed pages)
// @route GET /api/report/by-nav-slug/:slug
// @access Private
exports.byNavSlug = async (req, res) => {
  try {
    const { slug } = req.params;
    if (!slug) return res.status(400).json({ success: false, message: 'slug is required' });

    let scopedWhere;
    try { scopedWhere = withTenantScope(req, { nav_slug: slug }); }
    catch (e) { return sendAuthError(res, e); }

    const report = await Report.findOne({
      where: scopedWhere,
      include: [{ model: Category, as: 'category', attributes: ['name'] }],
    });

    if (!report) {
      return res.status(404).json({
        success: false,
        data: null,
        message: `No report found for slug "${slug}" in your company. Ask your admin to assign a report.`,
      });
    }

    return res.status(200).json({ success: true, data: report });
  } catch (error) {
    console.error('byNavSlug error:', error);
    return res.status(500).json({ success: false, message: 'Something went wrong' });
  }
};

exports.updateOrder = async (req, res) => {
  try {
    const reorderedItems = req.body.orderedIds;

    if (!Array.isArray(reorderedItems)) {
      return res.status(400).json({ success: false, message: "Invalid data" });
    }

    let companyId;
    try { companyId = tenantId(req); } catch (e) { return sendAuthError(res, e); }

    // Each update is tenant-scoped — caller can only reorder their own reports.
    for (let i = 0; i < reorderedItems.length; i++) {
      const item = reorderedItems[i];
      if (!item.id || typeof item.id !== "number") continue;
      await Report.update(
        { position: i },
        { where: { id: item.id, company_id: companyId } }
      );
    }

    return res.status(200).json({ success: true, message: "Report order updated successfully" });
  } catch (error) {
    console.error("Update order error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// @desc  Super-admin: list ALL reports across companies (with company name).
//        Optionally filter by ?company_id=<id>
// @route GET /api/report/admin/list
// @access Super-admin only
// ─────────────────────────────────────────────────────────────────────────────
exports.adminList = async (req, res) => {
  try {
    if (!req.auth?.isSuperAdmin) {
      return res.status(403).json({ success: false, message: 'Super admin access required' });
    }

    const { company_id, page: rawPage, limit: rawLimit } = req.query;
    const pageNum  = parseInt(rawPage)  || 1;
    const limitNum = rawLimit === 'all' ? null : (parseInt(rawLimit) || 50);

    const whereClause = {};
    if (company_id) whereClause.company_id = Number(company_id);

    // (Company association is defined once at module load — see top of file)

    const findOptions = {
      where: whereClause,
      include: [
        { model: Category, as: 'category', attributes: ['id', 'name'] },
        { model: Company,  as: 'company',  attributes: ['id', 'name'] },
      ],
      order: [['created_on', 'DESC']],
    };

    if (limitNum) {
      findOptions.limit  = limitNum;
      findOptions.offset = (pageNum - 1) * limitNum;
    }

    const { count, rows } = await Report.findAndCountAll(findOptions);

    return res.status(200).json({
      success: true,
      data: {
        reports: rows,
        total: count,
        page: pageNum,
        limit: limitNum || count,
      },
      message: 'Reports fetched successfully',
    });
  } catch (error) {
    console.error('adminList error:', error);
    return res.status(500).json({ success: false, message: 'Something went wrong' });
  }
};
