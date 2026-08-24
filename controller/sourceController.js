const { createSourceValidation } = require("../validation/sourceValidation");
const { runShopifySync }     = require('../services/shopify/shopifySyncService');
const { runZohoBooksSync }   = require('../services/zoho/zohobooksSyncService');
const { Airbyte, AirbytePublic } = require("../connection/airByteConnection");
const { Client } = require("pg");
const { client, createCache, getCache, setCache } = require("../utils/redis");
const { globalData } = require("../utils/globalData");
const { promisePool } = require("../utils/helperFuntions");
const Source = require("../model/sourceModel"); // Assuming you have a Sequelize model for Source
const FileService = require("../utils/fileService");
const { tenantId, withTenantScope, stampTenant, sendAuthError } = require("../utils/tenantScope");
const WORKSPACE_ID = process.env.AIRBYTE_WORKSPACE_ID;
const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx");
const { Connection } = require("../model/connectionModel");
const {
  generateZohoAccessToken,
  getZohoOrganizations 
} = require("../utils/validateZohoBooksTokenAndConnection");
const axios = require("axios");
const { google } = require("googleapis");
const { findEntityKeyInResponse, getCursorFieldForTable, getZohoBooksEntityDetails, getZohoBooksEntityMap } = require("../utils/zohoBooksUtils");
/* ====================================================================== */
/*                      RATE LIMIT + RETRY HELPERS                         */
/* ====================================================================== */
const RETRY_MAX_ATTEMPTS = Number(process.env.AIRBYTE_RETRY_MAX || 5);
const RETRY_BASE_MS = Number(process.env.AIRBYTE_RETRY_BASE_MS || 500); // base backoff
const RATE_MAX = Number(process.env.AIRBYTE_RATE_MAX || 8); // max requests/window
const RATE_WINDOW_MS = Number(process.env.AIRBYTE_RATE_WINDOW_MS || 1000); // window length

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseRetryAfter(h) {
  if (!h) return 0;
  // numeric seconds or HTTP-date
  const secs = parseInt(h, 10);
  if (!Number.isNaN(secs)) return secs * 1000;
  const t = Date.parse(h);
  if (!Number.isNaN(t)) return Math.max(0, t - Date.now());
  return 0;
}

function isRetryable(error) {
  // Network-level errors
  const code = error?.code;
  if (
    code &&
    [
      "ECONNRESET",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "ENETUNREACH",
      "ECONNABORTED",
    ].includes(code)
  ) {
    return true;
  }
  const status = error?.response?.status;
  // Retry on 429 and 5xx
  if (status === 429 || (status >= 500 && status < 600)) return true;
  return false;
}

function backoffDelayMs(attempt, retryAfterHeader) {
  const ra = parseRetryAfter(retryAfterHeader);
  if (ra) return ra;
  // Exponential backoff with jitter, capped at 30s
  const exp = Math.min(30000, RETRY_BASE_MS * 2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * 250);
  return exp + jitter;
}

function createSimpleRateLimiter(max, windowMs) {
  let timestamps = [];
  async function acquire() {
    const now = Date.now();
    timestamps = timestamps.filter((t) => now - t < windowMs);
    if (timestamps.length < max) {
      timestamps.push(now);
      return;
    }
    const wait = windowMs - (now - timestamps[0]);
    await sleep(wait);
    return acquire();
  }
  async function schedule(fn) {
    await acquire();
    return fn();
  }
  return { schedule };
}

const airbyteLimiter = createSimpleRateLimiter(RATE_MAX, RATE_WINDOW_MS);
const airbytePublicLimiter = createSimpleRateLimiter(RATE_MAX, RATE_WINDOW_MS);

async function withRetries(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === RETRY_MAX_ATTEMPTS) break;
      const retryAfter = err?.response?.headers?.["retry-after"];
      const delay = backoffDelayMs(attempt, retryAfter);
      if (process.env.NODE_ENV !== "production") {
        console.warn(
          `[airbyte][retry] ${label || ""} attempt ${attempt} failed (${
            err?.response?.status || err?.code || err?.message
          }); retrying in ${delay} ms`
        );
      }
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function airbyteCall(client, limiter, method, url, data, config, label) {
  return limiter.schedule(() =>
    withRetries(
      () => client[method](url, data, config),
      label || `${method.toUpperCase()} ${url}`
    )
  );
}

/* ====================================================================== */
/*                             SMALL HELPERS                               */
/* ====================================================================== */

// ---- small helper to invalidate cached source list ----
async function invalidateSourceCache() {
  try {
    await client.del("source"); // use DEL in your redis util if available
  } catch (e) {
    console.error("cache invalidate error:", e);
  }
}

// ---- shared helper to list all connections (optionally by sourceId) ----
async function listConnectionsByWorkspace(sourceId) {
  const resp = await airbyteCall(
    Airbyte,
    airbyteLimiter,
    "post",
    "/web_backend/connections/list",
    { workspaceId: WORKSPACE_ID }
  );
  const all = resp?.data?.connections || [];
  return sourceId ? all.filter((c) => c?.source?.sourceId === sourceId) : all;
}

/* ====================================================================== */
/*                                SOURCES                                  */
/* ====================================================================== */

// exports.createSource = async (req, res) => {
//   let transaction;
//   try {
//     let { name, configuration } = req.body;
//     console.log("Request body:", req.body);
//     let sourceType = configuration?.sourceType || req.body.sourceType;

//     // Validate required fields
//     if (!name || !sourceType) {
//       return res.status(400).json({
//         success: false,
//         message: "Name and sourceType are required",
//       });
//     }

//     // Check if source name already exists
//     let existingSource;
//     try {
//       existingSource = await Source.findOne({
//         where: { source_name: name },
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
//         message: "Source name must be unique",
//       });
//     }

//     // Start transaction for atomic operations
//     transaction = await Source.sequelize.transaction();

//     let connectorSettings = {};
//     let filePath = null;
//     let sourceRecord;

//     // Create source record first to get the source ID
//     sourceRecord = await Source.create(
//       {
//         source_name: name,
//         connector_name: sourceType,
//         connector_settings_json: {}, // Temporary empty object
//         // file_path: null, // Will update after file save
//         status: "processing", // Set to processing initially
//         created_by: 1,
//         created_on: new Date(),
//       },
//       { transaction }
//     );

//     const sourceId = sourceRecord.id.toString();

//     // Handle Excel source type with file validation
//     if (sourceType === "excel") {
//       // Validate file existence for Excel sources
//       if (!req.file) {
//         await transaction.rollback();
//         return res.status(400).json({
//           success: false,
//           message: "Excel file is required for Excel source type",
//         });
//       }

//       // Validate file type
//       if (
//         !req.file.mimetype.includes("excel") &&
//         !req.file.originalname.match(/\.(xlsx|xls)$/i)
//       ) {
//         await transaction.rollback();
//         return res.status(400).json({
//           success: false,
//           message: "Invalid file type. Only Excel files are allowed",
//         });
//       }

//       try {
//         // Save file using source ID as folder name
//         const savedFile = FileService.saveExcelFile(
//           sourceId, // Using source ID as folder name
//           name, // Using source name as file identifier
//           req.file.originalname,
//           req.file.buffer
//         );

//         filePath = savedFile.path; // Assuming FileService returns path

//         connectorSettings = {
//           originalName: req.file.originalname,
//           mimeType: req.file.mimetype,
//           size: req.file.size,
//           filePath: filePath,
//           savedFileName: savedFile.filename,
//           sourceId: sourceId, // Also store source ID in settings
//           path: savedFile.filePath,
//           url: savedFile.publicUrl,
//           sourceType: sourceType,
//           folderName: "source_excel_files",
//         };

//         // Update the source record with file path and connector settings
//         await Source.update(
//           {
//             connector_settings_json: connectorSettings,
//             // file_path: filePath,
//             status: "completed",
//           },
//           {
//             where: { id: sourceId },
//             transaction,
//           }
//         );
//       } catch (fileError) {
//         await transaction.rollback();
//         console.error("File save error:", fileError);
//         return res.status(500).json({
//           success: false,
//           message: `Failed to save file: ${fileError.message}`,
//         });
//       }
//     } else {
//       // Handle other source types (PostgreSQL, etc.)
//       if (!req.body.configuration) {
//         await transaction.rollback();
//         return res.status(400).json({
//           success: false,
//           message: "Configuration is required for non-Excel sources",
//         });
//       }
//       connectorSettings = req.body.configuration;

//       // Update source record for non-Excel sources
//       await Source.update(
//         {
//           connector_settings_json: connectorSettings,
//           status: "completed",
//         },
//         {
//           where: { id: sourceId },
//           transaction,
//         }
//       );
//     }

//     // Commit transaction
//     await transaction.commit();

//     // Refresh the source record to get updated data
//     const updatedSource = await Source.findByPk(sourceId);

//     // Cache operations (outside transaction)
//     try {
//       await invalidateSourceCache();
//       const freshSources = await Source.findAll();
//       await createCache("sourceListDB", freshSources);
//     } catch (cacheError) {
//       console.warn("Cache update failed:", cacheError);
//       // Don't fail the request if cache fails
//     }

//     return res.status(200).json({
//       success: true,
//       data: {
//         sourceId: updatedSource.id,
//         sourceRecord: {
//           id: updatedSource.id,
//           source_name: updatedSource.source_name,
//           file_path: updatedSource.file_path,
//           connector_name: updatedSource.connector_name,
//           status: updatedSource.status,
//         },
//       },
//       message:
//         "Source created successfully" +
//         (sourceType === "excel" ? " and Excel file saved" : ""),
//     });
//   } catch (error) {
//     // Rollback transaction if it exists
//     if (transaction) await transaction.rollback();

//     console.error("Source creation error:", error);

//     // More specific error handling
//     if (error.name === "SequelizeValidationError") {
//       return res.status(400).json({
//         success: false,
//         message:
//           "Validation error: " + error.errors.map((e) => e.message).join(", "),
//       });
//     }

//     if (error.name === "SequelizeDatabaseError") {
//       return res.status(500).json({
//         success: false,
//         message: "Database error occurred",
//       });
//     }

//     return res.status(500).json({
//       success: false,
//       message: "Internal server error",
//     });
//   }
// };
// Add this test connection endpoint to your API routes

exports.createSource = async (req, res) => {
  let transaction;
  try {
    let { name, configuration } = req.body;
    console.log("Request body:", req.body);
    let sourceType = configuration?.sourceType || req.body.sourceType;

    // Validate required fields
    if (!name || !sourceType) {
      return res.status(400).json({
        success: false,
        message: "Name and sourceType are required",
      });
    }

    // Check if source name already exists
    let existingSource;
    try {
      existingSource = await Source.findOne({
        where: { source_name: name },
      });
    } catch (dbError) {
      console.error("Database error:", dbError);
      return res.status(500).json({
        success: false,
        message: "Database query failed",
      });
    }

    if (existingSource) {
      return res.status(400).json({
        success: false,
        message: "Source name must be unique",
      });
    }

    // Start transaction for atomic operations
    transaction = await Source.sequelize.transaction();

    let connectorSettings = {};
    let filePath = null;
    let sourceRecord;

    // Create source record first to get the source ID
    sourceRecord = await Source.create(
      stampTenant(req, {
        source_name: name,
        connector_name: sourceType,
        connector_settings_json: {}, // Temporary empty object
        status: "processing", // Set to processing initially
        created_by: req.auth?.userId ?? 1,
        created_on: new Date(),
      }),
      { transaction }
    );

    const sourceId = sourceRecord.id.toString();

    // Handle different source types using switch case
    switch (sourceType.toLowerCase()) {
      case "excel":
        // Validate file existence for Excel sources
        if (!req.file) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: "Excel file is required for Excel source type",
          });
        }

        // Validate file type
        if (
          !req.file.mimetype.includes("excel") &&
          !req.file.originalname.match(/\.(xlsx|xls)$/i)
        ) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: "Invalid file type. Only Excel files are allowed",
          });
        }

        try {
          // Save file using source ID as folder name
          const savedFile = FileService.saveExcelFile(
            sourceId, // Using source ID as folder name
            name, // Using source name as file identifier
            req.file.originalname,
            req.file.buffer
          );

          filePath = savedFile.path;

          connectorSettings = {
            originalName: req.file.originalname,
            mimeType: req.file.mimetype,
            size: req.file.size,
            filePath: filePath,
            savedFileName: savedFile.filename,
            sourceId: sourceId,
            path: savedFile.filePath,
            url: savedFile.publicUrl,
            sourceType: sourceType,
            folderName: "source_excel_files",
          };

          // Update the source record with file path and connector settings
          await Source.update(
            {
              connector_settings_json: connectorSettings,
              status: "completed",
            },
            {
              where: { id: sourceId },
              transaction,
            }
          );
        } catch (fileError) {
          await transaction.rollback();
          console.error("File save error:", fileError);
          return res.status(500).json({
            success: false,
            message: `Failed to save file: ${fileError.message}`,
          });
        }
        break;

      case "quickbooks":
        if (!configuration) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: "Configuration is required for QuickBooks source type",
          });
        }

        // Validate required fields
        const requiredQuickBooksFields = [
          "client_id",
          "client_secret",
          "realm_id",
          "access_token",
          "refresh_token",
        ];
        const missingFields = requiredQuickBooksFields.filter(
          (field) => !configuration[field]
        );

        if (missingFields.length > 0) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: `Missing required QuickBooks configuration fields: ${missingFields.join(
              ", "
            )}`,
          });
        }

        // Validate QuickBooks connection with automatic token refresh
        try {
          console.log(
            "🔄 Testing QuickBooks connection with automatic token refresh..."
          );
          // ✅ STEP 1: Create final configuration with explicit refresh token preservation
          const finalConfiguration = {
            ...configuration,
            // Explicitly include refresh_token to prevent any loss
            refresh_token: configuration.refresh_token,
          };
          // ✅ STEP 2: Test connection with timeout
          const quickBooksResult = await testQuickBooksConnectionWithTimeout(
            configuration,
            3000000
          );

          // Always use the refreshed tokens
          if (quickBooksResult.tokensRefreshed) {
            finalConfiguration.access_token = quickBooksResult.newAccessToken;
            finalConfiguration.refresh_token = quickBooksResult.newRefreshToken;
            console.log("✅ Using refreshed tokens for QuickBooks");
          }

          connectorSettings = {
            ...finalConfiguration,
            sourceType: "quickbooks",
            connectedOn: new Date().toISOString(),
            environment: finalConfiguration?.sandbox ? "sandbox" : "production",
            lastValidated: new Date().toISOString(),
            companyName: quickBooksResult.companyName,
          };

          // Update source record for QuickBooks
          await Source.update(
            {
              connector_settings_json: connectorSettings,
              status: "completed",
            },
            {
              where: { id: sourceId },
              transaction,
            }
          );
        } catch (qbError) {
          await transaction.rollback();
          console.error("❌ QuickBooks validation error:", qbError);

          let userMessage = qbError.message;
          let requiresReauth = false;

          // Check if this is an authentication error that requires reauthorization
          if (
            qbError.message.includes("reauthorization required") ||
            qbError.message.includes("Refresh token is invalid") ||
            qbError.message.includes("Authentication failed")
          ) {
            requiresReauth = true;
            userMessage =
              "QuickBooks authentication failed. Please reauthorize the connection.";
          }

          return res.status(400).json({
            success: false,
            message: `QuickBooks connection failed: ${userMessage}`,
            requiresReauthorization: requiresReauth,
            detailedError:
              process.env.NODE_ENV === "development"
                ? qbError.message
                : undefined,
          });
        }
        break;
      case "google drive":
        if (!configuration) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: "Configuration is required for Google Drive source type",
          });
        }

        // Validate required fields
        const requiredGoogleDriveFields = [
          "client_id",
          "client_secret",
          "refresh_token",
          "access_token",
          "folder_id",
        ];

        const missingFieldsGoogleDrive = requiredGoogleDriveFields.filter(
          (field) => !configuration[field]
        );

        if (missingFieldsGoogleDrive.length > 0) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: `Missing required Google Drive configuration fields: ${missingFieldsGoogleDrive.join(
              ", "
            )}`,
          });
        }

        // Test Google Drive connection before creating source
        try {
          console.log("🔄 Testing Google Drive connection...");

          const testResult = await testGoogleDriveConnection(
            { body: { configuration } },
            {
              json: (data) => data,
            }
          );

          if (!testResult.success) {
            await transaction.rollback();
            return res.status(400).json({
              success: false,
              message: `Google Drive connection failed: ${testResult.message}`,
              requiresReauthorization: testResult.requiresReauthorization,
            });
          }

          connectorSettings = {
            ...configuration,
            sourceType: "google drive",
            connectedOn: new Date().toISOString(),
            driveType: configuration.drive_type || "my_drive",
            lastValidated: new Date().toISOString(),
            folderInfo: testResult.data.folder,
            userInfo: testResult.data.user,
          };

          // Update source record for Google Drive
          await Source.update(
            {
              connector_settings_json: connectorSettings,
              status: "completed",
            },
            {
              where: { id: sourceId },
              transaction,
            }
          );

          console.log("✅ Google Drive source created successfully");
        } catch (gdError) {
          await transaction.rollback();
          console.error("❌ Google Drive validation error:", gdError);

          return res.status(400).json({
            success: false,
            message: `Google Drive connection failed: ${gdError.message}`,
            requiresReauthorization:
              gdError.message.includes("authentication") ||
              gdError.message.includes("token"),
          });
        }
        break;
      case "postgres":
        // Handle PostgreSQL source type
        if (!configuration) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: "Configuration is required for PostgreSQL source type",
          });
        }

        connectorSettings = {
          ...configuration,
          sourceType: "postgres",
          connectedOn: new Date().toISOString(),
        };

        // Update source record for PostgreSQL
        await Source.update(
          {
            connector_settings_json: connectorSettings,
            status: "completed",
          },
          {
            where: { id: sourceId },
            transaction,
          }
        );
        break;
      // Add this case to your existing switch statement in createSource function
      case "shopify":
        if (!configuration) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: "Configuration is required for Shopify source type",
          });
        }

        // Validate required fields
        const requiredShopifyFields = ["shop"];

        // For OAuth, require client_id, client_secret, and access_token
        const authMethod = configuration.credentials?.auth_method || "oauth";
        if (authMethod === "oauth") {
          requiredShopifyFields.push(
            "client_id",
            "client_secret",
            "access_token"
          );
        } else if (authMethod === "api_password") {
          requiredShopifyFields.push("api_password");
        }

        const missingShopifyFields = requiredShopifyFields.filter((field) => {
          if (
            field === "client_id" ||
            field === "client_secret" ||
            field === "access_token" ||
            field === "api_password"
          ) {
            return !configuration.credentials?.[field];
          }
          return !configuration[field];
        });

        if (missingShopifyFields.length > 0) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: `Missing required Shopify configuration fields: ${missingShopifyFields.join(
              ", "
            )}`,
          });
        }

        // Test Shopify connection before creating source
        try {
          console.log("🔄 Testing Shopify connection...");

          const shopifyResult = await testShopifyConnectionWithTimeout(
            {
              shop: configuration.shop,
              access_token: configuration.credentials.access_token,
              client_id: configuration.credentials.client_id,
              client_secret: configuration.credentials.client_secret,
              auth_method: configuration.credentials.auth_method,
            },
            30000
          );

          connectorSettings = {
            ...configuration,
            sourceType: "shopify",
            connectedOn: new Date().toISOString(),
            lastValidated: new Date().toISOString(),
            shopInfo: shopifyResult.shop,
          };

          // Update source record for Shopify
          await Source.update(
            {
              connector_settings_json: connectorSettings,
              status: "completed",
            },
            {
              where: { id: sourceId },
              transaction,
            }
          );

          console.log("✅ Shopify source created successfully");
        } catch (shopifyError) {
          await transaction.rollback();
          console.error("❌ Shopify validation error:", shopifyError);

          return res.status(400).json({
            success: false,
            message: `Shopify connection failed: ${shopifyError.message}`,
            requiresReauthorization:
              shopifyError.message.includes("authentication") ||
              shopifyError.message.includes("token"),
          });
        }
        break;

       case "zoho books":
  if (!configuration) {
    await transaction.rollback();
    return res.status(400).json({
      success: false,
      message: "Configuration is required for Zoho Books"
    });
  }

  const requiredZoho = ["client_id", "client_secret", "refresh_token", "region"];
  const missingZoho = requiredZoho.filter(f => !configuration[f]);

  if (missingZoho.length > 0) {
    await transaction.rollback();
    return res.status(400).json({
      success: false,
      message: `Missing Zoho Books fields: ${missingZoho.join(", ")}`
    });
  }

  try {
    const region = configuration.region.toLowerCase();
    const base_url = `https://accounts.zoho.${region}`;

    console.log("🔄 Generating Zoho access token...");

    const access_token = await generateZohoAccessToken({
      client_id: configuration.client_id,
      client_secret: configuration.client_secret,
      refresh_token: configuration.refresh_token,
      base_url
    });

    console.log("🔍 Fetching Zoho Books organizations...");

    const { organization_id, organization_name } =
      await getZohoOrganizations(access_token, region);

    connectorSettings = {
      ...configuration,
      access_token,
      organization_id,
      organization_name,
      base_url,
      books_api_url: `https://books.zoho.${region}`,
      sourceType: "zoho books",
      connectedOn: new Date(),
      lastValidated: new Date()
    };

    await Source.update(
      {
        connector_settings_json: connectorSettings,
        status: "completed"
      },
      { where: { id: sourceId }, transaction }
    );

    console.log("✅ Zoho Books Source Created Successfully");
  } catch (err) {
    await transaction.rollback();
    return res.status(400).json({
      success: false,
      message: err.message,
      requiresReauthorization:
        err.message.includes("invalid") || err.message.includes("expired")
    });
  }

  break;

      default:
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: `Unsupported source type: ${sourceType}`,
        });
    }

    // Commit transaction
    await transaction.commit();

    // Refresh the source record to get updated data
    const updatedSource = await Source.findByPk(sourceId);

    // Cache operations (outside transaction)
    try {
      await invalidateSourceCache();
      const freshSources = await Source.findAll();
      await createCache("sourceListDB", freshSources);
    } catch (cacheError) {
      console.warn("Cache update failed:", cacheError);
      // Don't fail the request if cache fails
    }

    return res.status(200).json({
      success: true,
      data: {
        sourceId: updatedSource.id,
        sourceRecord: {
          id: updatedSource.id,
          source_name: updatedSource.source_name,
          file_path: updatedSource.file_path,
          connector_name: updatedSource.connector_name,
          status: updatedSource.status,
        },
      },
      message: getSuccessMessage(sourceType),
    });
  } catch (error) {
    // Rollback transaction if it exists
    if (transaction) await transaction.rollback();

    console.error("Source creation error:", error);

    // More specific error handling
    if (error.name === "SequelizeValidationError") {
      return res.status(400).json({
        success: false,
        message:
          "Validation error: " + error.errors.map((e) => e.message).join(", "),
      });
    }

    if (error.name === "SequelizeDatabaseError") {
      return res.status(500).json({
        success: false,
        message: "Database error occurred",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Helper function for success messages
function getSuccessMessage(sourceType) {
  const messages = {
    excel: "Source created successfully and Excel file saved",
    quickbooks: "Source created successfully and QuickBooks connected",
    postgres: "Source created successfully and PostgreSQL database connected",
    mysql: "Source created successfully and MySQL database connected",
    sqlserver: "Source created successfully and SQL Server database connected",
  };

  return messages[sourceType.toLowerCase()] || "Source created successfully";
}

  exports.discoverSchema = async (req, res) => {
    try {
      const { sourceId, startDate, endDate } = req.body;
      console.log("sourceRecord", req.body);
      if (!sourceId) {
        return res.status(400).json({
          success: false,
          data: null,
          message: "sourceId is required",
        });
      }

      // ✅ Auto-set dates if not provided
      let dateFilter = {};
      const today = new Date();

      // If no startDate provided, set to year start (January 1st of current year)
      const defaultStartDate = startDate
        ? new Date(startDate)
        : new Date(today.getFullYear(), 0, 1);

      // If no endDate provided, set to current date
      const defaultEndDate = endDate ? new Date(endDate) : today;

      // Validate dates
      if (isNaN(defaultStartDate.getTime())) {
        return res.status(400).json({
          success: false,
          data: null,
          message: "Invalid startDate format",
        });
      }
      if (isNaN(defaultEndDate.getTime())) {
        return res.status(400).json({
          success: false,
          data: null,
          message: "Invalid endDate format",
        });
      }

      dateFilter = {
        startDate: defaultStartDate,
        endDate: defaultEndDate,
        autoGenerated: !startDate || !endDate, // Flag to indicate auto-generated dates
      };

      // ✅ Fetch source record from DB
      const sourceRecord = await Source.findOne({ where: { id: sourceId } });

      if (!sourceRecord) {
        return res.status(404).json({
          success: false,
          data: null,
          message: "Source not found",
        });
      }

      // Parse connector settings JSON
      // const settings = JSON.parse(sourceRecord.connector_settings_json);
      const settings =
        typeof sourceRecord.connector_settings_json === "string"
          ? JSON.parse(sourceRecord.connector_settings_json)
          : sourceRecord.connector_settings_json;
      let schemaResult = null;
console.log("sourceRecord.connector_name",sourceRecord.connector_name)
      switch (sourceRecord.connector_name.toLowerCase()) {
        case "excel":
          const fileName = settings?.originalName || settings?.fileName;
          if (!fileName)
            return res.status(400).json({
              success: false,
              data: null,
              message: "Excel file name not found",
            });

          const folderPath = path.join(
            __dirname,
            "../public/source_excel_files",
            String(sourceId)
          );
          const filePath = path.join(folderPath, fileName);

          if (!fs.existsSync(filePath))
            return res.status(404).json({
              success: false,
              data: null,
              message: "Excel file not found",
            });

          const workbook = xlsx.readFile(filePath);
          const sheetNames = workbook.SheetNames;

          const sheets = sheetNames.map((sheet) => {
            const worksheet = workbook.Sheets[sheet];
            const json = xlsx.utils.sheet_to_json(worksheet, { header: 1 });
            const columns = json[0] || [];
            return { sheetName: sheet, columns };
          });

          schemaResult = { sheets };
          break;
        case "postgres":
          const client = new Client({
            host: settings.host,
            port: settings.port,
            user: settings.username,
            password: settings.password,
            database: settings.database,
            ssl: settings?.ssl_mode?.mode === "disable" ? false : true,
          });

          await client.connect();

          // ✅ Get tables
          const tables = await client.query(`
          SELECT table_name 
          FROM information_schema.tables 
          WHERE table_schema = '${settings.schema || "public"}'
        `);

          const columns = await client.query(`
              SELECT
                c.table_name,
                c.column_name,
                c.data_type,
                c.is_nullable,
                c.character_maximum_length,
                CASE WHEN tc.constraint_type = 'PRIMARY KEY' THEN true ELSE false END AS is_primary_key
              FROM information_schema.columns c
              LEFT JOIN information_schema.key_column_usage kcu
                ON c.table_name = kcu.table_name
                AND c.column_name = kcu.column_name
                AND c.table_schema = kcu.table_schema
              LEFT JOIN information_schema.table_constraints tc
                ON kcu.constraint_name = tc.constraint_name
                AND kcu.table_schema = tc.table_schema
              WHERE c.table_schema = '${settings.schema || "public"}'
              ORDER BY c.table_name, c.ordinal_position
            `);

          await client.end();

          const streams = tables.rows.map((table) => {
            const tableColumns = columns.rows.filter(
              (c) => c.table_name === table.table_name
            );

            const properties = {};
            const primaryKeys = [];

            tableColumns.forEach((col) => {
              properties[col.column_name] = {
                type: col.data_type,
                nullable: col.is_nullable === "YES",
                maxLength: col.character_maximum_length,
                isPrimaryKey: col.is_primary_key, // ✅ add PK info
              };
              if (col.is_primary_key) primaryKeys.push(col.column_name);
            });

            return {
              stream: {
                name: table.table_name,
                jsonSchema: { properties },
                primaryKeys, // ✅ array of primary key columns
              },
              config: {
                selected: false,
                syncMode: "full_refresh",
                destinationSyncMode: "overwrite",
                cursorField: [],
              },
            };
          });

          schemaResult = {
            catalog: { streams },
          };
          break;

        // case "quickbooks": {
        //     const { access_token, realm_id } = settings;
        //     const realmId = realm_id;
        //     if (!access_token || !realmId) {
        //       return res.status(400).json({
        //         success: false,
        //         data: null,
        //         message: "QuickBooks access_token or realmId missing in settings",
        //       });
        //     }

        //     const BASE_URL = "https://sandbox-quickbooks.api.intuit.com";
        //     const BATCH_URL = `${BASE_URL}/v3/company/${realmId}/batch`;
        //     const MINOR_VERSION = 65;

        //     const queryEntities = [
        //       "Account",
        //       "Attachable",
        //       "Budget",
        //       "Class",
        //       "CompanyCurrency",
        //       "CompanyInfo",
        //       "Customer",
        //       "CustomerType",
        //       "Department",
        //       "Employee",
        //       "Exchangerate",
        //       "Item",
        //       "JournalCode",
        //       "PaymentMethod",
        //       "TaxAgency",
        //       "TaxClassification",
        //       "TaxCode",
        //       "TaxRate",
        //       "Term",
        //       "Vendor",
        //     ];

        //     const directEntities = [
        //       "Batch",
        //       "Bill",
        //       "BillPayment",
        //       "CreditCardPayment",
        //       "CreditMemo",
        //       "Deposit",
        //       "Estimate",
        //       "Invoice",
        //       "JournalEntry",
        //       "Payment",
        //       "Purchase",
        //       "PurchaseOrder",
        //       "RecurringTransaction",
        //       "RefundReceipt",
        //       "ReimburseCharge",
        //       "SalesReceipt",
        //       "Transfer",
        //       "TaxPayment",
        //     ];

        //     // ✅ REPORTS THAT REQUIRE DATE RANGE
        //     const dateRangeReports = [
        //       "APAgingDetail",
        //       "ARAgingDetail",
        //       "CashFlow",
        //       "CustomerBalance",
        //       "JournalReport",
        //       "ProfitAndLossDetail",
        //       "SalesByClassSummary",
        //       "SalesByCustomer",
        //       "SalesByDepartment",
        //       "SalesByProduct",
        //       "TrialBalance",
        //       "VendorBalance",
        //       "VendorBalanceDetail",
        //       "GeneralLedger",
        //       "BalanceSheet",
        //       "ProfitAndLoss"
        //     ];

        //     const allEntities = [...queryEntities, ...directEntities, ...dateRangeReports];

        //     const chunkArray = (arr, size) =>
        //       arr.reduce(
        //         (acc, _, i) => (i % size ? acc : [...acc, arr.slice(i, i + size)]),
        //         []
        //       );

        //     const entityChunks = chunkArray(allEntities, 30);
        //     const streams = [];

        //     const inferType = (value) => {
        //       if (value === null || value === undefined) return "unknown";
        //       if (Array.isArray(value)) return "array";
        //       const type = typeof value;
        //       return type === "object" ? "object" : type;
        //     };

        //     const extractFields = (obj, prefix = "") => {
        //       const fields = {};
        //       for (const [key, value] of Object.entries(obj || {})) {
        //         const fieldName = prefix ? `${prefix}.${key}` : key;
        //         const type = inferType(value);
        //         fields[fieldName] = { type };
        //         if (type === "object" && value !== null)
        //           Object.assign(fields, extractFields(value, fieldName));
        //       }
        //       return fields;
        //     };

        //     // ✅ Helper function to format dates for QuickBooks API
        //     const formatQbDate = (date) => {
        //       if (!date) return '';
        //       const d = new Date(date);
        //       return d.toISOString().split('T')[0]; // YYYY-MM-DD format
        //     };

        //     console.time("QuickBooksBatchSchema");

        //     for (const batch of entityChunks) {
        //       const batchRequest = {
        //         BatchItemRequest: batch.map((entity) => {
        //           let relativeUrl;

        //           if (queryEntities.includes(entity)) {
        //             // Queryable entities - FIXED: removed extra space
        //             relativeUrl = `/v3/company/${realmId}/query?query=select * from ${entity} maxresults 1&minorversion=${MINOR_VERSION}`;
        //           }
        //           else if (dateRangeReports.includes(entity)) {
        //             // ✅ REPORTS WITH DATE RANGE FILTERING
        //             let reportUrl = `/v3/company/${realmId}/reports/${entity}?minorversion=${MINOR_VERSION}`;

        //             // Add date parameters (will always be available now due to auto-generation)
        //             const params = [];
        //             if (dateFilter.startDate) {
        //               params.push(`start_date=${formatQbDate(dateFilter.startDate)}`);
        //             }
        //             if (dateFilter.endDate) {
        //               params.push(`end_date=${formatQbDate(dateFilter.endDate)}`);
        //             }

        //             if (params.length > 0) {
        //               reportUrl += `&${params.join('&')}`;
        //             }

        //             relativeUrl = reportUrl;
        //           }
        //           else {
        //             // Direct transactional objects
        //             relativeUrl = `/v3/company/${realmId}/${entity}?minorversion=${MINOR_VERSION}&maxresults=1`;
        //           }

        //           return {
        //             bId: entity.toLowerCase(),
        //             method: "GET",
        //             relativeUrl,
        //           };
        //         }),
        //       };

        //       try {
        //         console.log(`Making batch request for ${batch.length} entities`);

        //         const response = await fetch(BATCH_URL, {
        //           method: "POST",
        //           headers: {
        //             Authorization: `Bearer ${access_token}`,
        //             Accept: "application/json",
        //             "Content-Type": "application/json",
        //           },
        //           body: JSON.stringify(batchRequest),
        //         });

        //         console.log("Response status:", response.status);

        //         if (!response.ok) {
        //           const errorText = await response.text();
        //           console.error("QuickBooks batch error response:", errorText);

        //           // Try to parse as JSON, if fails use text
        //           let errorData;
        //           try {
        //             errorData = JSON.parse(errorText);
        //           } catch {
        //             errorData = { error: errorText };
        //           }

        //           console.error("QuickBooks batch error:", errorData);
        //           continue;
        //         }

        //         const qbData = await response.json();
        //         console.log(`Batch processed successfully, ${qbData.BatchItemResponse?.length || 0} items`);

        //         for (const item of qbData.BatchItemResponse || []) {
        //           const entity = item.bId;

        //           // Check for individual item errors
        //           if (item.Fault) {
        //             console.error(`Error for entity ${entity}:`, item.Fault);
        //             continue;
        //           }

        //           const data =
        //             item.QueryResponse ||
        //             item.Report ||
        //             item.Entities ||
        //             {};

        //           let records = [];
        //           if (data.Report && data.Report.Rows?.Row)
        //             records = data.Report.Rows.Row;
        //           else if (data[entity]) records = data[entity];
        //           else if (data[entity.charAt(0).toUpperCase() + entity.slice(1)])
        //             records = data[entity.charAt(0).toUpperCase() + entity.slice(1)];
        //           else if (data.Entities) records = data.Entities;

        //           if (!records || !records.length) {
        //             console.log(`No records found for entity: ${entity}`);
        //             continue;
        //           }

        //           const sample = records[0];
        //           const properties = extractFields(sample);
        //           const primaryKeys = ["Id"];

        //           // ✅ Add date range info for reports that support it
        //           const supportsDateRange = dateRangeReports.includes(entity);

        //           streams.push({
        //             stream: {
        //               name: entity,
        //               jsonSchema: { properties },
        //               primaryKeys,
        //               supportsDateRange: supportsDateRange,
        //               currentDateRange: supportsDateRange ? {
        //                 startDate: dateFilter.startDate,
        //                 endDate: dateFilter.endDate
        //               } : null
        //             },
        //             config: {
        //               selected: false,
        //               syncMode: "full_refresh",
        //               destinationSyncMode: "overwrite",
        //               cursorField: [],
        //             },
        //           });
        //         }
        //       } catch (err) {
        //         console.error("QuickBooks batch fetch failed:", err.message);
        //       }
        //     }

        //     console.timeEnd("QuickBooksBatchSchema");

        //     schemaResult = {
        //       catalog: { streams },
        //       totalEntities: allEntities.length,
        //       processedBatches: entityChunks.length,
        //       dateRangeApplied: {
        //         startDate: dateFilter.startDate,
        //         endDate: dateFilter.endDate,
        //         autoGenerated: dateFilter.autoGenerated
        //       },
        //       dateRangeSupportedReports: dateRangeReports,
        //     };

        //     await Source.update(
        //       { cached_schema_json: schemaResult },
        //       { where: { id: sourceId } }
        //     );
        //     break;
        //   }

        case "quickbooks": {
          const { access_token, realm_id } = settings;
          const realmId = realm_id;
          if (!access_token || !realmId) {
            return res.status(400).json({
              success: false,
              data: null,
              message: "QuickBooks access_token or realmId missing in settings",
            });
          }

          const BASE_URL = "https://sandbox-quickbooks.api.intuit.com";
          const MINOR_VERSION = 75; // Updated to latest minor version

          // ✅ ALL ENTITIES SHOULD USE QUERY ENDPOINT (except reports)
          const queryEntities = [
            // Common entities
            "Account",
            "Customer",
            "Vendor",
            "Invoice",
            "Bill",
            "Payment",
            "Item",
            "Employee",
            "Department",
            "Class",
            "Term",
            "TaxCode",
            "TaxRate",
            "PaymentMethod",
            "Currency",
            "CompanyInfo",

            // Transactional entities that were failing
            "Estimate",
            "CreditMemo",
            "SalesReceipt",
            "Deposit",
            "JournalEntry",
            "Purchase",
            "PurchaseOrder",
            "Transfer",
            "VendorCredit",
            "BillPayment",
            "TimeActivity",
            "Budget",
          ];

          // ✅ REPORTS THAT REQUIRE DATE RANGE
          const dateRangeReports = [
            "ARAgingDetail",
            "APAgingDetail",
            "ProfitAndLoss",
            "BalanceSheet",
            "TrialBalance",
            "CashFlow",
            "CustomerBalance",
            "VendorBalance",
            "GeneralLedger",
            "SalesByProduct",
            "TaxSummary",
            "TrialBalance",
            "VendorBalanceDetail",
          ];

          const allEntities = [...queryEntities, ...dateRangeReports];

          const streams = [];
          const failedEntities = [];

          const inferType = (value) => {
            if (value === null || value === undefined) return "unknown";
            if (Array.isArray(value)) return "array";
            const type = typeof value;
            return type === "object" ? "object" : type;
          };

          const extractFields = (obj, prefix = "") => {
            const fields = {};
            for (const [key, value] of Object.entries(obj || {})) {
              const fieldName = prefix ? `${prefix}.${key}` : key;
              const type = inferType(value);
              fields[fieldName] = { type };
              if (type === "object" && value !== null)
                Object.assign(fields, extractFields(value, fieldName));
            }
            return fields;
          };

          // ✅ Helper function to format dates for QuickBooks API
          const formatQbDate = (date) => {
            if (!date) return "";
            const d = new Date(date);
            return d.toISOString().split("T")[0]; // YYYY-MM-DD format
          };

          console.time("QuickBooksSchemaFetch");

          // ✅ Process entities INDIVIDUALLY
          for (const entity of allEntities) {
            try {
              let url;

              if (dateRangeReports.includes(entity)) {
                // Reports with date range - use report endpoint
                let reportUrl = `${BASE_URL}/v3/company/${realmId}/reports/${entity}?minorversion=${MINOR_VERSION}`;

                // Add date parameters
                const params = [];
                if (dateFilter.startDate) {
                  params.push(`start_date=${formatQbDate(dateFilter.startDate)}`);
                }
                if (dateFilter.endDate) {
                  params.push(`end_date=${formatQbDate(dateFilter.endDate)}`);
                }

                if (params.length > 0) {
                  reportUrl += `&${params.join("&")}`;
                }

                url = reportUrl;
              } else {
                // ✅ ALL OTHER ENTITIES USE QUERY ENDPOINT
                url = `${BASE_URL}/v3/company/${realmId}/query?query=select * from ${entity} maxresults 1&minorversion=${MINOR_VERSION}`;
              }

              console.log(`Fetching schema for: ${entity}`);
              console.log(`URL: ${url.substring(0, 100)}...`);

              const response = await fetch(url, {
                method: "GET",
                headers: {
                  Authorization: `Bearer ${access_token}`,
                  Accept: "application/json",
                  "Content-Type": "application/json",
                },
              });
              console.log("sdsddfsdf", response);
              if (!response.ok) {
                const errorText = await response.text();
                console.warn(`Failed to fetch ${entity}: ${response.status}`);
                console.warn(`Error details: ${errorText.substring(0, 200)}...`);

                failedEntities.push({
                  entity,
                  error: `HTTP ${response.status}`,
                  details: errorText.substring(0, 500),
                });

                // Create basic schema for failed entities
                const commonProperties = {
                  Id: { type: "string" },
                  SyncToken: { type: "string" },
                  domain: { type: "string" },
                  MetaData: { type: "object" },
                  sparse: { type: "boolean" },
                };

                streams.push({
                  stream: {
                    name: entity,
                    jsonSchema: { properties: commonProperties },
                    primaryKeys: ["Id"],
                    supportsDateRange: dateRangeReports.includes(entity),
                    currentDateRange: dateRangeReports.includes(entity)
                      ? {
                          startDate: dateFilter.startDate,
                          endDate: dateFilter.endDate,
                        }
                      : null,
                    note: `Schema inference failed - using common fields. Error: ${response.status}`,
                  },
                  config: {
                    selected: false,
                    syncMode: "full_refresh",
                    destinationSyncMode: "overwrite",
                    cursorField: [],
                  },
                });
                continue;
              }

              const data = await response.json();
              console.log(`Response structure for ${entity}:`, Object.keys(data));

              let records = [];
              let sample = null;

              // ✅ Extract records based on response type
              if (data.QueryResponse && data.QueryResponse[entity]) {
                records = data.QueryResponse[entity];
              } else if (data.Report) {
                // Handle report data structure
                if (data.Report.Rows && data.Report.Rows.Row) {
                  records = data.Report.Rows.Row;
                } else if (data.Report.Columns && data.Report.Rows) {
                  // Alternative report structure
                  records = [data.Report];
                } else {
                  records = [data.Report];
                }
              } else if (data[entity]) {
                records = data[entity];
              } else if (Array.isArray(data)) {
                records = data;
              } else {
                // Try to find any array in the response
                const arrayKeys = Object.keys(data).filter((key) =>
                  Array.isArray(data[key])
                );
                if (arrayKeys.length > 0) {
                  records = data[arrayKeys[0]];
                }
              }

              if (!records || records.length === 0) {
                console.log(`No data found for ${entity}, creating basic schema`);

                const commonProperties = {
                  Id: { type: "string" },
                  SyncToken: { type: "string" },
                  domain: { type: "string" },
                  sparse: { type: "boolean" },
                };

                streams.push({
                  stream: {
                    name: entity,
                    jsonSchema: { properties: commonProperties },
                    primaryKeys: ["Id"],
                    supportsDateRange: dateRangeReports.includes(entity),
                    currentDateRange: dateRangeReports.includes(entity)
                      ? {
                          startDate: dateFilter.startDate,
                          endDate: dateFilter.endDate,
                        }
                      : null,
                    note: "Basic schema - no sample data available",
                  },
                  config: {
                    selected: false,
                    syncMode: "full_refresh",
                    destinationSyncMode: "overwrite",
                    cursorField: [],
                  },
                });
                continue;
              }

              sample = records[0];
              console.log(`Sample data for ${entity}:`, Object.keys(sample));

              const properties = extractFields(sample);
              const primaryKeys = ["Id"];

              // ✅ Add date range info for reports that support it
              const supportsDateRange = dateRangeReports.includes(entity);

              streams.push({
                stream: {
                  name: entity,
                  jsonSchema: { properties },
                  primaryKeys,
                  supportsDateRange: supportsDateRange,
                  currentDateRange: supportsDateRange
                    ? {
                        startDate: dateFilter.startDate,
                        endDate: dateFilter.endDate,
                      }
                    : null,
                  note: "Schema inferred from sample data",
                },
                config: {
                  selected: false,
                  syncMode: "full_refresh",
                  destinationSyncMode: "overwrite",
                  cursorField: [],
                },
              });

              console.log(`✓ Successfully processed: ${entity}`);
            } catch (err) {
              console.error(`Error processing ${entity}:`, err.message);
              failedEntities.push({ entity, error: err.message });
            }
          }

          console.timeEnd("QuickBooksSchemaFetch");

          schemaResult = {
            catalog: { streams },
            totalEntities: allEntities.length,
            successfulEntities: streams.length,
            failedEntities: failedEntities,
            dateRangeApplied: {
              startDate: dateFilter.startDate,
              endDate: dateFilter.endDate,
              autoGenerated: dateFilter.autoGenerated,
            },
            dateRangeSupportedReports: dateRangeReports,
          };

          await Source.update(
            { cached_schema_json: schemaResult },
            { where: { id: sourceId } }
          );
          break;
        }
        // Add this case to your existing discoverSchema function
        // case "shopify": {
        //   const { shop } = settings;
        //   const access_token = settings.credentials?.access_token;

        //   if (!shop || !access_token) {
        //     return res.status(400).json({
        //       success: false,
        //       data: null,
        //       message: "Shopify shop or access_token missing in settings",
        //     });
        //   }

        //   try {
        //     console.log(`🛍️ Starting Shopify schema discovery for: ${shop}`);

        //     // Test connection first
        //     const connectionTest = await testShopifyConnection(
        //       shop,
        //       access_token
        //     );
        //     if (!connectionTest) {
        //       throw new Error("Failed to connect to Shopify store");
        //     }

        //     // Discover schema with data validation
        //     const schemaDiscovery = await discoverShopifySchema(
        //       shop,
        //       access_token
        //     );

        //     schemaResult = {
        //       catalog: {
        //         streams: schemaDiscovery.streams,
        //       },
        //       summary: schemaDiscovery.summary,
        //       connectionInfo: {
        //         shop: connectionTest.shop,
        //         connectedAt: new Date().toISOString(),
        //         totalStreams: schemaDiscovery.streams.length,
        //       },
        //       discoverySettings: {
        //         onlyEntitiesWithData: true,
        //         prioritizedEntities: true,
        //         apiVersion: "2024-01",
        //       },
        //     };

        //     // Cache the schema result
        //     await Source.update(
        //       { cached_schema_json: schemaResult },
        //       { where: { id: sourceId } }
        //     );

        //     console.log(
        //       `✅ Shopify schema discovery completed. Found ${schemaDiscovery.streams.length} entities with data.`
        //     );
        //   } catch (error) {
        //     console.error("❌ Shopify schema discovery failed:", error);

        //     // Return basic schema with error information
        //     schemaResult = {
        //       catalog: { streams: [] },
        //       error: error.message,
        //       summary: {
        //         totalEntitiesChecked: 0,
        //         entitiesWithData: 0,
        //         entitiesWithoutData: 0,
        //         error: error.message,
        //       },
        //     };
        //   }
        //   break;
        // }
  case "shopify": {
    const { shop } = settings;
    const access_token = settings.credentials?.access_token;

    if (!shop || !access_token) {
      return res.status(400).json({
        success: false,
        data: null,
        message: "Shopify shop or access_token missing in settings",
      });
    }

    try {
      console.log(`🛍️ Starting Shopify schema discovery for: ${shop}`);

      // Test connection first
      const connectionTest = await testShopifyConnection(shop, access_token);
      if (!connectionTest) {
        throw new Error("Failed to connect to Shopify store");
      }

      // Discover schema with data validation and BIGINT support
      const schemaDiscovery = await discoverShopifySchemaWithBigInt(
        shop,
        access_token
      );

      schemaResult = {
        catalog: {
          streams: schemaDiscovery.streams,
        },
        summary: schemaDiscovery.summary,
        connectionInfo: {
          shop: connectionTest.shop,
          connectedAt: new Date().toISOString(),
          totalStreams: schemaDiscovery.streams.length,
        },
        discoverySettings: {
          onlyEntitiesWithData: true,
          prioritizedEntities: true,
          apiVersion: "2024-01",
          dataTypes: {
            idColumns: "bigint", // 🚨 CRITICAL: Specify BIGINT for IDs
            numericColumns: "bigint",
            defaultTextColumns: "text"
          }
        },
      };

      // Cache the schema result
      await Source.update(
        { cached_schema_json: schemaResult },
        { where: { id: sourceId } }
      );

      console.log(
        `✅ Shopify schema discovery completed. Found ${schemaDiscovery.streams.length} entities with data.`
      );
    } catch (error) {
      console.error("❌ Shopify schema discovery failed:", error);

      // Return basic schema with error information
      schemaResult = {
        catalog: { streams: [] },
        error: error.message,
        summary: {
          totalEntitiesChecked: 0,
          entitiesWithData: 0,
          entitiesWithoutData: 0,
          error: error.message,
        },
      };
    }
    break;
  }
        // case "quickbooks": {
        //   console.log("settings", settings);
        //   const { access_token, realm_id } = settings;
        //   const realmId = realm_id;
        //   if (!access_token || !realmId) {
        //     return res.status(400).json({
        //       success: false,
        //       data: null,
        //       message: "QuickBooks access_token or realmId missing in settings",
        //     });
        //   }

        //   // ✅ Use sandbox or production base URL
        //   const BASE_URL = "https://sandbox-quickbooks.api.intuit.com";
        //   const MINOR_VERSION = 65;

        //   // const entities = [
        //   //   "Account",
        //   //   "Customer",
        //   //   "Vendor",
        //   //   "Invoice",
        //   //   "Bill",
        //   //   "Payment",
        //   // ];

        //   // const entities = [
        //   //   "Account",
        //   //   "BillPayment",
        //   //   "Bill",
        //   //   "Budget",
        //   //   "Class",
        //   //   "CreditMemo",
        //   //   "Customer",
        //   //   "Department",
        //   //   "PurchaseOrder",
        //   //   "Purchase",
        //   //   "RefundReceipt",
        //   //   "SalesReceipt",
        //   //   "TaxAgency",
        //   //   "TaxCode",
        //   //   "TaxRate",
        //   //   "Term",
        //   //   "TimeActivity",
        //   //   "Transfer",
        //   //   "VendorCredit",
        //   //   "Vendor",
        //   //   "Deposit",
        //   //   "Employee",
        //   //   "Estimate",
        //   //   "Invoice",
        //   //   "Item",
        //   //   "JournalEntry",
        //   //   "PaymentMethod",
        //   //   "Payment",
        //   // ];
        //    const entities = getAllEntitiesForSchemaDiscovery();
        //   // ✅ Build parallel requests using Promise.all
        //   const requests = entities.map((entity) =>
        //     fetch(
        //       `${BASE_URL}/v3/company/${realmId}/query?query=select * from ${entity} maxresults 1&minorversion=${MINOR_VERSION}`,
        //       {
        //         headers: {
        //           Authorization: `Bearer ${access_token}`,
        //           Accept: "application/json",
        //         },
        //       }
        //     )
        //       .then((res) => res.json().catch(() => null))
        //       .then((data) => ({ entity, data }))
        //       .catch((err) => {
        //         console.error(`QuickBooks fetch failed for ${entity}:`, err);
        //         return { entity, data: null };
        //       })
        //   );

        //   console.time("QuickBooksSchemaFetch");
        //   const results = await Promise.all(requests);
        //   console.timeEnd("QuickBooksSchemaFetch");

        //   // ✅ Helper: Infer JS → simple data type
        //   function inferType(value) {
        //     if (value === null || value === undefined) return "unknown";
        //     if (Array.isArray(value)) return "array";
        //     const type = typeof value;
        //     if (type === "object") return "object";
        //     return type;
        //   }

        //   // ✅ Recursive extractor to infer field types
        //   function extractFields(obj, prefix = "") {
        //     const fields = {};
        //     for (const [key, value] of Object.entries(obj)) {
        //       const fieldName = prefix ? `${prefix}.${key}` : key;
        //       const type = inferType(value);
        //       fields[fieldName] = { type };

        //       if (type === "object" && value !== null) {
        //         Object.assign(fields, extractFields(value, fieldName));
        //       }
        //     }
        //     return fields;
        //   }

        //   const streams = [];

        //   // ✅ Process each QuickBooks entity result
        //   for (const { entity, data } of results) {
        //     const records = data?.QueryResponse?.[entity] || [];
        //     if (!records.length) {
        //       console.log(`No data for ${entity}`);
        //       continue;
        //     }

        //     const sample = records[0];
        //     const properties = extractFields(sample);
        //     const primaryKeys = ["Id"]; // Common QuickBooks PK

        //     streams.push({
        //       stream: {
        //         name: entity.toLowerCase(),
        //         jsonSchema: { properties },
        //         primaryKeys,
        //       },
        //       config: {
        //         selected: false,
        //         syncMode: "full_refresh",
        //         destinationSyncMode: "overwrite",
        //         cursorField: [],
        //       },
        //     });
        //   }

        //   // ✅ Optionally handle heavy reports asynchronously
        //   const reports = ["GeneralLedger", "TrialBalance"];
        //   const pendingReports = reports.map((r) => ({
        //     name: r,
        //     status: "pending",
        //     note: "Heavy report - fetch asynchronously if needed",
        //   }));

        //   schemaResult = {
        //     catalog: { streams },
        //     pendingReports,
        //   };

        //   // ✅ Cache schema result to DB for faster reuse
        //   await Source.update(
        //     { cached_schema_json: schemaResult },
        //     { where: { id: sourceId } }
        //   );

        //   break;
        // }
        case "zoho books": {
  console.log("Schema discovery: Zoho Books");

  try {
    const settings = typeof sourceRecord.connector_settings_json === "string"
      ? JSON.parse(sourceRecord.connector_settings_json)
      : sourceRecord.connector_settings_json;

    const {
      access_token,
      refresh_token,
      client_id,
      client_secret,
      region = "in",
      organization_id,
    } = settings;
    
    console.log("Zoho settings:", settings);

    // ✅ Validate required fields
    if (!access_token || !organization_id) {
      return res.status(400).json({
        success: false,
        data: null,
        message: "Missing required Zoho Books settings: access_token or organization_id",
      });
    }

    let finalToken = access_token;

    // ✅ Token Refresh Logic
    if (refresh_token && client_id && client_secret) {
      try {
        const refreshRes = await axios.post(
          `https://accounts.zoho.${region}/oauth/v2/token`,
          new URLSearchParams({
            refresh_token: refresh_token,
            client_id: client_id,
            client_secret: client_secret,
            grant_type: "refresh_token",
          }),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          }
        );

        if (refreshRes?.data?.access_token) {
          finalToken = refreshRes.data.access_token;
          console.log("✅ Zoho token refreshed successfully");
        }
      } catch (refreshError) {
        console.warn("⚠️ Zoho token refresh failed, using existing token:", refreshError.message);
      }
    }

    // ✅ CORRECT API BASE URL
    const baseURL = `https://www.zohoapis.${region}/books/v3`;
    
    console.log(`Using API URL: ${baseURL}`);

    // ✅ API Instance
    const api = axios.create({
      baseURL: baseURL,
      headers: { 
        Authorization: `Zoho-oauthtoken ${finalToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000,
    });

    // ✅ Get entity map from util helper
    const entityMap = getZohoBooksEntityMap();
    
    // ✅ Create modules list using the entity map for consistency
    const modules = Object.entries(entityMap).map(([table, endpoint]) => ({
      endpoint,
      key: endpoint,
      table: table,
      entity: getZohoBooksEntityDetails(table) // ✅ Add entity details from util
    }));

    console.log(`📋 Processing ${modules.length} Zoho Books entities`);

    const streams = [];
    const failedModules = [];

    // ✅ Process only modules that return successful API responses
    for (const mod of modules) {
      try {
        console.log(`Fetching schema for Zoho Books module: ${mod.table}`);
        
        // ✅ Simple request without problematic filters
        const params = { 
          organization_id
        };

        // Only add per_page for endpoints that support it
        if (!mod.endpoint.includes('chartofaccounts') && !mod.endpoint.includes('bankaccounts')) {
          params.per_page = 1;
        }

        const res = await api.get(mod.endpoint, { params });

        const responseData = res.data;
        
        // ✅ Use helper function to find the correct entity key in response
        const entityKey = findEntityKeyInResponse(responseData, mod.endpoint);
        const sample = entityKey ? responseData[entityKey]?.[0] : null;

        // ✅ Only create schema if we have actual sample data
        if (sample) {
          // ✅ Extract schema from sample data
          const properties = extractFields(sample);
          
          // ✅ FIXED: Get single primary key with data
          const primaryKey = detectSinglePrimaryKey(sample, mod.table);

          // ✅ Get cursor field from util helper for Airbyte compatibility
          const cursorField = getCursorFieldForTable(mod.table);
          const supportsIncremental = cursorField && cursorField !== 'updated_at';
          
          // ✅ Get entity details from util helper
          const entityDetails = getZohoBooksEntityDetails(mod.table);

          streams.push({
            stream: {
              name: mod.table,
              jsonSchema: { properties },
              primaryKeys: primaryKey ? [primaryKey] : ["id"], // Single primary key only
              supportsDateRange: supportsIncremental,
              sourceDefinedCursor: supportsIncremental,
              defaultCursorField: supportsIncremental ? [cursorField] : [],
              // ✅ ADD ENTITY INFORMATION FROM UTIL HELPER
              entity: {
                apiName: entityDetails.apiName,
                displayName: entityDetails.displayName,
                category: entityDetails.category,
                tableName: mod.table,
                supportsIncremental: supportsIncremental,
                cursorField: supportsIncremental ? cursorField : null
              }
            },
            config: {
              selected: false,
              syncMode: supportsIncremental ? "incremental" : "full_refresh",
              destinationSyncMode: "overwrite",
              cursorField: supportsIncremental ? [cursorField] : [], // ✅ Use cursorField from util
              // ✅ ADD ENTITY CONFIG FOR UI DISPLAY
              entityConfig: {
                category: entityDetails.category,
                displayName: entityDetails.displayName,
                description: `${entityDetails.displayName} from Zoho Books`
              }
            },
          });

          console.log(`✅ Successfully processed: ${mod.table} - Primary Key: ${primaryKey || 'id'} - Cursor Field: ${cursorField}`);
        } else {
          console.log(`⏭️ No sample data found for ${mod.table}, skipping`);
          failedModules.push({
            module: mod.table,
            error: "No sample data available",
            status: "SKIPPED"
          });
        }

      } catch (error) {
        console.error(`❌ Failed to process ${mod.table}:`, error.response?.data || error.message);
        failedModules.push({
          module: mod.table,
          error: error.response?.data || error.message,
          status: error.response?.status || "REQUEST_FAILED"
        });
      }
    }

    // ✅ Only return successful streams
    schemaResult = {
      catalog: { streams },
      summary: {
        totalModules: modules.length,
        successfulModules: streams.length,
        failedModules: failedModules.length,
        failedModulesDetails: failedModules,
      },
      connectionInfo: {
        organization_id,
        region,
        api_url: baseURL,
        // ✅ ADD ENTITY MAP INFO
        entityMapping: {
          totalEntities: Object.keys(entityMap).length,
          categories: [...new Set(streams.map(s => s.stream.entity?.category))].filter(Boolean)
        }
      },
    };

    // ✅ Cache the schema result
    await Source.update(
      { cached_schema_json: schemaResult },
      { where: { id: sourceId } }
    );

    break;

  } catch (error) {
    console.error("Zoho Books schema discovery failed:", error);
    throw new Error(`Zoho Books schema discovery failed: ${error.message}`);
  }
}
        default:
          schemaResult = {
            message: `Schema discovery for connector ${sourceRecord.connector_name} not implemented yet`,
          };
      }

      return res.status(200).json({
        success: true,
        data: { discoverSchema: schemaResult },
        message: "Discover schema fetched successfully",
      });
    } catch (error) {
      console.error("error:", error);
      return res.status(500).json({
        success: false,
        data: null,
        message: error.message || "Something went wrong",
      });
    }
  };




// ✅ FIXED: Detect single primary key with non-null data
function detectSinglePrimaryKey(sample, tableName) {
  const keyPriority = [
    // Highest priority - direct ID fields
    'id',
    tableName.toLowerCase() + '_id',
    tableName.slice(0, -1).toLowerCase() + '_id', // For plural tables (e.g., invoices -> invoice_id)
    
    // Common Zoho ID patterns
    'contact_id',
    'customer_id', 
    'vendor_id',
    'invoice_id',
    'bill_id',
    'item_id',
    'account_id',
    'project_id',
    'user_id',
    'organization_id',
    
    // Other ID patterns
    'zcrm_contact_id',
    'zcrm_account_id',
    'contact_name', // Sometimes used as identifier
    'customer_name',
    'vendor_name'
  ];

  // Find the first priority key that exists and has non-null data
  for (const keyPattern of keyPriority) {
    for (const actualKey of Object.keys(sample)) {
      if (actualKey.toLowerCase() === keyPattern.toLowerCase() && 
          sample[actualKey] !== null && 
          sample[actualKey] !== undefined &&
          sample[actualKey] !== '') {
        return actualKey; // Return the actual key name (preserving case)
      }
    }
  }

  // Fallback: find any key ending with _id that has data
  for (const key of Object.keys(sample)) {
    if (key.toLowerCase().endsWith('_id') && 
        sample[key] !== null && 
        sample[key] !== undefined &&
        sample[key] !== '') {
      return key;
    }
  }

  // Final fallback: return null and use default "id"
  return null;
}

// ✅ Extract fields from actual sample data
function extractFields(obj, prefix = "") {
  const fields = {};
  
  for (const [key, value] of Object.entries(obj || {})) {
    const fieldName = prefix ? `${prefix}.${key}` : key;
    
    if (value === null || value === undefined) {
      fields[fieldName] = { type: "string" }; // Default for nulls
      continue;
    }
    
    let type = typeof value;
    
    if (type === "number") {
      fields[fieldName] = { 
        type: "number",
        ...(Number.isInteger(value) ? { format: "integer" } : { format: "float" })
      };
    } else if (type === "boolean") {
      fields[fieldName] = { type: "boolean" };
    } else if (Array.isArray(value)) {
      fields[fieldName] = { type: "array" };
    } else if (type === "object") {
      fields[fieldName] = { type: "object" };
      // Recursively process nested objects
      Object.assign(fields, extractFields(value, fieldName));
    } else {
      // Check for date-like strings
      if (typeof value === "string" && isDateField(key)) {
        fields[fieldName] = { type: "string", format: "date-time" };
      } else {
        fields[fieldName] = { type: "string" };
      }
    }
  }
  
  return fields;
}

// ✅ Detect cursor field from actual data
function detectCursorField(sample) {
  const dateFields = [
    'last_modified_time',
    'created_time',
    'updated_time',
    'date',
    'created_at',
    'updated_at',
    'modified_time',
    'last_modified',
    'created'
  ];
  
  for (const field of dateFields) {
    if (sample.hasOwnProperty(field) && sample[field] !== null && sample[field] !== undefined) {
      return [field];
    }
  }
  
  return [];
}

// ✅ Date field detection
function isDateField(fieldName) {
  const dateIndicators = ['date', 'time', 'created', 'modified', 'updated', '_at'];
  return dateIndicators.some(indicator => 
    fieldName.toLowerCase().includes(indicator)
  );
}

/* ====================================================================== */
/*                          SHOPIFY HELPER FUNCTIONS                      */
/* ====================================================================== */

/**
 * Shopify Entity List - Comprehensive list of all Shopify entities
 */
const getAllShopifyEntitiesForSchemaDiscovery = () => {
  return [
    // Products & Inventory
    "products",
    "product_listings",
    "product_variants",
    "product_images",
    "inventory_items",
    "inventory_levels",
    "collects",
    "custom_collections",
    "smart_collections",
    "collection_listings",

    // Orders & Fulfillment
    "orders",
    "order_risks",
    "draft_orders",
    "abandoned_checkouts",
    "fulfillments",
    "fulfillment_orders",
    "fulfillment_events",
    "refunds",
    "transactions",
    "payment_transactions",

    // Customers
    "customers",
    "customer_addresses",
    "customer_saved_searches",
    "customer_invites",

    // Store Operations
    "shop",
    "locations",
    "countries",
    "provinces",
    "currencies",
    "policies",
    "shipping_zones",
    "carrier_services",

    // Marketing & Sales
    "price_rules",
    "discount_codes",
    "marketing_events",
    "metafields",
    "articles",
    "blogs",
    "comments",

    // Analytics & Reports
    "reports",
    "analytics_report",
    "visits",
    "checkouts",
    "sales",
    "sessions",

    // Apps & Themes
    "themes",
    "assets",
    "script_tags",
    "app_subscriptions",
    "app_usage_records",

    // Shipping & Delivery
    "shipping_rates",
    "fulfillment_services",
    "delivery_profiles",
    "delivery_customizations",

    // Additional Entities
    "pages",
    "redirects",
    "webhooks",
    "gift_cards",
    "users",
    "tender_transactions",
    "balance_transactions",
  ];
};

/**
 * Get prioritized Shopify entities for quick discovery
 */
const getPrioritizedShopifyEntities = () => {
  return [
    "products",
    "orders",
    "customers",
    "inventory_levels",
    "locations",
    "collections",
    "price_rules",
    "fulfillments",
    "transactions",
    "refunds",
    "metafields",
    "shop",
  ];
};

/**
 * Check if Shopify entity has data
 */
const checkShopifyEntityHasData = async (shop, accessToken, entity) => {
  try {
    const BASE_URL = `https://${shop}/admin/api/2024-01`;
    let url = `${BASE_URL}/${entity}.json?limit=1`;

    // Special handling for different entity types
    if (entity === "shop") {
      url = `${BASE_URL}/shop.json`;
    } else if (entity === "inventory_levels") {
      url = `${BASE_URL}/inventory_levels.json?limit=1`;
    }

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      return { hasData: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json();

    // Different response structures for different entities
    if (entity === "shop") {
      return { hasData: true, data: data.shop };
    } else if (Array.isArray(data[entity])) {
      return { hasData: data[entity].length > 0, data: data[entity] };
    } else if (data[entity] && Array.isArray(data[entity][entity])) {
      return {
        hasData: data[entity][entity].length > 0,
        data: data[entity][entity],
      };
    } else {
      return { hasData: false, data: null };
    }
  } catch (error) {
    return { hasData: false, error: error.message };
  }
};

/**
 * Extract fields from Shopify entity sample data
 */
const extractShopifyFields = (obj, prefix = "") => {
  const fields = {};

  const inferType = (value) => {
    if (value === null || value === undefined) return "unknown";
    if (Array.isArray(value)) return "array";
    const type = typeof value;
    return type === "object" ? "object" : type;
  };

  for (const [key, value] of Object.entries(obj || {})) {
    const fieldName = prefix ? `${prefix}.${key}` : key;
    const type = inferType(value);
    fields[fieldName] = { type };
    if (type === "object" && value !== null && !Array.isArray(value)) {
      Object.assign(fields, extractShopifyFields(value, fieldName));
    }
  }
  return fields;
};

/**
 * Get sync configuration for Shopify entity
 */
const getShopifySyncConfig = (entity) => {
  const incrementalEntities = [
    "orders",
    "customers",
    "products",
    "inventory_levels",
    "transactions",
    "fulfillments",
    "refunds",
    "draft_orders",
    "abandoned_checkouts",
  ];

  const supportsIncremental = incrementalEntities.includes(entity);

  return {
    selected: false,
    syncMode: supportsIncremental ? "incremental" : "full_refresh",
    destinationSyncMode: "overwrite",
    cursorField: supportsIncremental ? ["updated_at"] : [],
  };
};

/**
 * Get primary keys for Shopify entity
 */
const getShopifyPrimaryKeys = (entity) => {
  const primaryKeyMap = {
    products: ["id"],
    orders: ["id"],
    customers: ["id"],
    inventory_levels: ["inventory_item_id", "location_id"],
    locations: ["id"],
    collections: ["id"],
    price_rules: ["id"],
    fulfillments: ["id"],
    transactions: ["id"],
    refunds: ["id"],
    shop: ["id"],
    product_variants: ["id"],
    product_images: ["id"],
    inventory_items: ["id"],
    collects: ["id"],
    custom_collections: ["id"],
    smart_collections: ["id"],
    order_risks: ["id"],
    draft_orders: ["id"],
    abandoned_checkouts: ["id"],
    fulfillment_orders: ["id"],
    customer_addresses: ["id"],
    customer_saved_searches: ["id"],
    countries: ["id"],
    provinces: ["id"],
    price_rules: ["id"],
    discount_codes: ["id"],
    metafields: ["id"],
    articles: ["id"],
    blogs: ["id"],
    themes: ["id"],
    assets: ["key"],
    pages: ["id"],
    redirects: ["id"],
    webhooks: ["id"],
    gift_cards: ["id"],
    users: ["id"],
  };

  return primaryKeyMap[entity] || ["id"];
};

/**
 * Discover Shopify schema with data validation
 */


exports.getSourceList = async (req, res) => {
  try {
    console.log("getSourceList API running...");

    let companyId;
    try { companyId = tenantId(req); } catch (e) { return sendAuthError(res, e); }

    const allowedStatuses = ['pending', 'processing', 'completed', 'failed'];
    const rawStatus = typeof req.query.status === 'string' ? req.query.status : null;
    const status = rawStatus && allowedStatuses.includes(rawStatus) ? rawStatus : null;
    const search = req.query.search?.toLowerCase();

    // Parameterised — never interpolate user input into SQL.
    const replacements = { companyId };
    let statusClause = '';
    if (status) {
      replacements.status = status;
      statusClause = 'AND s.status = :status';
    }

    const query = `
      SELECT DISTINCT ON (s.id)
        s.id,
        s.source_name,
        s.connector_name,
        s.connector_settings_json,
        s.status,
        s.created_by,
        s.created_on,
        d.id as destination_id,
        d.destination_name
      FROM source s
      LEFT JOIN connections c ON s.id::varchar = c.source_id::varchar
      LEFT JOIN destination d ON c.destination_id::varchar = d.id::varchar
      WHERE s.company_id = :companyId
      ${statusClause}
      ORDER BY s.id, s.created_on DESC
    `;

    const [sourcesResponse] = await Source.sequelize.query(query, { replacements });

    // ✅ Apply search filter
    let filteredSources = sourcesResponse;
    if (search) {
      filteredSources = sourcesResponse.filter(
        (item) =>
          item?.source_name?.toLowerCase().includes(search) ||
          item?.destination_name?.toLowerCase().includes(search)
      );
    }

    const total = filteredSources.length;

    return res.status(200).json({
      success: true,
      data: {
        sources: filteredSources,
        totalSources: total,
      },
      message: "All sources fetched successfully from database",
    });
  } catch (error) {
    console.error("error", error?.message || error);
    return res.status(500).json({
      success: false,
      data: null,
      message: error?.message || "Something went wrong",
    });
  }
};

exports.getSourceDetails = async (req, res) => {
  try {
    const sourceId = req.params.sourceId;

    let where;
    try { where = withTenantScope(req, { id: sourceId }); }
    catch (e) { return sendAuthError(res, e); }

    const source = await Source.findOne({ where });

    if (!source) {
      return res.status(404).json({
        success: false,
        data: null,
        message: "Source not found",
      });
    }
    let fileUrl = null;
    if (source.connector_settings_json) {
      fileUrl = `${req.protocol}://${req.get(
        "host"
      )}/source_excel_files/${sourceId}/${
        source?.connector_settings_json?.originalName
      }`;
    }

    return res.status(200).json({
      success: true,
      data: { ...source.dataValues, fileUrl }, // directly return DB record
      message: "Source details fetched successfully",
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

// exports.checkForUpdate = async (req, res) => {
//   try {
//     const sourceId = req.params.sourceId;
// console.log(sourceId,"sourceId")
//     // 🔹 Fetch connector settings from DB
//     const source = await Source.findOne({
//       where: { id: sourceId },
//       attributes: ["id", "source_name", "connector_settings_json"],
//     });

//     if (!source) {
//       return res.status(404).json({
//         success: false,
//         message: "Source not found",
//       });
//     }

//     // 🔹 Parse connector settings
//     const settings = source.connector_settings_json;

//     // 🔹 Try connecting to DB
//     const client = new Client({
//       host: settings.host,
//       port: settings.port,
//       user: settings.username,
//       password: settings.password,
//       database: settings.database,
//     });

//     let dbTime = null;
//     try {
//       await client.connect();
//       const result = await client.query("SELECT NOW()");
//       dbTime = result.rows[0];
//     } catch (err) {
//       console.log("errr123", err);
//       return res.status(400).json({
//         success: false,
//         message: "Connection failed",
//         status: "failed",
//         error: err.message,
//       });
//     } finally {
//       await client.end().catch(() => {});
//     }

//     // 🔹 If successful
//     return res.status(200).json({
//       success: true,
//       message: "Connection successful",
//       status: "succeeded",
//       sourceId: source.id,
//       sourceName: source.source_name,
//       dbTime,
//     });
//   } catch (error) {
//     console.error("checkSourceConnection error:", error);
//     return res.status(500).json({
//       success: false,
//       message: "Internal Server Error",
//     });
//   }
// };


exports.checkForUpdate = async (req, res) => {
  try {
    const sourceId = req.params.sourceId;
    console.log(sourceId, "sourceId");

    let where;
    try { where = withTenantScope(req, { id: sourceId }); }
    catch (e) { return sendAuthError(res, e); }

    const source = await Source.findOne({
      where,
      attributes: ["id", "source_name", "connector_name", "connector_settings_json", "status"],
    });

    if (!source) {
      return res.status(404).json({
        success: false,
        message: "Source not found",
      });
    }

    const sourceType = source.connector_name?.toLowerCase();
    const settings = source.connector_settings_json;

    console.log(`🔄 Testing connection for source type: ${sourceType}`);

    // 🔹 Handle different source types
    switch (sourceType) {
      case "postgres":
        try {
          const { Client } = require('pg');
          const client = new Client({
            host: settings.host || 'localhost',
            port: settings.port || 5432,
            user: settings.username,
            password: settings.password,
            database: settings.database,
            connectionTimeoutMillis: 10000, // 10 second timeout
          });

          await client.connect();
          const result = await client.query("SELECT NOW() as current_time, version() as version");
          await client.end();

          return res.status(200).json({
            success: true,
            message: "PostgreSQL connection successful",
            status: "succeeded",
            sourceId: source.id,
            sourceName: source.source_name,
            data: {
              currentTime: result.rows[0].current_time,
              version: result.rows[0].version
            }
          });
        } catch (err) {
          console.error("PostgreSQL connection error:", err);
          return res.status(400).json({
            success: false,
            message: `PostgreSQL connection failed: ${err.message}`,
            status: "failed",
            error: err.message,
          });
        }

      case "zoho books":
        try {
          const region = settings.region?.toLowerCase() || 'in';
          const base_url = `https://accounts.zoho.${region}`;

          // Generate new access token to test connection
          const access_token = await generateZohoAccessToken({
            client_id: settings.client_id,
            client_secret: settings.client_secret,
            refresh_token: settings.refresh_token,
            base_url
          });

          // Test by fetching organizations
          const organizations = await getZohoOrganizations(access_token, region);

          return res.status(200).json({
            success: true,
            message: "Zoho Books connection successful",
            status: "succeeded",
            sourceId: source.id,
            sourceName: source.source_name,
            data: {
              organization: organizations.organization_name,
              organizationId: organizations.organization_id
            }
          });
        } catch (err) {
          console.error("Zoho Books connection error:", err);
          return res.status(400).json({
            success: false,
            message: `Zoho Books connection failed: ${err.message}`,
            status: "failed",
            error: err.message,
            requiresReauthorization: err.message.includes('invalid') || err.message.includes('expired')
          });
        }

      case "quickbooks":
        try {
          // Test QuickBooks connection
          const quickBooksResult = await testQuickBooksConnectionWithTimeout(settings, 30000);

          return res.status(200).json({
            success: true,
            message: "QuickBooks connection successful",
            status: "succeeded",
            sourceId: source.id,
            sourceName: source.source_name,
            data: {
              companyName: quickBooksResult.companyName,
              tokensRefreshed: quickBooksResult.tokensRefreshed
            }
          });
        } catch (err) {
          console.error("QuickBooks connection error:", err);
          return res.status(400).json({
            success: false,
            message: `QuickBooks connection failed: ${err.message}`,
            status: "failed",
            error: err.message,
            requiresReauthorization: err.message.includes('reauthorization') || err.message.includes('invalid')
          });
        }

      case "google drive":
        try {
          // Test Google Drive connection
          const testResult = await testGoogleDriveConnection(
            { body: { configuration: settings } },
            { json: (data) => data }
          );

          if (!testResult.success) {
            throw new Error(testResult.message);
          }

          return res.status(200).json({
            success: true,
            message: "Google Drive connection successful",
            status: "succeeded",
            sourceId: source.id,
            sourceName: source.source_name,
            data: {
              folder: testResult.data.folder,
              user: testResult.data.user
            }
          });
        } catch (err) {
          console.error("Google Drive connection error:", err);
          return res.status(400).json({
            success: false,
            message: `Google Drive connection failed: ${err.message}`,
            status: "failed",
            error: err.message,
            requiresReauthorization: err.message.includes('authentication') || err.message.includes('token')
          });
        }

      case "shopify":
        try {
          // Test Shopify connection
          const shopifyResult = await testShopifyConnectionWithTimeout(
            {
              shop: settings.shop,
              access_token: settings.credentials?.access_token || settings.access_token,
              client_id: settings.credentials?.client_id || settings.client_id,
              client_secret: settings.credentials?.client_secret || settings.client_secret,
              auth_method: settings.credentials?.auth_method || settings.auth_method || 'oauth'
            },
            30000
          );

          return res.status(200).json({
            success: true,
            message: "Shopify connection successful",
            status: "succeeded",
            sourceId: source.id,
            sourceName: source.source_name,
            data: {
              shop: shopifyResult.shop
            }
          });
        } catch (err) {
          console.error("Shopify connection error:", err);
          return res.status(400).json({
            success: false,
            message: `Shopify connection failed: ${err.message}`,
            status: "failed",
            error: err.message,
            requiresReauthorization: err.message.includes('authentication') || err.message.includes('token')
          });
        }

      case "excel":
        // For Excel files, check if file exists
        try {
          const fs = require('fs').promises;
          if (settings.path && await fs.access(settings.path).then(() => true).catch(() => false)) {
            return res.status(200).json({
              success: true,
              message: "Excel file connection successful",
              status: "succeeded",
              sourceId: source.id,
              sourceName: source.source_name,
              data: {
                fileName: settings.originalName,
                fileSize: settings.size
              }
            });
          } else {
            throw new Error("Excel file not found or inaccessible");
          }
        } catch (err) {
          console.error("Excel file connection error:", err);
          return res.status(400).json({
            success: false,
            message: `Excel file connection failed: ${err.message}`,
            status: "failed",
            error: err.message
          });
        }

      default:
        return res.status(400).json({
          success: false,
          message: `Unsupported source type: ${sourceType}`,
          status: "failed"
        });
    }

  } catch (error) {
    console.error("checkSourceConnection error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
      status: "failed",
      error: error.message
    });
  }
};

// exports.updateSource = async (req, res) => {
//   try {
//     const { sourceId } = req.params;
//     console.log("sadsadas", req.body);
//     const { name, sourceType, configuration, connectionConfiguration } =
//       req.body;

//     // 🔹 Check if source exists
//     const existingSource = await Source.findByPk(sourceId);
//     if (!existingSource) {
//       return res.status(404).json({
//         success: false,
//         message: "Source not found",
//       });
//     }

//     // 🔹 Ensure unique source name (if name is changing)
//     if (name && name !== existingSource.source_name) {
//       const duplicate = await Source.findOne({ where: { source_name: name } });
//       if (duplicate) {
//         return res.status(400).json({
//           success: false,
//           message: "Source name must be unique",
//         });
//       }
//     }

//     // 🔹 Handle connector settings
//     let connectorSettings;
//     if (sourceType === "excel") {
//       if (req.file) {
//         try {
//           // ✅ Delete old file if exists
//           if (existingSource.connector_settings_json?.path) {
//             FileService.deleteFile(existingSource.connector_settings_json.path);
//           }
//           const savedFile = FileService.saveExcelFile(
//             sourceId,
//             name || existingSource.source_name,
//             req.file.originalname,
//             req.file.buffer,
//             "source_excel_files"
//           );

//           connectorSettings = {
//             originalName: req.file.originalname,
//             mimeType: req.file.mimetype,
//             size: req.file.size,
//             path: savedFile.filePath,
//             filePath: savedFile.filePath,
//             savedFileName: savedFile.filename,
//             sourceId: sourceId,
//             url: savedFile.publicUrl,
//             sourceType: sourceType,
//             folderName: "source_excel_files",
//           };
//         } catch (fileError) {
//           return res.status(500).json({
//             success: false,
//             message: `Failed to save file: ${fileError.message}`,
//           });
//         }
//       } else {
//         connectorSettings = existingSource.connector_settings_json;
//       }
//     } else {
//       connectorSettings =
//         connectionConfiguration || existingSource.connector_settings_json;
//     }

//     // 🔹 Update DB
//     await Source.update(
//       {
//         source_name: name || existingSource.source_name,
//         connector_name: sourceType
//           ? sourceType
//           : req?.body?.connectionConfiguration?.sourceType ||
//             existingSource.connector_name,
//         connector_settings_json: connectorSettings,
//         status: "updated",
//         updated_on: new Date(),
//       },
//       { where: { id: sourceId } }
//     );

//     // 🔹 Get updated record
//     const updatedSource = await Source.findByPk(sourceId);

//     // 🔹 Invalidate + Rebuild cache
//     await invalidateSourceCache();
//     const freshSources = await Source.findAll();
//     await createCache("sourceListDB", freshSources);

//     return res.status(200).json({
//       success: true,
//       data: updatedSource,
//       message: "Source updated successfully and cache refreshed",
//     });
//   } catch (error) {
//     console.error("updateSource error:", error);
//     return res.status(error?.response?.status || 500).json({
//       success: false,
//       data: null,
//       message: error?.response?.data?.message || "Something went wrong",
//     });
//   }
// };

// exports.updateSource = async (req, res) => {
//   try {
//     const { sourceId } = req.params;
//     console.log("Update source request:", req.body);
//     const { name, sourceType, configuration, connectionConfiguration } =
//       req.body;

//     // 🔹 Check if source exists
//     const existingSource = await Source.findByPk(sourceId);
//     if (!existingSource) {
//       return res.status(404).json({
//         success: false,
//         message: "Source not found",
//       });
//     }

//     // 🔹 Ensure unique source name (if name is changing)
//     if (name && name !== existingSource.source_name) {
//       const duplicate = await Source.findOne({ where: { source_name: name } });
//       if (duplicate) {
//         return res.status(400).json({
//           success: false,
//           message: "Source name must be unique",
//         });
//       }
//     }

//     // 🔹 Handle connector settings based on source type
//     let connectorSettings;
//     const currentSourceType = sourceType || existingSource.connector_name;

//     switch (currentSourceType.toLowerCase()) {
//       case "excel":
//         if (req.file) {
//           try {
//             // ✅ Delete old file if exists
//             if (existingSource.connector_settings_json?.path) {
//               FileService.deleteFile(
//                 existingSource.connector_settings_json.path
//               );
//             }
//             const savedFile = FileService.saveExcelFile(
//               sourceId,
//               name || existingSource.source_name,
//               req.file.originalname,
//               req.file.buffer,
//               "source_excel_files"
//             );

//             connectorSettings = {
//               originalName: req.file.originalname,
//               mimeType: req.file.mimetype,
//               size: req.file.size,
//               path: savedFile.filePath,
//               filePath: savedFile.filePath,
//               savedFileName: savedFile.filename,
//               sourceId: sourceId,
//               url: savedFile.publicUrl,
//               sourceType: currentSourceType,
//               folderName: "source_excel_files",
//             };
//           } catch (fileError) {
//             return res.status(500).json({
//               success: false,
//               message: `Failed to save file: ${fileError.message}`,
//             });
//           }
//         } else {
//           // Keep existing settings if no new file
//           connectorSettings = existingSource.connector_settings_json;
//         }
//         break;

//       case "quickbooks":
//         const quickbooksConfig = configuration || connectionConfiguration;

//         if (!quickbooksConfig) {
//           return res.status(400).json({
//             success: false,
//             message: "Configuration is required for QuickBooks source type",
//           });
//         }

//         // Validate required fields for QuickBooks
//         const requiredQuickBooksFields = [
//           "client_id",
//           "client_secret",
//           "realm_id",
//           "access_token",
//           "refresh_token",
//         ];

//         const missingFields = requiredQuickBooksFields.filter(
//           (field) => !quickbooksConfig[field]
//         );

//         if (missingFields.length > 0) {
//           return res.status(400).json({
//             success: false,
//             message: `Missing required QuickBooks configuration fields: ${missingFields.join(
//               ", "
//             )}`,
//           });
//         }

//         try {
//           console.log("🔄 Testing QuickBooks connection during update...");
//           // ✅ Use the same better approach
//           const finalConfiguration = {
//             ...quickbooksConfig,
//             refresh_token: quickbooksConfig.refresh_token, // Explicit preservation
//           };
//           // Test QuickBooks connection with automatic token refresh
//           const quickBooksResult = await testQuickBooksConnectionWithTimeout(
//             quickbooksConfig,
//             300000
//           );

//           // Use refreshed tokens if available
//           if (quickBooksResult.tokensRefreshed) {
//             finalConfiguration.access_token = quickBooksResult.newAccessToken;
//             finalConfiguration.refresh_token = quickBooksResult.newRefreshToken;
//             console.log("✅ Using refreshed tokens for QuickBooks update");
//           }
//           console.log(
//             "✅ Using refreshed tokens for QuickBooks update",
//             quickBooksResult
//           );

//           console.log(
//             "quickbooksConfig.refresh_token",
//             quickbooksConfig.refresh_token
//           );
//           console.log(
//             "quickBooksResult.tokensRefreshed",
//             quickBooksResult.tokensRefreshed
//           );
//           connectorSettings = {
//             ...finalConfiguration,
//             sourceType: "quickbooks",
//             connectedOn: new Date().toISOString(),
//             environment: finalConfiguration.sandbox ? "sandbox" : "production",
//             lastValidated: new Date().toISOString(),
//             companyName:
//               quickBooksResult.companyName ||
//               existingSource.connector_settings_json?.companyName,
//           };
//           console.log("connectorSettings", connectorSettings);
//         } catch (qbError) {
//           console.error(
//             "❌ QuickBooks validation error during update:",
//             qbError
//           );

//           let userMessage = qbError.message;
//           let requiresReauth = false;

//           // Check if this is an authentication error that requires reauthorization
//           if (
//             qbError.message.includes("reauthorization required") ||
//             qbError.message.includes("Refresh token is invalid") ||
//             qbError.message.includes("Authentication failed")
//           ) {
//             requiresReauth = true;
//             userMessage =
//               "QuickBooks authentication failed. Please reauthorize the connection.";
//           }

//           return res.status(400).json({
//             success: false,
//             message: `QuickBooks connection failed: ${userMessage}`,
//             requiresReauthorization: requiresReauth,
//             detailedError:
//               process.env.NODE_ENV === "development"
//                 ? qbError.message
//                 : undefined,
//           });
//         }
//         break;

//       case "postgres":
//         const postgresConfig = configuration || connectionConfiguration;

//         if (!postgresConfig) {
//           return res.status(400).json({
//             success: false,
//             message: "Configuration is required for PostgreSQL source type",
//           });
//         }

//         connectorSettings = {
//           ...postgresConfig,
//           sourceType: "postgres",
//           connectedOn: new Date().toISOString(),
//           lastValidated: new Date().toISOString(),
//         };
//         break;

//       default:
//         // For other source types, use provided configuration or keep existing
//         connectorSettings =
//           configuration ||
//           connectionConfiguration ||
//           existingSource.connector_settings_json;
//     }

//     // 🔹 Update DB
//     const updateData = {
//       source_name: name || existingSource.source_name,
//       connector_name: sourceType || existingSource.connector_name,
//       connector_settings_json: connectorSettings,
//       status: "updated",
//       updated_on: new Date(),
//     };

//     await Source.update(updateData, { where: { id: sourceId } });

//     // 🔹 Get updated record
//     const updatedSource = await Source.findByPk(sourceId);

//     // 🔹 Invalidate + Rebuild cache
//     await invalidateSourceCache();
//     const freshSources = await Source.findAll();
//     await createCache("sourceListDB", freshSources);

//     return res.status(200).json({
//       success: true,
//       data: updatedSource,
//       message: getUpdateSuccessMessage(currentSourceType),
//     });
//   } catch (error) {
//     console.error("updateSource error:", error);
//     return res.status(error?.response?.status || 500).json({
//       success: false,
//       data: null,
//       message: error?.response?.data?.message || "Something went wrong",
//     });
//   }
// };

exports.updateSource = async (req, res) => {
  try {
    const { sourceId } = req.params;
    console.log("Update source request:", req.body);
    const { name, sourceType, configuration, connectionConfiguration } =
      req.body;

    let scopedWhere;
    try { scopedWhere = withTenantScope(req, { id: sourceId }); }
    catch (e) { return sendAuthError(res, e); }

    const existingSource = await Source.findOne({ where: scopedWhere });
    if (!existingSource) {
      return res.status(404).json({
        success: false,
        message: "Source not found",
      });
    }

    // Ensure unique source name within the same tenant.
    if (name && name !== existingSource.source_name) {
      const duplicate = await Source.findOne({
        where: withTenantScope(req, { source_name: name }),
      });
      if (duplicate) {
        return res.status(400).json({
          success: false,
          message: "Source name must be unique",
        });
      }
    }

    // 🔹 Handle connector settings based on source type
    let connectorSettings;
    const currentSourceType = sourceType || existingSource.connector_name;

    switch (currentSourceType.toLowerCase()) {
      case "excel":
        if (req.file) {
          try {
            // ✅ Delete old file if exists
            if (existingSource.connector_settings_json?.path) {
              FileService.deleteFile(
                existingSource.connector_settings_json.path
              );
            }
            const savedFile = FileService.saveExcelFile(
              sourceId,
              name || existingSource.source_name,
              req.file.originalname,
              req.file.buffer,
              "source_excel_files"
            );

            connectorSettings = {
              originalName: req.file.originalname,
              mimeType: req.file.mimetype,
              size: req.file.size,
              path: savedFile.filePath,
              filePath: savedFile.filePath,
              savedFileName: savedFile.filename,
              sourceId: sourceId,
              url: savedFile.publicUrl,
              sourceType: currentSourceType,
              folderName: "source_excel_files",
            };
          } catch (fileError) {
            return res.status(500).json({
              success: false,
              message: `Failed to save file: ${fileError.message}`,
            });
          }
        } else {
          // Keep existing settings if no new file
          connectorSettings = existingSource.connector_settings_json;
        }
        break;

      case "quickbooks":
        const quickbooksConfig = configuration || connectionConfiguration;

        if (!quickbooksConfig) {
          return res.status(400).json({
            success: false,
            message: "Configuration is required for QuickBooks source type",
          });
        }

        // Validate required fields for QuickBooks
        const requiredQuickBooksFields = [
          "client_id",
          "client_secret",
          "realm_id",
          "access_token",
          "refresh_token",
        ];

        const missingFields = requiredQuickBooksFields.filter(
          (field) => !quickbooksConfig[field]
        );

        if (missingFields.length > 0) {
          return res.status(400).json({
            success: false,
            message: `Missing required QuickBooks configuration fields: ${missingFields.join(
              ", "
            )}`,
          });
        }

        try {
          console.log("🔄 Testing QuickBooks connection during update...");
          // ✅ Use the same better approach
          const finalConfiguration = {
            ...quickbooksConfig,
            refresh_token: quickbooksConfig.refresh_token, // Explicit preservation
          };
          // Test QuickBooks connection with automatic token refresh
          const quickBooksResult = await testQuickBooksConnectionWithTimeout(
            quickbooksConfig,
            300000
          );

          // Use refreshed tokens if available
          if (quickBooksResult.tokensRefreshed) {
            finalConfiguration.access_token = quickBooksResult.newAccessToken;
            finalConfiguration.refresh_token = quickBooksResult.newRefreshToken;
            console.log("✅ Using refreshed tokens for QuickBooks update");
          }
          console.log(
            "✅ Using refreshed tokens for QuickBooks update",
            quickBooksResult
          );

          console.log(
            "quickbooksConfig.refresh_token",
            quickbooksConfig.refresh_token
          );
          console.log(
            "quickBooksResult.tokensRefreshed",
            quickBooksResult.tokensRefreshed
          );
          connectorSettings = {
            ...finalConfiguration,
            sourceType: "quickbooks",
            connectedOn: new Date().toISOString(),
            environment: finalConfiguration.sandbox ? "sandbox" : "production",
            lastValidated: new Date().toISOString(),
            companyName:
              quickBooksResult.companyName ||
              existingSource.connector_settings_json?.companyName,
          };
          console.log("connectorSettings", connectorSettings);
        } catch (qbError) {
          console.error(
            "❌ QuickBooks validation error during update:",
            qbError
          );

          let userMessage = qbError.message;
          let requiresReauth = false;

          // Check if this is an authentication error that requires reauthorization
          if (
            qbError.message.includes("reauthorization required") ||
            qbError.message.includes("Refresh token is invalid") ||
            qbError.message.includes("Authentication failed")
          ) {
            requiresReauth = true;
            userMessage =
              "QuickBooks authentication failed. Please reauthorize the connection.";
          }

          return res.status(400).json({
            success: false,
            message: `QuickBooks connection failed: ${userMessage}`,
            requiresReauthorization: requiresReauth,
            detailedError:
              process.env.NODE_ENV === "development"
                ? qbError.message
                : undefined,
          });
        }
        break;

      case "postgres":
        const postgresConfig = configuration || connectionConfiguration;

        if (!postgresConfig) {
          return res.status(400).json({
            success: false,
            message: "Configuration is required for PostgreSQL source type",
          });
        }

        connectorSettings = {
          ...postgresConfig,
          sourceType: "postgres",
          connectedOn: new Date().toISOString(),
          lastValidated: new Date().toISOString(),
        };
        break;

      case "zoho books":
        const zohoConfig = configuration || connectionConfiguration;

        if (!zohoConfig) {
          return res.status(400).json({
            success: false,
            message: "Configuration is required for Zoho Books source type",
          });
        }

        // Validate required fields for Zoho Books
        const requiredZohoFields = ["client_id", "client_secret", "refresh_token", "region"];
        const missingZohoFields = requiredZohoFields.filter(
          (field) => !zohoConfig[field]
        );

        if (missingZohoFields.length > 0) {
          return res.status(400).json({
            success: false,
            message: `Missing required Zoho Books configuration fields: ${missingZohoFields.join(", ")}`,
          });
        }

        try {
          console.log("🔄 Testing Zoho Books connection during update...");
          
          const region = zohoConfig.region.toLowerCase();
          const base_url = `https://accounts.zoho.${region}`;

          // Generate new access token
          console.log("🔄 Generating Zoho access token for update...");
          const access_token = await generateZohoAccessToken({
            client_id: zohoConfig.client_id,
            client_secret: zohoConfig.client_secret,
            refresh_token: zohoConfig.refresh_token,
            base_url
          });

          // Get organization information
          console.log("🔍 Fetching Zoho Books organizations for update...");
          const { organization_id, organization_name } = await getZohoOrganizations(access_token, region);

          // Build connector settings - preserve existing data where appropriate
          connectorSettings = {
            // Start with existing settings to preserve any additional fields
            ...existingSource.connector_settings_json,
            // Update with new configuration
            ...zohoConfig,
            // Ensure these critical fields are set
            access_token,
            organization_id,
            organization_name,
            base_url,
            books_api_url: `https://books.zoho.${region}`,
            sourceType: "zoho books",
            connectedOn: existingSource.connector_settings_json?.connectedOn || new Date().toISOString(),
            lastValidated: new Date().toISOString(),
          };

          console.log("✅ Zoho Books source updated successfully");
        } catch (zohoError) {
          console.error("❌ Zoho Books validation error during update:", zohoError);

          let userMessage = zohoError.message;
          let requiresReauth = false;

          // Check if this is an authentication error that requires reauthorization
          if (
            zohoError.message.includes("invalid") ||
            zohoError.message.includes("expired") ||
            zohoError.message.includes("authentication") ||
            zohoError.message.includes("token")
          ) {
            requiresReauth = true;
            userMessage = "Zoho Books authentication failed. Please check your credentials and reauthorize the connection.";
          }

          return res.status(400).json({
            success: false,
            message: `Zoho Books connection failed: ${userMessage}`,
            requiresReauthorization: requiresReauth,
            detailedError: process.env.NODE_ENV === "development" ? zohoError.message : undefined,
          });
        }
        break;

      case "google drive":
        const googleConfig = configuration || connectionConfiguration;

        if (!googleConfig) {
          return res.status(400).json({
            success: false,
            message: "Configuration is required for Google Drive source type",
          });
        }

        // Validate required fields for Google Drive
        const requiredGoogleDriveFields = [
          "client_id",
          "client_secret",
          "refresh_token",
          "access_token",
          "folder_id",
        ];

        const missingGoogleDriveFields = requiredGoogleDriveFields.filter(
          (field) => !googleConfig[field]
        );

        if (missingGoogleDriveFields.length > 0) {
          return res.status(400).json({
            success: false,
            message: `Missing required Google Drive configuration fields: ${missingGoogleDriveFields.join(", ")}`,
          });
        }

        try {
          console.log("🔄 Testing Google Drive connection during update...");

          const testResult = await testGoogleDriveConnection(
            { body: { configuration: googleConfig } },
            {
              json: (data) => data,
            }
          );

          if (!testResult.success) {
            return res.status(400).json({
              success: false,
              message: `Google Drive connection failed: ${testResult.message}`,
              requiresReauthorization: testResult.requiresReauthorization,
            });
          }

          connectorSettings = {
            ...existingSource.connector_settings_json,
            ...googleConfig,
            sourceType: "google drive",
            connectedOn: existingSource.connector_settings_json?.connectedOn || new Date().toISOString(),
            driveType: googleConfig.drive_type || "my_drive",
            lastValidated: new Date().toISOString(),
            folderInfo: testResult.data.folder,
            userInfo: testResult.data.user,
          };

          console.log("✅ Google Drive source updated successfully");
        } catch (gdError) {
          console.error("❌ Google Drive validation error during update:", gdError);

          return res.status(400).json({
            success: false,
            message: `Google Drive connection failed: ${gdError.message}`,
            requiresReauthorization:
              gdError.message.includes("authentication") ||
              gdError.message.includes("token"),
          });
        }
        break;

      case "shopify":
        const shopifyConfig = configuration || connectionConfiguration;

        if (!shopifyConfig) {
          return res.status(400).json({
            success: false,
            message: "Configuration is required for Shopify source type",
          });
        }

        // Validate required fields for Shopify
        const requiredShopifyFields = ["shop"];
        const authMethod = shopifyConfig.credentials?.auth_method || "oauth";
        
        if (authMethod === "oauth") {
          requiredShopifyFields.push("client_id", "client_secret", "access_token");
        } else if (authMethod === "api_password") {
          requiredShopifyFields.push("api_password");
        }

        const missingShopifyFields = requiredShopifyFields.filter((field) => {
          if (field === "client_id" || field === "client_secret" || field === "access_token" || field === "api_password") {
            return !shopifyConfig.credentials?.[field];
          }
          return !shopifyConfig[field];
        });

        if (missingShopifyFields.length > 0) {
          return res.status(400).json({
            success: false,
            message: `Missing required Shopify configuration fields: ${missingShopifyFields.join(", ")}`,
          });
        }

        try {
          console.log("🔄 Testing Shopify connection during update...");

          const shopifyResult = await testShopifyConnectionWithTimeout(
            {
              shop: shopifyConfig.shop,
              access_token: shopifyConfig.credentials.access_token,
              client_id: shopifyConfig.credentials.client_id,
              client_secret: shopifyConfig.credentials.client_secret,
              auth_method: shopifyConfig.credentials.auth_method,
            },
            30000
          );

          connectorSettings = {
            ...existingSource.connector_settings_json,
            ...shopifyConfig,
            sourceType: "shopify",
            connectedOn: existingSource.connector_settings_json?.connectedOn || new Date().toISOString(),
            lastValidated: new Date().toISOString(),
            shopInfo: shopifyResult.shop,
          };

          console.log("✅ Shopify source updated successfully");
        } catch (shopifyError) {
          console.error("❌ Shopify validation error during update:", shopifyError);

          return res.status(400).json({
            success: false,
            message: `Shopify connection failed: ${shopifyError.message}`,
            requiresReauthorization:
              shopifyError.message.includes("authentication") ||
              shopifyError.message.includes("token"),
          });
        }
        break;

      default:
        // For other source types, use provided configuration or keep existing
        connectorSettings =
          configuration ||
          connectionConfiguration ||
          existingSource.connector_settings_json;
    }

    // 🔹 Update DB
    const updateData = {
      source_name: name || existingSource.source_name,
      connector_name: sourceType || existingSource.connector_name,
      connector_settings_json: connectorSettings,
      status: "completed", // Use "completed" instead of "updated" for consistency
      updated_on: new Date(),
    };

    await Source.update(updateData, { where: { id: sourceId } });

    // 🔹 Get updated record
    const updatedSource = await Source.findByPk(sourceId);

    // 🔹 Invalidate + Rebuild cache
    await invalidateSourceCache();
    const freshSources = await Source.findAll();
    await createCache("sourceListDB", freshSources);

    return res.status(200).json({
      success: true,
      data: updatedSource,
      message: getUpdateSuccessMessage(currentSourceType),
    });
  } catch (error) {
    console.error("updateSource error:", error);
    return res.status(error?.response?.status || 500).json({
      success: false,
      data: null,
      message: error?.response?.data?.message || "Something went wrong",
    });
  }
};

// Helper function for update success messages
function getUpdateSuccessMessage(sourceType) {
  const messages = {
    excel: "Source updated successfully and Excel file replaced",
    quickbooks:
      "Source updated successfully and QuickBooks connection refreshed",
    postgres: "Source updated successfully and PostgreSQL connection updated",
    mysql: "Source updated successfully and MySQL connection updated",
    sqlserver: "Source updated successfully and SQL Server connection updated",
  };

  return messages[sourceType.toLowerCase()] || "Source updated successfully";
}
/**
 * DELETE /api/source/delete-source/:sourceId?cascade=true
 * - If cascade=true: deletes all related connections, then deletes source
 * - Else: attempts to delete source directly (Airbyte will error if connections exist)
 */
// exports.deleteSource = async (req, res) => {
//   const sourceId = req.params.sourceId;
//   const cascade = String(req.query.cascade || "false").toLowerCase() === "true";

//   try {
//     if (cascade) {
//       const related = await listConnectionsByWorkspace(sourceId);
//       if (related.length) {
//         await promisePool(related, 5, async (c) => {
//           await airbyteCall(
//             Airbyte,
//             airbyteLimiter,
//             "post",
//             "/connections/delete",
//             { connectionId: c?.connectionId },
//             null,
//             "connections/delete"
//           );
//         });
//       }
//     }

//     // Delete the source
//     await airbyteCall(
//       Airbyte,
//       airbyteLimiter,
//       "post",
//       "/sources/delete",
//       { sourceId },
//       null,
//       "sources/delete"
//     );

//     await invalidateSourceCache();

//     return res.status(200).json({
//       success: true,
//       data: null,
//       message: cascade
//         ? "Source and related connections deleted."
//         : "Source deleted.",
//     });
//   } catch (error) {
//     const msg =
//       error?.response?.data?.message ||
//       error?.message ||
//       "Something went wrong";

//     if (!cascade && /connection/i.test(msg)) {
//       return res.status(409).json({
//         success: false,
//         data: null,
//         message:
//           "Source has active connections. Retry with ?cascade=true to delete related connections.",
//       });
//     }

//     console.error("deleteSource error:", error?.response?.data || error);
//     return res.status(error?.response?.status || 500).json({
//       success: false,
//       data: null,
//       message: msg,
//     });
//   }
// };

// If you're using Sequelize models directly:
// exports.deleteSource = async (req, res) => {
//   const sourceId = req.params.sourceId;

//   const transaction = await Connection.sequelize.transaction();

//   try {
//     // Check if source exists
//     const source = await Source.findByPk(sourceId, { transaction });
//     if (!source) {
//       await transaction.rollback();
//       return res.status(404).json({
//         success: false,
//         data: null,
//         message: "Source not found",
//       });
//     }

//     // Check for connections
//     const connections = await Connection.findAll({
//       where: { source_id: sourceId },
//       transaction
//     });

//     if (connections.length > 0) {
//       await transaction.rollback();
//       return res.status(409).json({
//         success: false,
//         data: null,
//         message: `Cannot delete source because there are ${connections.length} connection(s) using it. Please delete all connections first before deleting the source.`,
//         connections: connections.map(conn => ({
//           id: conn.connection_id,
//           name: conn.connection_name,
//           connectionId: conn.connection_id
//         }))
//       });
//     }

//     // Delete the source (only if no connections exist)
//     await source.destroy({ transaction });

//     // Commit transaction
//     await transaction.commit();

//     // Invalidate cache
//     await invalidateSourceCache();

//     return res.status(200).json({
//       success: true,
//       data: null,
//       message: "Source deleted successfully.",
//     });
//   } catch (error) {
//     await transaction.rollback();
//     console.error("deleteSource error:", error);
//     return res.status(500).json({
//       success: false,
//       data: null,
//       message: error.message || "Something went wrong while deleting the source",
//     });
//   }
// };

exports.deleteSource = async (req, res) => {
  const sourceId = req.params.sourceId;

  let scopedWhere;
  try { scopedWhere = withTenantScope(req, { id: sourceId }); }
  catch (e) { return sendAuthError(res, e); }

  const transaction = await Connection.sequelize.transaction();

  try {
    const source = await Source.findOne({ where: scopedWhere, transaction });
    if (!source) {
      await transaction.rollback();
      return res.status(404).json({
        success: false,
        data: null,
        message: "Source not found",
      });
    }

    // Check for connections
    const connections = await Connection.findAll({
      where: { source_id: sourceId },
      transaction,
    });

    if (connections.length > 0) {
      await transaction.rollback();
      return res.status(409).json({
        success: false,
        data: null,
        message: `Cannot delete source because there are ${connections.length} connection(s) using it. Please delete all connections first before deleting the source.`,
        connections: connections.map((conn) => ({
          id: conn.connection_id,
          name: conn.connection_name,
          connectionId: conn.connection_id,
        })),
      });
    }

    // Store source details before deletion for file cleanup
    const sourceType = source.connector_name;
    const connectorSettings = source.connector_settings_json;
    let filePath = null;

    // Extract file path from connector settings for Excel sources
    if (sourceType === "excel" && connectorSettings) {
      const settings =
        typeof connectorSettings === "string"
          ? JSON.parse(connectorSettings)
          : connectorSettings;

      filePath = settings.path || settings.filePath;
    }

    // Delete the source from database (only if no connections exist)
    await source.destroy({ transaction });

    // Commit transaction first
    await transaction.commit();

    // After successful database deletion, check if it's an Excel source and delete the file
    if (sourceType === "excel" && filePath) {
      try {
        // Use your existing FileService to delete the file
        if (FileService && FileService.deleteFile) {
          FileService.deleteFile(filePath);
          console.log(`Excel file deleted: ${filePath}`);
        }
      } catch (fileError) {
        // Log the file deletion error but don't fail the request
        console.error(`Failed to delete Excel file: ${filePath}`, fileError);
        // Continue with success response since source was deleted from DB
      }
    }

    // Invalidate cache
    await invalidateSourceCache();

    return res.status(200).json({
      success: true,
      data: null,
      message:
        "Source deleted successfully." +
        (sourceType === "excel" && filePath
          ? " Associated Excel file has been removed."
          : ""),
    });
  } catch (error) {
    await transaction.rollback();
    console.error("deleteSource error:", error);
    return res.status(500).json({
      success: false,
      data: null,
      message:
        error.message || "Something went wrong while deleting the source",
    });
  }
};

exports.getConnectionsBySource = async (req, res) => {
  try {
    const { sourceId } = req.params;
    const { page = 1, perPage = 1000 } = req.query;

    // Validate source exists
    const source = await Source.findByPk(sourceId);
    if (!source) {
      return res.status(404).json({
        success: false,
        data: null,
        message: "Source not found",
      });
    }

    const connections = await Connection.findAll({
      where: { sourceId },
      include: [
        {
          model: Source,
          as: "source",
          attributes: ["id", "sourceName", "sourceType"],
        },
        {
          model: Destination,
          as: "destination",
          attributes: ["id", "destinationName", "destinationType"],
        },
      ],
      limit: parseInt(perPage),
      offset: (parseInt(page) - 1) * parseInt(perPage),
      order: [["createdAt", "DESC"]],
    });

    // Format response to match your frontend expectations
    const formattedConnections = connections.map((conn) => ({
      ...conn.toJSON(),
      connectionId: conn.id, // Provide both id and connectionId for compatibility
      id: conn.id,
    }));

    return res.status(200).json({
      success: true,
      data: {
        items: formattedConnections,
        total: formattedConnections.length,
        page: parseInt(page),
        perPage: parseInt(perPage),
      },
      message: "Connections fetched successfully",
    });
  } catch (error) {
    console.error("getConnectionsBySource error:", error);
    return res.status(500).json({
      success: false,
      data: null,
      message: error?.message || "Something went wrong",
    });
  }
};

/* ====================================================================== */
/*                              CONNECTIONS                                */
/* ====================================================================== */

/**
 * GET /api/connection/get-connection-list?sourceId=&page=&perPage=&search=&status=
 * Lightweight list used by client fallback deletion.
 */
exports.getConnectionList = async (req, res) => {
  try {
    const { sourceId, page = 1, perPage = 1000, search, status } = req.query;

    // Tenant ownership: only list connections for sources owned by the caller.
    if (sourceId) {
      try {
        const owned = await Source.findOne({
          where: withTenantScope(req, { id: sourceId }),
          attributes: ['id'],
        });
        if (!owned) {
          return res.status(404).json({ success: false, data: null, message: 'Source not found' });
        }
      } catch (e) { return sendAuthError(res, e); }
    }

    const all = await listConnectionsByWorkspace(sourceId);

    let filtered = all;

    if (status) {
      filtered = filtered.filter((c) => c?.status === status);
    }

    if (search) {
      const s = String(search).toLowerCase();
      filtered = filtered.filter(
        (c) =>
          c?.name?.toLowerCase?.().includes(s) ||
          c?.namespaceDefinition?.toLowerCase?.().includes(s) ||
          c?.source?.name?.toLowerCase?.().includes(s) ||
          c?.destination?.name?.toLowerCase?.().includes(s)
      );
    }

    const start = (parseInt(page) - 1) * parseInt(perPage);
    const end = start + parseInt(perPage);
    const items = filtered.slice(start, end).map((c) => ({
      connectionId: c?.connectionId,
      name: c?.name,
      status: c?.status,
      scheduleType: c?.scheduleType,
      source: c?.source,
      destination: c?.destination,
      namespaceDefinition: c?.namespaceDefinition,
      prefix: c?.prefix,
      syncCatalog: c?.syncCatalog,
    }));

    return res.status(200).json({
      success: true,
      data: {
        items,
        total: filtered.length,
        page: Number(page),
        perPage: Number(perPage),
      },
      message: "Connections fetched successfully",
    });
  } catch (error) {
    console.error("getConnectionList error:", error?.response?.data || error);
    return res.status(error?.response?.status || 500).json({
      success: false,
      data: null,
      message: error?.response?.data?.message || "Something went wrong",
    });
  }
};

/**
 * DELETE /api/connection/delete-connection/:connectionId
 */
exports.deleteConnection = async (req, res) => {
  try {
    const { connectionId } = req.params;
    await airbyteCall(
      Airbyte,
      airbyteLimiter,
      "post",
      "/connections/delete",
      { connectionId },
      null,
      "connections/delete"
    );

    // a connection removal can change "last job" enrichment in cached list
    await invalidateSourceCache();

    return res.status(200).json({
      success: true,
      data: null,
      message: "Connection deleted",
    });
  } catch (error) {
    console.error("deleteConnection error:", error?.response?.data || error);
    return res.status(error?.response?.status || 500).json({
      success: false,
      data: null,
      message: error?.response?.data?.message || "Something went wrong",
    });
  }
};

/* ====================================================================== */
/*                              QUICKBOOKS SETUP                                */
/* ====================================================================== */

/**
 * Improved QuickBooks Connection Test with Better Error Handling
 */
/**
 * Improved QuickBooks Connection Test
 */
// async function testQuickBooksConnection(settings) {
//   const { access_token, realm_id, client_id, client_secret, refresh_token } =
//     settings;

//   if (!access_token || !realm_id) {
//     throw new Error("QuickBooks access_token and realm_id are required");
//   }

//   console.log("🔍 Testing QuickBooks Connection...");
//   console.log("Realm ID:", realm_id);
//   console.log("Token Preview:", access_token.substring(0, 20) + "...");

//   const baseUrl = "https://sandbox-quickbooks.api.intuit.com/v3/company";

//   try {
//     // Test basic company info access
//     const response = await fetch(
//       `${baseUrl}/${realm_id}/companyinfo/${realm_id}`,
//       {
//         method: "GET",
//         headers: {
//           Authorization: `Bearer ${access_token}`,
//           Accept: "application/json",
//           "Content-Type": "application/json",
//         },
//       }
//     );

//     console.log("Response Status:", response.status);

//     // Clone response for safe reading
//     const responseClone = response.clone();

//     if (!response.ok) {
//       const errorText = await responseClone.text();
//       console.log("Error Response:", errorText);

//       try {
//         const errorData = JSON.parse(errorText);
//         const quickbooksError = errorData.fault?.error?.[0];

//         if (quickbooksError) {
//           console.log("🔴 QuickBooks Error Details:", quickbooksError);

//           // Handle specific QuickBooks error codes
//           switch (quickbooksError.code) {
//             case "3100":
//               throw new Error(
//                 "APPLICATION_NOT_CONNECTED: Your app is not connected to this QuickBooks company. Please reconnect in QuickBooks."
//               );

//             case "3200":
//               throw new Error(
//                 "AUTHENTICATION_FAILED: The access token is invalid or expired."
//               );

//             case "1000":
//               throw new Error(
//                 "INTERNAL_SERVER_ERROR: QuickBooks server error. Please try again later."
//               );

//             default:
//               throw new Error(
//                 `QUICKBOOKS_ERROR_${quickbooksError.code}: ${
//                   quickbooksError.message || "Unknown QuickBooks error"
//                 }`
//               );
//           }
//         }
//       } catch (parseError) {
//         // If we can't parse the error, use the status code
//         if (response.status === 401) {
//           throw new Error(
//             "AUTHENTICATION_FAILED: Invalid or expired access token"
//           );
//         } else if (response.status === 403) {
//           throw new Error(
//             "APPLICATION_NOT_CONNECTED: App not connected to this company"
//           );
//         } else if (response.status === 404) {
//           throw new Error(
//             "COMPANY_NOT_FOUND: Company not found with the provided Realm ID"
//           );
//         } else {
//           throw new Error(
//             `HTTP_${response.status}: ${errorText.substring(0, 200)}`
//           );
//         }
//       }
//     }

//     const data = await response.json();
//     console.log("✅ Company Info:", data.CompanyInfo?.CompanyName);

//     return {
//       companyName: data.CompanyInfo.CompanyName,
//       companyId: data.CompanyInfo.Id,
//       legalName: data.CompanyInfo.LegalName,
//       connectionStatus: "connected",
//       message: "QuickBooks connection successful",
//     };
//   } catch (error) {
//     console.error("🔴 QuickBooks connection test failed:", error);

//     // Provide user-friendly error messages
//     if (error.message.includes("APPLICATION_NOT_CONNECTED")) {
//       throw new Error(
//         "🔗 App Connection Required\n\n" +
//           "Your app is not connected to this QuickBooks company. Here's how to fix this:\n\n" +
//           "1. Go to QuickBooks Online and log in as the company admin\n" +
//           "2. Navigate to Settings ⚙️ → Manage apps\n" +
//           "3. Find your app and click 'Connect' or 'Get app now'\n" +
//           "4. Follow the authorization prompts\n" +
//           "5. Try connecting again with the new authorization\n\n" +
//           "If you don't see your app listed, you may need to:\n" +
//           "• Contact your QuickBooks company admin\n" +
//           "• Check if your app is published in the QuickBooks App Store\n" +
//           "• Ensure you're using the correct QuickBooks company"
//       );
//     }

//     throw error;
//   }
// }

// async function testQuickBooksConnection(settings) {
//   const {
//     access_token,
//     realm_id,
//     client_id,
//     client_secret,
//     refresh_token,
//     environment = "sandbox",
//   } = settings;

//   if (
//     !access_token ||
//     !realm_id ||
//     !client_id ||
//     !client_secret ||
//     !refresh_token
//   ) {
//     throw new Error("Missing required QuickBooks credentials");
//   }

//   console.log("🔍 Testing QuickBooks Connection...");
//   console.log("Realm ID:", realm_id);
//   console.log("Environment:", environment || "production");

//   // Determine base URL based on environment
//   const baseUrl =
//     environment === "sandbox"
//       ? "https://sandbox-quickbooks.api.intuit.com/v3/company"
//       : "https://quickbooks.api.intuit.com/v3/company";

//   try {
//     // First, try to refresh the token automatically
//     console.log("🔄 Attempting to refresh access token...");
//     const newTokens = await refreshQuickBooksToken({
//       client_id,
//       client_secret,
//       refresh_token,
//     });

//     console.log("✅ Token refreshed successfully");

//     // Test connection with new token
//     const testResponse = await fetch(
//       `${baseUrl}/${realm_id}/companyinfo/${realm_id}`,
//       {
//         method: "GET",
//         headers: {
//           Authorization: `Bearer ${newTokens.access_token}`,
//           Accept: "application/json",
//           "Content-Type": "application/json",
//         },
//       }
//     );

//     if (!testResponse.ok) {
//       const errorText = await testResponse.text();
//       throw new Error(
//         `Connection test failed after token refresh: ${testResponse.status}`
//       );
//     }

//     const companyData = await testResponse.json();
//     console.log("✅ QuickBooks connection successful");
//     console.log("Company:", companyData.CompanyInfo.CompanyName);

//     return {
//       success: true,
//       tokensRefreshed: true,
//       newAccessToken: newTokens.access_token,
//       newRefreshToken: newTokens.refresh_token,
//       companyName: companyData.CompanyInfo.CompanyName,
//       message: "QuickBooks connection successful (token refreshed)",
//     };
//   } catch (error) {
//     console.error("🔴 QuickBooks connection test failed:", error);

//     // If token refresh failed, provide reconnection instructions
//     if (
//       error.message.includes("AuthenticationFailed") ||
//       error.message.includes("3200") ||
//       error.message.includes("401")
//     ) {
//       throw new Error(
//         "Authentication failed. The refresh token may be expired or revoked. " +
//           "Please reauthorize your QuickBooks connection."
//       );
//     }

//     throw error;
//   }
// }

async function testQuickBooksConnection(settings) {
  const {
    access_token,
    realm_id,
    client_id,
    client_secret,
    refresh_token,
    environment = "sandbox",
  } = settings;

  if (!access_token || !realm_id) {
    throw new Error("QuickBooks access_token and realm_id are required");
  }

  console.log("🔍 Testing QuickBooks Connection...");
  console.log("Realm ID:", realm_id);
  console.log("Environment:", environment || "production");

  // Determine base URL based on environment
  const baseUrl =
    environment === "sandbox"
      ? "https://sandbox-quickbooks.api.intuit.com/v3/company"
      : "https://quickbooks.api.intuit.com/v3/company";

  try {
    // Test with a simpler, faster endpoint first
    const response = await fetch(
      `${baseUrl}/${realm_id}/query?query=SELECT COUNT(*) FROM Customer MAXRESULTS 1`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${access_token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      }
    );

    console.log("QuickBooks API Response Status:", response.status);

    if (response.status === 401) {
      // Token might be expired, try to refresh
      console.log("🔄 Access token may be expired, attempting refresh...");
      try {
        const newTokens = await refreshQuickBooksToken(settings);
        console.log("✅ Token refreshed successfully");

        // Retry with new token
        const retryResponse = await fetch(
          `${baseUrl}/${realm_id}/query?query=SELECT COUNT(*) FROM Customer MAXRESULTS 1`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${newTokens.access_token}`,
              Accept: "application/json",
              "Content-Type": "application/json",
            },
          }
        );
        console.log("in test function", newTokens);
        if (retryResponse.ok) {
          return {
            success: true,
            tokensRefreshed: true,
            newRefreshToken: newTokens.refresh_token,
            newAccessToken: newTokens.access_token,
            message: "QuickBooks connection successful (token refreshed)",
          };
        }
      } catch (refreshError) {
        console.error("Token refresh failed:", refreshError);
        throw new Error("Authentication failed and token refresh unsuccessful");
      }
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.log("QuickBooks API Error:", errorText);

      try {
        const errorData = JSON.parse(errorText);
        const quickbooksError = errorData.fault?.error?.[0];

        if (quickbooksError) {
          throw new Error(
            `QuickBooks Error ${quickbooksError.code}: ${quickbooksError.message}`
          );
        }
      } catch (parseError) {
        // If we can't parse the error response
        throw new Error(
          `HTTP ${response.status}: ${errorText.substring(0, 100)}`
        );
      }
    }

    const data = await response.json();
    console.log("✅ QuickBooks connection test successful");

    return {
      success: true,
      tokensRefreshed: false,
      message: "QuickBooks connection successful",
    };
  } catch (error) {
    console.error("🔴 QuickBooks connection test failed:", error);

    // Provide more specific error messages
    if (
      error.message.includes("fetch failed") ||
      error.message.includes("ENOTFOUND")
    ) {
      throw new Error(
        "Network error: Cannot reach QuickBooks API. Check your internet connection."
      );
    }

    if (error.message.includes("timeout")) {
      throw new Error(
        "QuickBooks API is not responding. Please try again later."
      );
    }

    throw error;
  }
}
/**
 * GET /api/quickbooks/check-connection/:sourceId
 * Checks QuickBooks connection status and provides reconnection instructions
 */
exports.checkQuickBooksConnection = async (req, res) => {
  try {
    const { sourceId } = req.params;

    // Get source from database
    const source = await Source.findByPk(sourceId);
    if (!source) {
      return res.status(404).json({
        success: false,
        message: "Source not found",
      });
    }

    if (source.connector_name !== "quickbooks") {
      return res.status(400).json({
        success: false,
        message: "Source is not a QuickBooks connection",
      });
    }

    const settings = source.connector_settings_json;

    try {
      // Test the current connection
      const connectionTest = await testQuickBooksConnectionWithTimeout(
        settings,
        3000000
      );

      return res.status(200).json({
        success: true,
        data: connectionTest,
        message: "QuickBooks connection is active",
      });
    } catch (error) {
      // Connection failed - provide reconnection instructions
      const authUrl = await generateReconnectUrl(req, sourceId);

      return res.status(400).json({
        success: false,
        data: {
          error: error.message,
          reconnectionRequired: true,
          authUrl: authUrl,
          instructions: [
            "1. Click the authorization link above",
            "2. Log in to QuickBooks as company admin",
            "3. Grant permissions to your app",
            "4. You'll be redirected back with new connection tokens",
          ],
        },
        message: "Reconnection required",
      });
    }
  } catch (error) {
    console.error("QuickBooks connection check error:", error);
    return res.status(500).json({
      success: false,
      message: "Connection check failed",
    });
  }
};

/**
 * Generate reconnection URL
 */
async function generateReconnectUrl(req, sourceId) {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const callbackUrl = `${baseUrl}/api/quickbooks/callback?sourceId=${sourceId}`;

  const scopes = [
    "com.intuit.quickbooks.accounting",
    "com.intuit.quickbooks.payment",
    "openid",
    "profile",
    "email",
  ].join("+");

  const authUrl = new URL("https://appcenter.intuit.com/connect/oauth2");
  authUrl.searchParams.append("client_id", process.env.QUICKBOOKS_CLIENT_ID);
  authUrl.searchParams.append("response_type", "code");
  authUrl.searchParams.append("scope", scopes);
  authUrl.searchParams.append("redirect_uri", callbackUrl);
  authUrl.searchParams.append("state", `reconnect_${sourceId}`);

  return authUrl.toString();
}
// Add this debug function to check company access
async function debugQuickBooksConnection(settings) {
  const { access_token, realm_id } = settings;
  const baseUrl = "https://quickbooks.api.intuit.com/v3/company";

  console.log("🔍 Debugging QuickBooks Connection...");
  console.log("Realm ID:", realm_id);
  console.log("Access Token Length:", access_token?.length);

  try {
    // Test with a simpler endpoint first
    const response = await fetch(
      `${baseUrl}/${realm_id}/companyinfo/${realm_id}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${access_token}`,
          Accept: "application/json",
        },
      }
    );

    console.log("Response Status:", response.status);
    console.log("Response Headers:", Object.fromEntries(response.headers));

    // Clone the response before reading it to avoid "Body is unusable" error
    const responseClone = response.clone();

    if (!response.ok) {
      const errorText = await responseClone.text();
      console.log("Error Response:", errorText);

      // More specific error analysis
      if (response.status === 401 || response.status === 403) {
        try {
          const errorData = JSON.parse(errorText);
          console.log(
            "🔴 QuickBooks Error Details:",
            errorData.fault?.error?.[0]
          );

          if (errorData.fault?.error?.[0]?.code === "3100") {
            return {
              success: false,
              error: "APPLICATION_NOT_CONNECTED",
              message:
                "Your app is not connected to this QuickBooks company. Please reconnect in QuickBooks.",
            };
          }
        } catch (parseError) {
          console.log("Could not parse error response:", parseError);
        }
      }

      return {
        success: false,
        status: response.status,
        message: `HTTP ${response.status}: ${errorText.substring(0, 200)}`,
      };
    }

    const data = await response.json();
    console.log("✅ Company Info:", data.CompanyInfo?.CompanyName);
    return { success: true, data };
  } catch (error) {
    console.error("🔴 Debug Error:", error);
    return {
      success: false,
      error: error.message,
      message: `Connection failed: ${error.message}`,
    };
  }
}

/**
 * Refresh QuickBooks access token
 */
async function refreshQuickBooksToken(settings) {
  const { client_id, client_secret, refresh_token } = settings;

  if (!client_id || !client_secret || !refresh_token) {
    throw new Error("Missing credentials for token refresh");
  }

  console.log("🔄 Refreshing QuickBooks token...");

  const tokenEndpoint =
    "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

  try {
    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(
          `${client_id}:${client_secret}`
        ).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refresh_token,
      }),
    });

    console.log("Token refresh response status:", response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Token refresh failed:", errorText);

      if (response.status === 400 || response.status === 401) {
        throw new Error(
          "Refresh token is invalid or expired. Reauthorization required."
        );
      }

      throw new Error(`Token refresh failed: ${response.status} ${errorText}`);
    }

    const tokenData = await response.json();
    console.log("✅ Token refresh successful");

    return {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token, // Always use the new refresh token
      expires_in: tokenData.expires_in,
      token_type: tokenData.token_type,
      x_refresh_token_expires_in: tokenData.x_refresh_token_expires_in,
    };
  } catch (error) {
    console.error("🔴 Token refresh error:", error);
    throw error;
  }
}

/**
 * GET /api/quickbooks/auth-url
 * Generates QuickBooks OAuth authorization URL
 */
exports.getQuickBooksAuthUrl = async (req, res) => {
  try {
    const { callbackUrl } = req.query;

    // Your QuickBooks app credentials
    const clientId = process.env.QUICKBOOKS_CLIENT_ID;
    const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return res.status(400).json({
        success: false,
        message: "QuickBooks client ID and secret not configured",
      });
    }

    // Scopes your app needs - adjust based on your requirements
    const scopes = [
      "com.intuit.quickbooks.accounting",
      "com.intuit.quickbooks.payment",
      "openid",
      "profile",
      "email",
      "phone",
      "address",
    ].join("+");

    const authUrl = new URL("https://appcenter.intuit.com/connect/oauth2");
    authUrl.searchParams.append("client_id", clientId);
    authUrl.searchParams.append("response_type", "code");
    authUrl.searchParams.append("scope", scopes);
    authUrl.searchParams.append(
      "redirect_uri",
      callbackUrl ||
        `${req.protocol}://${req.get("host")}/api/quickbooks/callback`
    );
    authUrl.searchParams.append(
      "state",
      Math.random().toString(36).substring(7)
    ); // CSRF protection

    return res.status(200).json({
      success: true,
      data: {
        authUrl: authUrl.toString(),
        clientId,
        scopes,
      },
      message: "QuickBooks authorization URL generated",
    });
  } catch (error) {
    console.error("QuickBooks auth URL error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to generate authorization URL",
    });
  }
};

/**
 * GET /api/quickbooks/callback
 * Handles QuickBooks OAuth callback
 */
exports.handleQuickBooksCallback = async (req, res) => {
  try {
    const { code, state, realmId } = req.query;
    const { error, error_description } = req.query;

    if (error) {
      return res.status(400).json({
        success: false,
        message: `OAuth Error: ${error} - ${error_description}`,
      });
    }

    if (!code) {
      return res.status(400).json({
        success: false,
        message: "Authorization code not provided",
      });
    }

    if (!realmId) {
      return res.status(400).json({
        success: false,
        message: "Company ID (realmId) not provided",
      });
    }

    // Exchange authorization code for tokens
    const tokenResponse = await fetch(
      "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(
            `${process.env.QUICKBOOKS_CLIENT_ID}:${process.env.QUICKBOOKS_CLIENT_SECRET}`
          ).toString("base64")}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code,
          redirect_uri: `${req.protocol}://${req.get(
            "host"
          )}/api/quickbooks/callback`,
        }),
      }
    );

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      throw new Error(
        `Token exchange failed: ${tokenResponse.status} ${errorText}`
      );
    }

    const tokenData = await tokenResponse.json();

    // Test the connection with new tokens
    const connectionTest = await testQuickBooksConnectionWithTimeout(
      {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        realm_id: realmId,
        client_id: process.env.QUICKBOOKS_CLIENT_ID,
        client_secret: process.env.QUICKBOOKS_CLIENT_SECRET,
      },
      15000
    );

    return res.status(200).json({
      success: true,
      data: {
        tokens: {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_in: tokenData.expires_in,
          token_type: tokenData.token_type,
          x_refresh_token_expires_in: tokenData.x_refresh_token_expires_in,
        },
        realmId,
        companyInfo: connectionTest,
      },
      message: "QuickBooks connected successfully",
    });
  } catch (error) {
    console.error("QuickBooks callback error:", error);
    return res.status(500).json({
      success: false,
      message: `Connection failed: ${error.message}`,
    });
  }
};
/**
 * Estimate supported entities based on batch test response
 */
function estimateSupportedEntities(batchData) {
  const supported = [];
  const entities = ["Customer", "Invoice", "Account", "Item", "Vendor"];

  batchData.BatchItemResponse.forEach((item) => {
    if (item.QueryResponse) {
      const entity = Object.keys(item.QueryResponse).find(
        (key) =>
          key !== "startPosition" &&
          key !== "maxResults" &&
          key !== "totalCount"
      );
      if (entity && entities.includes(entity)) {
        supported.push(entity);
      }
    }
  });

  return supported.length > 0 ? supported : ["CompanyInfo (basic only)"];
}

/**
 * Enhanced version with timeout and better error handling
 */
async function testQuickBooksConnectionWithTimeout(
  settings,
  timeoutMs = 300000
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await Promise.race([
      testQuickBooksConnection(settings),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Connection test timeout")),
          timeoutMs
        )
      ),
    ]);

    clearTimeout(timeoutId);
    return result;
  } catch (error) {
    clearTimeout(timeoutId);

    if (error.name === "AbortError") {
      throw new Error(
        `QuickBooks connection test timed out after ${timeoutMs}ms`
      );
    }
    throw error;
  }
}

// Add this handler function to your existing sourceController.js file
// Place it with the other Google Drive functions

/**
 * GET /api/google-drive/folders
 * Get all folders from Google Drive that contain spreadsheets
 */

exports.getGoogleDriveFolders = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed",
    });
  }

  try {
    const { client_id, client_secret, access_token, refresh_token } = req.body;

    if (!client_id || !client_secret || !access_token) {
      return res.status(400).json({
        success: false,
        message:
          "Missing required credentials: client_id, client_secret, and access_token are required",
      });
    }

    const OAuth2 = google.auth.OAuth2;
    const oauth2Client = new OAuth2(client_id, client_secret);

    oauth2Client.setCredentials({
      access_token,
      refresh_token,
    });

    // ✅ IMPROVED TOKEN VALIDATION AND REFRESH
    let currentAccessToken = access_token;
    let tokenRefreshed = false;

    try {
      // Test token validity
      const tokenInfo = await oauth2Client.getTokenInfo(access_token);
      console.log(
        "✅ Access token is valid, expires in:",
        Math.round((tokenInfo.expiry_date - Date.now()) / 1000 / 60),
        "minutes"
      );
    } catch (tokenError) {
      console.warn("⚠️ Access token invalid or expired:", tokenError.message);

      if (!refresh_token) {
        console.warn("❌ No refresh token available");
        return res.status(401).json({
          success: false,
          message: "No refresh token available. Please reauthorize.",
          error: "missing_refresh_token",
          requiresReauthorization: true,
        });
      }

      try {
        console.log("🔄 Attempting to refresh access token...");

        // Clear the current credentials to force refresh
        oauth2Client.setCredentials({
          refresh_token: refresh_token,
        });

        const { credentials } = await oauth2Client.refreshAccessToken();

        if (!credentials.access_token) {
          throw new Error("No access token received from refresh");
        }

        currentAccessToken = credentials.access_token;
        tokenRefreshed = true;

        // Update credentials with new token
        oauth2Client.setCredentials({
          access_token: credentials.access_token,
          refresh_token: refresh_token, // Keep the original refresh token
          expiry_date: credentials.expiry_date,
        });

        console.log("✅ Token refreshed successfully");
      } catch (refreshError) {
        console.error("❌ Token refresh failed:", refreshError.message);

        // Enhanced error diagnostics
        let errorDetails = "Token refresh failed";
        let errorCode = "refresh_failed";

        if (refreshError.response?.data) {
          const refreshData = refreshError.response.data;
          errorDetails += `: ${JSON.stringify(refreshData)}`;

          // Specific error handling
          if (refreshData.error === "unauthorized_client") {
            errorCode = "unauthorized_client";
            errorDetails +=
              ". This usually means: 1) Refresh token was revoked, 2) App not authorized in Google Console, 3) OAuth consent screen not verified";
          } else if (refreshData.error === "invalid_grant") {
            errorCode = "invalid_grant";
            errorDetails += ". Refresh token is invalid or expired";
          }
        }

        return res.status(401).json({
          success: false,
          message:
            "Access token expired and refresh failed. Please reauthorize.",
          error: errorDetails,
          errorCode: errorCode,
          requiresReauthorization: true,
        });
      }
    }

    // ✅ STEP 2: Use valid token to call Google Drive API
    try {
      const drive = google.drive({ version: "v3", auth: oauth2Client });
      console.log("📁 Fetching folders from Google Drive...");

      // Enhanced Drive API test with better error handling
      try {
        const aboutResponse = await drive.about.get({
          fields: "user,storageQuota",
        });
        console.log(
          "✅ Drive API access confirmed for user:",
          aboutResponse.data.user?.emailAddress
        );
      } catch (driveTestError) {
        console.error("❌ Drive API access failed:", driveTestError.message);

        let errorMessage = "Drive API access denied";
        if (driveTestError.code === 403) {
          errorMessage =
            "Insufficient Drive API permissions. Ensure drive.readonly scope is granted.";
        } else if (driveTestError.code === 401) {
          errorMessage = "Drive API authentication failed";
        }

        return res.status(401).json({
          success: false,
          message: errorMessage,
          error: driveTestError.message,
          requiresReauthorization: driveTestError.code === 401,
        });
      }

      const foldersResponse = await drive.files.list({
        q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
        pageSize: 100,
        fields: "files(id, name, mimeType, createdTime, modifiedTime)",
        orderBy: "name",
      });

      const allFolders = foldersResponse.data.files || [];
      const foldersWithSheets = [];

      console.log(`📂 Processing ${allFolders.length} folders...`);

      // Process folders with concurrency control
      const batchSize = 5;
      for (let i = 0; i < allFolders.length; i += batchSize) {
        const batch = allFolders.slice(i, i + batchSize);
        const batchPromises = batch.map(async (folder) => {
          try {
            const sheetsResponse = await drive.files.list({
              q: `mimeType='application/vnd.google-apps.spreadsheet' and '${folder.id}' in parents and trashed=false`,
              pageSize: 1,
              fields: "files(id)",
            });

            if (sheetsResponse.data.files.length > 0) {
              return {
                id: folder.id,
                name: folder.name,
                createdTime: folder.createdTime,
                modifiedTime: folder.modifiedTime,
                sheetCount: sheetsResponse.data.files.length,
              };
            }
            return null;
          } catch (err) {
            console.warn(
              `Cannot access folder "${folder.name}": ${err.message}`
            );
            return null;
          }
        });

        const batchResults = await Promise.all(batchPromises);
        const validFolders = batchResults.filter((folder) => folder !== null);
        foldersWithSheets.push(...validFolders);

        // Small delay between batches to avoid rate limiting
        if (i + batchSize < allFolders.length) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      console.log(
        `✅ Found ${foldersWithSheets.length} folders with spreadsheets`
      );

      // ✅ STEP 3: Send success response
      return res.status(200).json({
        success: true,
        data: {
          folders: foldersWithSheets,
          totalFolders: allFolders.length,
          foldersWithSheets: foldersWithSheets.length,
        },
        newAccessToken: tokenRefreshed ? currentAccessToken : undefined,
        message: `Found ${foldersWithSheets.length} folders containing spreadsheets`,
      });
    } catch (driveError) {
      console.error("Google Drive API error:", driveError);

      if (driveError.code === 401) {
        return res.status(401).json({
          success: false,
          message: "Drive API authentication failed",
          error: driveError.message,
          requiresReauthorization: true,
        });
      }

      return res.status(500).json({
        success: false,
        message: "Google Drive API error",
        error: driveError.message,
        requiresReauthorization: false,
      });
    }
  } catch (error) {
    console.error("Unexpected error in getGoogleDriveFolders:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error while fetching folders",
      error: error.message,
      requiresReauthorization: false,
    });
  }
};

/**
 * GET /api/google-drive/sheets
 * Get all spreadsheets from a specific Google Drive folder
 */
exports.getGoogleDriveSheets = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed",
    });
  }

  try {
    const { client_id, client_secret, access_token, refresh_token, folder_id } =
      req.body;

    if (!client_id || !client_secret || !access_token || !folder_id) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameters",
      });
    }

    const oauth2Client = new google.auth.OAuth2(client_id, client_secret);
    oauth2Client.setCredentials({
      access_token,
      refresh_token,
    });

    const drive = google.drive({ version: "v3", auth: oauth2Client });

    const sheetsResponse = await drive.files.list({
      q: `mimeType='application/vnd.google-apps.spreadsheet' and '${folder_id}' in parents and trashed=false`,
      pageSize: 50,
      fields: "files(id, name, createdTime, modifiedTime)",
      orderBy: "name",
    });

    const sheets = sheetsResponse.data.files.map((sheet) => ({
      id: sheet.id,
      name: sheet.name,
      createdTime: sheet.createdTime,
      modifiedTime: sheet.modifiedTime,
    }));

    res.status(200).json({
      success: true,
      data: {
        sheets,
        totalSheets: sheets.length,
      },
    });
  } catch (error) {
    console.error("Sheets API error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch sheets",
      error: error.message,
    });
  }
};

// Add these to your existing backend controller file

// Generate reauthorization URL for Google Drive
exports.getGoogleDriveReauthorizationUrl = async (req, res) => {
  try {
    const { client_id, client_secret } = req.body;

    if (!client_id || !client_secret) {
      return res.status(400).json({
        success: false,
        message: "client_id and client_secret are required",
      });
    }

    const OAuth2 = google.auth.OAuth2;
    const oauth2Client = new OAuth2(
      client_id,
      client_secret,
      "http://localhost:3000" // Make sure this matches your configured redirect URI
    );

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: ["https://www.googleapis.com/auth/drive"],
      prompt: "consent", // Force reauthorization to get new refresh token
      include_granted_scopes: true,
    });

    return res.status(200).json({
      success: true,
      authUrl: authUrl,
      message: "Visit this URL to reauthorize the application",
    });
  } catch (error) {
    console.error("Error generating auth URL:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to generate authorization URL",
      error: error.message,
    });
  }
};

// Exchange authorization code for tokens
exports.exchangeGoogleDriveCodeForTokens = async (req, res) => {
  try {
    const { client_id, client_secret, authorization_code } = req.body;

    if (!client_id || !client_secret || !authorization_code) {
      return res.status(400).json({
        success: false,
        message:
          "client_id, client_secret, and authorization_code are required",
      });
    }

    const OAuth2 = google.auth.OAuth2;
    const oauth2Client = new OAuth2(
      client_id,
      client_secret,
      "http://localhost:3000" // Must match redirect URI
    );

    const { tokens } = await oauth2Client.getToken(authorization_code);

    console.log("✅ New Google Drive tokens obtained successfully");

    return res.status(200).json({
      success: true,
      tokens: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token, // This will be new
        expiry_date: tokens.expiry_date,
        scope: tokens.scope,
      },
      message:
        "Google Drive reauthorization successful. Save these new tokens.",
    });
  } catch (error) {
    console.error("Error exchanging code for tokens:", error);
    return res.status(400).json({
      success: false,
      message: "Failed to exchange authorization code",
      error: error.message,
    });
  }
};

/* ====================================================================== */
/*                              SHOPIFY SETUP                             */
/* ====================================================================== */

/**
 * GET /api/shopify/auth-url
 * Generates Shopify OAuth authorization URL
 */
/* ====================================================================== */
/*                              SHOPIFY SETUP                             */
/* ====================================================================== */

/**
 * POST /api/source/shopify/auth-url   (protected)
 * Returns Shopify OAuth URL — credentials come from .env, user only supplies shop domain.
 * state = userId so callback can look up company_id without a session.
 */
exports.getShopifyAuthUrl = async (req, res) => {
  try {
    let { shop } = req.body;

    if (!shop) {
      return res.status(400).json({ success: false, message: "shop domain is required" });
    }

    // Normalise: accept "my-store" or "my-store.myshopify.com"
    shop = shop.trim().toLowerCase();
    if (!shop.includes(".")) shop = `${shop}.myshopify.com`;

    const shopRegex = /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/;
    if (!shopRegex.test(shop)) {
      return res.status(400).json({
        success: false,
        message: "Invalid shop domain. Use: your-store.myshopify.com",
      });
    }

    const clientId = process.env.SHOPIFY_CLIENT_ID;
    if (!clientId) {
      return res.status(500).json({ success: false, message: "Shopify app not configured on server" });
    }

    const scopes = [
      "read_products", "read_orders", "read_customers",
      "read_inventory", "read_locations", "read_fulfillments",
      "read_shipping", "read_price_rules",
      "read_draft_orders", "read_collection_listings", "read_product_listings",
      "read_checkouts", "read_gift_cards",
    ].join(",");

    const baseUrl   = process.env.BASE_URL?.startsWith("http")
      ? process.env.BASE_URL
      : `${req.protocol}://${req.get("host")}`;
    const redirectUri = `${baseUrl}/api/source/shopify/callback`;

    // state = userId (same pattern as QuickBooks)
    const state = req.user.id;

    const authUrl =
      `https://${shop}/admin/oauth/authorize?` +
      `client_id=${clientId}&` +
      `scope=${scopes}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `state=${state}`;

    return res.status(200).json({
      success: true,
      data: { authUrl, shop },
      message: "Shopify authorization URL generated",
    });
  } catch (error) {
    console.error("[shopify-auth-url]", error.message);
    return res.status(500).json({ success: false, message: "Failed to generate authorization URL" });
  }
};

/**
 * GET /api/source/shopify/callback   (public — Shopify redirects here)
 * Exchanges auth code for access_token, saves source, fires sync, redirects to frontend.
 */
exports.handleShopifyCallback = async (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL?.replace(/\/$/, "") || "http://localhost:3000";

  try {
    const { code, shop, state, error: oauthError } = req.query;

    // OAuth denied
    if (oauthError) {
      return res.redirect(`${frontendUrl}/source?shopify=error&message=${encodeURIComponent(oauthError)}`);
    }

    if (!code || !shop || !state) {
      return res.redirect(`${frontendUrl}/source?shopify=error&message=missing_params`);
    }

    const clientId     = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return res.redirect(`${frontendUrl}/source?shopify=error&message=server_not_configured`);
    }

    // 1. Exchange code → access_token
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });

    if (!tokenRes.ok) {
      const txt = await tokenRes.text();
      throw new Error(`Token exchange failed: ${tokenRes.status} — ${txt}`);
    }

    const { access_token, scope, refresh_token } = await tokenRes.json();

    // 2. Resolve companyId from userId in state (same as QuickBooks pattern)
    const User = require('../model/userModel');
    const user = await User.findByPk(state);
    if (!user) {
      return res.redirect(`${frontendUrl}/source?shopify=error&message=user_not_found`);
    }
    const companyId = user.company_id;

    // 3. Save source (upsert — if same shop reconnects, update tokens)
    const [source] = await Source.findOrCreate({
      where: { connector_name: "Shopify", company_id: companyId, connector_settings_json: { shop } },
      defaults: {
        source_name:             shop,
        connector_name:          "Shopify",
        company_id:              companyId,
        status:                  "pending",
        connector_settings_json: {
          shop,
          access_token,
          refresh_token: refresh_token || null,
          scope,
          connected_at: new Date().toISOString(),
        },
        created_on: new Date(),
      },
    });

    // If it already existed, update the tokens
    if (source.connector_settings_json?.shop === shop && source.connector_settings_json?.access_token !== access_token) {
      await source.update({
        status: "pending",
        connector_settings_json: {
          ...source.connector_settings_json,
          access_token,
          refresh_token: refresh_token || source.connector_settings_json?.refresh_token,
          scope,
          connected_at: new Date().toISOString(),
        },
      });
    }

    // 4. Fire background sync
    setImmediate(() =>
      runShopifySync({ sourceId: source.id, companyId, shop, accessToken: access_token })
    );

    // 5. Redirect to frontend success page
    return res.redirect(`${frontendUrl}/source?shopify=success&shop=${encodeURIComponent(shop)}`);

  } catch (err) {
    console.error("[shopify-callback]", err.message);
    return res.redirect(`${frontendUrl}/source?shopify=error&message=${encodeURIComponent(err.message)}`);
  }
};

/* ====================================================================== */
/*                           ZOHOBOOKS OAUTH                              */
/* ====================================================================== */

/**
 * POST /api/source/zoho/auth-url   (protected)
 * Returns ZohoBooks OAuth URL — credentials from .env, user supplies region only.
 */
exports.getZohoAuthUrl = async (req, res) => {
  try {
    const { region = "com" } = req.body;

    const validRegions = ["com", "eu", "in", "com.au", "jp", "com.cn"];
    if (!validRegions.includes(region)) {
      return res.status(400).json({ success: false, message: "Invalid region" });
    }

    const clientId = process.env.ZOHO_CLIENT_ID;
    if (!clientId) {
      return res.status(500).json({ success: false, message: "ZohoBooks app not configured on server" });
    }

    const baseUrl    = process.env.BASE_URL?.startsWith("http")
      ? process.env.BASE_URL
      : `${req.protocol}://${req.get("host")}`;
    const redirectUri = `${baseUrl}/api/source/zoho/callback`;

    // state = userId_region (so callback knows both user and region)
    const state = `${req.user.id}_${region}`;

    const scopes = [
      "ZohoBooks.fullaccess.all",
    ].join(",");

    const authUrl =
      `https://accounts.zoho.${region}/oauth/v2/auth?` +
      `client_id=${clientId}&` +
      `scope=${encodeURIComponent(scopes)}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `response_type=code&` +
      `access_type=offline&` +
      `state=${encodeURIComponent(state)}&` +
      `prompt=consent`;

    return res.status(200).json({
      success: true,
      data: { authUrl, region },
      message: "ZohoBooks authorization URL generated",
    });
  } catch (error) {
    console.error("[zoho-auth-url]", error.message);
    return res.status(500).json({ success: false, message: "Failed to generate authorization URL" });
  }
};

/**
 * GET /api/source/zoho/callback   (public — Zoho redirects here)
 * Exchanges auth code for access_token + refresh_token, saves source, redirects frontend.
 */
exports.handleZohoCallback = async (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL?.replace(/\/$/, "") || "http://localhost:3000";

  try {
    const {
      code,
      state,
      location,
      "accounts-server": accountsServer,
      error: oauthError,
      "error-description": errorDesc,
    } = req.query;

    if (oauthError) {
      return res.redirect(`${frontendUrl}/source?zoho=error&message=${encodeURIComponent(errorDesc || oauthError)}`);
    }

    if (!code || !state) {
      return res.redirect(`${frontendUrl}/source?zoho=error&message=missing_params`);
    }

    // Decode state → userId_region
    const decodedState  = decodeURIComponent(state);
    const underscoreIdx = decodedState.indexOf("_");
    const userId        = decodedState.substring(0, underscoreIdx);
    const regionFromState = decodedState.substring(underscoreIdx + 1) || "com";

    // ── CRITICAL: use the accounts-server Zoho sends back, NOT the region from state.
    // Zoho always returns the correct server for this user's account (e.g. zoho.in for India).
    // Using the wrong server causes "invalid_code".
    const zohoAccountsBase = accountsServer
      ? accountsServer.replace(/\/$/, "")          // e.g. "https://accounts.zoho.in"
      : `https://accounts.zoho.${regionFromState}`;

    // Derive the Books API base from the location param Zoho provides (e.g. "in", "eu", "com").
    // IMPORTANT: the REST API lives at www.zohoapis.<tld>/books/v3 — NOT books.zoho.<tld>.
    const effectiveRegion = location || regionFromState;
    const zohoBooksBase   = `https://www.zohoapis.${effectiveRegion}`;

    const clientId     = process.env.ZOHO_CLIENT_ID;
    const clientSecret = process.env.ZOHO_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return res.redirect(`${frontendUrl}/source?zoho=error&message=server_not_configured`);
    }

    const baseUrl     = process.env.BASE_URL?.startsWith("http")
      ? process.env.BASE_URL
      : "http://localhost:9001";
    const redirectUri = `${baseUrl}/api/source/zoho/callback`;

    // 1. Exchange code → tokens (use the exact accounts-server Zoho returned)
    const tokenRes = await fetch(`${zohoAccountsBase}/oauth/v2/token`, {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "authorization_code",
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  redirectUri,
        code,
      }).toString(),
    });

    if (!tokenRes.ok) {
      const txt = await tokenRes.text();
      throw new Error(`Zoho token exchange failed: ${tokenRes.status} — ${txt}`);
    }

    const tokenData = await tokenRes.json();
    const { access_token, refresh_token, expires_in } = tokenData;

    if (!access_token) {
      throw new Error(tokenData.error || `No access_token in Zoho response: ${JSON.stringify(tokenData)}`);
    }

    // 2. Get Zoho organisation info (use correct region Books URL)
    let organizationName = null;
    let organizationId   = null;
    try {
      const orgRes = await fetch(`${zohoBooksBase}/books/v3/organizations`, {
        headers: { Authorization: `Zoho-oauthtoken ${access_token}` },
      });
      if (orgRes.ok) {
        const orgData = await orgRes.json();
        const org = orgData?.organizations?.[0];
        organizationName = org?.name || null;
        organizationId   = org?.organization_id || null;
      }
    } catch (_) { /* non-fatal */ }

    // 3. Resolve companyId
    const User = require('../model/userModel');
    const user = await User.findByPk(userId);
    if (!user) {
      return res.redirect(`${frontendUrl}/source?zoho=error&message=user_not_found`);
    }
    const companyId = user.company_id;

    // 4. Save source
    const tokenExpiry = expires_in
      ? new Date(Date.now() + expires_in * 1000).toISOString()
      : null;

    const [source] = await Source.findOrCreate({
      where: { connector_name: "Zoho Books", company_id: companyId },
      defaults: {
        source_name:             organizationName || `ZohoBooks (${effectiveRegion})`,
        connector_name:          "Zoho Books",
        company_id:              companyId,
        status:                  "pending",
        connector_settings_json: {
          region:            effectiveRegion,
          accounts_server:   zohoAccountsBase,
          access_token,
          refresh_token:     refresh_token || null,
          token_expiry:      tokenExpiry,
          organization_name: organizationName,
          organization_id:   organizationId,
          connected_at:      new Date().toISOString(),
        },
        created_on: new Date(),
      },
    });

    // If reconnecting, update tokens
    if (source.connector_settings_json?.access_token !== access_token) {
      await source.update({
        status: "pending",
        connector_settings_json: {
          ...source.connector_settings_json,
          access_token,
          refresh_token:  refresh_token || source.connector_settings_json?.refresh_token,
          token_expiry:   tokenExpiry,
          connected_at:   new Date().toISOString(),
        },
      });
    }

    // 5. Fire background sync
    const orgId      = source.connector_settings_json?.organization_id || organizationId;
    const booksBase  = `${zohoBooksBase}`;
    setImmediate(() =>
      runZohoBooksSync({
        sourceId:       source.id,
        companyId,
        accessToken:    access_token,
        organizationId: orgId,
        booksBaseUrl:   booksBase,
      })
    );

    // 6. Redirect to frontend
    return res.redirect(`${frontendUrl}/source?zoho=success`);

  } catch (err) {
    console.error("[zoho-callback]", err.message);
    return res.redirect(`${frontendUrl}/source?zoho=error&message=${encodeURIComponent(err.message)}`);
  }
};

/**
 * POST /api/shopify/sync/:sourceId
 * Manually trigger a full Shopify re-sync for an existing source.
 * Authenticated — only the owning company can trigger it.
 */
exports.triggerShopifySync = async (req, res) => {
  try {
    const sourceId  = Number(req.params.sourceId);
    const companyId = req.auth?.companyId ?? req.user?.company_id;

    const source = await Source.findOne({ where: { id: sourceId, company_id: companyId } });
    if (!source) {
      return res.status(404).json({ success: false, message: 'Source not found' });
    }

    const { shop, access_token } = source.connector_settings_json || {};
    if (!shop || !access_token) {
      return res.status(400).json({ success: false, message: 'Source is missing Shopify credentials' });
    }

    // Fire sync in background
    setImmediate(() => runShopifySync({ sourceId, companyId, shop, accessToken: access_token }));

    return res.status(202).json({
      success: true,
      message: 'Shopify sync started',
      data: { sourceId, status: 'processing' },
    });

  } catch (err) {
    console.error('[shopify-sync-trigger]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/source/zoho/sync/:sourceId
 * Manually trigger a full ZohoBooks re-sync for an existing source.
 */
exports.triggerZohoBooksSync = async (req, res) => {
  try {
    const sourceId  = Number(req.params.sourceId);
    const companyId = req.auth?.companyId ?? req.user?.company_id;

    const source = await Source.findOne({ where: { id: sourceId, company_id: companyId } });
    if (!source) {
      return res.status(404).json({ success: false, message: 'Source not found' });
    }

    const cfg = source.connector_settings_json || {};
    const { access_token, organization_id, region, accounts_server } = cfg;

    if (!access_token || !organization_id) {
      return res.status(400).json({ success: false, message: 'Source is missing ZohoBooks credentials or organization_id' });
    }

    // Derive Books API base URL from stored accounts_server or region.
    // REST API is at www.zohoapis.<tld>/books/v3 — NOT books.zoho.<tld>.
    const effectiveRegion = region || 'com';
    const booksBaseUrl = accounts_server
      ? accounts_server.replace('accounts.zoho', 'www.zohoapis')
      : `https://www.zohoapis.${effectiveRegion}`;

    setImmediate(() =>
      runZohoBooksSync({ sourceId, companyId, accessToken: access_token, organizationId: organization_id, booksBaseUrl })
    );

    return res.status(202).json({
      success: true,
      message: 'ZohoBooks sync started',
      data: { sourceId, status: 'processing' },
    });

  } catch (err) {
    console.error('[zoho-sync-trigger]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/shopify/test-connection
 * Tests Shopify connection with provided credentials
 */
exports.testShopifyConnection = async (req, res) => {
  try {
    const { shop, access_token, client_id, client_secret, auth_method } =
      req.body;

    if (!shop) {
      return res.status(400).json({
        success: false,
        message: "Shop domain is required",
      });
    }

    let testAccessToken = access_token;

    // If OAuth method but no access token, try to get one
    if (auth_method === "oauth" && (!access_token || access_token === "")) {
      if (!client_id || !client_secret) {
        return res.status(400).json({
          success: false,
          message:
            "For OAuth authentication, client_id and client_secret are required",
        });
      }

      // In a real scenario, you might want to initiate OAuth flow
      // For now, we'll return a message to complete OAuth first
      return res.status(400).json({
        success: false,
        message:
          "Please complete OAuth authentication first to get access token",
        requiresOAuth: true,
      });
    }

    try {
      const connectionTest = await testShopifyConnection(shop, testAccessToken);

      return res.status(200).json({
        success: true,
        data: connectionTest,
        message: "Shopify connection test successful",
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        data: {
          error: error.message,
          reconnectionRequired: true,
        },
        message: "Connection test failed",
      });
    }
  } catch (error) {
    console.error("Shopify connection test error:", error);
    return res.status(500).json({
      success: false,
      message: "Connection test failed",
    });
  }
};
/**
 * Test Shopify connection with access token
 */
// async function testShopifyConnection(shop, accessToken) {
//   try {
//     console.log("🔍 Testing Shopify Connection...");

//     // Test basic API access by fetching shop info
//     const response = await fetch(
//       `https://${shop}/admin/api/2024-01/shop.json`,
//       {
//         method: "GET",
//         headers: {
//           "X-Shopify-Access-Token": accessToken,
//           "Content-Type": "application/json",
//         },
//       }
//     );

//     if (!response.ok) {
//       const errorText = await response.text();
//       throw new Error(
//         `Shopify API test failed: ${response.status} ${errorText}`
//       );
//     }

//     const shopData = await response.json();
//     console.log("✅ Shopify connection successful");

//     return {
//       shop: shopData.shop,
//       connectionStatus: "connected",
//       message: "Shopify connection successful",
//     };
//   } catch (error) {
//     console.error("🔴 Shopify connection test failed:", error);
//     throw error;
//   }
// }

async function testShopifyConnection(shop, accessToken) {
  try {
    console.log(`🔍 Testing Shopify Connection for: ${shop}`);

    // Validate inputs
    if (!shop || !shop.trim()) {
      throw new Error("Shop domain is required");
    }
    
    if (!accessToken || !accessToken.trim()) {
      throw new Error("Access token is required");
    }

    // Normalize shop domain (remove protocol and trailing slashes)
    const normalizedShop = shop.replace(/^https?:\/\//, '').replace(/\/$/, '');
    
    // Test basic API access by fetching shop info
    const apiUrl = `https://${normalizedShop}/admin/api/2024-01/shop.json`;
    console.log(`📡 Testing API endpoint: ${apiUrl}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    const response = await fetch(apiUrl, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
        "User-Agent": "ETL-Connector/1.0"
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      let errorDetails = `HTTP ${response.status}`;
      
      try {
        const errorText = await response.text();
        const errorData = JSON.parse(errorText);
        errorDetails += ` - ${errorData.errors || errorText}`;
      } catch (parseError) {
        errorDetails += ` - ${response.statusText}`;
      }

      // Specific error handling for common Shopify API errors
      switch (response.status) {
        case 401:
          throw new Error(`Shopify authentication failed: Invalid access token or app permissions`);
        case 403:
          throw new Error(`Shopify access forbidden: Check app permissions and store access`);
        case 404:
          throw new Error(`Shopify store not found or invalid domain: ${normalizedShop}`);
        case 429:
          throw new Error(`Shopify API rate limit exceeded: Try again later`);
        case 500:
        case 502:
        case 503:
          throw new Error(`Shopify API server error: Please try again later`);
        default:
          throw new Error(`Shopify API error: ${errorDetails}`);
      }
    }

    const shopData = await response.json();
    
    if (!shopData.shop) {
      throw new Error("Invalid response from Shopify API: Missing shop data");
    }

    // Additional validation of shop data
    const requiredFields = ['id', 'name', 'myshopify_domain'];
    const missingFields = requiredFields.filter(field => !shopData.shop[field]);
    
    if (missingFields.length > 0) {
      console.warn(`⚠️ Shopify response missing fields: ${missingFields.join(', ')}`);
    }

    console.log("✅ Shopify connection successful");
    console.log(`🏪 Store: ${shopData.shop.name} (${shopData.shop.myshopify_domain})`);
    console.log(`📧 Email: ${shopData.shop.email || 'Not provided'}`);
    console.log(`💳 Plan: ${shopData.shop.plan_name || 'Unknown'}`);

    return {
      shop: shopData.shop,
      connectionStatus: "connected",
      environment: getShopEnvironment(shopData.shop), // You already have this function
      isLive: analyzeShopForProduction(shopData.shop), // You already have this function
      message: "Shopify connection successful",
      testedAt: new Date().toISOString(),
      apiVersion: "2024-01"
    };

  } catch (error) {
    console.error("🔴 Shopify connection test failed:", error.message);

    // Enhanced error categorization
    let errorType = "unknown_error";
    let userMessage = error.message;

    if (error.name === 'AbortError') {
      errorType = "timeout";
      userMessage = "Shopify connection timeout: The request took too long";
    } else if (error.message.includes('authentication') || error.message.includes('401')) {
      errorType = "authentication_error";
    } else if (error.message.includes('rate limit')) {
      errorType = "rate_limit_error";
    } else if (error.message.includes('not found') || error.message.includes('404')) {
      errorType = "store_not_found";
    } else if (error.message.includes('network') || error.message.includes('fetch')) {
      errorType = "network_error";
    }

    throw {
      type: errorType,
      message: userMessage,
      originalError: error.message,
      shop: shop,
      testedAt: new Date().toISOString()
    };
  }
}
function analyzeShopForProduction(shop) {
  if (!shop) return false;
  
  const indicators = {
    hasCustomDomain: shop.domain && !shop.domain.includes(".myshopify.com"),
    hasPaidPlan: !["trial", "development", "partner_test", "staff"].includes(shop.plan_name?.toLowerCase()),
    isNotTrial: shop.plan_name?.toLowerCase() !== "trial",
    hasStorefront: shop.has_storefront === true,
    financesEnabled: shop.finances === true,
    createdAgo: shop.created_at ? (new Date() - new Date(shop.created_at)) > (30 * 24 * 60 * 60 * 1000) : false, // Older than 30 days
  };

  const score = Object.values(indicators).filter(Boolean).length;
  return score >= 3; // Require multiple indicators
}

/**
 * Determine Shopify environment type
 */
function getShopEnvironment(shop) {
  const plan = shop.plan_name?.toLowerCase();
  const domain = shop.myshopify_domain || shop.domain || "";

  if (plan?.includes("development") || plan?.includes("partner_test")) {
    return "development";
  } else if (
    plan?.includes("staff") ||
    domain.includes("-dev") ||
    domain.includes("-staging")
  ) {
    return "staging";
  } else {
    return "production";
  }
}
/**
 * Enhanced Shopify connection test with timeout
 */
async function testShopifyConnectionWithTimeout(settings, timeoutMs = 30000) {
  const { shop, access_token } = settings;

  if (!shop || !access_token) {
    throw new Error("Shopify shop domain and access token are required");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await Promise.race([
      testShopifyConnection(shop, access_token),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Connection test timeout")),
          timeoutMs
        )
      ),
    ]);

    clearTimeout(timeoutId);
    return result;
  } catch (error) {
    clearTimeout(timeoutId);

    if (error.name === "AbortError") {
      throw new Error(`Shopify connection test timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}
/**
 * GET /api/shopify/check-connection/:sourceId
 * Checks Shopify connection status
 */
exports.checkShopifyConnection = async (req, res) => {
  try {
    const { sourceId } = req.params;

    // Get source from database
    const source = await Source.findByPk(sourceId);
    if (!source) {
      return res.status(404).json({
        success: false,
        message: "Source not found",
      });
    }

    if (source.connector_name !== "shopify") {
      return res.status(400).json({
        success: false,
        message: "Source is not a Shopify connection",
      });
    }

    const settings = source.connector_settings_json;
    const { shop, access_token } = settings;

    try {
      const connectionTest = await testShopifyConnection(shop, access_token);

      return res.status(200).json({
        success: true,
        data: connectionTest,
        message: "Shopify connection is active",
      });
    } catch (error) {
      // Connection failed - provide reconnection instructions
      const authUrl = await generateShopifyReconnectUrl(req, shop);

      return res.status(400).json({
        success: false,
        data: {
          error: error.message,
          reconnectionRequired: true,
          authUrl: authUrl,
          instructions: [
            "1. Click the authorization link above",
            "2. Log in to your Shopify store as admin",
            "3. Grant permissions to your app",
            "4. You'll be redirected back with new connection tokens",
          ],
        },
        message: "Reconnection required",
      });
    }
  } catch (error) {
    console.error("Shopify connection check error:", error);
    return res.status(500).json({
      success: false,
      message: "Connection check failed",
    });
  }
};

/**
 * Generate Shopify reconnection URL
 */
async function generateShopifyReconnectUrl(req, shop) {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const callbackUrl = `${baseUrl}/api/shopify/callback`;

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const scopes = [
    "read_products",
    "read_orders",
    "read_customers",
    "read_inventory",
  ].join(",");

  return (
    `https://${shop}/admin/oauth/authorize?` +
    `client_id=${clientId}&` +
    `scope=${scopes}&` +
    `redirect_uri=${encodeURIComponent(callbackUrl)}&` +
    `state=reconnect_${Date.now()}`
  );
}

exports.googleAuth = async (req, res) => {
  try {
    const {
      client_id,
      redirect_uri,
      scope,
      access_type = "offline",
      prompt = "consent",
    } = req.query;

    console.log("Received parameters:", { client_id, redirect_uri, scope });

    // Validate required parameters
    if (!client_id || !redirect_uri || !scope) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameters: client_id, redirect_uri, scope",
      });
    }

    // ✅ USE THE redirect_uri FROM FRONTEND, don't hardcode!
    const authUrl =
      `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${encodeURIComponent(client_id)}&` +
      `redirect_uri=${encodeURIComponent(redirect_uri)}&` +
      `response_type=code&` +
      `scope=${encodeURIComponent(scope)}&` +
      `access_type=${encodeURIComponent(access_type)}&` +
      `prompt=${encodeURIComponent(prompt)}`;

    console.log("Generated Google OAuth URL:", authUrl);

    res.json({
      success: true,
      auth_url: authUrl,
    });
  } catch (error) {
    console.error("Google auth error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error: " + error.message,
    });
  }
};

exports.googleCallback = async (req, res) => {
  try {
    const { client_id, client_secret, redirect_uri, code } = req.body;

    console.log("Callback received:", { client_id, redirect_uri, code });

    if (!client_id || !client_secret || !redirect_uri || !code) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameters",
      });
    }
    console.log("redirect_uri", redirect_uri);
    // Exchange code for tokens
    const tokenResponse = await axios.post(
      "https://oauth2.googleapis.com/token",
      {
        client_id,
        client_secret,
        code,
        redirect_uri, // ✅ Use the same redirect_uri
        grant_type: "authorization_code",
      }
    );

    const { access_token, refresh_token, expires_in } = tokenResponse.data;

    res.json({
      success: true,
      access_token,
      refresh_token,
      expires_in,
    });
  } catch (error) {
    console.error(
      "Google callback error:",
      error.response?.data || error.message
    );
    res.status(500).json({
      success: false,
      message: "Failed to exchange code for tokens",
    });
  }
};
exports.googleRefreshToken = async (req, res) => {
  try {
    console.log("googleRefreshToken API running...");
    const { client_id, client_secret, refresh_token } = req.body;

    // Validate required parameters
    if (!client_id || !client_secret || !refresh_token) {
      return res.status(400).json({
        success: false,
        data: null,
        message:
          "client_id, client_secret, and refresh_token are required parameters",
      });
    }

    const oauth2Client = new google.auth.OAuth2(client_id, client_secret);

    oauth2Client.setCredentials({
      refresh_token,
    });

    const { credentials } = await oauth2Client.refreshAccessToken();

    console.log("Google token refreshed successfully");

    return res.status(200).json({
      success: true,
      data: {
        tokens: credentials,
      },
      message: "Google access token refreshed successfully",
    });
  } catch (error) {
    console.error(
      "Google refresh token error:",
      error?.response?.data || error
    );
    return res.status(error?.response?.status || 500).json({
      success: false,
      data: null,
      message:
        error?.response?.data?.message ||
        "Failed to refresh Google access token",
    });
  }
};

exports.oneDriveAuth = async (req, res) => {
  try {
    console.log("oneDriveAuth API running...");
    // const { client_id, redirect_uri, scope } = req.query;
    const { client_id, redirect_uri, scope, tenant_id } = req.query;
    // Validate required parameters
    if (!client_id || !redirect_uri) {
      return res.status(400).json({
        success: false,
        data: null,
        message: "client_id and redirect_uri are required parameters",
      });
    }
    // Use tenant-specific endpoint if tenant_id is provided, otherwise use common
    const tenant = tenant_id || "common";
    const authUrl = new URL(
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`
    );
    // const authUrl = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');

    // authUrl.searchParams.append('client_id', client_id);
    // authUrl.searchParams.append('response_type', 'code');
    // authUrl.searchParams.append('redirect_uri', redirect_uri);
    // authUrl.searchParams.append('scope', scope || 'Files.Read.All offline_access');
    // authUrl.searchParams.append('response_mode', 'query');
    // authUrl.searchParams.append('prompt', 'consent');
    console.log("redirect_uri", redirect_uri);
    authUrl.searchParams.append("client_id", client_id);
    authUrl.searchParams.append("response_type", "code");
    authUrl.searchParams.append("redirect_uri", redirect_uri);
    authUrl.searchParams.append(
      "scope",
      scope || "Files.Read.All offline_access"
    );
    authUrl.searchParams.append("response_mode", "query");
    authUrl.searchParams.append("prompt", "consent");
    console.log(
      "OneDrive OAuth URL generated successfully:",
      authUrl.toString()
    );

    // Return the response in the expected format
    return res.status(200).json({
      success: true,
      data: {
        auth_url: authUrl.toString(), // Make sure this matches what frontend expects
      },
      message: "OneDrive OAuth URL generated successfully",
    });
  } catch (error) {
    console.error("OneDrive OAuth error:", error?.response?.data || error);
    return res.status(error?.response?.status || 500).json({
      success: false,
      data: null,
      message:
        error?.response?.data?.message ||
        "Failed to generate OneDrive OAuth URL",
    });
  }
};
exports.oneDriveCallback = async (req, res) => {
  try {
    console.log("oneDriveCallback API running...");
    const { client_id, client_secret, redirect_uri, code } = req.body;

    // Validate required parameters
    if (!client_id || !client_secret || !redirect_uri || !code) {
      return res.status(400).json({
        success: false,
        data: null,
        message:
          "client_id, client_secret, redirect_uri, and code are required parameters",
      });
    }

    const tokenResponse = await fetch(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id,
          client_secret,
          code,
          redirect_uri,
          grant_type: "authorization_code",
          scope: "Files.Read.All offline_access",
        }),
      }
    );

    const tokens = await tokenResponse.json();

    if (!tokenResponse.ok) {
      throw new Error(
        tokens.error_description || "Failed to get tokens from Microsoft"
      );
    }

    // Verify the tokens work by making a test API call
    const verifyResponse = await fetch(
      "https://graph.microsoft.com/v1.0/me/drive/root/children?$top=1",
      {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
        },
      }
    );

    if (!verifyResponse.ok) {
      throw new Error("Failed to verify OneDrive access with provided tokens");
    }

    const verificationData = await verifyResponse.json();

    console.log("OneDrive OAuth callback completed successfully");

    return res.status(200).json({
      success: true,
      data: {
        tokens: {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_in: tokens.expires_in,
          scope: tokens.scope,
          token_type: tokens.token_type,
        },
        verification: {
          item_count: verificationData.value?.length || 0,
          can_access_drive: true,
        },
      },
      message: "OneDrive OAuth authentication completed successfully",
    });
  } catch (error) {
    console.error(
      "OneDrive OAuth callback error:",
      error?.response?.data || error
    );
    return res.status(error?.response?.status || 500).json({
      success: false,
      data: null,
      message:
        error?.response?.data?.message ||
        "OneDrive OAuth authentication failed",
    });
  }
};

exports.oneDriveRefreshToken = async (req, res) => {
  try {
    console.log("oneDriveRefreshToken API running...");
    const { client_id, client_secret, refresh_token } = req.body;

    // Validate required parameters
    if (!client_id || !client_secret || !refresh_token) {
      return res.status(400).json({
        success: false,
        data: null,
        message:
          "client_id, client_secret, and refresh_token are required parameters",
      });
    }

    const tokenResponse = await fetch(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id,
          client_secret,
          refresh_token,
          grant_type: "refresh_token",
          scope: "Files.Read.All offline_access",
        }),
      }
    );

    const tokens = await tokenResponse.json();

    if (!tokenResponse.ok) {
      throw new Error(
        tokens.error_description || "Failed to refresh tokens from Microsoft"
      );
    }

    console.log("OneDrive token refreshed successfully");

    return res.status(200).json({
      success: false,
      data: {
        tokens: tokens,
      },
      message: "OneDrive access token refreshed successfully",
    });
  } catch (error) {
    console.error(
      "OneDrive refresh token error:",
      error?.response?.data || error
    );
    return res.status(error?.response?.status || 500).json({
      success: false,
      data: null,
      message:
        error?.response?.data?.message ||
        "Failed to refresh OneDrive access token",
    });
  }
};

/* ====================================================================== */
/*                          CHECK CONNECTION FUNCTION                     */
/* ====================================================================== */

/**
 * POST /api/source/check-connection
 * Tests connection for various source types with proper validation
 */
exports.checkConnection = async (req, res) => {
  try {
    const { configuration, connectionConfiguration } = req.body;
    let sourceType =
      configuration?.sourceType ||
      req.body.sourceType ||
      connectionConfiguration?.sourceType;
    console.log("Received connection test request:", req.body);
    if (!sourceType) {
      return res.status(400).json({
        success: false,
        message: "Source type is required",
      });
    }

    console.log(`🔍 Testing connection for source type: ${sourceType}`);

    let testResult;

    switch (sourceType.toLowerCase()) {
      case "shopify":
        testResult = await testShopifyConnectionForCheck(
          configuration || connectionConfiguration
        );
        break;

      case "quickbooks":
        testResult = await testQuickBooksConnectionForCheck(
          configuration || connectionConfiguration
        );
        break;

      case "google drive":
        testResult = await testGoogleDriveConnectionForCheck(
          configuration || connectionConfiguration
        );
        break;

      case "postgres":
        testResult = await testPostgreSQLConnectionForCheck(
          configuration || connectionConfiguration
        );
        break;

      case "excel":
        testResult = await testExcelConnectionForCheck(
          configuration || connectionConfiguration
        );
        break;

      case "mysql":
        testResult = await testMySQLConnectionForCheck(
          configuration || connectionConfiguration
        );
        break;

      case "sqlserver":
        testResult = await testSQLServerConnectionForCheck(
          configuration || connectionConfiguration
        );
        break;

      default:
        return res.status(400).json({
          success: false,
          message: `Unsupported source type for connection test: ${sourceType}`,
        });
    }

    return res.status(200).json({
      success: true,
      data: testResult,
      message: "Connection test completed successfully",
    });
  } catch (error) {
    console.error("Connection test error:", error);

    return res.status(400).json({
      success: false,
      message: error.message || "Connection test failed",
      error: error.details || error.message,
      requiresReauthorization: error.requiresReauthorization || false,
    });
  }
};

/* ====================================================================== */
/*                      INDIVIDUAL CONNECTION TESTERS                     */
/* ====================================================================== */

/**
 * Shopify Connection Test
 */
async function testShopifyConnectionForCheck(config) {
  const { shop, credentials } = config;

  if (!shop) {
    throw new Error("Shopify shop URL is required");
  }

  if (!credentials) {
    throw new Error("Shopify credentials are required");
  }

  const { auth_method, access_token, api_password, client_id, client_secret } =
    credentials;

  if (auth_method === "oauth") {
    if (!access_token) {
      throw new Error("Access token is required for OAuth authentication");
    }
    if (!client_id || !client_secret) {
      throw new Error("Client ID and Client Secret are required for OAuth");
    }
  } else if (auth_method === "api_password") {
    if (!api_password) {
      throw new Error(
        "API password is required for API password authentication"
      );
    }
  } else {
    throw new Error("Invalid authentication method");
  }

  try {
    // Test with the access token (for OAuth) or API password
    const testToken = auth_method === "oauth" ? access_token : api_password;

    const response = await fetch(
      `https://${shop}/admin/api/2024-01/shop.json`,
      {
        method: "GET",
        headers: {
          "X-Shopify-Access-Token": testToken,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();

      if (response.status === 401) {
        throw new Error(
          "Authentication failed - invalid access token or API password"
        );
      } else if (response.status === 404) {
        throw new Error("Shop not found - please check your shop URL");
      } else {
        throw new Error(`Shopify API error: ${response.status} ${errorText}`);
      }
    }

    const shopData = await response.json();

    return {
      connectionStatus: "connected",
      shop: shopData.shop,
      message: "Successfully connected to Shopify store",
      details: {
        shopName: shopData.shop.name,
        email: shopData.shop.email,
        domain: shopData.shop.domain,
        plan: shopData.shop.plan_name,
      },
    };
  } catch (error) {
    console.error("Shopify connection test failed:", error);

    if (
      error.message.includes("Authentication failed") ||
      error.message.includes("invalid access token")
    ) {
      error.requiresReauthorization = true;
    }

    throw error;
  }
}

/**
 * QuickBooks Connection Test
 */
async function testQuickBooksConnectionForCheck(config) {
  const {
    access_token,
    realm_id,
    client_id,
    client_secret,
    refresh_token,
    environment = "sandbox",
  } = config;

  if (!access_token || !realm_id) {
    throw new Error("QuickBooks access_token and realm_id are required");
  }

  const baseUrl =
    environment === "sandbox"
      ? "https://sandbox-quickbooks.api.intuit.com"
      : "https://quickbooks.api.intuit.com";

  try {
    // Test company info endpoint
    const response = await fetch(
      `${baseUrl}/v3/company/${realm_id}/companyinfo/${realm_id}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${access_token}`,
          Accept: "application/json",
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();

      if (response.status === 401) {
        // Try to refresh token if refresh token is available
        if (refresh_token && client_id && client_secret) {
          try {
            const newTokens = await refreshQuickBooksToken({
              client_id,
              client_secret,
              refresh_token,
            });

            // Retry with new token
            const retryResponse = await fetch(
              `${baseUrl}/v3/company/${realm_id}/companyinfo/${realm_id}`,
              {
                method: "GET",
                headers: {
                  Authorization: `Bearer ${newTokens.access_token}`,
                  Accept: "application/json",
                },
              }
            );

            if (retryResponse.ok) {
              const companyData = await retryResponse.json();
              return {
                connectionStatus: "connected",
                message: "QuickBooks connection successful (token refreshed)",
                companyInfo: companyData.CompanyInfo,
                tokensRefreshed: true,
                newAccessToken: newTokens.access_token,
              };
            }
          } catch (refreshError) {
            console.error("Token refresh failed:", refreshError);
          }
        }

        throw new Error(
          "Authentication failed - access token is invalid or expired"
        );
      } else if (response.status === 403) {
        throw new Error(
          "Access forbidden - check if your app is properly connected to this QuickBooks company"
        );
      } else {
        throw new Error(
          `QuickBooks API error: ${response.status} ${errorText}`
        );
      }
    }

    const companyData = await response.json();

    return {
      connectionStatus: "connected",
      message: "Successfully connected to QuickBooks",
      companyInfo: companyData.CompanyInfo,
      details: {
        companyName: companyData.CompanyInfo.CompanyName,
        legalName: companyData.CompanyInfo.LegalName,
        companyAddress: companyData.CompanyInfo.CompanyAddr,
      },
    };
  } catch (error) {
    console.error("QuickBooks connection test failed:", error);

    if (
      error.message.includes("Authentication failed") ||
      error.message.includes("invalid or expired")
    ) {
      error.requiresReauthorization = true;
    }

    throw error;
  }
}

/**
 * Google Drive Connection Test
 */
async function testGoogleDriveConnectionForCheck(config) {
  const { client_id, client_secret, access_token, refresh_token, folder_id } =
    config;

  if (!client_id || !client_secret || !access_token) {
    throw new Error(
      "Google Drive client_id, client_secret, and access_token are required"
    );
  }

  try {
    const OAuth2 = google.auth.OAuth2;
    const oauth2Client = new OAuth2(client_id, client_secret);

    oauth2Client.setCredentials({
      access_token,
      refresh_token,
    });

    const drive = google.drive({ version: "v3", auth: oauth2Client });

    // Test 1: Verify authentication by getting user info
    const aboutResponse = await drive.about.get({
      fields: "user,storageQuota",
    });

    // Test 2: If folder_id provided, verify folder access
    let folderInfo = null;
    if (folder_id) {
      const folderResponse = await drive.files.get({
        fileId: folder_id,
        fields: "id,name,mimeType,capabilities",
      });

      if (
        folderResponse.data.mimeType !== "application/vnd.google-apps.folder"
      ) {
        throw new Error("The provided Folder ID is not a Google Drive folder");
      }

      folderInfo = folderResponse.data;
    }

    return {
      connectionStatus: "connected",
      message: "Successfully connected to Google Drive",
      details: {
        user: aboutResponse.data.user,
        storageQuota: aboutResponse.data.storageQuota,
        folder: folderInfo,
      },
    };
  } catch (error) {
    console.error("Google Drive connection test failed:", error);

    let userMessage = error.message;
    let requiresReauthorization = false;

    if (error.code === 401) {
      userMessage =
        "Authentication failed - access token is invalid or expired";
      requiresReauthorization = true;
    } else if (error.code === 403) {
      userMessage = "Access denied - check folder permissions and OAuth scopes";
    }

    const enhancedError = new Error(userMessage);
    enhancedError.requiresReauthorization = requiresReauthorization;
    throw enhancedError;
  }
}

/**
 * PostgreSQL Connection Test
 */
async function testPostgreSQLConnectionForCheck(config) {
  const {
    host,
    port,
    database,
    username,
    password,
    schema = "public",
  } = config;

  if (!host || !port || !database || !username || !password) {
    throw new Error(
      "PostgreSQL host, port, database, username, and password are required"
    );
  }

  const client = new Client({
    host,
    port: parseInt(port),
    user: username,
    password,
    database,
    ssl:
      config?.ssl_mode?.mode === "disable"
        ? false
        : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });

  try {
    await client.connect();

    // Test basic query
    const result = await client.query(
      "SELECT version(), current_database(), current_user"
    );
    const version = result.rows[0];

    // Test schema access
    const tableCount = await client.query(
      `
      SELECT COUNT(*) as table_count 
      FROM information_schema.tables 
      WHERE table_schema = $1
    `,
      [schema]
    );

    await client.end();

    return {
      connectionStatus: "connected",
      message: "Successfully connected to PostgreSQL database",
      details: {
        version: version.version,
        database: version.current_database,
        user: version.current_user,
        tablesInSchema: parseInt(tableCount.rows[0].table_count),
        schema: schema,
      },
    };
  } catch (error) {
    console.error("PostgreSQL connection test failed:", error);

    let userMessage = error.message;

    if (error.code === "ECONNREFUSED") {
      userMessage = `Connection refused - cannot connect to ${host}:${port}`;
    } else if (error.code === "ENOTFOUND") {
      userMessage = `Host not found - ${host}`;
    } else if (error.code === "28P01") {
      userMessage = "Authentication failed - invalid username or password";
    } else if (error.code === "3D000") {
      userMessage = `Database not found - ${database}`;
    }

    throw new Error(userMessage);
  }
}

/**
 * MySQL Connection Test
 */
async function testMySQLConnectionForCheck(config) {
  // MySQL connection test implementation
  // You'll need to install mysql2 package: npm install mysql2
  const mysql = require("mysql2/promise");

  const { host, port, database, username, password } = config;

  if (!host || !port || !database || !username || !password) {
    throw new Error(
      "MySQL host, port, database, username, and password are required"
    );
  }

  let connection;
  try {
    connection = await mysql.createConnection({
      host,
      port: parseInt(port),
      user: username,
      password,
      database,
      connectTimeout: 10000,
    });

    // Test basic query
    const [rows] = await connection.execute(
      "SELECT VERSION() as version, DATABASE() as database, USER() as user"
    );
    const version = rows[0];

    return {
      connectionStatus: "connected",
      message: "Successfully connected to MySQL database",
      details: {
        version: version.version,
        database: version.database,
        user: version.user,
      },
    };
  } catch (error) {
    console.error("MySQL connection test failed:", error);

    let userMessage = error.message;

    if (error.code === "ECONNREFUSED") {
      userMessage = `Connection refused - cannot connect to ${host}:${port}`;
    } else if (error.code === "ER_ACCESS_DENIED_ERROR") {
      userMessage = "Authentication failed - invalid username or password";
    } else if (error.code === "ER_BAD_DB_ERROR") {
      userMessage = `Database not found - ${database}`;
    }

    throw new Error(userMessage);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

/**
 * SQL Server Connection Test
 */
async function testSQLServerConnectionForCheck(config) {
  // SQL Server connection test implementation
  // You'll need to install mssql package: npm install mssql
  const sql = require("mssql");

  const { host, port, database, username, password } = config;

  if (!host || !database || !username || !password) {
    throw new Error(
      "SQL Server host, database, username, and password are required"
    );
  }

  try {
    const pool = await sql.connect({
      server: host,
      port: port ? parseInt(port) : 1433,
      database,
      user: username,
      password,
      options: {
        enableArithAbort: true,
        trustServerCertificate: true,
        connectTimeout: 10000,
      },
    });

    // Test basic query
    const result = await pool
      .request()
      .query("SELECT @@VERSION as version, DB_NAME() as database_name");
    const version = result.recordset[0];

    await pool.close();

    return {
      connectionStatus: "connected",
      message: "Successfully connected to SQL Server database",
      details: {
        version: version.version,
        database: version.database_name,
      },
    };
  } catch (error) {
    console.error("SQL Server connection test failed:", error);

    let userMessage = error.message;

    if (error.code === "ECONNREFUSED") {
      userMessage = `Connection refused - cannot connect to ${host}:${
        port || 1433
      }`;
    } else if (error.message.includes("Login failed")) {
      userMessage = "Authentication failed - invalid username or password";
    } else if (error.message.includes("Cannot open database")) {
      userMessage = `Database not found - ${database}`;
    }

    throw new Error(userMessage);
  }
}

/**
 * Excel Connection Test
 */
async function testExcelConnectionForCheck(config) {
  const { filePath, originalName, url } = config;

  if (!filePath && !url) {
    throw new Error("Excel file path or URL is required");
  }

  try {
    let fileBuffer;

    if (url) {
      // Download file from URL
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `Failed to download Excel file from URL: ${response.status}`
        );
      }
      fileBuffer = await response.buffer();
    } else {
      // Read file from local path
      const fs = require("fs").promises;
      fileBuffer = await fs.readFile(filePath);
    }

    // Parse Excel file to verify it's valid
    const workbook = xlsx.read(fileBuffer, { type: "buffer" });
    const sheetNames = workbook.SheetNames;

    if (sheetNames.length === 0) {
      throw new Error("Excel file contains no sheets");
    }

    // Test reading first sheet
    const firstSheet = workbook.Sheets[sheetNames[0]];
    const jsonData = xlsx.utils.sheet_to_json(firstSheet, { header: 1 });

    return {
      connectionStatus: "connected",
      message: "Successfully validated Excel file",
      details: {
        fileName: originalName || "Excel File",
        sheetCount: sheetNames.length,
        sheetNames: sheetNames,
        firstSheetColumns: jsonData[0] || [],
        totalRows: jsonData.length - 1,
      },
    };
  } catch (error) {
    console.error("Excel connection test failed:", error);

    let userMessage = error.message;

    if (
      error.message.includes("Cannot read file") ||
      error.message.includes("file not found")
    ) {
      userMessage = "Excel file not found or inaccessible";
    } else if (error.message.includes("corrupt")) {
      userMessage = "Excel file appears to be corrupt or invalid";
    } else if (error.message.includes("password")) {
      userMessage = "Excel file is password protected";
    }

    throw new Error(userMessage);
  }
}

/* ====================================================================== */
/*                              HELPER FUNCTIONS                          */
/* ====================================================================== */

/**
 * QuickBooks Token Refresh Helper
 */
async function refreshQuickBooksToken(settings) {
  const { client_id, client_secret, refresh_token } = settings;

  if (!client_id || !client_secret || !refresh_token) {
    throw new Error("Missing credentials for token refresh");
  }

  const tokenEndpoint =
    "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

  try {
    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(
          `${client_id}:${client_secret}`
        ).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refresh_token,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token refresh failed: ${response.status} ${errorText}`);
    }

    const tokenData = await response.json();

    return {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_in: tokenData.expires_in,
    };
  } catch (error) {
    console.error("Token refresh error:", error);
    throw error;
  }
}

async function discoverShopifySchemaWithBigInt(shop, access_token) {
  const apiVersion = "2024-01";
  const baseUrl = `https://${shop}/admin/api/${apiVersion}`;
  
  // COMPLETE Shopify entities list
  const shopifyEntities = [
    // Products & Inventory
    { name: "products", displayName: "Products", category: "products" },
    { name: "variants", displayName: "Product Variants", category: "products" },
    { name: "collections", displayName: "Collections", category: "products" },
    { name: "collects", displayName: "Collects", category: "products" },
    { name: "custom_collections", displayName: "Custom Collections", category: "products" },
    { name: "smart_collections", displayName: "Smart Collections", category: "products" },
    { name: "inventory_items", displayName: "Inventory Items", category: "inventory" },
    { name: "inventory_levels", displayName: "Inventory Levels", category: "inventory" },
    { name: "locations", displayName: "Locations", category: "inventory" },
    
    // Sales & Orders
    { name: "orders", displayName: "Orders", category: "sales" },
    { name: "draft_orders", displayName: "Draft Orders", category: "sales" },
    { name: "abandoned_checkouts", displayName: "Abandoned Checkouts", category: "sales" },
    { name: "fulfillments", displayName: "Fulfillments", category: "sales" },
    { name: "fulfillment_orders", displayName: "Fulfillment Orders", category: "sales" },
    { name: "fulfillment_events", displayName: "Fulfillment Events", category: "sales" },
    { name: "transactions", displayName: "Transactions", category: "sales" },
    { name: "refunds", displayName: "Refunds", category: "sales" },
    { name: "tender_transactions", displayName: "Tender Transactions", category: "sales" },
    
    // Customers
    { name: "customers", displayName: "Customers", category: "customers" },
    { name: "customer_address", displayName: "Customer Addresses", category: "customers" },
    { name: "customer_saved_searches", displayName: "Customer Saved Searches", category: "customers" },
    
    // Marketing & Discounts
    { name: "price_rules", displayName: "Price Rules", category: "marketing" },
    { name: "discount_codes", displayName: "Discount Codes", category: "marketing" },
    { name: "marketing_events", displayName: "Marketing Events", category: "marketing" },
    
    // Store Operations
    // { name: "shop", displayName: "Shop", category: "store" },
    { name: "themes", displayName: "Themes", category: "store" },
    { name: "assets", displayName: "Assets", category: "store" },
    { name: "pages", displayName: "Pages", category: "store" },
    { name: "blogs", displayName: "Blogs", category: "store" },
    { name: "articles", displayName: "Articles", category: "store" },
    { name: "comments", displayName: "Comments", category: "store" },
    { name: "redirects", displayName: "Redirects", category: "store" },
    { name: "script_tags", displayName: "Script Tags", category: "store" },
    
    // Shipping & Fulfillment
    { name: "carrier_services", displayName: "Carrier Services", category: "shipping" },
    { name: "shipping_zones", displayName: "Shipping Zones", category: "shipping" },
    { name: "countries", displayName: "Countries", category: "shipping" },
    
    // Analytics & Reports
    { name: "reports", displayName: "Reports", category: "analytics" },
    
    // Global Metafields
    { name: "metafields", displayName: "Metafields", category: "metadata" },
    
    // Resource-specific Metafields (from your image)
    { name: "metafield_blogs", displayName: "Blog Metafields", category: "metadata" },
    { name: "metafield_collections", displayName: "Collection Metafields", category: "metadata" },
    { name: "metafield_customers", displayName: "Customer Metafields", category: "metadata" },
    { name: "metafield_draft_orders", displayName: "Draft Order Metafields", category: "metadata" },
    { name: "metafield_locations", displayName: "Location Metafields", category: "metadata" },
    { name: "metafield_orders", displayName: "Order Metafields", category: "metadata" },
    { name: "metafield_pages", displayName: "Page Metafields", category: "metadata" },
    { name: "metafield_product_images", displayName: "Product Image Metafields", category: "metadata" },
    { name: "metafield_product_variants", displayName: "Product Variant Metafields", category: "metadata" },
    { name: "metafield_products", displayName: "Product Metafields", category: "metadata" },
    { name: "metafield_shops", displayName: "Shop Metafields", category: "metadata" },
    
    // Gift Cards
    { name: "gift_cards", displayName: "Gift Cards", category: "sales" },
    
    // Users & Permissions
    { name: "users", displayName: "Users", category: "store" },
    { name: "storefront_access_tokens", displayName: "Storefront Access Tokens", category: "store" },
    
    // Billing
    { name: "application_charges", displayName: "Application Charges", category: "billing" },
    { name: "recurring_application_charges", displayName: "Recurring Charges", category: "billing" },
    
    // Events & Webhooks
    { name: "events", displayName: "Events", category: "events" },
    { name: "webhooks", displayName: "Webhooks", category: "events" }
  ];

  const streams = [];
  let entitiesWithData = 0;
  let entitiesWithoutData = 0;
  let entitiesWithErrors = 0;

  console.log(`🔍 Checking ${shopifyEntities.length} Shopify entities for schema discovery...`);

  for (const entity of shopifyEntities) {
    try {
      console.log(`📋 Processing entity: ${entity.name}`);
      
      // Special handling for metafield endpoints
      let url;
      if (entity.name.startsWith('metafield_')) {
        const resourceType = entity.name.replace('metafield_', '');
        // For metafield endpoints, we need to first get a sample resource ID
        const sampleResource = await fetchSampleResource(baseUrl, resourceType, access_token);
        if (!sampleResource) {
          console.log(`⏭️ No sample resource found for: ${entity.name}`);
          entitiesWithoutData++;
          continue;
        }
        url = `${baseUrl}/${resourceType}/${sampleResource.id}/metafields.json?limit=1`;
      } else {
        url = `${baseUrl}/${entity.name}.json?limit=1`;
      }

      const response = await fetch(url, {
        headers: {
          "X-Shopify-Access-Token": access_token,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          console.log(`⏭️ Entity not available: ${entity.name}`);
          entitiesWithoutData++;
          continue;
        }
        if (response.status === 403) {
          console.log(`🚫 Access forbidden: ${entity.name}`);
          entitiesWithoutData++;
          continue;
        }
        if (response.status === 422) {
          console.log(`🔄 Entity requires different endpoint: ${entity.name}`);
          entitiesWithoutData++;
          continue;
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      let entities;
      
      // Handle different response structures
      if (entity.name.startsWith('metafield_')) {
        entities = data.metafields || [];
      } else {
        entities = data[entity.name] || data[entity.name.slice(0, -1)] || [];
      }
      
      if (entities.length === 0) {
        console.log(`ℹ️ No data available for: ${entity.name}`);
        entitiesWithoutData++;
        continue;
      }

      const sample = entities[0];
      const properties = extractShopifyFieldsWithBigInt(sample, entity.name);
      const primaryKeys = detectShopifyPrimaryKeys(entity.name);
      const cursorField = detectShopifyCursorField(entity.name);

      streams.push({
        stream: {
          name: entity.name,
          jsonSchema: { 
            type: "object",
            properties: properties 
          },
          primaryKeys,
          supportedSyncModes: ["full_refresh", "incremental"],
          sourceDefinedCursor: !!cursorField,
          defaultCursorField: cursorField,
          shopifyMetadata: {
            displayName: entity.displayName,
            category: entity.category,
            hasData: true,
            sampleSize: entities.length,
            fieldsCount: Object.keys(properties).length
          }
        },
        config: {
          selected: false,
          syncMode: "full_refresh",
          destinationSyncMode: "overwrite",
          cursorField: cursorField,
          aliasName: entity.name,
        },
      });

      entitiesWithData++;
      console.log(`✅ Schema discovered for: ${entity.name} (${Object.keys(properties).length} fields)`);

      // Rate limiting - be gentle with Shopify API
      await new Promise(resolve => setTimeout(resolve, 300));

    } catch (error) {
      console.error(`❌ Error processing ${entity.name}:`, error.message);
      entitiesWithErrors++;
    }
  }

  return {
    streams,
    summary: {
      totalEntities: shopifyEntities.length,
      entitiesWithData,
      entitiesWithoutData,
      entitiesWithErrors,
      successRate: `${Math.round((entitiesWithData / shopifyEntities.length) * 100)}%`,
      coverage: `${Math.round((entitiesWithData / shopifyEntities.length) * 100)}%`
    }
  };
}

/**
 * Fetch a sample resource for metafield endpoints
 */
async function fetchSampleResource(baseUrl, resourceType, access_token) {
  try {
    const url = `${baseUrl}/${resourceType}.json?limit=1`;
    const response = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": access_token,
        "Content-Type": "application/json",
      },
    });

    if (response.ok) {
      const data = await response.json();
      const resources = data[resourceType] || data[resourceType.slice(0, -1)] || [];
      return resources[0] || null;
    }
    return null;
  } catch (error) {
    console.error(`Error fetching sample resource for ${resourceType}:`, error.message);
    return null;
  }
}

/**
 * Extract Shopify fields with proper BIGINT handling for IDs
 */
function extractShopifyFieldsWithBigInt(obj, entityName, prefix = "") {
  const fields = {};
  
  for (const [key, value] of Object.entries(obj || {})) {
    const fieldName = prefix ? `${prefix}.${key}` : key;
    const fullFieldName = fieldName.toLowerCase();
    
    // 🚨 CRITICAL: Detect ID fields and use BIGINT
    if (fullFieldName.includes('id') || fullFieldName.endsWith('_id')) {
      fields[fieldName] = { 
        type: "bigint",
        shopifyType: "id",
        description: `Shopify ${entityName} ID field`
      };
    } 
    // Handle numeric fields that might be large
    else if (fullFieldName.includes('amount') || fullFieldName.includes('price') || 
             fullFieldName.includes('quantity') || fullFieldName.includes('total') ||
             fullFieldName.includes('subtotal') || fullFieldName.includes('weight')) {
      fields[fieldName] = { 
        type: "numeric",
        shopifyType: "currency_or_quantity",
        description: `Shopify ${entityName} numeric field`
      };
    }
    // Handle dates
    else if (fullFieldName.includes('date') || fullFieldName.includes('_at')) {
      fields[fieldName] = { 
        type: "string",
        format: "date-time",
        shopifyType: "timestamp",
        description: `Shopify ${entityName} timestamp field`
      };
    }
    // Handle booleans
    else if (typeof value === "boolean") {
      fields[fieldName] = { 
        type: "boolean",
        shopifyType: "boolean",
        description: `Shopify ${entityName} boolean field`
      };
    }
    // Handle arrays
    else if (Array.isArray(value)) {
      if (value.length > 0 && typeof value[0] === "object") {
        // Array of objects - extract nested fields
        fields[fieldName] = { 
          type: "array",
          items: { type: "object" },
          shopifyType: "object_array",
          description: `Shopify ${entityName} array of objects`
        };
        
        // Extract sample from first array item
        if (value[0]) {
          const nestedFields = extractShopifyFieldsWithBigInt(value[0], entityName, `${fieldName}[0]`);
          Object.assign(fields, nestedFields);
        }
      } else {
        // Array of primitives
        const itemType = value.length > 0 ? typeof value[0] : "string";
        fields[fieldName] = { 
          type: "array",
          items: { type: itemType },
          shopifyType: "primitive_array",
          description: `Shopify ${entityName} array field`
        };
      }
    }
    // Handle nested objects
    else if (typeof value === "object" && value !== null) {
      fields[fieldName] = { 
        type: "object",
        shopifyType: "nested_object",
        description: `Shopify ${entityName} nested object`
      };
      
      // Recursively extract nested fields
      const nestedFields = extractShopifyFieldsWithBigInt(value, entityName, fieldName);
      Object.assign(fields, nestedFields);
    }
    // Handle strings and other types
    else {
      fields[fieldName] = { 
        type: typeof value,
        shopifyType: "primitive",
        description: `Shopify ${entityName} field`
      };
    }
  }
  
  return fields;
}

/**
 * Detect primary keys for Shopify entities
 */
function detectShopifyPrimaryKeys(entityName) {
  const primaryKeyMap = {
    // Products
    products: ["id"],
    variants: ["id"],
    collections: ["id"],
    collects: ["id"],
    custom_collections: ["id"],
    smart_collections: ["id"],
    
    // Inventory
    inventory_items: ["id"],
    inventory_levels: ["inventory_item_id", "location_id"],
    locations: ["id"],
    
    // Sales
    orders: ["id"],
    draft_orders: ["id"],
    abandoned_checkouts: ["id"],
    fulfillments: ["id"],
    fulfillment_orders: ["id"],
    fulfillment_events: ["id"],
    transactions: ["id"],
    refunds: ["id"],
    tender_transactions: ["id"],
    gift_cards: ["id"],
    
    // Customers
    customers: ["id"],
    customer_address: ["id"],
    customer_saved_searches: ["id"],
    
    // Marketing
    price_rules: ["id"],
    discount_codes: ["id"],
    marketing_events: ["id"],
    
    // Store
    // shop: ["id"],
    themes: ["id"],
    assets: ["key"],
    pages: ["id"],
    blogs: ["id"],
    articles: ["id"],
    comments: ["id"],
    redirects: ["id"],
    script_tags: ["id"],
    
    // Shipping
    carrier_services: ["id"],
    shipping_zones: ["id"],
    countries: ["id"],
    
    // Analytics
    reports: ["id"],
    
    // Metafields
    metafields: ["id"],
    metafield_blogs: ["id"],
    metafield_collections: ["id"],
    metafield_customers: ["id"],
    metafield_draft_orders: ["id"],
    metafield_locations: ["id"],
    metafield_orders: ["id"],
    metafield_pages: ["id"],
    metafield_product_images: ["id"],
    metafield_product_variants: ["id"],
    metafield_products: ["id"],
    // metafield_shops: ["id"],
    
    // Users
    users: ["id"],
    storefront_access_tokens: ["id"],
    
    // Billing
    application_charges: ["id"],
    recurring_application_charges: ["id"],
    
    // Events
    events: ["id"],
    webhooks: ["id"]
  };
  
  return primaryKeyMap[entityName] || ["id"];
}

/**
 * Detect cursor fields for incremental sync
 */
function detectShopifyCursorField(entityName) {
  const cursorFieldMap = {
    orders: ["updated_at"],
    customers: ["updated_at"],
    products: ["updated_at"],
    variants: ["updated_at"],
    collections: ["updated_at"],
    inventory_items: ["updated_at"],
    events: ["created_at"],
    webhooks: ["updated_at"],
    pages: ["updated_at"],
    articles: ["updated_at"],
    blogs: ["updated_at"],
    metafields: ["updated_at"],
    metafield_blogs: ["updated_at"],
    metafield_collections: ["updated_at"],
    metafield_customers: ["updated_at"],
    metafield_draft_orders: ["updated_at"],
    metafield_locations: ["updated_at"],
    metafield_orders: ["updated_at"],
    metafield_pages: ["updated_at"],
    metafield_product_images: ["updated_at"],
    metafield_product_variants: ["updated_at"],
    metafield_products: ["updated_at"],
    metafield_shops: ["updated_at"]
  };
  
  return cursorFieldMap[entityName] || [];
}
// async function discoverShopifySchemaWithBigInt(shop, access_token) {
//   const apiVersion = "2024-01";
//   const baseUrl = `https://${shop}/admin/api/${apiVersion}`;
  
//   // COMPLETE Shopify entities list
//   const shopifyEntities = [
//     // Products & Inventory
//     { name: "products", displayName: "Products", category: "products" },
//     { name: "variants", displayName: "Product Variants", category: "products" },
//     { name: "collections", displayName: "Collections", category: "products" },
//     { name: "collects", displayName: "Collects", category: "products" },
//     { name: "custom_collections", displayName: "Custom Collections", category: "products" },
//     { name: "smart_collections", displayName: "Smart Collections", category: "products" },
//     { name: "inventory_items", displayName: "Inventory Items", category: "inventory" },
//     { name: "inventory_levels", displayName: "Inventory Levels", category: "inventory" },
//     { name: "locations", displayName: "Locations", category: "inventory" },
    
//     // Sales & Orders
//     { name: "orders", displayName: "Orders", category: "sales" },
//     { name: "draft_orders", displayName: "Draft Orders", category: "sales" },
//     { name: "abandoned_checkouts", displayName: "Abandoned Checkouts", category: "sales" },
//     { name: "fulfillments", displayName: "Fulfillments", category: "sales" },
//     { name: "fulfillment_orders", displayName: "Fulfillment Orders", category: "sales" },
//     { name: "fulfillment_events", displayName: "Fulfillment Events", category: "sales" },
//     { name: "transactions", displayName: "Transactions", category: "sales" },
//     { name: "refunds", displayName: "Refunds", category: "sales" },
//     { name: "tender_transactions", displayName: "Tender Transactions", category: "sales" },
    
//     // Customers
//     { name: "customers", displayName: "Customers", category: "customers" },
//     { name: "customer_address", displayName: "Customer Addresses", category: "customers" },
//     { name: "customer_saved_searches", displayName: "Customer Saved Searches", category: "customers" },
    
//     // Marketing & Discounts
//     { name: "price_rule", displayName: "Price Rules", category: "marketing" },
//     { name: "discount_codes", displayName: "Discount Codes", category: "marketing" },
//     { name: "marketing_events", displayName: "Marketing Events", category: "marketing" },
    
//     // Store Operations
//     { name: "shop", displayName: "Shop", category: "store" },
//     { name: "themes", displayName: "Themes", category: "store" },
//     { name: "assets", displayName: "Assets", category: "store" },
//     { name: "pages", displayName: "Pages", category: "store" },
//     { name: "blogs", displayName: "Blogs", category: "store" },
//     { name: "articles", displayName: "Articles", category: "store" },
//     { name: "comments", displayName: "Comments", category: "store" },
//     { name: "redirects", displayName: "Redirects", category: "store" },
//     { name: "script_tags", displayName: "Script Tags", category: "store" },
    
//     // Shipping & Fulfillment
//     { name: "carrier_services", displayName: "Carrier Services", category: "shipping" },
//     { name: "shipping_zones", displayName: "Shipping Zones", category: "shipping" },
//     { name: "countries", displayName: "Countries", category: "shipping" },
    
//     // Analytics & Reports
//     { name: "reports", displayName: "Reports", category: "analytics" },
    
//     // Metafields
//     { name: "metafields", displayName: "Metafields", category: "metadata" },
    
//     // Gift Cards
//     { name: "gift_cards", displayName: "Gift Cards", category: "sales" },
    
//     // Users & Permissions
//     { name: "users", displayName: "Users", category: "store" },
//     { name: "storefront_access_tokens", displayName: "Storefront Access Tokens", category: "store" },
    
//     // Online Store
//     { name: "redirects", displayName: "Redirects", category: "store" },
//     { name: "pages", displayName: "Pages", category: "store" },
//     { name: "blogs", displayName: "Blogs", category: "store" },
//     { name: "articles", displayName: "Articles", category: "store" },
    
//     // Billing
//     { name: "application_charges", displayName: "Application Charges", category: "billing" },
//     { name: "recurring_application_charges", displayName: "Recurring Charges", category: "billing" },
    
//     // Events & Webhooks
//     { name: "events", displayName: "Events", category: "events" },
//     { name: "webhooks", displayName: "Webhooks", category: "events" }
//   ];

//   const streams = [];
//   let entitiesWithData = 0;
//   let entitiesWithoutData = 0;
//   let entitiesWithErrors = 0;

//   console.log(`🔍 Checking ${shopifyEntities.length} Shopify entities for schema discovery...`);

//   for (const entity of shopifyEntities) {
//     try {
//       console.log(`📋 Processing entity: ${entity.name}`);
      
//       const url = `${baseUrl}/${entity.name}.json?limit=1`;
//       const response = await fetch(url, {
//         headers: {
//           "X-Shopify-Access-Token": access_token,
//           "Content-Type": "application/json",
//         },
//       });

//       if (!response.ok) {
//         if (response.status === 404) {
//           console.log(`⏭️ Entity not available: ${entity.name}`);
//           entitiesWithoutData++;
//           continue;
//         }
//         if (response.status === 403) {
//           console.log(`🚫 Access forbidden: ${entity.name}`);
//           entitiesWithoutData++;
//           continue;
//         }
//         if (response.status === 422) {
//           console.log(`🔄 Entity requires different endpoint: ${entity.name}`);
//           entitiesWithoutData++;
//           continue;
//         }
//         throw new Error(`HTTP ${response.status}: ${response.statusText}`);
//       }

//       const data = await response.json();
//       const entities = data[entity.name] || data[entity.name.slice(0, -1)] || []; // Handle singular/plural
      
//       if (entities.length === 0) {
//         console.log(`ℹ️ No data available for: ${entity.name}`);
//         entitiesWithoutData++;
//         continue;
//       }

//       const sample = entities[0];
//       const properties = extractShopifyFieldsWithBigInt(sample, entity.name);
//       const primaryKeys = detectShopifyPrimaryKeys(entity.name);
//       const cursorField = detectShopifyCursorField(entity.name);

//       streams.push({
//         stream: {
//           name: entity.name,
//           jsonSchema: { 
//             type: "object",
//             properties: properties 
//           },
//           primaryKeys,
//           supportedSyncModes: ["full_refresh", "incremental"],
//           sourceDefinedCursor: !!cursorField,
//           defaultCursorField: cursorField,
//           shopifyMetadata: {
//             displayName: entity.displayName,
//             category: entity.category,
//             hasData: true,
//             sampleSize: entities.length,
//             fieldsCount: Object.keys(properties).length
//           }
//         },
//         config: {
//           selected: false,
//           syncMode: "full_refresh",
//           destinationSyncMode: "overwrite",
//           cursorField: cursorField,
//           aliasName: entity.name,
//         },
//       });

//       entitiesWithData++;
//       console.log(`✅ Schema discovered for: ${entity.name} (${Object.keys(properties).length} fields)`);

//       // Rate limiting - be gentle with Shopify API
//       await new Promise(resolve => setTimeout(resolve, 300));

//     } catch (error) {
//       console.error(`❌ Error processing ${entity.name}:`, error.message);
//       entitiesWithErrors++;
//     }
//   }

//   return {
//     streams,
//     summary: {
//       totalEntities: shopifyEntities.length,
//       entitiesWithData,
//       entitiesWithoutData,
//       entitiesWithErrors,
//       successRate: `${Math.round((entitiesWithData / shopifyEntities.length) * 100)}%`,
//       coverage: `${Math.round((entitiesWithData / shopifyEntities.length) * 100)}%`
//     }
//   };
// }

// /**
//  * Extract Shopify fields with proper BIGINT handling for IDs
//  */
// function extractShopifyFieldsWithBigInt(obj, entityName, prefix = "") {
//   const fields = {};
  
//   for (const [key, value] of Object.entries(obj || {})) {
//     const fieldName = prefix ? `${prefix}.${key}` : key;
//     const fullFieldName = fieldName.toLowerCase();
    
//     // 🚨 CRITICAL: Detect ID fields and use BIGINT
//     if (fullFieldName.includes('id') || fullFieldName.endsWith('_id')) {
//       fields[fieldName] = { 
//         type: "bigint",
//         shopifyType: "id",
//         description: `Shopify ${entityName} ID field`
//       };
//     } 
//     // Handle numeric fields that might be large
//     else if (fullFieldName.includes('amount') || fullFieldName.includes('price') || 
//              fullFieldName.includes('quantity') || fullFieldName.includes('total') ||
//              fullFieldName.includes('subtotal') || fullFieldName.includes('weight')) {
//       fields[fieldName] = { 
//         type: "numeric",
//         shopifyType: "currency_or_quantity",
//         description: `Shopify ${entityName} numeric field`
//       };
//     }
//     // Handle dates
//     else if (fullFieldName.includes('date') || fullFieldName.includes('_at')) {
//       fields[fieldName] = { 
//         type: "string",
//         format: "date-time",
//         shopifyType: "timestamp",
//         description: `Shopify ${entityName} timestamp field`
//       };
//     }
//     // Handle booleans
//     else if (typeof value === "boolean") {
//       fields[fieldName] = { 
//         type: "boolean",
//         shopifyType: "boolean",
//         description: `Shopify ${entityName} boolean field`
//       };
//     }
//     // Handle arrays
//     else if (Array.isArray(value)) {
//       if (value.length > 0 && typeof value[0] === "object") {
//         // Array of objects - extract nested fields
//         fields[fieldName] = { 
//           type: "array",
//           items: { type: "object" },
//           shopifyType: "object_array",
//           description: `Shopify ${entityName} array of objects`
//         };
        
//         // Extract sample from first array item
//         if (value[0]) {
//           const nestedFields = extractShopifyFieldsWithBigInt(value[0], entityName, `${fieldName}[0]`);
//           Object.assign(fields, nestedFields);
//         }
//       } else {
//         // Array of primitives
//         const itemType = value.length > 0 ? typeof value[0] : "string";
//         fields[fieldName] = { 
//           type: "array",
//           items: { type: itemType },
//           shopifyType: "primitive_array",
//           description: `Shopify ${entityName} array field`
//         };
//       }
//     }
//     // Handle nested objects
//     else if (typeof value === "object" && value !== null) {
//       fields[fieldName] = { 
//         type: "object",
//         shopifyType: "nested_object",
//         description: `Shopify ${entityName} nested object`
//       };
      
//       // Recursively extract nested fields
//       const nestedFields = extractShopifyFieldsWithBigInt(value, entityName, fieldName);
//       Object.assign(fields, nestedFields);
//     }
//     // Handle strings and other types
//     else {
//       fields[fieldName] = { 
//         type: typeof value,
//         shopifyType: "primitive",
//         description: `Shopify ${entityName} field`
//       };
//     }
//   }
  
//   return fields;
// }

// /**
//  * Detect primary keys for Shopify entities
//  */
// function detectShopifyPrimaryKeys(entityName) {
//   const primaryKeyMap = {
//     // Products
//     products: ["id"],
//     variants: ["id"],
//     collections: ["id"],
//     collects: ["id"],
//     custom_collections: ["id"],
//     smart_collections: ["id"],
    
//     // Inventory
//     inventory_items: ["id"],
//     inventory_levels: ["inventory_item_id", "location_id"],
//     locations: ["id"],
    
//     // Sales
//     orders: ["id"],
//     draft_orders: ["id"],
//     abandoned_checkouts: ["id"],
//     fulfillments: ["id"],
//     fulfillment_orders: ["id"],
//     fulfillment_events: ["id"],
//     transactions: ["id"],
//     refunds: ["id"],
//     tender_transactions: ["id"],
//     gift_cards: ["id"],
    
//     // Customers
//     customers: ["id"],
//     customer_address: ["id"],
//     customer_saved_searches: ["id"],
    
//     // Marketing
//     price_rules: ["id"],
//     discount_codes: ["id"],
//     marketing_events: ["id"],
    
//     // Store
//     shop: ["id"],
//     themes: ["id"],
//     assets: ["key"],
//     pages: ["id"],
//     blogs: ["id"],
//     articles: ["id"],
//     comments: ["id"],
//     redirects: ["id"],
//     script_tags: ["id"],
    
//     // Shipping
//     carrier_services: ["id"],
//     shipping_zones: ["id"],
//     countries: ["id"],
    
//     // Analytics
//     reports: ["id"],
    
//     // Metadata
//     metafields: ["id"],
    
//     // Users
//     users: ["id"],
//     storefront_access_tokens: ["id"],
    
//     // Billing
//     application_charges: ["id"],
//     recurring_application_charges: ["id"],
    
//     // Events
//     events: ["id"],
//     webhooks: ["id"]
//   };
  
//   return primaryKeyMap[entityName] || ["id"];
// }

// /**
//  * Detect cursor fields for incremental sync
//  */
// function detectShopifyCursorField(entityName) {
//   const cursorFieldMap = {
//     orders: ["updated_at"],
//     customers: ["updated_at"],
//     products: ["updated_at"],
//     variants: ["updated_at"],
//     collections: ["updated_at"],
//     inventory_items: ["updated_at"],
//     events: ["created_at"],
//     webhooks: ["updated_at"],
//     pages: ["updated_at"],
//     articles: ["updated_at"],
//     blogs: ["updated_at"]
//   };
  
//   return cursorFieldMap[entityName] || [];
// }

/**
 * Enhanced Shopify schema discovery with BIGINT support for IDs
 */
// async function discoverShopifySchemaWithBigInt(shop, access_token) {
//   const apiVersion = "2024-01";
//   const baseUrl = `https://${shop}/admin/api/${apiVersion}`;
  
//   // Shopify entities to discover
//   const shopifyEntities = [
//     { name: "products", displayName: "Products", category: "products" },
//     { name: "variants", displayName: "Product Variants", category: "products" },
//     { name: "orders", displayName: "Orders", category: "sales" },
//     { name: "customers", displayName: "Customers", category: "customers" },
//     { name: "collections", displayName: "Collections", category: "products" },
//     { name: "inventory_items", displayName: "Inventory Items", category: "inventory" },
//     { name: "locations", displayName: "Locations", category: "inventory" },
//     { name: "fulfillments", displayName: "Fulfillments", category: "sales" },
//     { name: "transactions", displayName: "Transactions", category: "sales" },
//   ];

//   const streams = [];
//   let entitiesWithData = 0;
//   let entitiesWithoutData = 0;

//   console.log(`🔍 Checking ${shopifyEntities.length} Shopify entities for schema discovery...`);

//   for (const entity of shopifyEntities) {
//     try {
//       console.log(`📋 Processing entity: ${entity.name}`);
      
//       const url = `${baseUrl}/${entity.name}.json?limit=1`;
//       const response = await fetch(url, {
//         headers: {
//           "X-Shopify-Access-Token": access_token,
//           "Content-Type": "application/json",
//         },
//       });

//       if (!response.ok) {
//         if (response.status === 404) {
//           console.log(`⏭️ Entity not available: ${entity.name}`);
//           entitiesWithoutData++;
//           continue;
//         }
//         throw new Error(`HTTP ${response.status}: ${response.statusText}`);
//       }

//       const data = await response.json();
//       const entities = data[entity.name] || [];
      
//       if (entities.length === 0) {
//         console.log(`ℹ️ No data available for: ${entity.name}`);
//         entitiesWithoutData++;
//         continue;
//       }

//       const sample = entities[0];
//       const properties = extractShopifyFieldsWithBigInt(sample, entity.name);
//       const primaryKeys = detectShopifyPrimaryKeys(entity.name);

//       streams.push({
//         stream: {
//           name: entity.name,
//           jsonSchema: { 
//             type: "object",
//             properties: properties 
//           },
//           primaryKeys,
//           supportedSyncModes: ["full_refresh", "incremental"],
//           sourceDefinedCursor: entity.name === "orders" || entity.name === "customers",
//           defaultCursorField: entity.name === "orders" ? ["updated_at"] : [],
//           shopifyMetadata: {
//             displayName: entity.displayName,
//             category: entity.category,
//             hasData: true,
//             sampleSize: entities.length
//           }
//         },
//         config: {
//           selected: false,
//           syncMode: "full_refresh",
//           destinationSyncMode: "overwrite",
//           cursorField: entity.name === "orders" ? ["updated_at"] : [],
//           aliasName: entity.name,
//         },
//       });

//       entitiesWithData++;
//       console.log(`✅ Schema discovered for: ${entity.name} (${Object.keys(properties).length} fields)`);

//       // Rate limiting
//       await new Promise(resolve => setTimeout(resolve, 200));

//     } catch (error) {
//       console.error(`❌ Error processing ${entity.name}:`, error.message);
//       entitiesWithoutData++;
//     }
//   }

//   return {
//     streams,
//     summary: {
//       totalEntitiesChecked: shopifyEntities.length,
//       entitiesWithData,
//       entitiesWithoutData,
//       successRate: `${Math.round((entitiesWithData / shopifyEntities.length) * 100)}%`
//     }
//   };
// }

// /**
//  * Extract Shopify fields with proper BIGINT handling for IDs
//  */
// function extractShopifyFieldsWithBigInt(obj, entityName, prefix = "") {
//   const fields = {};
  
//   for (const [key, value] of Object.entries(obj || {})) {
//     const fieldName = prefix ? `${prefix}.${key}` : key;
//     const fullFieldName = fieldName.toLowerCase();
    
//     // 🚨 CRITICAL: Detect ID fields and use BIGINT
//     if (fullFieldName.includes('id') || fullFieldName.endsWith('_id')) {
//       fields[fieldName] = { 
//         type: "bigint", // 🚨 Use BIGINT for ID columns
//         shopifyType: "id",
//         description: `Shopify ${entityName} ID field`
//       };
//     } 
//     // Handle numeric fields that might be large
//     else if (fullFieldName.includes('amount') || fullFieldName.includes('price') || fullFieldName.includes('quantity')) {
//       fields[fieldName] = { 
//         type: "numeric",
//         shopifyType: "currency_or_quantity",
//         description: `Shopify ${entityName} numeric field`
//       };
//     }
//     // Handle dates
//     else if (fullFieldName.includes('date') || fullFieldName.includes('_at')) {
//       fields[fieldName] = { 
//         type: "string", // Store as string, let PostgreSQL handle date parsing
//         format: "date-time",
//         shopifyType: "timestamp",
//         description: `Shopify ${entityName} timestamp field`
//       };
//     }
//     // Handle booleans
//     else if (typeof value === "boolean") {
//       fields[fieldName] = { 
//         type: "boolean",
//         shopifyType: "boolean",
//         description: `Shopify ${entityName} boolean field`
//       };
//     }
//     // Handle arrays
//     else if (Array.isArray(value)) {
//       if (value.length > 0 && typeof value[0] === "object") {
//         // Array of objects - extract nested fields
//         fields[fieldName] = { 
//           type: "array",
//           items: { type: "object" },
//           shopifyType: "object_array",
//           description: `Shopify ${entityName} array of objects`
//         };
        
//         // Extract sample from first array item
//         if (value[0]) {
//           const nestedFields = extractShopifyFieldsWithBigInt(value[0], entityName, `${fieldName}[0]`);
//           Object.assign(fields, nestedFields);
//         }
//       } else {
//         // Array of primitives
//         const itemType = value.length > 0 ? typeof value[0] : "string";
//         fields[fieldName] = { 
//           type: "array",
//           items: { type: itemType },
//           shopifyType: "primitive_array",
//           description: `Shopify ${entityName} array field`
//         };
//       }
//     }
//     // Handle nested objects
//     else if (typeof value === "object" && value !== null) {
//       fields[fieldName] = { 
//         type: "object",
//         shopifyType: "nested_object",
//         description: `Shopify ${entityName} nested object`
//       };
      
//       // Recursively extract nested fields
//       const nestedFields = extractShopifyFieldsWithBigInt(value, entityName, fieldName);
//       Object.assign(fields, nestedFields);
//     }
//     // Handle strings and other types
//     else {
//       fields[fieldName] = { 
//         type: typeof value,
//         shopifyType: "primitive",
//         description: `Shopify ${entityName} field`
//       };
//     }
//   }
  
//   return fields;
// }

// /**
//  * Detect primary keys for Shopify entities
//  */
// function detectShopifyPrimaryKeys(entityName) {
//   const primaryKeyMap = {
//     products: ["id"],
//     variants: ["id"],
//     orders: ["id"],
//     customers: ["id"],
//     collections: ["id"],
//     inventory_items: ["id"],
//     locations: ["id"],
//     fulfillments: ["id"],
//     transactions: ["id"],
//   };
  
//   return primaryKeyMap[entityName] || ["id"];
// }

// @desc  Check if the current company has at least one connected source
// @route GET /api/source/has-connected
// @access Private
exports.hasConnectedSource = async (req, res) => {
  try {
    const { Op } = require('sequelize');
    const { UserQbCompany } = require('../model');

    // ── Primary check: source in the user's JWT company ──────────────────────
    let count = 0;
    try {
      const scopedWhere = withTenantScope(req);
      count = await Source.count({ where: scopedWhere });
    } catch (e) {
      // withTenantScope throws when company_id is missing — fall through
    }

    // ── Fallback: JWT company_id is the signup placeholder, not the QB company.
    //    Check ALL companies this user is linked to via UserQbCompany.
    //    This happens for new users whose JWT was issued before QB OAuth ran.
    if (count === 0 && req.auth?.userId) {
      const links = await UserQbCompany.findAll({
        where:      { user_id: req.auth.userId },
        attributes: ['company_id'],
      });
      const companyIds = links.map(l => l.company_id).filter(Boolean);
      if (companyIds.length > 0) {
        count = await Source.count({ where: { company_id: { [Op.in]: companyIds } } });
      }
    }

    return res.status(200).json({
      success: true,
      data: { hasConnected: count > 0, count },
    });
  } catch (error) {
    console.error('hasConnectedSource error:', error);
    return res.status(500).json({ success: false, message: 'Something went wrong' });
  }
};
