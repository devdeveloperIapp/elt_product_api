const {
  createDestinationValidation,
} = require("../validation/destinationValidation");
// const { Airbyte, AirbytePublic } = require('../connection/airByteConnection');
const { client, getCache, createCache } = require("../utils/redis");
const { Client } = require("pg");
const jwt = require("jsonwebtoken");
const { promisePool } = require("../utils/helperFuntions");
const Destination = require("../model/destinationModel");
const FileService = require("../utils/fileService");
const Source = require("../model/sourceModel");
const { Connection } = require("../model/connectionModel");
const { tenantId, withTenantScope, stampTenant, sendAuthError } = require("../utils/tenantScope");
// exports.createDestination = async (req, res) => {
//   try {
//     // const { error } = createDestinationValidation.validate(req.body, { abortEarly: false });
//     // if (error) {
//     //     return res.status(400).json({
//     //         success: false,
//     //         data: null,
//     //         message: error.message
//     //     })
//     // }
//     const payload = req.body;
//     payload.workspaceId = process.env.AIRBYTE_WORKSPACE_ID;
//     console.log("payload.....:", payload)
//     const response = await AirbytePublic.post('/destinations', payload)
//     return res.status(200).json({
//       success: true,
//       data: response.data,
//       message: 'all destinations fetch successfully'
//     })
//   } catch (error) {
//     console.log("error", error)
//     return res.status(500).json({
//       success: false,
//       data: null,
//       message: 'Something went wrong'
//     })
//   }
// }

// exports.createDestination = async (req, res) => {
//   try {
//     // const { error } = createSourceValidation.validate(req.body, {
//     //   abortEarly: false,
//     // });
//     // if (error)
//     //   return res
//     //     .status(400)
//     //     .json({ success: false, data: null, message: error.message });

//     const { name, sourceType } = req.body;
//     // const payload = { ...req.body, workspaceId: WORKSPACE_ID };
//     console.log("asdasd42133", req.body);
//     // Check if file exists in request

//     // Check if source name already exists - with better error handling
//     let existingSource;
//     try {
//       existingSource = await Destination.findOne({
//         where: { destination_name: name },
//       });
//     } catch (dbError) {
//       console.error("Database error:", dbError);
//       return res.status(500).json({
//         success: false,
//         message: "Database query failed",
//       });
//     }

//     if (existingSource) {
//       return res.status(400).json({
//         success: false,
//         message: "Destination name must be unique",
//       });
//     }
//     // Save Excel file to public folder
//     let savedFile;

//     if (sourceType === "excel") {
//       // ✅ If file uploaded → save file details
//       connectorSettings = {
//         originalName: req.file.originalname,
//         mimeType: req.file.mimetype,
//         size: req.file.size,
//       };
//     } else {
//       connectorSettings = req.body.configuration;
//     }
//     console.log("asuidhdhvaudsvvaussd", req.body);
//     // Prepare connector settings JSON with file information
// //  else if (req.body.sourceType === "postgres") {
// //       connectorSettings = req.body.configuration;
// //     }
//     // Create source record
//     const sourceRecord = await Destination.create({
//       destination_name: req.body.name,
//       connector_name: sourceType
//         ? sourceType
//         : req.body.configuration.sourceType,
//       connector_settings_json: connectorSettings,
//       status: "completed",
//       created_by: 1,
//       created_on: new Date(),
//     });

//     // Get primary ID (auto-increment field)
//     const sourceId = sourceRecord.id.toString();
//  if (sourceType === "excel") {
//       try {
//         if (!req.file) {
//           return res.status(400).json({
//             success: false,
//             message: "Excel file is required",
//           });
//         }

//         savedFile = FileService.saveExcelFile(
//           sourceId,//Using source id as folder name
//           name, // Using source name
//           req.file.originalname,
//           req.file.buffer,
//           folderName="destination_excel_file"
//         );
//       } catch (fileError) {
//         return res.status(500).json({
//           success: false,
//           message: `Failed to save file: ${fileError.message}`,
//         });
//       }
//     }

//   // 🔹 Invalidate + Refresh cache
//     // await invalidateSourceCache();
//     const freshSources = await Destination.findAll();
//     await createCache("sourceListDB", freshSources);
//     return res.status(200).json({
//       success: true,
//       data: {
//         // airbyteResponse: sourceRecord,
//         sourceId: sourceRecord.id,
//         sourceRecord: {
//           id: sourceRecord.id,
//           destination_name: sourceRecord.destination_name,
//         },
//       },
//       message: "Destination created successfully and Excel file saved",
//     });
//   } catch (error) {
//     console.log("error324234232", error?.response?.data || error);
//     return res.status(error?.response?.status || 500).json({
//       success: false,
//       data: null,
//       message: error?.response?.data?.message || "Something went wrong",
//     });
//   }
// };
exports.createDestination = async (req, res) => {
  let transaction;
  try {
    const { name, configuration } = req.body;
    // Extract destinationType from configuration or directly from body
    const destinationType = configuration?.sourceType || req.body.sourceType;
    console.log("jsajdoas", req.body);
    // Validate required fields
    if (!name || !destinationType) {
      return res.status(400).json({
        success: false,
        message: "Name and destinationType are required",
      });
    }

    let existingDestination;
    try {
      existingDestination = await Destination.findOne({
        where: withTenantScope(req, { destination_name: name }),
      });
    } catch (dbError) {
      if (dbError.status) return sendAuthError(res, dbError);
      console.error("Database error:", dbError);
      return res.status(500).json({
        success: false,
        message: "Database query failed",
      });
    }

    if (existingDestination) {
      return res.status(400).json({
        success: false,
        message: "Destination name must be unique",
      });
    }

    // Start transaction for atomic operations
    transaction = await Destination.sequelize.transaction();

    let connectorSettings = {};
    let destinationRecord;

    // Create destination record first to get the ID
    destinationRecord = await Destination.create(
      stampTenant(req, {
        destination_name: name,
        connector_name: destinationType,
        connector_settings_json: {},
        status: "processing",
        created_by: req.auth?.userId ?? 1,
        created_on: new Date(),
      }),
      { transaction }
    );

    const destinationId = destinationRecord.id.toString();

    // Handle Excel destination type
    // if (destinationType === "excel") {
    //   console.log("Processing Excel destination...");

    //   // Check for file - use req.file (single file) or req.files[0] (array)
    //   const file = req.file || (req.files && req.files[0]);
    //   console.log("iusdhfisd", file);
    //   if (!file) {
    //     await transaction.rollback();
    //     return res.status(400).json({
    //       success: false,
    //       message: "Excel file is required for Excel destination type",
    //     });
    //   }

    //   // Validate file type
    //   if (
    //     !file.mimetype.includes("excel") &&
    //     !file.originalname.match(/\.(xlsx|xls)$/i)
    //   ) {
    //     await transaction.rollback();
    //     return res.status(400).json({
    //       success: false,
    //       message: "Invalid file type. Only Excel files are allowed",
    //     });
    //   }

    //   try {
    //     // Save file using destination ID as folder name
    //     const savedFile = FileService.saveExcelFile(
    //       destinationId,
    //       name,
    //       file.originalname,
    //       file.buffer,
    //       "destination_excel_files"
    //     );

    //     // Save file details in connector_settings_json
    //     connectorSettings = {
    //       originalName: file.originalname,
    //       mimeType: file.mimetype,
    //       size: file.size,
    //       path: savedFile.filePath,
    //       url: savedFile.publicUrl,
    //       savedFileName: file.originalname,
    //       destinationId: destinationId,
    //       folderName: "destination_excel_files",
    //       sourceType: destinationType,
    //     };

    //     console.log("Excel file saved successfully:", connectorSettings);
    //   } catch (fileError) {
    //     await transaction.rollback();
    //     console.error("File save error:", fileError);
    //     return res.status(500).json({
    //       success: false,
    //       message: `Failed to save file: ${fileError.message}`,
    //     });
    //   }
    // }
    // Handle PostgreSQL destination type
     if (destinationType === "postgres") {
      console.log("Processing PostgreSQL destination...");

      if (!configuration) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: "Configuration is required for PostgreSQL destinations",
        });
      }

      // Use the entire configuration for PostgreSQL
      connectorSettings = {
        ...configuration,
        // configuredAt: new Date().toISOString()
      };

      console.log("PostgreSQL configuration saved:", connectorSettings);
    }
    // Handle other destination types
    else {
      console.log("Processing other destination type:", destinationType);

      // if (!configuration) {
      //   await transaction.rollback();
      //   return res.status(400).json({
      //     success: false,
      //     message: `Configuration is required for ${destinationType} destinations`,
      //   });
      // }

      connectorSettings = configuration;
    }

    // Update the destination record with final connector settings
    await Destination.update(
      {
        connector_settings_json: connectorSettings,
        status: "completed",
      },
      {
        where: { id: destinationId },
        transaction,
      }
    );

    // Commit transaction
    await transaction.commit();

    // Refresh the destination record to get updated data
    const updatedDestination = await Destination.findByPk(destinationId);

    // Cache operations
    try {
      const freshDestinations = await Destination.findAll();
      await createCache("destinationListDB", freshDestinations);
    } catch (cacheError) {
      console.warn("Cache update failed:", cacheError);
    }

    return res.status(200).json({
      success: true,
      data: {
        destinationId: updatedDestination.id,
        destinationRecord: {
          id: updatedDestination.id,
          destination_name: updatedDestination.destination_name,
          connector_name: updatedDestination.connector_name, // This shows the type (excel/postgres)
          connector_settings: updatedDestination.connector_settings_json,
          status: updatedDestination.status,
        },
      },
      message:
        `Destination '${name}' created successfully as ${destinationType} type` +
        (destinationType === "excel" ? " and Excel file saved" : ""),
    });
  } catch (error) {
    // Rollback transaction if it exists
    if (transaction) await transaction.rollback();

    console.error("Destination creation error:", error);

    // More specific error handling
    if (error.name === "SequelizeValidationError") {
      return res.status(400).json({
        success: false,
        message:
          "Validation error: " + error.errors.map((e) => e.message).join(", "),
      });
    }

    return res.status(500).json({
      success: false,
      message: "Internal server error: " + error.message,
    });
  }
};

exports.deleteDestination = async (req, res) => {
  const destinationId = req.params.destinationId;

  let scopedWhere;
  try { scopedWhere = withTenantScope(req, { id: destinationId }); }
  catch (e) { return sendAuthError(res, e); }

  const transaction = await Connection.sequelize.transaction();

  try {
    const destination = await Destination.findOne({ where: scopedWhere, transaction });
    if (!destination) {
      await transaction.rollback();
      return res.status(404).json({
        success: false,
        data: null,
        message: "Destination not found",
      });
    }

    // Check for connections
    const connections = await Connection.findAll({
      where: { destination_id: destinationId },
      transaction,
    });

    if (connections.length > 0) {
      await transaction.rollback();
      return res.status(409).json({
        success: false,
        data: null,
        message: `Cannot delete destination because there are ${connections.length} connection(s) using it. Please delete all connections first before deleting the destination.`,
        connections: connections.map((conn) => ({
          id: conn.connection_id,
          name: conn.connection_name,
          connectionId: conn.connection_id,
        })),
      });
    }

    // Store destination details before deletion for file cleanup
    const destinationType = destination.connector_name;
    const connectorSettings = destination.connector_settings_json;
    let filePath = null;

    // Extract file path from connector settings for file-based destinations (if applicable)
    if (
      (destinationType === "excel" || destinationType === "csv") &&
      connectorSettings
    ) {
      const settings =
        typeof connectorSettings === "string"
          ? JSON.parse(connectorSettings)
          : connectorSettings;

      filePath = settings.path || settings.filePath;
    }

    // Delete the destination from database (only if no connections exist)
    await destination.destroy({ transaction });

    // Commit transaction first
    await transaction.commit();

    // After successful database deletion, check if it's a file-based destination and delete the file
    if (
      (destinationType === "excel" || destinationType === "csv") &&
      filePath
    ) {
      try {
        // Use your existing FileService to delete the file
        if (FileService && FileService.deleteFile) {
          FileService.deleteFile(filePath);
          console.log(`${destinationType} file deleted: ${filePath}`);
        }
      } catch (fileError) {
        // Log the file deletion error but don't fail the request
        console.error(
          `Failed to delete ${destinationType} file: ${filePath}`,
          fileError
        );
        // Continue with success response since destination was deleted from DB
      }
    }

    // Invalidate cache (you might want to create a separate cache for destinations)
    await invalidateDestinationCache();

    return res.status(200).json({
      success: true,
      data: null,
      message:
        "Destination deleted successfully." +
        ((destinationType === "excel" || destinationType === "csv") && filePath
          ? ` Associated ${destinationType} file has been removed.`
          : ""),
    });
  } catch (error) {
    await transaction.rollback();
    console.error("deleteDestination error:", error);
    return res.status(500).json({
      success: false,
      data: null,
      message:
        error.message || "Something went wrong while deleting the destination",
    });
  }
};

// Helper function to invalidate destination cache
async function invalidateDestinationCache() {
  try {
    // Invalidate destination-related caches
    await client.del("destination");
    await client.del("destinationListDB");
  } catch (e) {
    console.error("destination cache invalidate error:", e);
  }
}

// exports.getDestinationList = async (req, res) => {
//   try {
//     console.log("getDestinationList API running...");

//     const redis = req.query.redis;
//     const search = req.query.search?.toLowerCase();

//     let destinationsResponse;

//     // ✅ Redis cache check
//     // if (redis && (await getCache("destinationListDB"))) {
//     //   console.log("Fetching destinations from cache...");
//     //   destinationsResponse = JSON.parse(await getCache("destinationListDB"));
//     // } else {
//       console.log("Fetching destinations from DB...");

//       // Fetch from DB with JOIN to get source name
//       destinationsResponse = await Destination.findAll({
//         attributes: [
//           "id",
//           "destination_name",
//           "connector_name",
//           "connector_settings_json",
//           "status",
//           "created_by",
//           "created_on",
//         ],
//         include: [
//           {
//             model: Source, // Assuming your Source model is named 'Source'
//             attributes: ["id", "source_name"], // Include source ID and name
//             required: false, // Use LEFT JOIN to include destinations without sources
//           }
//         ],
//         order: [["created_on", "DESC"]],
//       });

//       // Cache result
//       await createCache("destinationListDB", destinationsResponse);
//     // }

//     // ✅ Transform the data to include source name in the response
//     const transformedDestinations = destinationsResponse.map(destination => {
//       const destinationData = destination.toJSON ? destination.toJSON() : destination;

//       return {
//         ...destinationData,
//         source_name: destinationData.Source?.source_name || null,
//         source_id: destinationData.Source?.id || null
//       };
//     });

//     // ✅ Apply search filter (now searches in both destination_name and source_name)
//     let filteredDestinations = transformedDestinations;
//     if (search) {
//       filteredDestinations = transformedDestinations.filter((item) =>
//         item?.destination_name?.toLowerCase().includes(search) ||
//         item?.source_name?.toLowerCase().includes(search)
//       );
//     }

//     const total = filteredDestinations.length;

//     return res.status(200).json({
//       success: true,
//       data: {
//         destinations: filteredDestinations,
//         totalItems: total,
//       },
//       message: "Destinations fetched successfully",
//     });
//   } catch (error) {
//     console.error("getDestinationList error:", error);
//     return res.status(500).json({
//       success: false,
//       data: null,
//       message: "Something went wrong",
//       error: error.message,
//     });
//   }
// };
// exports.getDestinationList = async (req, res) => {
//   try {
//     // const page = parseInt(req.query.page) || 1;
//     // const limit = parseInt(req.query.limit) || 5;
//     // const skip = (page - 1) * limit;
//     const redis = req.query.redis;
//     const search = req.query.search?.toLowerCase();

//     console.log("Destination API is running");
//     let destinationResponse;

//     if (redis && (await getCache("destination"))) {
//       console.log("cache fetching");
//       destinationResponse = JSON.parse(await getCache("destination"));
//     } else {
//       console.log("cache creating for destination");

//       const destinationRes = await Airbyte.post("/destinations/list", {
//         workspaceId: process.env.AIRBYTE_WORKSPACE_ID,
//       });
//       console.log("Destination API response fetched");

//       const connectionsRes = await Airbyte.post("/web_backend/connections/list", {
//         workspaceId: process.env.AIRBYTE_WORKSPACE_ID,
//       });
//       console.log("Connection API response fetched");

//       const allDestinations = destinationRes?.data?.destinations || [];
//       const allConnections = connectionsRes?.data?.connections || [];

//       // 👇 Use promisePool to avoid overload
//       destinationResponse = await promisePool(
//         allDestinations,
//         5, // max 5 concurrent requests
//         async (destination) => {
//           const resp = allConnections.filter(
//             (connection) => destination?.destinationId === connection?.destination?.destinationId
//           );

//           if (resp?.length === 0) {
//             return { destination, connections: resp, lastJobdetails: null };
//           }

//           const lastJobdetails = await Airbyte.post("/jobs/list", {
//             configId: resp[0]?.connectionId,
//             configTypes: ["sync"],
//           });

//           console.log("LastJobdetails API response fetched");

//           return {
//             destination,
//             connections: resp,
//             lastJobdetails: lastJobdetails?.data?.jobs || null,
//           };
//         }
//       );

//       await createCache("destination", destinationResponse);
//     }

//     let filteredDestinations = destinationResponse;

//     if (search) {
//       filteredDestinations = filteredDestinations.filter(
//         (item) => item?.destination?.name?.toLowerCase().includes(search)
//       );
//     }

//     const total = filteredDestinations.length;
//     // const paginatedDestination = filteredDestinations.slice(skip, skip + limit);

//     const paginatedDestination = filteredDestinations;

//     return res.status(200).json({
//       success: true,
//       data: {
//         destinations: paginatedDestination,
//         // page,
//         // limit,
//         // totalPages: Math.ceil(total / limit),
//         totalItems: total,
//       },
//       message: "Destinations fetched successfully",
//     });
//   } catch (error) {
//     console.error("error", error);
//     return res.status(500).json({
//       success: false,
//       data: null,
//       message: "Something went wrong",
//       error: error.message
//     });
//   }
// };

// exports.getDestinationList = async (req, res) => {
//   try {
//     console.log("getDestinationList API running...");

//     const redis = req.query.redis;
//     const search = req.query.search?.toLowerCase();

//     let destinationsResponse;

//     // ✅ Redis cache check
//     // if (redis && (await getCache("destinationListDB"))) {
//     //   console.log("Fetching destinations from cache...");
//     //   destinationsResponse = JSON.parse(await getCache("destinationListDB"));
//     // } else {
//       console.log("Fetching destinations from DB...");

//       // Fetch from DB
//       destinationsResponse = await Destination.findAll({
//         attributes: [
//           "id",
//           "destination_name",
//           "connector_name",
//           "connector_settings_json",
//           "status",
//           "created_by",
//           "created_on",
//         ],
//         order: [["created_on", "DESC"]],
//       });

//       // Cache result
//       await createCache("destinationListDB", destinationsResponse);
//     // }

//     // ✅ Apply search filter
//     let filteredDestinations = destinationsResponse;
//     if (search) {
//       filteredDestinations = filteredDestinations.filter((item) =>
//         item?.destination_name?.toLowerCase().includes(search)
//       );
//     }

//     const total = filteredDestinations.length;

//     return res.status(200).json({
//       success: true,
//       data: {
//         destinations: filteredDestinations,
//         totalItems: total,
//       },
//       message: "Destinations fetched successfully",
//     });
//   } catch (error) {
//     console.error("getDestinationList error:", error);
//     return res.status(500).json({
//       success: false,
//       data: null,
//       message: "Something went wrong",
//       error: error.message,
//     });
//   }
// };

// exports.getDestinationDetails = async (req, res) => {
//   try {
//     const destinationId = req.params.destinationId;
//     console.log("destinationId", destinationId)
//     console.log("Api calling");
//     const payload = { destinationId }
//     const destination = await Airbyte.post(`/destinations/get`, payload);
//     console.log("destination api response fetched");

//     return res.status(200).json({
//       success: true,
//       data: {
//         destination: destination?.data,
//       },
//       message: "destination details fetched successfully ",
//     });
//   } catch (error) {
//     console.error("error", error);
//     return res.status(500).json({
//       success: false,
//       data: null,
//       message: "Something went wrong",
//       error: error.message
//     });
//   }
// };
exports.getDestinationList = async (req, res) => {
  try {
    console.log("getDestinationList API running...");

    let companyId;
    try { companyId = tenantId(req); } catch (e) { return sendAuthError(res, e); }

    const search = req.query.search?.toLowerCase();

    const query = `
      SELECT DISTINCT ON (d.id)
        d.id,
        d.destination_name,
        d.connector_name,
        d.connector_settings_json,
        d.status,
        d.created_by,
        d.created_on,
        s.id as source_id,
        s.source_name
      FROM destination d
      LEFT JOIN connections c ON d.id::varchar = c.destination_id::varchar
      LEFT JOIN source s ON c.source_id::varchar = s.id::varchar
      WHERE d.company_id = :companyId
      ORDER BY d.id, d.created_on DESC
    `;

    const [destinationsResponse] = await Destination.sequelize.query(query, { replacements: { companyId } });

    // ✅ Apply search filter
    let filteredDestinations = destinationsResponse;
    if (search) {
      filteredDestinations = destinationsResponse.filter(
        (item) =>
          item?.destination_name?.toLowerCase().includes(search) ||
          item?.source_name?.toLowerCase().includes(search)
      );
    }

    const total = filteredDestinations.length;

    return res.status(200).json({
      success: true,
      data: {
        destinations: filteredDestinations,
        totalItems: total,
      },
      message: "Destinations fetched successfully",
    });
  } catch (error) {
    console.error("getDestinationList error:", error);
    return res.status(500).json({
      success: false,
      data: null,
      message: "Something went wrong",
      error: error.message,
    });
  }
};

exports.getDestinationDetails = async (req, res) => {
  try {
    const { destinationId } = req.params;
    console.log("destinationId", destinationId);
    console.log("Fetching destination from DB");

    let scopedWhere;
    try { scopedWhere = withTenantScope(req, { id: destinationId }); }
    catch (e) { return sendAuthError(res, e); }

    const destination = await Destination.findOne({
      where: scopedWhere,
      attributes: [
        "id",
        "destination_name",
        "connector_name",
        "connector_settings_json",
        "status",
        "created_by",
        "created_on",
      ],
    });
    if (!destination) {
      return res.status(404).json({ success: false, message: "Destination not found" });
    }
    let fileUrl = null;
    if (destination.connector_settings_json) {
      fileUrl = `${req.protocol}://${req.get(
        "host"
      )}/destination_excel_files/${destinationId}/${
        destination?.connector_settings_json?.originalName
      }`;
    }

    return res.status(200).json({
      success: true,
      data: { ...destination.dataValues, fileUrl },
      message: "Destination details fetched successfully",
    });
  } catch (error) {
    console.error("getDestinationDetails error:", error);
    return res.status(500).json({
      success: false,
      data: null,
      message: "Something went wrong",
      error: error.message,
    });
  }
};
// exports.checkForUpdate = async (req, res) => {
//   try {

//     const destinationId = req.params.destinationId;
//     console.log("sourceId", destinationId)
//     console.log("Api calling");
//     const payload = req.body;
//     payload.destinationId = destinationId
//     payload.workspaceId = process.env.AIRBYTE_WORKSPACE_ID;
//     console.log("payload", payload)
//     const source = await Airbyte.post(`/destinations/check_connection_for_update`, payload);
//     console.log("source api response fetched");

//     return res.status(200).json({
//       success: true,
//       data: source?.data,
//       message: "destination tested successfully",
//     });
//   } catch (error) {
//     console.error("error", error);
//     return res.status(500).json({
//       success: false,
//       data: null,
//       message: "Something went wrong",
//       error: error.message
//     });
//   }
// }

exports.checkForUpdate = async (req, res) => {
  try {
    const sourceId = req.params.destinationId;

    let scopedWhere;
    try { scopedWhere = withTenantScope(req, { id: sourceId }); }
    catch (e) { return sendAuthError(res, e); }

    const source = await Destination.findOne({
      where: scopedWhere,
      attributes: ["id", "destination_name", "connector_settings_json"],
    });

    if (!source) {
      return res.status(404).json({
        success: false,
        message: "Destination not found",
      });
    }

    // 🔹 Parse connector settings
    const settings = source.connector_settings_json;
    console.log("settings123 des", settings);
    // 🔹 Try connecting to DB
    const client = new Client({
      host: settings.host,
      port: settings.port,
      user: settings.username,
      password: settings.password,
      database: settings.database,
    });

    let dbTime = null;
    try {
      await client.connect();
      const result = await client.query("SELECT NOW()");
      dbTime = result.rows[0];
    } catch (err) {
      console.log("errr123", err.message);
      return res.status(400).json({
        success: false,
        message: "Connection failed",
        status: "failed",
        error: err.message,
      });
    } finally {
      await client.end().catch(() => {});
    }

    // 🔹 If successful
    return res.status(200).json({
      success: true,
      message: "Connection successful",
      status: "succeeded",
      sourceId: source.id,
      sourceName: source.destination_name,
      dbTime,
    });
  } catch (error) {
    console.error("checkSourceConnection error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
};

exports.updateDestination = async (req, res) => {
  try {
    const { destinationId } = req.params;
    const { name, sourceType, configuration, connectionConfiguration } =
      req.body;

    let scopedWhere;
    try { scopedWhere = withTenantScope(req, { id: destinationId }); }
    catch (e) { return sendAuthError(res, e); }

    const existingDestination = await Destination.findOne({ where: scopedWhere });
    if (!existingDestination) {
      return res.status(404).json({
        success: false,
        message: "Destination not found",
      });
    }

    // 🔹 Ensure unique destination name
    if (name && name !== existingDestination.destination_name) {
      const duplicate = await Destination.findOne({
        where: { destination_name: name },
      });
      if (duplicate) {
        return res.status(400).json({
          success: false,
          message: "Destination name must be unique",
        });
      }
    }

    // 🔹 Handle connector settings
    // let connectorSettings;
    // if (sourceType === "excel") {
    //   if (req.file) {
    //     try {
    //       // ✅ Delete old file if exists
    //       if (existingDestination.connector_settings_json?.path) {
    //         FileService.deleteFile(
    //           existingDestination.connector_settings_json.path
    //         );
    //       }

    //       // ✅ Save new file
    //       const savedFile = FileService.saveExcelFile(
    //         destinationId,
    //         name || existingDestination.destination_name,
    //         req.file.originalname,
    //         req.file.buffer,
    //         (folderName = "destination_excel_files")
    //       );

    //       connectorSettings = {
    //         originalName: req.file.originalname,
    //         mimeType: req.file.mimetype,
    //         size: req.file.size,
    //         path: savedFile.filePath,
    //         url: savedFile.publicUrl,
    //         savedFileName: req.file.originalname,
    //         destinationId: destinationId,
    //         folderName: "destination_excel_files",
    //         sourceType: sourceType,
    //       };
    //     } catch (fileError) {
    //       return res.status(500).json({
    //         success: false,
    //         message: `Failed to save file: ${fileError.message}`,
    //       });
    //     }
    //   } else {
    //     connectorSettings = existingDestination.connector_settings_json;
    //   }
    // } else {
    const  connectorSettings =
        connectionConfiguration || existingDestination.connector_settings_json;
    // }

    // 🔹 Update DB
    await Destination.update(
      {
        destination_name: name || existingDestination.destination_name,
        connector_name:
          sourceType ||
          req?.body?.connectionConfiguration?.sourceType ||
          existingDestination.connector_name,
        connector_settings_json: connectorSettings,
        status: "updated",
        updated_on: new Date(),
      },
      { where: { id: destinationId } }
    );

    // 🔹 Get updated record
    const updatedDestination = await Destination.findByPk(destinationId);

    // 🔹 Invalidate + Refresh cache
    // await invalidateDestination();
    const freshDestinations = await Destination.findAll();
    await createCache("destinationListDB", freshDestinations);

    return res.status(200).json({
      success: true,
      data: updatedDestination,
      message: "Destination updated successfully and cache refreshed",
    });
  } catch (error) {
    console.error("updateDestination error:", error);
    return res.status(error?.response?.status || 500).json({
      success: false,
      data: null,
      message: error?.response?.data?.message || "Something went wrong",
    });
  }
};

// exports.updateDestination = async (req, res) => {
//   try {

//     const destinationId = req.params.destinationId;
//     console.log("sourceId", destinationId)
//     console.log("Api calling");
//     const payload = req.body;
//     payload.destinationId = destinationId
//     const source = await Airbyte.post(`/destinations/update`, payload);
//     console.log("destination api response fetched");

//     return res.status(200).json({
//       success: true,
//       data: {
//         source: source?.data,
//       },
//       message: "destination details updated successfully ",
//     });
//   } catch (error) {
//     console.error("error", error);
//     return res.status(500).json({
//       success: false,
//       data: null,
//       message: "Something went wrong",
//       error: error.message
//     });
//   }
// };
