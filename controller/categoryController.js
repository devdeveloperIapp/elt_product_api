const Category = require("../model/categoryModel");
const { createCategoryValidation } = require("../validation/categoryValidation")
const Report = require("../model/reportModel");
const { tenantId, withTenantScope, stampTenant, sendAuthError } = require("../utils/tenantScope");


Category.hasMany(Report, {
  foreignKey: 'category_id',
  as: 'reports'
});

exports.create = async (req, res) => {
  try {
    const { error } = createCategoryValidation.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({
        success: false,
        data: null,
        message: error.message
      })
    }
    let scopedPayload;
    try { scopedPayload = stampTenant(req, req.body); }
    catch (e) { return sendAuthError(res, e); }

    const category = await Category.findOne({ where: withTenantScope(req, { name: req.body.name }) });
    if (category) {
      return res.status(400).json({
        success: false,
        data: { category },
        message: "This data already exist"
      })
    }
    await Category.create(scopedPayload);
    return res.status(200).json({
      success: true,
      data: null,
      message: "Category created successfully"
    })
  } catch (error) {
    console.log("error", error)
    return res.status(500).json({
      success: false,
      data: null,
      message: "something went wrong"
    })
  }
}

// exports.list = async (req, res) => {
//     try {
//         const categories = await Category.findAll({});

//         return res.status(200).json({
//             success: true,
//             data: {
//                 categories
//             },
//             message: "categories fetch successfully"
//         })
//     } catch (error) {
//         console.log("error", error)
//         return res.status(500).json({
//             success: false,
//             data: null,
//             message: "something went wrong"
//         })

//     }
// }

const { Sequelize } = require("sequelize");


// Controller method
// const redis = require('redis');
// const client = redis.createClient(); // Assuming the default local Redis setup

exports.list = async (req, res) => {
  try {
    // Check Redis Cache First for all categories data
    // const cacheKey = 'all_categories';
    // client.get(cacheKey, async (err, cachedData) => {
    //   if (cachedData) {
    //     // If data exists in cache
    //     return res.status(200).json({
    //       success: true,
    //       data: JSON.parse(cachedData),
    //       message: "Categories fetched from cache"
    //     });
    //   } else {
        let scopedWhere;
        try { scopedWhere = withTenantScope(req); }
        catch (e) { return sendAuthError(res, e); }

        const categories = await Category.findAll({
          where: scopedWhere,
          attributes: [
            'id',
            'name',
            'order',
            [
              Sequelize.literal(`(
                SELECT COUNT(*) FROM reports WHERE reports.category_id = "Category"."id"
              )`),
              "reportCount"
            ]
          ],
          include: [
            {
              model: Report,
              as: 'reports',
              attributes: ['id', 'name', 'embeded_url']
            }
          ],
          order: [['order', 'ASC']],
          subQuery: false,
        });

        const totalCount = categories.length;  // Total records fetched

        const result = {
          categories,
          total: totalCount,
          currentPage: 1,  // As you're fetching all records, currentPage is 1
          totalPages: 1,  // All records, so only 1 page
        };

        // Store data in Redis cache for 10 minutes (example)
       // client.setex(cacheKey, 600, JSON.stringify(result));

        return res.status(200).json({
          success: true,
          data: result,
          message: "Categories fetched from database"
        });
      
    // });
  } catch (error) {
    console.error("Error fetching categories:", error);
    return res.status(500).json({
      success: false,
      data: null,
      message: "Something went wrong",
      error: error
    });
  }
};

// exports.list = async (req, res) => {
//   try {
//     const page = parseInt(req.query.page) || 1;
//     const limitParam = req.query.limit;

//     const limit = limitParam === "all" ? null : parseInt(limitParam) || 10;
//     const offset = limit ? (page - 1) * limit : null;

//     const categories = await Category.findAll({
//       attributes: [
//         'id',
//         'name',
//         'order',
//         [
//           Sequelize.literal(`(
//             SELECT COUNT(*) FROM reports WHERE reports.category_id = "Category"."id"
//           )`),
//           "reportCount"
//         ]
//       ],
//       include: [
//         {
//           model: Report,
//           as: 'reports',
//           attributes: ['id', 'name', 'embeded_url']
//         }
//       ],
//       order: [['order', 'ASC']],
//       ...(limit ? { limit, offset } : {}),
//       subQuery: false,
//     });

//     const totalCount = await Category.count();
// console.log("categoriescategoriescategoriescategories",categories);
//     return res.status(200).json({
//       success: true,
//       data: {
//         categories,
//         total: totalCount,
//         currentPage: page,
//         totalPages: limit ? Math.ceil(totalCount / limit) : 1,
//       },
//       message: "Categories fetched with pagination"
//     });
//   } catch (error) {
//     console.error("Error fetching categories:", error);
//     return res.status(500).json({
//       success: false,
//       data:null,
//       message: "Something went wrong",
//       error:error
//     });
//   }
// };

// exports.list = async (req, res) => {
//   try {
//     const id = req.params.id;
//     const categories = await Category.findAll({
//       attributes: [
//         'id',
//         'name',
//         [Sequelize.fn("COUNT", Sequelize.col("reports.id")), "reportCount"]
//       ],
//       include: [
//         {
//           model: Report,
//           as: 'reports', // must match hasMany alias
//           attributes: ['id', 'name', 'embeded_url']
//         }
//       ],
//       group: [
//         'Category.id',
//         'reports.id',
//         'reports.name',
//         'reports.embeded_url'
//       ],
//       order: [['name', 'ASC']]
//     });

//     return res.status(200).json({
//       success: true,
//       data: { categories },
//       message: "Categories fetched successfully with report count"
//     });

//   } catch (error) {
//     console.error("Error fetching categories:", error);
//     return res.status(500).json({
//       success: false,
//       data: null,
//       message: "Something went wrong"
//     });
//   }
// };

exports.fetchDetails = async (req, res) => {
  try {
    const id = req.params.id;

    let scopedWhere;
    try { scopedWhere = withTenantScope(req, { id }); }
    catch (e) { return sendAuthError(res, e); }

    const category = await Category.findOne({
      where: scopedWhere,
      attributes: [
        'id',
        'name',
        [Sequelize.fn("COUNT", Sequelize.col("reports.id")), "reportCount"]
      ],
      include: [
        {
          model: Report,
          as: 'reports', // must match association alias
          attributes: ['id', 'name', 'embeded_url']
        }
      ],
      group: [
        'Category.id',
        'reports.id',
        'reports.name',
        'reports.embeded_url'
      ]
    });

    if (!category) {
      return res.status(404).json({
        success: false,
        data: null,
        message: "Category not found"
      });
    }

    return res.status(200).json({
      success: true,
      data: { category },
      message: "Category details fetched successfully"
    });

  } catch (error) {
    console.error("Error fetching category details:", error);
    return res.status(500).json({
      success: false,
      data: null,
      message: "Something went wrong"
    });
  }
};


exports.update = async (req, res) => {
  try {
    const id = req.params.id;
    const { name } = req.body;
    if (!name) {
      return res.status(404).json({
        success: false,
        data: null,
        message: "name is required"
      });
    }
    let scopedWhere;
    try { scopedWhere = withTenantScope(req, { id }); }
    catch (e) { return sendAuthError(res, e); }

    const category = await Category.findOne({ where: scopedWhere });

    if (!category) {
      return res.status(404).json({
        success: false,
        data: null,
        message: "Category not found"
      });
    }

    // Update the category fields
    category.name = name || category.name;

    await category.save();

    return res.status(200).json({
      success: true,
      data: { category },
      message: "Category updated successfully"
    });

  } catch (error) {
    console.error("Error updating category:", error);
    return res.status(500).json({
      success: false,
      data: null,
      message: "Something went wrong"
    });
  }
};

exports.delete = async (req, res) => {
  try {
    const id = req.params.id;

    let scopedWhere;
    try { scopedWhere = withTenantScope(req, { id }); }
    catch (e) { return sendAuthError(res, e); }

    const category = await Category.findOne({ where: scopedWhere });

    if (!category) {
      return res.status(404).json({
        success: false,
        data: null,
        message: "Category not found"
      });
    }

    await category.destroy();

    return res.status(200).json({
      success: true,
      data: null,
      message: "Category deleted successfully"
    });

  } catch (error) {
    console.error("Error deleting category:", error);
    return res.status(500).json({
      success: false,
      data: null,
      message: "Something went wrong"
    });
  }
};


exports.reorderCategories = async (req, res) => {
  try {
    const { orderedIds } = req.body; // [{ id: 5, order: 0 }, { id: 2, order: 1 }, ...]

    let companyId;
    try { companyId = tenantId(req); } catch (e) { return sendAuthError(res, e); }

    // Each update is scoped — caller can only reorder their own categories.
    const updatePromises = orderedIds.map(({ id, order }) =>
      Category.update({ order }, { where: { id, company_id: companyId } })
    );

    await Promise.all(updatePromises);

    return res.status(200).json({
      success: true,
      message: "Categories reordered successfully"
    });
  } catch (error) {
    console.error("Error reordering categories:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong while reordering"
    });
  }
};

