const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");
const {
  updateConnectionStatusValidation,
  createConnectionStatusValidation,
} = require("../validation/connectionValidation");
const { Airbyte, AirbytePublic } = require("../connection/airByteConnection");
const { client, createCache, getCache } = require("../utils/redis");
const { Connection, SchemaDetail } = require("../model/connectionModel");
// const { DataTypes } = require("sequelize");
// const Sequelize = require('../connection/dbConnection');
const { Sequelize, DataTypes, QueryTypes } = require("sequelize");
const Source = require("../model/sourceModel");
const Destination = require("../model/destinationModel");
const ConnectionSyncRun = require("../model/ConnectionSyncRun");
const { tenantId, withTenantScope, stampTenant, sendAuthError } = require("../utils/tenantScope");
const { quoteIdent } = require("../utils/sqlIdentifier");
const {
  getEntityMapForETL,
  isValidQuickBooksEntity,
  getEntityDetails,
  formatQbDate,
} = require("../utils/quickbooksEntityHelper");
const {
  getZohoBooksEntityDetails,
  getZohoBooksEntityCategory,
  refreshZohoAccessToken,
  findEntityKeyInResponse,
  getNestedZohoBooksValue,
  transformZohoBooksData,
  debugZohoBooksBills,
  cleanZohoBooksDataForPostgres,
  getCursorFieldForTable 
} = require("../utils/zohoBooksUtils");

// exports.createConnection = async (req, res) => {
//   const t = await Connection.sequelize.transaction();
//   try {
//     const payload = req.body;
//     console.log("asdasdasfsasdsd", payload);
//     // 1️⃣ Create the connection
//     const newConnection = await Connection.create(
//       {
//         connection_name: payload.name,
//         source_id: payload.sourceId,
//         destination_id: payload.destinationId,
//         schedule_type: payload.scheduleType,
//         replication_frequency:
//           payload.scheduleData?.basicSchedule?.timeUnit || "hours",
//         destination_schema: payload.namespaceDefinition || "public",
//         last_sync: null,
//         is_active: payload.status === "active",
//       },
//       { transaction: t }
//     );

//     const schemaRecords = [];

//     if (payload.syncCatalog && payload.syncCatalog.streams) {
//       payload.syncCatalog.streams.forEach((streamItem) => {
//         const streamConfig = streamItem.config;

//         // Only process table if selected
//         if (streamConfig.selected) {
//           const tableName = streamItem.stream.name;

//           // Get all columns for this table from source schema
//           // For demo purposes, assuming streamItem.stream.jsonSchema.properties contains all columns
//           const allColumns = Object.keys(
//             streamItem.stream.jsonSchema?.properties || {}
//           );

//           allColumns.forEach((colName) => {
//             const isPrimaryKey =
//               streamItem.stream.primaryKeys &&
//               Array.isArray(streamItem.stream.primaryKeys) &&
//               streamItem.stream.primaryKeys.includes(colName);
//             schemaRecords.push({
//               connection_id: newConnection.connection_id,
//               table_name: tableName,
//               column_name: colName,
//               data_type:
//                 streamItem.stream.jsonSchema?.properties?.[colName]?.type ||
//                 "string", // ✅ new: save sync mode as insertion_type
//               insertion_type: streamConfig.syncMode || null, // Active only if column is in fields array
//               cursor_column: colName === streamConfig.cursorField,
//               primary_key_column_name: isPrimaryKey ? colName : null, // Fixed line  //streamItem.stream.primaryKeys.includes(colName) ? colName : null,
//               is_active:
//                 Array.isArray(streamConfig.fields) &&
//                 streamConfig.fields.includes(colName),
//             });
//           });
//         }
//         console.log("Stream data for Excel:", {
//           tableName: streamItem.stream.name,
//           hasPrimaryKeys: !!streamItem.stream.primaryKeys,
//           primaryKeys: streamItem.stream.primaryKeys,
//         });
//       });
//     }

//     // Bulk insert all columns with correct is_active flags
//     if (schemaRecords.length > 0) {
//       await SchemaDetail.bulkCreate(schemaRecords, { transaction: t });
//     }

//     await t.commit();
//     // 2️⃣ Trigger ETL run right after connection is created
//     try {
//       await runETL(
//         payload.sourceId,
//         newConnection.connection_id,
//         payload.destinationId
//       );
//       console.log(
//         `✅ Initial ETL run completed for connection ${newConnection.connection_id}`
//       );
//     } catch (etlError) {
//       console.error(
//         "❌ ETL failed right after connection creation:",
//         etlError.message
//       );
//     }
//     return res.status(200).json({
//       success: true,
//       data: { connection: newConnection },
//       message: "Connection and schema details created successfully.",
//     });
//   } catch (error) {
//     await t.rollback();
//     console.error("Error creating connection:", error);
//     return res.status(500).json({
//       success: false,
//       data: null,
//       message: "Something went wrong",
//     });
//   }
// };

// exports.createConnection = async (req, res) => {
//   try {
//     // const { error } = createConnectionStatusValidation.validate(req.body, { abortEarly: false })
//     // if (error) {
//     //     return res.status(400).json({
//     //         success: false,
//     //         data: null,
//     //         message: error.message
//     //     })
//     // }
//     const payload = req.body;
//     console.log("payload", payload)
//     const connection = await Airbyte.post("/connections/create",
//       payload)
//     console.log("coneection", connection);

//     return res.status(200).json({
//       success: true,
//       data: null,
//       message: "Conection created successfully."
//     })

//   } catch (error) {
//     console.log("error: ", error);
//     return res.status(500).json({
//       success: false,
//       data: null,
//       message: "Something went wrong"
//     })
//   }
// }

// exports.getConnections = async (req, res) => {
//     try {

//         const connections = await Airbyte.post('/web_backend/connections/list', {
//             workspaceId: process.env.AIRBYTE_WORKSPACE_ID,
//         });
//         return res.status(200).json({
//             success: false,
//             data: connections.data,
//             message: 'all sources fetch successfully'
//         })
//     } catch (error) {
//         console.log("error", error)
//         return res.status(500).json({
//             success: false,
//             data: null,
//             message: 'Something went wrong'
//         })
//     }
// }

exports.createConnection = async (req, res) => {
  let companyId;
  try { companyId = tenantId(req); } catch (e) { return sendAuthError(res, e); }

  const t = await Connection.sequelize.transaction();
  try {
    const payload = req.body;

    // Tenant ownership: source + destination must belong to the caller.
    const [src, dst] = await Promise.all([
      Source.findOne({ where: { id: payload.sourceId, company_id: companyId }, transaction: t }),
      Destination.findOne({ where: { id: payload.destinationId, company_id: companyId }, transaction: t }),
    ]);
    if (!src || !dst) {
      await t.rollback();
      return res.status(404).json({ success: false, data: null, message: 'Source or destination not found' });
    }

    // 1️⃣ Create the connection (stamped with tenant)
    const newConnection = await Connection.create(
      {
        connection_name: payload.name,
        source_id: payload.sourceId,
        destination_id: payload.destinationId,
        schedule_type: payload.scheduleType,
        replication_frequency: payload.replication_frequency || "1 hours",
        destination_schema: payload.namespaceDefinition || "public",
        last_sync: null,
        is_active: payload.status === "active",
        company_id: companyId,
      },
      { transaction: t }
    );

    const schemaRecords = [];

    if (payload.syncCatalog && payload.syncCatalog.streams) {
      payload.syncCatalog.streams.forEach((streamItem) => {
        const streamConfig = streamItem.config;

        // Only process table if selected
        if (streamConfig.selected) {
          const tableName = streamItem.stream.name;

          // Get all columns for this table from source schema
          const allColumns = Object.keys(
            streamItem.stream.jsonSchema?.properties || {}
          );

          allColumns.forEach((colName) => {
            const isPrimaryKey =
              streamItem.stream.primaryKeys &&
              Array.isArray(streamItem.stream.primaryKeys) &&
              streamItem.stream.primaryKeys.includes(colName);
            schemaRecords.push({
              connection_id: newConnection.connection_id,
              table_name: tableName,
              column_name: colName,
              data_type:
                streamItem.stream.jsonSchema?.properties?.[colName]?.type ||
                "string",
              insertion_type: streamConfig.syncMode || null,
              cursor_column: colName === streamConfig.cursorField,
              primary_key_column_name: isPrimaryKey ? colName : null,
              is_active:
                Array.isArray(streamConfig.fields) &&
                streamConfig.fields.includes(colName),
              company_id: companyId,
            });
          });
        }
      });
    }

    // Bulk insert all columns with correct is_active flags
    if (schemaRecords.length > 0) {
      await SchemaDetail.bulkCreate(schemaRecords, { transaction: t });
    }

    await t.commit();

    // 2️⃣ Trigger ETL run right after connection is created
    try {
      // Get destination details to check if it's Excel
      const destination = await Destination.findOne({
        where: { id: payload.destinationId },
      });

      if (destination && destination.connector_name.toLowerCase() === "excel") {
        // For Excel destination, pass res to handle file download
        await runETL(
          payload.sourceId,
          newConnection.connection_id,
          payload.destinationId,
          res // Pass response object for file download
        );
        // Note: runETL will handle the response and file download
        // So we don't return anything else - the response is already sent
        return; // ✅ Important: Exit the function

        // If Excel download was initiated, response is already sent
      } else {
        // For non-Excel destinations, normal ETL
        await runETL(
          payload.sourceId,
          newConnection.connection_id,
          payload.destinationId
        );

        return res.status(200).json({
          success: true,
          data: { connection: newConnection },
          message: "Connection and schema details created successfully.",
        });
      }
    } catch (etlError) {
      console.error(
        "❌ ETL failed right after connection creation:",
        etlError.message
      );

      // Even if ETL fails, connection was created successfully
      return res.status(200).json({
        success: true,
        data: { connection: newConnection },
        message:
          "Connection created but ETL failed. Please try syncing manually.",
      });
    }
  } catch (error) {
    await t.rollback();
    console.error("Error creating connection:", error);
    return res.status(500).json({
      success: false,
      data: null,
      message: "Something went wrong",
    });
  }
};


/** ---------------------------------------------------------------------------------- */

async function runETL(
  source_id,
  connection_id,
  destination_id,
  res = null,
  useSyncStrategies = false
) {
  let syncRun = null;

  try {
    console.log(`🚀 Starting ETL process for connection ${connection_id}`);
    const startTime = Date.now();

    syncRun = await ConnectionSyncRun.create({
      connection_id: connection_id,
      started_at: startTime,
      status: "RUNNING",
      rows_processed: 0,
    });

    // 1. Get source + destination details
    const source = await Source.findOne({ where: { id: source_id } });
    const destination = await Destination.findOne({
      where: { id: destination_id },
    });
    if (!source || !destination)
      throw new Error("Source/Destination not found");

    const sourceSettings =
      typeof source.connector_settings_json === "string"
        ? JSON.parse(source.connector_settings_json)
        : source.connector_settings_json;

    const destSettings =
      typeof destination.connector_settings_json === "string"
        ? JSON.parse(destination.connector_settings_json)
        : destination.connector_settings_json;

    // 2. Get schema details and GROUP BY TABLE
    const schemaDetails = await SchemaDetail.findAll({
      where: { connection_id, is_active: true },
    });

    if (!schemaDetails.length)
      throw new Error("No active schema columns found");

    // Group columns by table name
    const tablesData = {};
    schemaDetails.forEach((col) => {
      if (!tablesData[col.table_name]) {
        tablesData[col.table_name] = {
          columns: [],
          schemaDetails: [],
        };
      }
      tablesData[col.table_name].columns.push(col.column_name);
      tablesData[col.table_name].schemaDetails.push(col);
    });

    console.log(
      `📋 Processing ${Object.keys(tablesData).length} tables:`,
      Object.keys(tablesData)
    );

    let totalRowsProcessed = 0;
    const allTablesData = []; // Store data for all tables

    // 3. Process each table separately
    for (const [tableName, tableData] of Object.entries(tablesData)) {
      console.log(`\n📊 Processing table: ${tableName}`);
      console.log(`📝 Columns: ${tableData.columns.join(", ")}`);

      let rows;
      const fetchStartTime = Date.now();

      // Fetch data for this specific table
      switch (source.connector_name.toLowerCase()) {
        case "excel":
          rows = await readExcelData(
            sourceSettings,
            tableName,
            tableData.columns,
            10000
          );
          break;
        case "postgres":
          rows = await readPostgresData(
            sourceSettings,
            tableName,
            tableData.columns,
            1000
          );
          break;
        case "quickbooks":
          // Check data availability first
          const hasData = await checkQuickBooksDataAvailability(
            sourceSettings,
            tableName
          );
          if (!hasData) {
            console.log(`⏭️ Skipping ${tableName} - no data available`);
            continue;
          }
          rows = await readQuickBooksData(
            sourceSettings,
            tableName,
            tableData.columns,
            1000 // QuickBooks API chunk size
          );
          break;
        case "shopify":
          // Check store environment first
          const storeInfo = await getShopifyStoreInfo(sourceSettings);
          console.log(
            `🏪 Processing data from ${storeInfo.environment} Shopify store`
          );

          if (storeInfo.isLive) {
            console.log(
              "🚨 WORKING WITH LIVE PRODUCTION STORE - Be careful with data operations!"
            );
            // You could add additional safeguards here for production data
          } else {
            console.log(
              `ℹ️ Working with ${storeInfo.environment} store - safe for testing`
            );
          }

          // Check data availability
          const shopifyHasData = await checkShopifyDataAvailability(
            sourceSettings,
            tableName
          );
          if (!shopifyHasData) {
            console.log(`⏭️ Skipping ${tableName} - no data available`);
            continue;
          }

          rows = await readShopifyData(
            sourceSettings,
            tableName,
            tableData.columns,
            250 // Shopify API chunk size (recommended: 250 per request)
          );
          break;
        // ✅ NEW: ZOHO BOOKS SUPPORT
        case "zoho books":
          if (tableName.toLowerCase() === "bills") {
            await testZohoBooksBillsIntegration(sourceSettings, connection_id);
          }
          const hasZohoData = await checkZohoBooksDataAvailability(
            sourceSettings,
            tableName
          );
          if (!hasZohoData) {
            console.log(`⏭️ Skipping ${tableName} - no data available`);
            continue;
          }

          rows = await readZohoBooksData(
            sourceSettings,
            tableName,
            tableData.columns,
            100
          );
          break;

        default:
          throw new Error(`Unsupported source: ${source.connector_name}`);
      }

      const fetchTime = Date.now() - fetchStartTime;
      console.log(
        `⏱️ Data fetch completed for ${tableName} in ${fetchTime}ms - ${rows.length} rows`
      );

      if (!rows.length) {
        console.log(`ℹ️ No rows fetched from ${tableName}`);
        continue;
      }

      totalRowsProcessed += rows.length;

      // Store table data for later processing
      allTablesData.push({
        tableName,
        rows,
        columns: tableData.columns,
        schemaDetails: tableData.schemaDetails,
        sourceType: source.connector_name.toLowerCase(), // Add source type for destination handling
      });
    }

    // 4. Handle destination type
    let result;

    switch (destination.connector_name.toLowerCase()) {
      case "postgres":
        // Create PostgreSQL connection
        const sequelizeDest = new Sequelize(
          destSettings.database,
          destSettings.username,
          destSettings.password,
          {
            host: destSettings.host,
            port: destSettings.port,
            dialect: "postgres",
            logging: false,
            pool: {
              max: 1000,
              min: 0,
              acquire: 300000,
              idle: 100000,
            },
          }
        );
        try {
          // Process each table for PostgreSQL
          for (const tableData of allTablesData) {
            // ✅ DIFFERENT CLEANING STRATEGIES BASED ON SOURCE TYPE
            let cleanedRows;
            if (tableData.sourceType === "quickbooks") {
              // QuickBooks: Use simple text conversion
              console.log(
                `🧹 Using QuickBooks text conversion for ${tableData.tableName}`
              );
              cleanedRows = cleanQuickBooksDataForPostgres(
                tableData.rows,
                tableData.columns
              );
            } else if (tableData.sourceType.toLowerCase() === "zoho books") {
              // ✅ ADD ZOHO BOOKS DATA CLEANING
              console.log(
                `🧹 Using Zoho Books text conversion for ${tableData.tableName}`
              );
              cleanedRows = cleanZohoBooksDataForPostgres(
                tableData.rows,
                tableData.columns
              );
              // Debug: Check what we're about to insert
              console.log(`📊 Zoho Books data ready for insertion:`, {
                table: tableData.tableName,
                rows: cleanedRows.length,
                columns: tableData.columns,
                sample: cleanedRows.slice(0, 1),
              });
            } else {
              // Other sources: Use complex type handling
              console.log(
                `🧹 Using complex type handling for ${tableData.sourceType} data`
              );
              cleanedRows = cleanDataWithSchemaAwareness(
                tableData.rows,
                tableData.columns,
                tableData.schemaDetails
              );
            }

            if (useSyncStrategies) {
              const syncMode =
                tableData.schemaDetails[0]?.insertion_type ||
                "Full refresh | Overwrite";
              console.log(
                `🔄 Using sync strategy for ${tableData.tableName}: ${syncMode}`
              );
              // ✅ DIFFERENT TABLE CREATION BASED ON SOURCE TYPE
              if (tableData.sourceType === "quickbooks") {
                await ensureQuickBooksTableFromSchema(
                  sequelizeDest,
                  tableData.tableName,
                  tableData.schemaDetails
                );
              } else if (tableData.sourceType.toLowerCase() === "zoho books") {
                await ensureZohoBooksTableFromSchema(
                  sequelizeDest,
                  tableData.tableName,
                  tableData.schemaDetails
                );
              } else {
                await ensureTableFromSchema(
                  sequelizeDest,
                  tableData.tableName,
                  tableData.schemaDetails
                );
              }
              await syncData(
                sequelizeDest,
                destSettings,
                tableData.tableName,
                tableData.columns,
                tableData.rows,
                tableData.schemaDetails,
                syncMode
              );
            } else {
              console.log(
                `🔄 Using regular ETL flow for ${tableData.tableName} (overwrite)`
              );
              // ✅ DIFFERENT TABLE CREATION BASED ON SOURCE TYPE
              if (tableData.sourceType === "quickbooks") {
                await ensureQuickBooksTableFromSchema(
                  sequelizeDest,
                  tableData.tableName,
                  tableData.schemaDetails
                );
              } else if (tableData.sourceType.toLowerCase() === "zoho books") {
                await ensureZohoBooksTableFromSchema(
                  sequelizeDest,
                  tableData.tableName,
                  tableData.schemaDetails
                );
              } else {
                await ensureTableFromSchema(
                  sequelizeDest,
                  tableData.tableName,
                  tableData.schemaDetails
                );
              }
              await insertIntoPostgres(
                sequelizeDest,
                // destSettings,
                tableData.tableName,
                tableData.columns,
                tableData.rows,
                tableData.schemaDetails,
                1000
              );
            }
          }

          result = {
            success: true,
            message: `Data successfully synced to PostgreSQL (${totalRowsProcessed} rows across ${allTablesData.length} tables)`,
            rows: totalRowsProcessed,
            tables_processed: allTablesData.length,
            sync_id: syncRun.sync_id,
          };
        } catch (error) {
          console.error("❌ Error in PostgreSQL destination:", error.message);
          throw error;
        } finally {
          // Always close the connection
          await sequelizeDest.close();
        }
        break;

      case "excel":
        // ✅ FIXED: Create a SINGLE Excel file with multiple sheets
        const excelResult = await writeExcelFileWithMultipleSheets(
          destSettings,
          allTablesData,
          destination.destination_name
        );

        result = {
          success: true,
          message: `Excel file with ${allTablesData.length} sheets generated successfully (${totalRowsProcessed} total rows)`,
          rows: totalRowsProcessed,
          tables_processed: allTablesData.length,
          fileInfo: excelResult,
          sync_id: syncRun.sync_id,
        };

        // If response object is provided, send file for download
        if (res && excelResult.filePath) {
          // Update sync run before sending file
          await syncRun.update({
            ended_at: new Date(),
            status: "SUCCESS",
            rows_processed: totalRowsProcessed,
            error_message: null,
          });

          // ✅ Send the single Excel file
          return sendExcelFile(res, excelResult.filePath, excelResult.fileName);
        }
        break;

      default:
        throw new Error(
          `Unsupported destination: ${destination.connector_name}`
        );
    }

    // 5. Update sync run with SUCCESS status
    await syncRun.update({
      ended_at: new Date(),
      status: "SUCCESS",
      rows_processed: totalRowsProcessed,
      error_message: null,
    });

    const totalTime = Date.now() - startTime;
    console.log(`\n🎉 ETL completed successfully for all tables!`);
    console.log(`📊 Total statistics:`);
    console.log(`   - Total tables processed: ${allTablesData.length}`);
    console.log(`   - Total rows processed: ${totalRowsProcessed}`);
    console.log(`   - Total time: ${totalTime}ms`);

    // If response object provided but not handling Excel download, send JSON response
    if (res) {
      return res.status(200).json(result);
    }
    return result;
  } catch (err) {
    console.error("❌ Error in ETL:", err.message);
    if (syncRun) {
      await syncRun.update({
        ended_at: new Date(),
        status: "FAILED",
        error_message: err.message,
      });
    }
    if (res) {
      return res.status(500).json({
        success: false,
        message: "ETL failed: " + err.message,
        sync_id: syncRun ? syncRun.sync_id : null,
      });
    }
    throw err;
  }
}

/**
 * ------------------------------------------------------------END ETL function with chunks ---------------------------------
 */

/**
 * Write multiple tables to a single Excel file with multiple sheets
 */
// async function writeExcelFileWithMultipleSheets(
//   destSettings,
//   tablesData,
//   chunkSize = 10000
// ) {
//   console.log(
//     `📝 Writing ${tablesData.length} tables to Excel file with multiple sheets`
//   );

//   const workbook = XLSX.utils.book_new();

//   for (const tableData of tablesData) {
//     const { tableName, rows } = tableData;
//     console.log(`   Adding sheet: ${tableName} with ${rows.length} rows`);

//     if (rows.length <= chunkSize) {
//       // Small dataset - write all at once
//       const worksheet = XLSX.utils.json_to_sheet(rows);
//       XLSX.utils.book_append_sheet(workbook, worksheet, tableName);
//     } else {
//       // Large dataset - write in chunks
//       const worksheet = XLSX.utils.aoa_to_sheet([]);

//       // Add headers
//       const headers = Object.keys(rows[0] || {});
//       XLSX.utils.sheet_add_aoa(worksheet, [headers], { origin: "A1" });

//       // Add data in chunks
//       for (let i = 0; i < rows.length; i += chunkSize) {
//         const chunk = rows.slice(i, i + chunkSize);
//         const chunkData = chunk.map((row) =>
//           headers.map((header) => row[header])
//         );
//         XLSX.utils.sheet_add_aoa(worksheet, chunkData, { origin: `A${i + 2}` });
//       }

//       XLSX.utils.book_append_sheet(workbook, worksheet, tableName);
//     }
//   }

//   // Generate unique filename with timestamp
//   const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
//   const fileName = `multi_table_export_${timestamp}.xlsx`;
//   const filePath = path.join(__dirname, "../exports", fileName);

//   // Ensure exports directory exists
//   const exportsDir = path.dirname(filePath);
//   if (!fs.existsSync(exportsDir)) {
//     fs.mkdirSync(exportsDir, { recursive: true });
//   }

//   XLSX.writeFile(workbook, filePath);

//   console.log(
//     `✅ Excel file created with ${tablesData.length} sheets: ${filePath}`
//   );

//   return {
//     filePath,
//     fileName,
//     fileSize: fs.statSync(filePath).size,
//     sheets: tablesData.length,
//     totalRows: tablesData.reduce((sum, table) => sum + table.rows.length, 0),
//   };
// }
/**
 * Write multiple QuickBooks entities to a single Excel file with destination name
 */
async function writeExcelFileWithMultipleSheets(
  destSettings,
  tablesData,
  destinationName = "QuickBooks_Export",
  chunkSize = 10000
) {
  console.log(
    `📝 Writing ${tablesData.length} QuickBooks entities to Excel file`
  );

  const workbook = XLSX.utils.book_new();

  for (const tableData of tablesData) {
    const { tableName, rows } = tableData;
    console.log(`   Adding sheet: ${tableName} with ${rows.length} rows`);

    if (rows.length <= chunkSize) {
      // Small dataset - write all at once
      const worksheet = XLSX.utils.json_to_sheet(rows);
      XLSX.utils.book_append_sheet(workbook, worksheet, tableName);
    } else {
      // Large dataset - write in chunks
      const worksheet = XLSX.utils.aoa_to_sheet([]);

      // Add headers
      const headers = Object.keys(rows[0] || {});
      XLSX.utils.sheet_add_aoa(worksheet, [headers], { origin: "A1" });

      // Add data in chunks
      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const chunkData = chunk.map((row) =>
          headers.map((header) => row[header])
        );
        XLSX.utils.sheet_add_aoa(worksheet, chunkData, { origin: `A${i + 2}` });
      }

      XLSX.utils.book_append_sheet(workbook, worksheet, tableName);
    }
  }

  // Generate filename with destination name and timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeDestinationName = destinationName.replace(/[^a-zA-Z0-9-_]/g, "_");
  const fileName = `${safeDestinationName}_${timestamp}.xlsx`;
  const filePath = path.join(__dirname, "../exports", fileName);

  // Ensure exports directory exists
  const exportsDir = path.dirname(filePath);
  if (!fs.existsSync(exportsDir)) {
    fs.mkdirSync(exportsDir, { recursive: true });
  }

  XLSX.writeFile(workbook, filePath);

  console.log(
    `✅ Excel file created with ${tablesData.length} sheets: ${filePath}`
  );

  return {
    filePath,
    fileName,
    fileSize: fs.statSync(filePath).size,
    sheets: tablesData.length,
    totalRows: tablesData.reduce((sum, table) => sum + table.rows.length, 0),
    destinationName: safeDestinationName,
  };
}
/**
 *
 * @param {*} res
 * @param {*} filePath
 * @param {*} fileName
 * @returns
 * for excel file download
 */

function sendExcelFile(res, filePath, fileName) {
  try {
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      throw new Error("Excel file not found");
    }

    // Set headers for file download
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Length", fs.statSync(filePath).size);

    // Stream the file to response
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);

    // Clean up file after sending (optional)
    fileStream.on("end", () => {
      try {
        fs.unlinkSync(filePath);
        console.log(`✅ Temporary file cleaned up: ${filePath}`);
      } catch (cleanupError) {
        console.warn(
          "Could not clean up temporary file:",
          cleanupError.message
        );
      }
    });

    fileStream.on("error", (error) => {
      console.error("Error streaming file:", error);
      res.status(500).json({
        success: false,
        message: "Error downloading file",
      });
    });

    return null; // Return null to indicate response was handled
  } catch (error) {
    console.error("Error sending Excel file:", error);
    throw error;
  }
}

/**
 * ---------------------------------------Start Read Excel Data withou chunks --------------------------------------------
 */
// async function readExcelData(settings, sheetName, activeColumns) {
//   const workbook = XLSX.readFile(settings.path);
//   const sheet = workbook.Sheets[sheetName];
//   if (!sheet) throw new Error(`Sheet ${sheetName} not found`);

//   let jsonData = XLSX.utils.sheet_to_json(sheet);

//   return jsonData.map(row => {
//     let filtered = {};
//     activeColumns.forEach(col => {
//       filtered[col] = row[col] ?? null;
//     });
//     return filtered;
//   });
// }
/**
 * -----------------------------------------------------End Read Excel Data withou chunks----------------------------------
 */

/**
 * ------------------------------------Read Excel Data in Chunks (for large Excel files)------------------------------------
 */
// async function readExcelData(settings, sheetName, activeColumns, chunkSize = 10000) {
//   const workbook = XLSX.readFile(settings.path, {
//     sheetRows: chunkSize * 10 // Limit rows read at once for large files
//   });

//   const sheet = workbook.Sheets[sheetName];
//   if (!sheet) throw new Error(`Sheet ${sheetName} not found`);

//   // Read data in chunks if file is large
//   const range = XLSX.utils.decode_range(sheet['!ref']);
//   const totalRows = range.e.r - range.s.r + 1;

//   console.log(`📖 Reading Excel data: ${totalRows} total rows`);

//   if (totalRows <= chunkSize) {
//     // Small file - read all at once
//     let jsonData = XLSX.utils.sheet_to_json(sheet);
//     return jsonData.map(row => {
//       let filtered = {};
//       activeColumns.forEach(col => {
//         filtered[col] = row[col] ?? null;
//       });
//       return filtered;
//     });
//   } else {
//     // Large file - read in chunks
//     const allRows = [];

//     for (let startRow = 0; startRow < totalRows; startRow += chunkSize) {
//       const endRow = Math.min(startRow + chunkSize, totalRows);
//       const chunkRange = XLSX.utils.encode_range({
//         s: { r: startRow, c: range.s.c },
//         e: { r: endRow, c: range.e.c }
//       });

//       const chunkSheet = XLSX.utils.sheet_to_json(sheet, { range: chunkRange });
//       const processedChunk = chunkSheet.map(row => {
//         let filtered = {};
//         activeColumns.forEach(col => {
//           filtered[col] = row[col] ?? null;
//         });
//         return filtered;
//       });

//       allRows.push(...processedChunk);
//       console.log(`📊 Processed Excel chunk: ${processedChunk.length} rows (Total: ${allRows.length})`);
//     }

//     return allRows;
//   }
// }

async function readExcelData(
  settings,
  sheetName,
  activeColumns,
  chunkSize = 10000
) {
  // Try different possible path property names
  const filePath =
    settings.path || settings.file_path || settings.filePath || settings.file;
  console.log(`📖 Reading Excel file from: ${filePath}`);
  if (!filePath) {
    console.error("❌ Excel file path not found in settings:", settings);
    throw new Error(
      "Excel file path is required. Available settings: " +
        JSON.stringify(settings)
    );
  }

  console.log(`📖 Reading Excel file from: ${filePath}`);

  // Check if file exists
  if (!fs.existsSync(filePath)) {
    throw new Error(`Excel file not found at path: ${filePath}`);
  }

  const workbook = XLSX.readFile(filePath, {
    sheetRows: chunkSize * 10,
  });

  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    // Try to find the sheet by different naming conventions
    const sheetNames = workbook.SheetNames;
    console.log(`📋 Available sheets: ${sheetNames.join(", ")}`);
    throw new Error(
      `Sheet "${sheetName}" not found. Available sheets: ${sheetNames.join(
        ", "
      )}`
    );
  }

  // Rest of your existing code...
  const range = XLSX.utils.decode_range(sheet["!ref"]);
  const totalRows = range.e.r - range.s.r + 1;

  console.log(`📖 Reading Excel data: ${totalRows} total rows`);

  if (totalRows <= chunkSize) {
    // Small file - read all at once
    let jsonData = XLSX.utils.sheet_to_json(sheet);
    return jsonData.map((row) => {
      let filtered = {};
      activeColumns.forEach((col) => {
        filtered[col] = row[col] ?? null;
      });
      return filtered;
    });
  } else {
    // Large file - read in chunks
    const allRows = [];

    for (let startRow = 0; startRow < totalRows; startRow += chunkSize) {
      const endRow = Math.min(startRow + chunkSize, totalRows);
      const chunkRange = XLSX.utils.encode_range({
        s: { r: startRow, c: range.s.c },
        e: { r: endRow, c: range.e.c },
      });

      const chunkSheet = XLSX.utils.sheet_to_json(sheet, { range: chunkRange });
      const processedChunk = chunkSheet.map((row) => {
        let filtered = {};
        activeColumns.forEach((col) => {
          filtered[col] = row[col] ?? null;
        });
        return filtered;
      });

      allRows.push(...processedChunk);
      console.log(
        `📊 Processed Excel chunk: ${processedChunk.length} rows (Total: ${allRows.length})`
      );
    }

    return allRows;
  }
}
/**
 * ---------------------------End Read Excel Data in Chunks (for large Excel files)------------------------------------
 */

/**
 * --------------------------------------------start Read Postgres Data without chunuks -------------------------------------
 */

// async function readPostgresData(settings, tableName, activeColumns) {
//   const sequelizeSource = new Sequelize(
//     settings.database,
//     settings.username,
//     settings.password,
//     {
//       host: settings.host,
//       port: settings.port,
//       dialect: "postgres",
//       logging: false,
//     }
//   );

//   console.log("jhcdsuahdiads", tableName);

//   // FIXED: Use quoted column names and table name
//   const query = `SELECT ${activeColumns.map(col => `"${col}"`).join(", ")} FROM "${tableName}"`;
//   const rows = await sequelizeSource.query(query, { type: QueryTypes.SELECT });
//   console.log("query", query);
//   console.log("rows fetched:", rows.length);

//   await sequelizeSource.close();
//   return rows;
// }
/**
 * ----------------------------------------------------End Read Postgres Data without chunuks ----------------------------------------
 */

/**
 * ------------------------------------------- Start Read Postgres Data in Chunks -------------------------------------------
 */
async function readPostgresData(
  settings,
  tableName,
  activeColumns,
  chunkSize = 10000
) {
  const sequelizeSource = new Sequelize(
    settings.database,
    settings.username,
    settings.password,
    {
      host: settings.host,
      port: settings.port,
      dialect: "postgres",
      logging: false,
      pool: {
        max: 10,
        min: 0,
        acquire: 30000,
        idle: 10000,
      },
    }
  );

  try {
    console.log(`📖 Reading data from ${tableName} in chunks of ${chunkSize}`);

    let offset = 0;
    const allRows = [];
    let hasMoreData = true;

    while (hasMoreData) {
      const query = `
        SELECT ${activeColumns.map((col) => quoteIdent(col)).join(", ")} 
        FROM ${quoteIdent(tableName)} 
        ORDER BY 1
        LIMIT ${chunkSize} OFFSET ${offset}
      `;

      const rows = await sequelizeSource.query(query, {
        type: QueryTypes.SELECT,
      });

      if (rows.length === 0) {
        hasMoreData = false;
        break;
      }

      allRows.push(...rows);
      offset += chunkSize;

      console.log(
        `📊 Fetched chunk: ${rows.length} rows (Total: ${allRows.length})`
      );

      // Small delay to prevent overwhelming the database
      if (rows.length === chunkSize) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    console.log(`✅ Total rows fetched: ${allRows.length}`);
    return allRows;
  } finally {
    await sequelizeSource.close();
  }
}

/**
 * ------------------------------------------End Read Postgres Data in Chunks-------------------------------------------------
 */
/**
 * ----------------------------------------------Start Insert into Postgres Destination --------------------------------------
 */

// async function insertIntoPostgres(destSettings, tableName, activeColumns, rows, schemaDetails) {

//   const sequelizeDest = new Sequelize(
//     destSettings.database,
//     destSettings.username,
//     destSettings.password,
//     {
//       host: destSettings.host,
//       port: destSettings.port,
//       dialect: "postgres",
//       logging: false,
//     }
//   );

//   console.log("kugiuwgeir", tableName);

//   // Ensure table exists - FIXED: Remove the extra 'rows' parameter
//   await ensureTableFromSchema(sequelizeDest, tableName, schemaDetails);

//   // Bulk Insert - FIXED: Use quoted column names
//   const placeholders = rows
//     .map(() => `(${activeColumns.map(() => "?").join(", ")})`)
//     .join(", ");

//   const sql = `INSERT INTO "${tableName}" (${activeColumns.map(col => `"${col}"`).join(", ")}) VALUES ${placeholders}`;

//   const values = rows.flatMap(row => activeColumns.map(c => row[c] ?? null));

//   await sequelizeDest.query(sql, { replacements: values });

//   console.log(`✅ Inserted ${rows.length} rows into ${tableName}`);

//   await sequelizeDest.close();
// }
/**
 *--------------------------------------------------------End  Insert into Postgres Destination-----------------------------
 */
/**
 * ----------------------------------------------------Start  Insert into Postgres Destination in Chunks----------------------------
 */
// async function insertIntoPostgres(
//   destSettings,
//   tableName,
//   activeColumns,
//   rows,
//   schemaDetails,
//   chunkSize = 50000
// ) {
//   const sequelizeDest = new Sequelize(
//     destSettings.database,
//     destSettings.username,
//     destSettings.password,
//     {
//       host: destSettings.host,
//       port: destSettings.port,
//       dialect: "postgres",
//       logging: false,
//       pool: {
//         max: 1000,
//         min: 0,
//         acquire: 300000,
//         idle: 100000,
//       },
//     }
//   );

//   try {
//     console.log(`🗃️ Ensuring table ${tableName} exists`);
//     await ensureTableFromSchema(sequelizeDest, tableName, schemaDetails);
//     console.log("return after ensuring")

//     if (rows.length === 0) {
//       console.log("ℹ️ No rows to insert");
//       return;
//     }

//     console.log(`🚀 Inserting ${rows.length} rows in chunks of ${chunkSize}`);
//   console.log("before loop rows",rows)
//     // Process data in chunks
//     for (let i = 0; i < rows.length; i += chunkSize) {
//       const chunk = rows.slice(i, i + chunkSize);

//       const placeholders = chunk
//         .map(() => `(${activeColumns.map(() => "?").join(", ")})`)
//         .join(", ");

//       const sql = `INSERT INTO "${tableName}" (${activeColumns
//         .map((col) => `"${col}"`)
//         .join(", ")}) VALUES ${placeholders}`;

//       const values = chunk.flatMap((row) =>
//         activeColumns.map((c) => row[c] ?? null)
//       );
//       console.log("step 1")
//       await sequelizeDest.query(sql, { replacements: values });
//  console.log("step 2")
//       console.log(
//         `✅ Inserted chunk: ${chunk.length} rows (Progress: ${Math.min(
//           i + chunkSize,
//           rows.length
//         )}/${rows.length})`
//       );
//       console.log("step 3")

//       // Small delay to prevent overwhelming the database
//       if (i + chunkSize < rows.length) {
//         await new Promise((resolve) => setTimeout(resolve, 50));
//       }
//     }
//       console.log("step 4")

//     console.log(
//       `🎉 Successfully inserted all ${rows.length} rows into ${tableName}`
//     );
//   } finally {
//     await sequelizeDest.close();
//   }
// }

// async function insertIntoPostgres(
//   destSettings,
//   tableName,
//   activeColumns,
//   rows,
//   schemaDetails,
//   chunkSize = 50000
// ) {
//   const sequelizeDest = new Sequelize(
//     destSettings.database,
//     destSettings.username,
//     destSettings.password,
//     {
//       host: destSettings.host,
//       port: destSettings.port,
//       dialect: "postgres",
//       logging: false,
//       pool: {
//         max: 1000,
//         min: 0,
//         acquire: 300000,
//         idle: 100000,
//       },
//     }
//   );

//   try {
//     console.log(`🗃️ Ensuring table ${tableName} exists`);
//     await ensureTableFromSchema(sequelizeDest, tableName, schemaDetails);
//     console.log("return after ensuring");

//     if (rows.length === 0) {
//       console.log("ℹ️ No rows to insert");
//       return;
//     }

//     console.log(`🚀 Inserting ${rows.length} rows in chunks of ${chunkSize}`);

//     // ADD DATA VALIDATION AND CLEANING
//     const cleanedRows = rows.map(row => {
//       const cleanedRow = {};
//       activeColumns.forEach(col => {
//         // Handle different data types and null values
//         let value = row[col];

//         // Convert empty strings to null
//         if (value === '') {
//           value = null;
//         }

//         // Handle date strings
//         if (typeof value === 'string' && value.match(/^\d{4}-\d{2}-\d{2}/)) {
//           // It's a date string, keep as is (PostgreSQL will handle it)
//         }

//         // Handle boolean strings
//         if (value === 'true') value = true;
//         if (value === 'false') value = false;
//         if (value === '1') value = 1;
//         if (value === '0') value = 0;

//         cleanedRow[col] = value;
//       });
//       return cleanedRow;
//     });

//     console.log(`✅ Data cleaned and validated for ${cleanedRows.length} rows`);

//     // Process data in chunks
//     for (let i = 0; i < cleanedRows.length; i += chunkSize) {
//       const chunk = cleanedRows.slice(i, i + chunkSize);

//       console.log(`📦 Processing chunk ${i/chunkSize + 1}: ${chunk.length} rows`);

//       try {
//         const placeholders = chunk
//           .map(() => `(${activeColumns.map(() => "?").join(", ")})`)
//           .join(", ");

//         const sql = `INSERT INTO "${tableName}" (${activeColumns
//           .map((col) => `"${col}"`)
//           .join(", ")}) VALUES ${placeholders}`;

//         const values = chunk.flatMap((row) =>
//           activeColumns.map((c) => row[c] ?? null)
//         );
//         console.log("insert query",sql)
//         console.log("Executing SQL query...");
//         await sequelizeDest.query(sql, { replacements: values });
//         console.log("✅ Query executed successfully");

//         console.log(
//           `✅ Inserted chunk: ${chunk.length} rows (Progress: ${Math.min(
//             i + chunkSize,
//             cleanedRows.length
//           )}/${cleanedRows.length})`
//         );

//         // Small delay to prevent overwhelming the database
//         if (i + chunkSize < cleanedRows.length) {
//           await new Promise((resolve) => setTimeout(resolve, 50));
//         }
//       } catch (chunkError) {
//         console.error(`❌ Error in chunk ${i/chunkSize + 1}:`, chunkError.message);

//         // Log the problematic data for debugging
//         console.log("Problematic chunk data:", JSON.stringify(chunk, null, 2));
//         console.log("Active columns:", activeColumns);

//         throw chunkError; // Re-throw to stop the process
//       }
//     }

//     console.log(
//       `🎉 Successfully inserted all ${cleanedRows.length} rows into ${tableName}`
//     );
//   } catch (error) {
//     console.error("❌ Error in insertIntoPostgres:", error.message);
//     throw error;
//   } finally {
//     await sequelizeDest.close();
//   }
// }

// In your insertIntoPostgres function, add validation calls:
// async function insertIntoPostgres(
//   destSettings,
//   tableName,
//   activeColumns,
//   rows,
//   schemaDetails,
//   chunkSize = 50000
// ) {
//   const sequelizeDest = new Sequelize(
//     destSettings.database,
//     destSettings.username,
//     destSettings.password,
//     {
//       host: destSettings.host,
//       port: destSettings.port,
//       dialect: "postgres",
//       logging: false,
//       pool: {
//         max: 1000,
//         min: 0,
//         acquire: 300000,
//         idle: 100000,
//       },
//     }
//   );

//   try {
//     console.log(`🗃️ Ensuring table ${tableName} exists`);

//     // await ensureTableFromSchema(sequelizeDest, tableName, schemaDetails);

//     if (rows.length === 0) {
//       console.log("ℹ️ No rows to insert");
//       return;
//     }

//     console.log(`🚀 Inserting ${rows.length} rows in chunks of ${chunkSize}`);

//     // ✅ ADD VALIDATION STEPS HERE
//     // const cleanedRows = cleanDataForInsertion(rows, activeColumns);
//     const cleanedRows = cleanDataForUniversalInsertion(rows, activeColumns);
//     validateDataBeforeInsertion(cleanedRows, schemaDetails);
//     // ✅ USE UNIVERSAL DATA CLEANING

//     // Process data in chunks
//     for (let i = 0; i < cleanedRows.length; i += chunkSize) {
//       const chunk = cleanedRows.slice(i, i + chunkSize);

//       console.log(
//         `📦 Processing chunk ${i / chunkSize + 1}: ${chunk.length} rows`
//       );

//       await bulkInsert(sequelizeDest, tableName, activeColumns, chunk, 1000);

//       console.log(
//         `✅ Processed chunk: ${chunk.length} rows (Progress: ${Math.min(
//           i + chunkSize,
//           cleanedRows.length
//         )}/${cleanedRows.length})`
//       );

//       if (i + chunkSize < cleanedRows.length) {
//         await new Promise((resolve) => setTimeout(resolve, 50));
//       }
//     }

//     console.log(
//       `🎉 Successfully inserted all ${cleanedRows.length} rows into ${tableName}`
//     );
//   } catch (error) {
//     console.error("❌ Error in insertIntoPostgres:", error.message);
//     throw error;
//   } finally {
//     await sequelizeDest.close();
//   }
// }
// PURANA FUNCTION (hata do ya comment karo):
// async function insertIntoPostgres(
//   destSettings,
//   tableName,
//   activeColumns,
//   rows,
//   schemaDetails,
//   chunkSize = 50000
// ) {
//   const sequelizeDest = new Sequelize(...); // YE HATA DO
//   ...
// }

// NAYA SIMPLE FUNCTION:
async function insertIntoPostgres(
  sequelizeDest, // ✅ Connection pass karo

  tableName,
  activeColumns,
  rows,
  schemaDetails,
  chunkSize = 1000
) {
  // ✅ Connection creation hata diya

  try {
    console.log(`🗃️ Ensuring table ${tableName} exists`);

    // ✅ ADD VALIDATION
    if (!chunkSize || chunkSize <= 0) {
      console.warn(`⚠️ Invalid chunkSize: ${chunkSize}, using default 1000`);
      chunkSize = 1000;
    }

    if (!rows || !Array.isArray(rows)) {
      console.error("❌ Invalid rows data");
      return;
    }
    // Table creation main function mein ho raha hai, so yahan kuch nahi karna
    // await ensureTableFromSchema(...); // YE BHI HATA DO

    if (rows.length === 0) {
      console.log("ℹ️ No rows to insert");
      return;
    }

    console.log(`🚀 Inserting ${rows.length} rows in chunks of ${chunkSize}`);

    // Process data in chunks
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);

      console.log(
        `📦 Processing chunk ${i / chunkSize + 1}: ${chunk.length} rows`
      );

      await bulkInsert(sequelizeDest, tableName, activeColumns, chunk, 1000);

      console.log(
        `✅ Processed chunk: ${chunk.length} rows (Progress: ${Math.min(
          i + chunkSize,
          rows.length
        )}/${rows.length})`
      );

      if (i + chunkSize < rows.length) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    console.log(
      `🎉 Successfully inserted all ${rows.length} rows into ${tableName}`
    );
  } catch (error) {
    console.error("❌ Error in insertIntoPostgres:", error.message);
    throw error;
  }
  // ✅ finally block bhi hata do kyunki connection main function close karega
}

/**
 * ----------------------------------------------------End  Insert into Postgres Destination in Chunks----------------------------
 */
/**
 * --------------------------------------------Start Write to Excel Destination wihtout chunks --------------------------------------------
 */
// async function writeExcelFile(destSettings, tableName, rows) {
//   const worksheet = XLSX.utils.json_to_sheet(rows);
//   const workbook = XLSX.utils.book_new();
//   XLSX.utils.book_append_sheet(workbook, worksheet, tableName);

//   // Default path or provided in settings
//   const filePath =
//     destSettings.path || path.join(__dirname, `${tableName}_output.xlsx`);

//   XLSX.writeFile(workbook, filePath);

//   console.log(`✅ Excel file created: ${filePath}`);
// }
/**
 * --------------------------------------------END Write to Excel Destination wihtout chunks --------------------------------------------
 */

/**
 * ----------------------------------------------Write to Excel Destination with Streaming (for large files)with chunks -----------------------------
 */
// async function writeExcelFile(
//   destSettings,
//   tableName,
//   rows,
//   chunkSize = 10000
// ) {
//   console.log(`📝 Writing ${rows.length} rows to Excel file`);

//   const workbook = XLSX.utils.book_new();

//   if (rows.length <= chunkSize) {
//     // Small dataset - write all at once
//     const worksheet = XLSX.utils.json_to_sheet(rows);
//     XLSX.utils.book_append_sheet(workbook, worksheet, tableName);
//   } else {
//     // Large dataset - write in chunks to avoid memory issues
//     const worksheet = XLSX.utils.aoa_to_sheet([]);

//     // Add headers
//     const headers = Object.keys(rows[0] || {});
//     XLSX.utils.sheet_add_aoa(worksheet, [headers], { origin: "A1" });

//     // Add data in chunks
//     for (let i = 0; i < rows.length; i += chunkSize) {
//       const chunk = rows.slice(i, i + chunkSize);
//       const chunkData = chunk.map((row) =>
//         headers.map((header) => row[header])
//       );
//       XLSX.utils.sheet_add_aoa(worksheet, chunkData, { origin: `A${i + 2}` });

//       console.log(
//         `✅ Written Excel chunk: ${chunk.length} rows (Progress: ${
//           i + chunkSize
//         }/${rows.length})`
//       );
//     }

//     XLSX.utils.book_append_sheet(workbook, worksheet, tableName);
//   }

//   const filePath =
//     destSettings.path || path.join(__dirname, `${tableName}_output.xlsx`);
//   XLSX.writeFile(workbook, filePath);

//   console.log(`✅ Excel file created: ${filePath}`);
// }

async function writeExcelFile(
  destSettings,
  tableName,
  rows,
  chunkSize = 10000
) {
  console.log(`📝 Writing ${rows.length} rows to Excel file`);

  const workbook = XLSX.utils.book_new();

  if (rows.length <= chunkSize) {
    // Small dataset - write all at once
    const worksheet = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(workbook, worksheet, tableName);
  } else {
    // Large dataset - write in chunks to avoid memory issues
    const worksheet = XLSX.utils.aoa_to_sheet([]);

    // Add headers
    const headers = Object.keys(rows[0] || {});
    XLSX.utils.sheet_add_aoa(worksheet, [headers], { origin: "A1" });

    // Add data in chunks
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const chunkData = chunk.map((row) =>
        headers.map((header) => row[header])
      );
      XLSX.utils.sheet_add_aoa(worksheet, chunkData, { origin: `A${i + 2}` });

      console.log(
        `✅ Written Excel chunk: ${chunk.length} rows (Progress: ${
          i + chunkSize
        }/${rows.length})`
      );
    }

    XLSX.utils.book_append_sheet(workbook, worksheet, tableName);
  }

  // Generate unique filename with timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${tableName}_export_${timestamp}.xlsx`;
  const filePath = path.join(__dirname, "../exports", fileName);

  // Ensure exports directory exists
  const exportsDir = path.dirname(filePath);
  if (!fs.existsSync(exportsDir)) {
    fs.mkdirSync(exportsDir, { recursive: true });
  }

  XLSX.writeFile(workbook, filePath);

  console.log(`✅ Excel file created: ${filePath}`);

  return {
    filePath,
    fileName,
    fileSize: fs.statSync(filePath).size,
  };
}
/**
 * ----------------------------------------------END Write to Excel Destination with Streaming (for large files)with chunks -----------------------------
 */

/**
 * Ensure table exists in Postgres destination
 */

// async function ensureTableFromSchema(sequelize, tableName, schemaDetails) {
//   const queryInterface = sequelize.getQueryInterface();

//   // 1. Check if table exists
//   const tables = await queryInterface.showAllTables();
//   if (tables.includes(tableName)) {
//     console.log(`Table ${tableName} already exists`);
//     return;
//   }

//   // 2. Build columns from schema - FIXED: Use correct property names
//   const attributes = {};
//   let primaryKeys = [];

//   schemaDetails?.forEach((col) => {
//     if (!col.is_active) return;

//     let type;
//     switch ((col.data_type || "text").toLowerCase()) {
//       case "integer":
//       case "int":
//         type = DataTypes.INTEGER;
//         break;
//       case "float":
//       case "double":
//       case "numeric":
//       case "decimal":
//         type = DataTypes.FLOAT;
//         break;
//       case "boolean":
//       case "bool":
//         type = DataTypes.BOOLEAN;
//         break;
//       case "date":
//       case "timestamp":
//         type = DataTypes.DATE;
//         break;
//       default:
//         type = DataTypes.STRING;
//     }

//     attributes[col.column_name] = { type, allowNull: true };

//     // FIXED: Check the correct property for primary key
//     if (col.primary_key_column_name) {
//       primaryKeys.push(col.column_name);
//     }
//   });

//   // 3. Create table
//   await queryInterface.createTable(tableName, attributes);

//   // 4. Add primary key constraint if any primary keys exist
//   if (primaryKeys.length > 0) {
//     await sequelize.query(
//       `ALTER TABLE "${tableName}" ADD PRIMARY KEY (${primaryKeys
//         .map((pk) => `"${pk}"`)
//         .join(", ")});`
//     );
//   }

//   console.log(`✅ Table ${tableName} created with schema & primary key`);
// }

// async function ensureTableFromSchema(sequelize, tableName, schemaDetails) {
//   const queryInterface = sequelize.getQueryInterface();

//   try {
//     // 1. Check if table exists
//     const tables = await queryInterface.showAllTables();

//     if (tables.includes(tableName)) {
//       console.log(
//         `🔄 Table ${tableName} already exists - checking schema compatibility`
//       );

//       // Option A: DROP AND RECREATE TABLE (Recommended)
//       console.log(
//         `🗑️ Dropping existing table ${tableName} to recreate with correct schema`
//       );
//       await queryInterface.dropTable(tableName);

//       // Option B: ALTER TABLE (More complex - uncomment if you prefer)
//       // await alterTableToMatchSchema(sequelize, tableName, schemaDetails);
//       // return;
//     }

//     console.log(`🆕 Creating new table: ${tableName}`);

//     // 2. Build columns from schema with CORRECT data type mapping
//     const attributes = {};
//     let primaryKeys = [];

//     schemaDetails?.forEach((col) => {
//       if (!col.is_active) return;

//       let type;
//       const dataType = (col.data_type || "string").toLowerCase(); // Default to string

//       // Map data types based on your actual data
//       switch (dataType) {
//         case "integer":
//         case "int":
//         case "number":
//         case "bigint":
//         case "numeric":
//           type = DataTypes.INTEGER;
//           break;
//         case "float":
//         case "double":
//         case "decimal":
//           type = DataTypes.FLOAT;
//           break;
//         case "boolean":
//         case "bool":
//           type = DataTypes.BOOLEAN;
//           break;
//         case "date":
//         case "timestamp":
//         case "datetime":
//           type = DataTypes.DATE;
//           break;
//         case "string":
//         case "text":
//         case "varchar":
//         default:
//           type = DataTypes.TEXT; // Use TEXT for flexibility with long strings
//           break;
//       }

//       attributes[col.column_name] = {
//         type,
//         allowNull: true,
//       };

//       // Check for primary key
//       if (col.primary_key_column_name === col.column_name) {
//         primaryKeys.push(col.column_name);
//         console.log(`🔑 Marking as primary key: ${col.column_name}`);
//       }
//     });

//     console.log(
//       `📋 Creating table with schema:`,
//       JSON.stringify(attributes, null, 2)
//     );

//     // 3. Create table
//     await queryInterface.createTable(tableName, attributes);

//     // 4. Add primary key constraint if any primary keys exist
//     if (primaryKeys.length > 0) {
//       console.log(
//         `🔑 Adding primary key constraint: ${primaryKeys.join(", ")}`
//       );
//       await sequelize.query(
//         `ALTER TABLE "${tableName}" ADD PRIMARY KEY (${primaryKeys
//           .map((pk) => `"${pk}"`)
//           .join(", ")});`
//       );
//     }

//     console.log(
//       `✅ Table ${tableName} created successfully with correct schema`
//     );
//   } catch (error) {
//     console.error(`❌ Error ensuring table ${tableName}:`, error.message);
//     throw error;
//   }
// }

// async function ensureTableFromSchema(sequelize, tableName, schemaDetails) {
//   const queryInterface = sequelize.getQueryInterface();

//   try {
//     // Check if table exists
//     const tables = await queryInterface.showAllTables();

//     if (tables.includes(tableName)) {
//       console.log(
//         `🔄 Table ${tableName} already exists - checking schema compatibility`
//       );
//       await queryInterface.dropTable(tableName);
//     }

//     console.log(`🆕 Creating new table: ${tableName}`);

//     // Build columns from schema with TEXT instead of JSON for string data
//     const attributes = {};
//     let primaryKeys = [];

//     schemaDetails?.forEach((col) => {
//       if (!col.is_active) return;

//       let type;
//       const dataType = (col.data_type || "string").toLowerCase();

//       // Use TEXT for columns that might contain mixed string/JSON data
//       // This is more flexible for QuickBooks data
//       switch (dataType) {
//         case "integer":
//         case "int":
//         case "number":
//         case "bigint":
//         case "numeric":
//           type = DataTypes.INTEGER;
//           break;
//         case "float":
//         case "double":
//         case "decimal":
//           type = DataTypes.FLOAT;
//           break;
//         case "boolean":
//         case "bool":
//           type = DataTypes.BOOLEAN;
//           break;
//         case "date":
//         case "timestamp":
//         case "datetime":
//           type = DataTypes.DATE;
//           break;
//         case "json":
//         case "object":
//         case "array":
//           // Use TEXT instead of JSONB for flexibility with QuickBooks data
//           type = DataTypes.TEXT;
//           break;
//         case "string":
//         case "text":
//         case "varchar":
//         default:
//           type = DataTypes.TEXT;
//           break;
//       }

//       attributes[col.column_name] = {
//         type,
//         allowNull: true,
//       };

//       if (col.primary_key_column_name === col.column_name) {
//         primaryKeys.push(col.column_name);
//         console.log(`🔑 Marking as primary key: ${col.column_name}`);
//       }
//     });

//     console.log(`📋 Creating table with flexible schema for QuickBooks data`);

//     // Create table
//     await queryInterface.createTable(tableName, attributes);

//     // Add primary key constraint if any primary keys exist
//     if (primaryKeys.length > 0) {
//       console.log(
//         `🔑 Adding primary key constraint: ${primaryKeys.join(", ")}`
//       );
//       await sequelize.query(
//         `ALTER TABLE "${tableName}" ADD PRIMARY KEY (${primaryKeys
//           .map((pk) => `"${pk}"`)
//           .join(", ")});`
//       );
//     }

//     console.log(
//       `✅ Table ${tableName} created successfully with universal schema`
//     );
//   } catch (error) {
//     console.error(`❌ Error ensuring table ${tableName}:`, error.message);
//     throw error;
//   }
// }

// async function ensureTableFromSchema(sequelize, tableName, schemaDetails) {
//   const queryInterface = sequelize.getQueryInterface();

//   try {
//     // Check if table exists
//     const tables = await queryInterface.showAllTables();

//     if (tables.includes(tableName)) {
//       console.log(`🔄 Table ${tableName} already exists - checking schema compatibility`);
//       await queryInterface.dropTable(tableName);
//     }

//     console.log(`🆕 Creating new table: ${tableName}`);

//     // Build columns from schema with BIGINT for large IDs
//     const attributes = {};
//     let primaryKeys = [];

//     schemaDetails?.forEach((col) => {
//       if (!col.is_active) return;

//       let type;
//       const dataType = (col.data_type || "string").toLowerCase();
//       const columnName = col.column_name.toLowerCase();

//       // 🚨 CRITICAL FIX: Use BIGINT for Shopify IDs and other large numbers
//       if (columnName.includes('id') || columnName.includes('_id')) {
//         // For ID columns, use BIGINT to handle Shopify's large IDs
//         type = DataTypes.BIGINT;
//       } else {
//         // Use TEXT for columns that might contain mixed string/JSON data
//         switch (dataType) {
//           case "integer":
//           case "int":
//           case "number":
//           case "bigint":
//           case "numeric":
//             type = DataTypes.BIGINT; // 🚨 CHANGED FROM INTEGER TO BIGINT
//             break;
//           case "float":
//           case "double":
//           case "decimal":
//             type = DataTypes.FLOAT;
//             break;
//           case "boolean":
//           case "bool":
//             type = DataTypes.BOOLEAN;
//             break;
//           case "date":
//           case "timestamp":
//           case "datetime":
//             type = DataTypes.DATE;
//             break;
//           case "json":
//           case "object":
//           case "array":
//             type = DataTypes.TEXT;
//             break;
//           case "string":
//           case "text":
//           case "varchar":
//           default:
//             type = DataTypes.TEXT;
//             break;
//         }
//       }

//       attributes[col.column_name] = {
//         type,
//         allowNull: true,
//       };

//       if (col.primary_key_column_name === col.column_name) {
//         primaryKeys.push(col.column_name);
//         console.log(`🔑 Marking as primary key: ${col.column_name}`);
//       }
//     });

//     console.log(`📋 Creating table with BIGINT support for Shopify IDs`);

//     // Create table
//     await queryInterface.createTable(tableName, attributes);

//     // Add primary key constraint if any primary keys exist
//     if (primaryKeys.length > 0) {
//       console.log(`🔑 Adding primary key constraint: ${primaryKeys.join(", ")}`);
//       await sequelize.query(
//         `ALTER TABLE "${tableName}" ADD PRIMARY KEY (${primaryKeys
//           .map((pk) => `"${pk}"`)
//           .join(", ")});`
//       );
//     }

//     console.log(`✅ Table ${tableName} created successfully with BIGINT support`);
//   } catch (error) {
//     console.error(`❌ Error ensuring table ${tableName}:`, error.message);
//     throw error;
//   }
// }

/**
 * QuickBooks-specific: Simple data cleaner - convert everything to text
 */
function cleanQuickBooksDataForPostgres(rows, activeColumns) {
  console.log("🧹 Converting QuickBooks data to text for PostgreSQL...");

  return rows.map((row) => {
    const cleanedRow = {};

    activeColumns.forEach((col) => {
      let value = row[col];

      // Handle null/undefined/empty strings
      if (value === null || value === undefined) {
        cleanedRow[col] = null;
        return;
      }

      // ✅ QUICKBOOKS-SPECIFIC: Convert everything to string
      if (typeof value === "object" && value !== null) {
        // Handle objects and arrays by stringifying them
        try {
          cleanedRow[col] = JSON.stringify(value);
        } catch (error) {
          cleanedRow[col] = String(value);
        }
      } else if (typeof value === "boolean") {
        // Convert booleans to string 'true'/'false'
        cleanedRow[col] = value ? "true" : "false";
      } else {
        // Convert everything else to string
        cleanedRow[col] = String(value);
      }
    });

    return cleanedRow;
  });
}

/**
 * QuickBooks-specific: Simple table schema - all TEXT columns
 */
async function ensureQuickBooksTableFromSchema(
  sequelize,
  tableName,
  schemaDetails
) {
  const queryInterface = sequelize.getQueryInterface();

  try {
    // Check if table exists
    const tables = await queryInterface.showAllTables();

    if (tables.includes(tableName)) {
      console.log(
        `🔄 Table ${tableName} already exists - checking schema compatibility`
      );
      await queryInterface.dropTable(tableName);
    }

    console.log(`🆕 Creating QuickBooks table: ${tableName}`);

    // ✅ QUICKBOOKS-SPECIFIC: Create all columns as TEXT
    const attributes = {};
    let primaryKeys = [];

    schemaDetails?.forEach((col) => {
      if (!col.is_active) return;

      // Everything becomes TEXT for QuickBooks
      attributes[col.column_name] = {
        type: DataTypes.TEXT,
        allowNull: true,
      };

      console.log(`📝 ${col.column_name} → TEXT (QuickBooks)`);

      if (col.primary_key_column_name === col.column_name) {
        primaryKeys.push(col.column_name);
        console.log(`🔑 Marking as primary key: ${col.column_name}`);
      }
    });

    console.log(`📋 Creating QuickBooks table with universal TEXT schema`);

    // Create table
    await queryInterface.createTable(tableName, attributes);

    // Add primary key constraint if any primary keys exist
    if (primaryKeys.length > 0) {
      console.log(
        `🔑 Adding primary key constraint: ${primaryKeys.join(", ")}`
      );
      await sequelize.query(
        `ALTER TABLE ${quoteIdent(tableName)} ADD PRIMARY KEY (${primaryKeys
          .map((pk) => quoteIdent(pk))
          .join(", ")});`
      );
    }

    console.log(
      `✅ QuickBooks table ${tableName} created successfully with TEXT columns`
    );
  } catch (error) {
    console.error(
      `❌ Error ensuring QuickBooks table ${tableName}:`,
      error.message
    );
    throw error;
  }
}

async function ensureTableFromSchema(sequelize, tableName, schemaDetails) {
  const queryInterface = sequelize.getQueryInterface();

  try {
    // Check if table exists
    const tables = await queryInterface.showAllTables();

    if (tables.includes(tableName)) {
      console.log(
        `🔄 Table ${tableName} already exists - checking schema compatibility`
      );
      await queryInterface.dropTable(tableName);
    }

    console.log(`🆕 Creating new table: ${tableName}`);

    // Build columns from schema
    const attributes = {};
    let primaryKeys = [];

    schemaDetails?.forEach((col) => {
      if (!col.is_active) return;

      let type;
      const dataType = (col.data_type || "string").toLowerCase();
      const columnName = col.column_name.toLowerCase();

      // 🚨 CRITICAL: Use TEXT for array columns and JSON data
      if (
        columnName.includes("[") ||
        columnName.includes("]") ||
        columnName.includes("variants") ||
        columnName.includes("options") ||
        columnName.includes("images") ||
        columnName.includes("variant_ids") ||
        columnName.includes("weight_unit") ||
        columnName.includes("unit") ||
        columnName.includes("currency") ||
        columnName.includes("policy") ||
        columnName.includes("service") ||
        columnName.includes("management")
      ) {
        type = DataTypes.TEXT;
      }
      // 🚨 CRITICAL: Use TEXT for GraphQL IDs and string-based IDs
      else if (
        columnName.includes("admin_graphql_api_id") ||
        columnName.includes("graphql") ||
        columnName.includes("gid_")
      ) {
        type = DataTypes.TEXT;
      }
      // Use BIGINT for regular numeric IDs
      else if (
        (columnName === "id" || columnName.endsWith("_id")) &&
        !columnName.includes("[") &&
        !columnName.includes("variant_ids")
      ) {
        type = DataTypes.BIGINT;
      } else {
        // Use TEXT for columns that might contain mixed string/JSON data
        switch (dataType) {
          case "integer":
          case "int":
          case "number":
          case "bigint":
          case "numeric":
            type = DataTypes.BIGINT;
            break;
          case "float":
          case "double":
          case "decimal":
            type = DataTypes.FLOAT;
            break;
          case "boolean":
          case "bool":
            type = DataTypes.BOOLEAN;
            break;
          case "date":
          case "timestamp":
          case "datetime":
            type = DataTypes.DATE;
            break;
          case "json":
          case "object":
          case "array":
            type = DataTypes.TEXT;
            break;
          case "string":
          case "text":
          case "varchar":
          default:
            type = DataTypes.TEXT;
            break;
        }
      }

      attributes[col.column_name] = {
        type,
        allowNull: true,
      };

      if (col.primary_key_column_name === col.column_name) {
        primaryKeys.push(col.column_name);
        console.log(`🔑 Marking as primary key: ${col.column_name}`);
      }
    });

    console.log(`📋 Creating table with proper array and GraphQL ID handling`);

    // Create table
    await queryInterface.createTable(tableName, attributes);

    // Add primary key constraint if any primary keys exist
    if (primaryKeys.length > 0) {
      console.log(
        `🔑 Adding primary key constraint: ${primaryKeys.join(", ")}`
      );
      await sequelize.query(
        `ALTER TABLE ${quoteIdent(tableName)} ADD PRIMARY KEY (${primaryKeys
          .map((pk) => quoteIdent(pk))
          .join(", ")});`
      );
    }

    console.log(
      `✅ Table ${tableName} created successfully with array support`
    );
  } catch (error) {
    console.error(`❌ Error ensuring table ${tableName}:`, error.message);
    throw error;
  }
}

// async function upsertData(
//   sequelize,
//   tableName,
//   activeColumns,
//   rows,
//   primaryKeyColumns,
//   chunkSize = 10000
// ) {
//   // Validate primary key columns exist in active columns
//   const missingPrimaryKeys = primaryKeyColumns.filter(
//     (pk) => !activeColumns.includes(pk)
//   );
//   if (missingPrimaryKeys.length > 0) {
//     throw new Error(
//       `Primary key columns not found in active columns: ${missingPrimaryKeys.join(
//         ", "
//       )}`
//     );
//   }
//   if (!rows.length) return;

//   console.log(
//     `🔄 Performing UPSERT on ${rows.length} rows in chunks of ${chunkSize}`
//   );
//   console.log(`🔑 Primary key: ${primaryKeyColumns.join(", ")}`);

//   const transaction = await sequelize.transaction();

//   try {
//     const totalChunks = Math.ceil(rows.length / chunkSize);

//     for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
//       const start = chunkIndex * chunkSize;
//       const end = Math.min(start + chunkSize, rows.length);
//       const chunk = rows.slice(start, end);

//       console.log(
//         `📦 Processing chunk ${chunkIndex + 1}/${totalChunks}: ${
//           chunk.length
//         } rows`
//       );

//       await bulkUpsertChunk(
//         sequelize,
//         tableName,
//         activeColumns,
//         chunk,
//         primaryKeyColumns,
//         transaction
//       );
//     }

//     await transaction.commit();
//     console.log(`🎉 Bulk UPSERT completed for ${rows.length} rows`);
//   } catch (error) {
//     await transaction.rollback();
//     console.error(`❌ UPSERT failed:`, error.message);
//     throw error;
//   }
// }

// async function bulkUpsertChunk(
//   sequelize,
//   tableName,
//   activeColumns,
//   chunk,
//   primaryKeyColumns,
//   transaction
// ) {
//   const columns = activeColumns.map((col) => `"${col}"`).join(", ");
//   const valuePlaceholders = [];
//   const allValues = [];

//   // Build VALUES clause for all rows
//   chunk.forEach((row, rowIndex) => {
//     const rowPlaceholders = activeColumns
//       .map((_, colIndex) => {
//         return `$${rowIndex * activeColumns.length + colIndex + 1}`;
//       })
//       .join(", ");

//     valuePlaceholders.push(`(${rowPlaceholders})`);

//     activeColumns.forEach((col) => {
//       allValues.push(row[col] ?? null);
//     });
//   });

//   const updateSet = activeColumns
//     .map((col) => `"${col}" = EXCLUDED."${col}"`)
//     .join(", ");

//   const sql = `
//     INSERT INTO "${tableName}" (${columns})
//     VALUES ${valuePlaceholders.join(", ")}
//     ON CONFLICT (${primaryKeyColumns.map((pk) => `"${pk}"`).join(", ")})
//     DO UPDATE SET ${updateSet}
//   `;

//   await sequelize.query(sql, {
//     bind: allValues,
//     transaction,
//   });
// }

// function debugSchemaDetails(schemaDetails, tableName) {
//   console.log(`🔍 DEBUG SCHEMA for ${tableName}:`);
//   schemaDetails.forEach((col, index) => {
//     console.log(`  [${index}] ${col.column_name}:`, {
//       is_active: col.is_active,
//       primary_key_column_name: col.primary_key_column_name,
//       data_type: col.data_type,
//       table_name: col.table_name,
//     });
//   });

//   const primaryKeys = schemaDetails
//     .filter((col) => col.primary_key_column_name && col.is_active)
//     .map((col) => col.primary_key_column_name);

//   console.log(`🔑 Detected primary keys:`, primaryKeys);
// }
// Then modify your syncData function to include debugging:
// async function syncData(
//   destSettings,
//   tableName,
//   activeColumns,
//   rows,
//   schemaDetails,
//   syncMode
// ) {
//   // Add debug logging
//   debugSchemaDetails(schemaDetails, tableName);
//   const sequelizeDest = new Sequelize(
//     destSettings.database,
//     destSettings.username,
//     destSettings.password,
//     {
//       host: destSettings.host,
//       port: destSettings.port,
//       dialect: "postgres",
//       logging: false,
//       pool: {
//         max: 1000,
//         min: 0,
//         acquire: 300000,
//         idle: 100000,
//       },
//     }
//   );

//   try {
//     console.log(`🔄 Executing sync strategy: ${syncMode}`);

//     // Clean data first
//     const cleanedRows = cleanDataForInsertion(rows, activeColumns);
//     validateDataBeforeInsertion(cleanedRows, schemaDetails);

//     // Get primary key columns from schema
//     const primaryKeyColumns = schemaDetails
//       .filter((col) => col.primary_key_column_name === col.column_name)
//       .map((col) => col.column_name);

//     console.log(`🔑 Primary key columns: ${primaryKeyColumns.join(", ")}`);

//     // For "Incremental | Append" with primary key, use UPSERT
//     if (syncMode === "Incremental | Append" && primaryKeyColumns.length > 0) {
//       console.log(
//         "🔄 Using UPSERT (INSERT ON CONFLICT) for incremental append with primary key"
//       );
//       await upsertData(
//         sequelizeDest,
//         tableName,
//         activeColumns,
//         cleanedRows,
//         primaryKeyColumns
//       );
//     } else {
//       // Use the original logic for other cases
//       switch (syncMode) {
//         case "Incremental | Append":
//           await bulkInsert(
//             sequelizeDest,
//             tableName,
//             activeColumns,
//             cleanedRows
//           );
//           break;

//         case "Incremental | Append + Deduped":
//           await incrementalAppendDedup(
//             sequelizeDest,
//             tableName,
//             activeColumns,
//             cleanedRows,
//             schemaDetails
//           );
//           break;

//         case "Full refresh | Overwrite":
//           await overwrite(sequelizeDest, tableName, activeColumns, cleanedRows);
//           break;

//         case "Full refresh | Overwrite + Deduped":
//           await overwriteDedup(
//             sequelizeDest,
//             tableName,
//             activeColumns,
//             cleanedRows,
//             schemaDetails
//           );
//           break;

//         case "Full refresh | Append":
//           // await bulkInsert(
//           //   sequelizeDest,
//           //   tableName,
//           //   activeColumns,
//           //   cleanedRows
//           // );
//           // break;
//           // Skip validation temporarily to test
//         // await bulkInsert(sequelizeDest, tableName, activeColumns, cleanedRows);

//         // Try direct insertion without complex validation
//         await simpleBulkInsert(sequelizeDest, tableName, activeColumns, cleanedRows);
//         break;

//         default:
//           console.log(
//             `⚠️ Unknown sync mode: ${syncMode}, using default: Full refresh | Overwrite`
//           );
//           await overwrite(sequelizeDest, tableName, activeColumns, cleanedRows);
//       }
//     }

//     console.log(`✅ Sync completed using strategy: ${syncMode}`);
//   } catch (error) {
//     console.error(`❌ Sync failed with strategy ${syncMode}:`, error.message);
//     throw error;
//   } finally {
//     await sequelizeDest.close();
//   }
// }

function debugSchemaDetails(schemaDetails, tableName) {
  console.log(`🔍 DEBUG SCHEMA for ${tableName}:`);

  // schemaDetails.forEach((col, index) => {
  //   console.log(`  [${index}] ${col.column_name}:`, {
  //     is_active: col.is_active,
  //     primary_key_column_name: col.primary_key_column_name,
  //     data_type: col.data_type,
  //     table_name: col.table_name,
  //     has_primary_key: col.primary_key_column_name === col.column_name,
  //     raw_data: col, // Log entire object for debugging
  //   });
  // });

  const primaryKeys = schemaDetails
    .filter((col) => {
      // Multiple detection methods
      return (
        (col.primary_key_column_name &&
          col.primary_key_column_name === col.column_name) ||
        col.is_primary_key ||
        col.primary_key
      );
    })
    .map((col) => col.column_name);

  console.log(`🔑 Detected primary keys:`, primaryKeys);

  if (primaryKeys.length === 0) {
    console.warn(`⚠️ WARNING: No primary keys detected for table ${tableName}`);
  }
}
function debugPrimaryKeyDetection(schemaDetails, tableName) {
  console.log(`🔍 DEBUG PRIMARY KEYS for ${tableName}:`);

  const detectedPrimaryKeys = schemaDetails
    .filter((col) => col.primary_key_column_name === col.column_name)
    .map((col) => col.column_name);

  console.log("Detected PKs:", detectedPrimaryKeys);
  console.log(
    "All schema details:",
    schemaDetails.map((col) => ({
      column: col.column_name,
      pk_column_name: col.primary_key_column_name,
      is_pk: col.primary_key_column_name === col.column_name,
    }))
  );

  return detectedPrimaryKeys;
}
// async function syncData(
//   sequelizeDest,
//   destSettings,
//   tableName,
//   activeColumns,
//   rows,
//   schemaDetails,
//   syncMode
// ) {

//   // Add primary key debugging
//   const primaryKeyColumns = debugPrimaryKeyDetection(schemaDetails, tableName);

//   console.log(`🔑 FINAL Primary key columns: ${primaryKeyColumns.join(", ")}`);

//   // If no valid primary keys, fall back to overwrite
//   if (primaryKeyColumns.length === 0) {
//     console.log(`⚠️ No valid primary keys detected for ${tableName}, using overwrite instead of UPSERT`);
//     await overwrite(sequelizeDest, tableName, activeColumns, cleanedRows);
//     return;
//   }
//   // Add debug logging
//   debugSchemaDetails(schemaDetails, tableName);

//   // const sequelizeDest = new Sequelize(
//   //   destSettings.database,
//   //   destSettings.username,
//   //   destSettings.password,
//   //   {
//   //     host: destSettings.host,
//   //     port: destSettings.port,
//   //     dialect: "postgres",
//   //     logging: false,
//   //     pool: {
//   //       max: 1000,
//   //       min: 0,
//   //       acquire: 300000,
//   //       idle: 100000,
//   //     },
//   //   }
//   // );

//   try {
//     console.log(`🔄 Executing sync strategy: ${syncMode}`);

//     // // Clean data first
//     // const cleanedRows = cleanDataForInsertion(rows, activeColumns);

//     // // Only validate for strategies that require it
//     // if (syncMode.includes("Deduped")) {
//     //   validateDataBeforeInsertion(cleanedRows, schemaDetails);
//     // }
//     // ✅ USE SCHEMA-AWARE DATA CLEANING
//     const cleanedRows = cleanDataWithSchemaAwareness(
//       rows,
//       activeColumns,
//       schemaDetails
//     );

//     // Log sample data for debugging
//     console.log("🔍 Sample cleaned data:", cleanedRows.slice(0, 2));

//     // Only validate for strategies that require it
//     if (syncMode.includes("Deduped")) {
//       validateDataBeforeInsertion(cleanedRows, schemaDetails);
//     }

//     // Get primary key columns from schema
//     const primaryKeyColumns = schemaDetails
//       .filter((col) => {
//         return (
//           col.primary_key_column_name === col.column_name ||
//           col.is_primary_key ||
//           (col.primary_key_column_name && col.is_active)
//         );
//       })
//       .map((col) => col.column_name);

//     console.log(`🔑 Primary key columns: ${primaryKeyColumns.join(", ")}`);

//     // Handle different sync strategies with fallbacks
//     switch (syncMode) {
//       case "Incremental | Append":
//         if (primaryKeyColumns.length > 0) {
//           console.log(
//             "🔄 Using UPSERT for incremental append with primary key"
//           );
//           await upsertData(
//             sequelizeDest,
//             tableName,
//             activeColumns,
//             cleanedRows,
//             primaryKeyColumns
//           );
//         } else {
//           console.log(
//             "📝 Using bulk insert for incremental append (no primary key)"
//           );
//           await bulkInsert(
//             sequelizeDest,
//             tableName,
//             activeColumns,
//             cleanedRows
//           );
//         }
//         break;

//       case "Incremental | Append + Deduped":
//         if (primaryKeyColumns.length > 0) {
//           console.log("🔄 Using UPSERT for incremental append + deduped");
//           await upsertData(
//             sequelizeDest,
//             tableName,
//             activeColumns,
//             cleanedRows,
//             primaryKeyColumns
//           );
//         } else {
//           console.warn(
//             "⚠️ Cannot deduplicate without primary key, using regular append"
//           );
//           await bulkInsert(
//             sequelizeDest,
//             tableName,
//             activeColumns,
//             cleanedRows
//           );
//         }
//         break;

//       case "Full refresh | Overwrite":
//         await overwrite(sequelizeDest, tableName, activeColumns, cleanedRows);
//         break;

//       case "Full refresh | Overwrite + Deduped":
//         if (primaryKeyColumns.length > 0) {
//           await overwriteDedup(
//             sequelizeDest,
//             tableName,
//             activeColumns,
//             cleanedRows,
//             schemaDetails
//           );
//         } else {
//           console.warn(
//             "⚠️ Cannot deduplicate without primary key, using regular overwrite"
//           );
//           await overwrite(sequelizeDest, tableName, activeColumns, cleanedRows);
//         }
//         break;

//       case "Full refresh | Append":
//         await bulkInsert(sequelizeDest, tableName, activeColumns, cleanedRows);
//         break;

//       default:
//         console.log(
//           `⚠️ Unknown sync mode: ${syncMode}, using default: Full refresh | Overwrite`
//         );
//         await overwrite(sequelizeDest, tableName, activeColumns, cleanedRows);
//     }

//     console.log(`✅ Sync completed using strategy: ${syncMode}`);
//   } catch (error) {
//     console.error(`❌ Sync failed with strategy ${syncMode}:`, error.message);

//     // Provide more helpful error messages
//     if (error.message.includes("No primary key defined")) {
//       throw new Error(
//         `Sync strategy '${syncMode}' requires primary keys for deduplication. Please configure primary keys in your schema or use a different sync strategy.`
//       );
//     }

//     throw error;
//   } finally {
//     // await sequelizeDest.close();
//   }
// }

/**
 * Enhanced syncData function with proper primary key validation and error handling
 */
async function syncData(
  sequelizeDest,
  destSettings,
  tableName,
  activeColumns,
  rows,
  schemaDetails,
  syncMode
) {
  let transaction;

  try {
    console.log(
      `🔄 Executing sync strategy: ${syncMode} for table: ${tableName}`
    );

    // Start transaction for data consistency
    transaction = await sequelizeDest.transaction();

    // 1. Clean and validate data first
    const cleanedRows = cleanDataWithSchemaAwareness(
      rows,
      activeColumns,
      schemaDetails
    );

    console.log(`📊 Data prepared: ${cleanedRows.length} rows`);
    if (cleanedRows.length > 0) {
      console.log("🔍 Sample cleaned data:", cleanedRows.slice(0, 1));
    }

    // 2. Get properly validated primary keys
    const { primaryKeyColumns, validation } = validateAndExtractPrimaryKeys(
      schemaDetails,
      tableName,
      activeColumns
    );

    console.log(`🔑 Primary Key Analysis for ${tableName}:`);
    console.log(`   - Valid PKs: ${primaryKeyColumns.join(", ")}`);
    console.log(`   - Validation: ${validation.status}`);
    console.log(`   - Message: ${validation.message}`);

    // 3. Handle different sync strategies with proper fallbacks
    const result = await executeSyncStrategy(
      {
        sequelize: sequelizeDest,
        tableName,
        activeColumns,
        rows: cleanedRows,
        schemaDetails,
        syncMode,
        primaryKeyColumns,
        validation,
      },
      transaction
    );

    // 4. Commit transaction if successful
    await transaction.commit();

    console.log(`✅ Sync completed successfully: ${syncMode} for ${tableName}`);
    console.log(`📈 Result: ${result.message}`);

    return result;
  } catch (error) {
    // 5. Rollback transaction on error
    if (transaction) {
      await transaction.rollback();
    }

    console.error(`❌ Sync failed with strategy ${syncMode}:`, error.message);

    // Enhanced error handling with suggestions
    const enhancedError = enhanceSyncError(error, syncMode, tableName);

    throw enhancedError;
  }
}

/**
 * Comprehensive primary key validation and extraction
 */
function validateAndExtractPrimaryKeys(
  schemaDetails,
  tableName,
  activeColumns
) {
  const analysis = {
    allColumns: [],
    potentialPKs: [],
    validPKs: [],
    issues: [],
  };

  // Phase 1: Collect all column information
  schemaDetails.forEach((col, index) => {
    const columnInfo = {
      index,
      name: col.column_name,
      isActive: col.is_active,
      pkColumnName: col.primary_key_column_name,
      isCursor: col.cursor_column,
      dataType: col.data_type,
      insertionType: col.insertion_type,
      // Check if this column is marked as primary key
      isMarkedAsPK: col.primary_key_column_name === col.column_name,
      // Additional checks
      hasPkName: !!col.primary_key_column_name,
      pkMatchesColumn: col.primary_key_column_name === col.column_name,
    };

    analysis.allColumns.push(columnInfo);

    // Collect potential primary keys
    if (columnInfo.isMarkedAsPK && columnInfo.isActive) {
      analysis.potentialPKs.push(columnInfo);
    }
  });

  // Phase 2: Validate primary keys
  analysis.potentialPKs.forEach((pk) => {
    // Check if PK column exists in active columns
    if (!activeColumns.includes(pk.name)) {
      analysis.issues.push(
        `Primary key column '${pk.name}' not in active columns`
      );
      return;
    }

    // Check data type suitability for primary key
    if (!isSuitableDataTypeForPK(pk.dataType)) {
      analysis.issues.push(
        `Primary key column '${pk.name}' has unsuitable data type: ${pk.dataType}`
      );
      return;
    }

    // Valid primary key
    analysis.validPKs.push(pk.name);
  });

  // Phase 3: Determine validation status
  let status, message;

  if (analysis.validPKs.length === 1) {
    status = "VALID";
    message = `Single valid primary key: ${analysis.validPKs[0]}`;
  } else if (analysis.validPKs.length > 1) {
    status = "MULTIPLE_PK";
    message = `Multiple primary keys detected: ${analysis.validPKs.join(
      ", "
    )}. Using first one.`;
    // For UPSERT, we can only use one primary key, so take the first
    analysis.validPKs = [analysis.validPKs[0]];
  } else if (analysis.potentialPKs.length > 0) {
    status = "INVALID_PK";
    message = `Primary key configuration issues: ${analysis.issues.join("; ")}`;
  } else {
    status = "NO_PK";
    message = "No primary keys configured";
  }

  // Log detailed analysis for debugging
  console.log(`🔍 Primary Key Analysis Details for ${tableName}:`, {
    totalColumns: analysis.allColumns.length,
    potentialPKs: analysis.potentialPKs.map((pk) => pk.name),
    validPKs: analysis.validPKs,
    issues: analysis.issues,
    status,
    message,
  });

  return {
    primaryKeyColumns: analysis.validPKs,
    validation: { status, message, issues: analysis.issues },
    analysis,
  };
}

/**
 * Check if data type is suitable for primary key
 */
function isSuitableDataTypeForPK(dataType) {
  if (!dataType) return true; // Default to true if unknown

  const unsuitableTypes = [
    "text",
    "json",
    "jsonb",
    "array",
    "object",
    "blob",
    "bytea",
    "geometry",
    "point",
  ];

  const normalizedType = dataType.toLowerCase().split("(")[0]; // Remove precision/size
  return !unsuitableTypes.includes(normalizedType);
}

/**
 * Execute the appropriate sync strategy based on mode and PK validation
 */
async function executeSyncStrategy(params, transaction) {
  const {
    sequelize,
    tableName,
    activeColumns,
    rows,
    schemaDetails,
    syncMode,
    primaryKeyColumns,
    validation,
  } = params;

  const strategyHandlers = {
    // Full Refresh Strategies
    "Full refresh | Overwrite": async () => {
      console.log(`🗑️ Using Full Refresh Overwrite for ${tableName}`);
      await overwrite(sequelize, tableName, activeColumns, rows, transaction);
      return {
        strategy: "overwrite",
        message: `Complete table overwrite (${rows.length} rows)`,
        rowsProcessed: rows.length,
      };
    },

    "Full refresh | Overwrite + Deduped": async () => {
      if (primaryKeyColumns.length > 0) {
        console.log(
          `🔄 Using Full Refresh Overwrite + Deduped with PK for ${tableName}`
        );
        await overwriteDedup(
          sequelize,
          tableName,
          activeColumns,
          rows,
          schemaDetails,
          transaction
        );
        return {
          strategy: "overwrite_dedup",
          message: `Table overwrite with deduplication using PK (${rows.length} rows)`,
          rowsProcessed: rows.length,
        };
      } else {
        console.log(
          `⚠️ No PK for deduplication, using regular overwrite for ${tableName}`
        );
        await overwrite(sequelize, tableName, activeColumns, rows, transaction);
        return {
          strategy: "overwrite_fallback",
          message: `Table overwrite (no PK for deduplication) (${rows.length} rows)`,
          rowsProcessed: rows.length,
        };
      }
    },

    "Full refresh | Append": async () => {
      console.log(`📝 Using Full Refresh Append for ${tableName}`);
      await bulkInsert(
        sequelize,
        tableName,
        activeColumns,
        rows,
        1000,
        transaction
      );
      return {
        strategy: "append",
        message: `Data appended (${rows.length} rows)`,
        rowsProcessed: rows.length,
      };
    },

    // Incremental Strategies
    "Incremental | Append": async () => {
      if (primaryKeyColumns.length > 0) {
        console.log(`🔄 Using Incremental Append with UPSERT for ${tableName}`);
        await upsertData(
          sequelize,
          tableName,
          activeColumns,
          rows,
          primaryKeyColumns,
          1000,
          transaction
        );
        return {
          strategy: "upsert",
          message: `Data upserted using PK (${rows.length} rows)`,
          rowsProcessed: rows.length,
          primaryKeysUsed: primaryKeyColumns,
        };
      } else {
        console.log(`📝 Using Incremental Append (no PK) for ${tableName}`);
        await bulkInsert(
          sequelize,
          tableName,
          activeColumns,
          rows,
          1000,
          transaction
        );
        return {
          strategy: "append_fallback",
          message: `Data appended (no PK for upsert) (${rows.length} rows)`,
          rowsProcessed: rows.length,
        };
      }
    },

    "Incremental | Append + Deduped": async () => {
      if (primaryKeyColumns.length > 0) {
        console.log(
          `🔄 Using Incremental Append + Deduped with UPSERT for ${tableName}`
        );
        await upsertData(
          sequelize,
          tableName,
          activeColumns,
          rows,
          primaryKeyColumns,
          1000,
          transaction
        );
        return {
          strategy: "upsert_dedup",
          message: `Data upserted with deduplication (${rows.length} rows)`,
          rowsProcessed: rows.length,
          primaryKeysUsed: primaryKeyColumns,
        };
      } else {
        console.warn(
          `⚠️ Cannot deduplicate without PK, using regular append for ${tableName}`
        );
        await bulkInsert(
          sequelize,
          tableName,
          activeColumns,
          rows,
          1000,
          transaction
        );
        return {
          strategy: "append_no_dedup",
          message: `Data appended (cannot deduplicate without PK) (${rows.length} rows)`,
          rowsProcessed: rows.length,
          warning: "Deduplication requires primary keys",
        };
      }
    },
  };

  // Get the appropriate handler
  const handler =
    strategyHandlers[syncMode] || strategyHandlers["Full refresh | Overwrite"];

  return await handler();
}

/**
 * Enhanced UPSERT function with better error handling
 */
async function upsertData(
  sequelize,
  tableName,
  activeColumns,
  rows,
  primaryKeyColumns,
  chunkSize = 1000,
  transaction = null
) {
  if (!rows.length) {
    console.log("ℹ️ No rows to upsert");
    return;
  }

  // Validate primary key columns exist in active columns
  const missingPrimaryKeys = primaryKeyColumns.filter(
    (pk) => !activeColumns.includes(pk)
  );

  if (missingPrimaryKeys.length > 0) {
    throw new Error(
      `Primary key columns not found in active columns: ${missingPrimaryKeys.join(
        ", "
      )}`
    );
  }

  console.log(
    `🔄 Performing UPSERT on ${rows.length} rows in chunks of ${chunkSize}`
  );
  console.log(`🔑 Primary key: ${primaryKeyColumns.join(", ")}`);
  console.log(`📝 Active columns: ${activeColumns.join(", ")}`);

  const totalChunks = Math.ceil(rows.length / chunkSize);

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    const start = chunkIndex * chunkSize;
    const end = Math.min(start + chunkSize, rows.length);
    const chunk = rows.slice(start, end);

    console.log(
      `📦 Processing chunk ${chunkIndex + 1}/${totalChunks}: ${
        chunk.length
      } rows`
    );

    try {
      await bulkUpsertChunk(
        sequelize,
        tableName,
        activeColumns,
        chunk,
        primaryKeyColumns,
        transaction
      );

      console.log(
        `✅ Upserted chunk: ${chunk.length} rows (Progress: ${end}/${rows.length})`
      );
    } catch (chunkError) {
      console.error(
        `❌ UPSERT failed in chunk ${chunkIndex + 1}:`,
        chunkError.message
      );

      // Enhanced error information
      console.log("🔍 Problematic chunk info:", {
        chunkSize: chunk.length,
        table: tableName,
        primaryKeys: primaryKeyColumns,
        sampleRow: chunk[0] ? Object.keys(chunk[0]) : "empty",
      });

      // Check if it's a constraint error and provide better message
      if (
        chunkError.message.includes("ON CONFLICT") ||
        chunkError.message.includes("constraint")
      ) {
        throw new Error(
          `UPSERT failed: No unique constraint exists for primary key (${primaryKeyColumns.join(
            ", "
          )}). ` +
            `Please ensure your table has a unique constraint on these columns. ` +
            `Error: ${chunkError.message}`
        );
      }

      throw chunkError;
    }

    // Rate limiting between chunks
    if (chunkIndex + 1 < totalChunks) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  console.log(`🎉 UPSERT completed for ${rows.length} rows`);
}

/**
 * Enhanced bulk UPSERT chunk function
 */
async function bulkUpsertChunk(
  sequelize,
  tableName,
  activeColumns,
  chunk,
  primaryKeyColumns,
  transaction
) {
  const columns = activeColumns.map((col) => quoteIdent(col)).join(", ");
  const valuePlaceholders = [];
  const allValues = [];

  // Build VALUES clause for all rows
  chunk.forEach((row, rowIndex) => {
    const rowPlaceholders = activeColumns
      .map((_, colIndex) => {
        return `$${rowIndex * activeColumns.length + colIndex + 1}`;
      })
      .join(", ");

    valuePlaceholders.push(`(${rowPlaceholders})`);

    // Add row values in column order
    activeColumns.forEach((col) => {
      allValues.push(row[col] ?? null);
    });
  });

  // Build UPDATE SET clause (update all columns except primary keys)
  const updateColumns = activeColumns.filter(
    (col) => !primaryKeyColumns.includes(col)
  );
  const updateSet = updateColumns
    .map((col) => `${quoteIdent(col)} = EXCLUDED.${quoteIdent(col)}`)
    .join(", ");

  const sql = `
    INSERT INTO ${quoteIdent(tableName)} (${columns})
    VALUES ${valuePlaceholders.join(", ")}
    ON CONFLICT (${primaryKeyColumns.map((pk) => quoteIdent(pk)).join(", ")})
    DO UPDATE SET ${updateSet}
  `;

  // Log SQL for debugging (first 200 chars)
  console.log(`🔍 UPSERT SQL: ${sql.substring(0, 200)}...`);

  try {
    await sequelize.query(sql, {
      bind: allValues,
      transaction,
      logging: false, // Disable logging to avoid sensitive data exposure
    });
  } catch (error) {
    // Enhanced error logging
    console.error("❌ UPSERT Query Failed:");
    console.error("   Table:", tableName);
    console.error("   Primary Keys:", primaryKeyColumns);
    console.error("   Columns:", activeColumns);
    console.error("   Chunk Size:", chunk.length);
    console.error("   SQL Error:", error.message);

    if (error.original) {
      console.error("   PostgreSQL Error:", error.original);
    }

    throw error;
  }
}

/**
 * Enhanced error handling for sync operations
 */
function enhanceSyncError(error, syncMode, tableName) {
  let enhancedMessage = error.message;
  let suggestion = "";

  // Handle common PostgreSQL errors
  if (
    error.message.includes("ON CONFLICT") ||
    error.message.includes("constraint")
  ) {
    enhancedMessage = `UPSERT operation failed: The table '${tableName}' does not have a unique constraint on the specified primary key columns.`;
    suggestion =
      'Please ensure your destination table has unique constraints on the primary key columns, or use a different sync strategy like "Full refresh | Overwrite".';
  }

  if (error.message.includes("unique constraint")) {
    enhancedMessage = `Duplicate key violation in table '${tableName}'.`;
    suggestion =
      'Consider using "Incremental | Append + Deduped" strategy or check your primary key configuration.';
  }

  if (error.message.includes("foreign key constraint")) {
    enhancedMessage = `Foreign key constraint violation in table '${tableName}'.`;
    suggestion =
      "Ensure referenced data exists in parent tables or disable foreign key checks temporarily.";
  }

  if (error.message.includes("value too long")) {
    enhancedMessage = `Data truncation error in table '${tableName}'.`;
    suggestion =
      "Check column lengths in your destination table and consider increasing VARCHAR limits.";
  }

  const enhancedError = new Error(
    `Sync failed for table '${tableName}' with strategy '${syncMode}': ${enhancedMessage} ${suggestion}`
  );
  enhancedError.originalError = error;
  enhancedError.suggestion = suggestion;
  enhancedError.tableName = tableName;
  enhancedError.syncMode = syncMode;

  return enhancedError;
}

/**
 * Enhanced overwrite function with transaction support
 */
async function overwrite(
  sequelize,
  tableName,
  activeColumns,
  rows,
  transaction = null
) {
  console.log(`🗑️ Truncating table ${tableName} for full refresh overwrite`);

  try {
    // Truncate table
    await sequelize.query(`TRUNCATE TABLE ${quoteIdent(tableName)}`, { transaction });
    console.log(`✅ Table ${tableName} truncated successfully`);
  } catch (error) {
    console.log(`⚠️ Could not truncate table ${tableName}:`, error.message);
    // Continue with insert anyway - table might not exist or have permissions issue
  }

  // Insert new data
  if (rows.length > 0) {
    await bulkInsert(
      sequelize,
      tableName,
      activeColumns,
      rows,
      1000,
      transaction
    );
  }

  console.log(`✅ Overwrote ${rows.length} rows in ${tableName}`);
}

/**
 * Enhanced bulkInsert with transaction support
 */
async function bulkInsert(
  sequelize,
  tableName,
  activeColumns,
  rows,
  chunkSize = 1000,
  transaction = null
) {
  if (!rows.length) {
    console.log("ℹ️ No rows to insert");
    return;
  }

  console.log(
    `🚀 Bulk inserting ${rows.length} rows in chunks of ${chunkSize}`
  );

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const chunkNumber = Math.floor(i / chunkSize) + 1;
    const totalChunks = Math.ceil(rows.length / chunkSize);

    console.log(
      `📦 Processing chunk ${chunkNumber}/${totalChunks}: ${chunk.length} rows`
    );

    try {
      const placeholders = chunk
        .map(() => `(${activeColumns.map(() => "?").join(", ")})`)
        .join(", ");

      const sql = `INSERT INTO ${quoteIdent(tableName)} (${activeColumns
        .map((col) => quoteIdent(col))
        .join(", ")}) VALUES ${placeholders}`;

      const values = chunk.flatMap((row) =>
        activeColumns.map((col) => {
          const value = row[col];
          if (value === undefined) {
            console.warn(`⚠️ Undefined value for column ${col} in row:`, row);
            return null;
          }
          return value;
        })
      );

      await sequelize.query(sql, {
        replacements: values,
        transaction,
      });

      console.log(
        `✅ Inserted chunk: ${chunk.length} rows (Progress: ${Math.min(
          i + chunkSize,
          rows.length
        )}/${rows.length})`
      );
    } catch (chunkError) {
      console.error(
        `❌ Error in bulk insert chunk ${chunkNumber}:`,
        chunkError.message
      );
      console.log("🔍 Problematic chunk data (first row):", chunk[0]);
      throw chunkError;
    }

    // Small delay between chunks
    if (i + chunkSize < rows.length) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  console.log(
    `🎉 Successfully inserted all ${rows.length} rows into ${tableName}`
  );
}

// Data cleaning function
// function cleanDataForInsertion(rows, activeColumns) {
//   return rows.map(row => {
//     const cleanedRow = {};
//     activeColumns.forEach(col => {
//       let value = row[col];

//       // Convert empty strings to null
//       if (value === '') value = null;

//       // Handle boolean strings
//       if (value === 'true') value = true;
//       if (value === 'false') value = false;
//       if (value === '1') value = 1;
//       if (value === '0') value = 0;

//       cleanedRow[col] = value;
//     });
//     return cleanedRow;
//   });
// }
// Enhanced data cleaning function - add this to your code
// Enhanced data cleaning function
// function cleanDataForInsertion(rows, activeColumns) {
//   return rows.map((row) => {
//     const cleanedRow = {};
//     activeColumns.forEach((col) => {
//       let value = row[col];

//       // Convert empty strings to null
//       if (value === "") value = null;

//       // Handle boolean conversions
//       if (value === "true" || value === "TRUE") value = true;
//       if (value === "false" || value === "FALSE") value = false;
//       if (value === "1") value = 1;
//       if (value === "0") value = 0;

//       // Handle numeric strings
//       if (typeof value === "string" && !isNaN(value) && value.trim() !== "") {
//         // Check if it's integer or float
//         if (value.includes(".")) {
//           value = parseFloat(value);
//         } else {
//           value = parseInt(value);
//         }

//         // If parsing resulted in NaN, keep original value
//         if (isNaN(value)) {
//           value = row[col];
//         }
//       }

//       // Handle date strings - let PostgreSQL handle date parsing
//       if (typeof value === "string" && value.match(/^\d{4}-\d{2}-\d{2}/)) {
//         // Keep as string, PostgreSQL will handle it
//       }

//       cleanedRow[col] = value;
//     });
//     return cleanedRow;
//   });
// }
function cleanDataForInsertion(rows, activeColumns) {
  return rows.map((row) => {
    const cleanedRow = {};
    activeColumns.forEach((col) => {
      let value = row[col];

      // Handle null/undefined/empty strings
      if (value === null || value === undefined || value === "") {
        cleanedRow[col] = null;
        return;
      }

      // Handle boolean conversions
      if (value === "true" || value === "TRUE") value = true;
      if (value === "false" || value === "FALSE") value = false;
      if (value === "1") value = 1;
      if (value === "0") value = 0;

      // Handle numeric strings with proper validation
      if (typeof value === "string") {
        // Remove any currency symbols, commas, etc.
        const numericString = value.replace(/[$,]/g, "").trim();

        // Check if it's a valid number (including decimals)
        if (numericString !== "" && !isNaN(numericString)) {
          // Check if it should be integer or float
          if (numericString.includes(".")) {
            value = parseFloat(numericString);
            // If parsing resulted in NaN, keep original value
            if (isNaN(value)) {
              value = row[col];
            }
          } else {
            value = parseInt(numericString, 10);
            // If parsing resulted in NaN, keep original value
            if (isNaN(value)) {
              value = row[col];
            }
          }
        }
      }

      // Handle date strings - let PostgreSQL handle date parsing
      if (typeof value === "string" && value.match(/^\d{4}-\d{2}-\d{2}/)) {
        // Keep as string, PostgreSQL will handle it
      }

      cleanedRow[col] = value;
    });
    return cleanedRow;
  });
}

// function cleanDataWithSchemaAwareness(rows, activeColumns, schemaDetails) {
//   // Create a map of column data types from schema
//   const columnTypes = {};
//   schemaDetails.forEach((col) => {
//     if (col.is_active) {
//       columnTypes[col.column_name] = col.data_type;
//     }
//   });

//   return rows.map((row) => {
//     const cleanedRow = {};
//     activeColumns.forEach((col) => {
//       let value = row[col];
//       const expectedType = columnTypes[col] || "string";

//       // Handle null/undefined/empty strings
//       if (value === null || value === undefined || value === "") {
//         cleanedRow[col] = null;
//         return;
//       }

//       // Type-specific cleaning
//       switch (expectedType.toLowerCase()) {
//         case "integer":
//         case "int":
//         case "number":
//           value = convertToInteger(value);
//           break;

//         case "float":
//         case "double":
//         case "decimal":
//         case "numeric":
//           value = convertToFloat(value);
//           break;

//         case "boolean":
//         case "bool":
//           value = convertToBoolean(value);
//           break;

//         case "string":
//         case "text":
//         case "varchar":
//           value = convertToString(value);
//           break;

//         default:
//           value = convertToString(value);
//       }

//       cleanedRow[col] = value;
//     });
//     return cleanedRow;
//   });
// }

// Helper functions for type conversion

// function cleanDataWithSchemaAwareness(rows, activeColumns, schemaDetails) {
//   // Create a map of column data types from schema
//   const columnTypes = {};
//   schemaDetails.forEach((col) => {
//     if (col.is_active) {
//       columnTypes[col.column_name] = col.data_type;
//     }
//   });

//   return rows.map((row) => {
//     const cleanedRow = {};
//     activeColumns.forEach((col) => {
//       let value = row[col];
//       const expectedType = columnTypes[col] || "string";
//       const columnName = col.toLowerCase();

//       // Handle null/undefined/empty strings
//       if (value === null || value === undefined || value === "") {
//         cleanedRow[col] = null;
//         return;
//       }

//       // 🚨 SPECIAL HANDLING FOR ID COLUMNS (BIGINT)
//       if (columnName.includes('id') || columnName.includes('_id')) {
//         value = convertToBigInt(value);
//         cleanedRow[col] = value;
//         return;
//       }

//       // Type-specific cleaning
//       switch (expectedType.toLowerCase()) {
//         case "integer":
//         case "int":
//         case "number":
//         case "bigint":
//         case "numeric":
//           value = convertToBigInt(value);
//           break;

//         case "float":
//         case "double":
//         case "decimal":
//         case "numeric":
//           value = convertToFloat(value);
//           break;

//         case "boolean":
//         case "bool":
//           value = convertToBoolean(value);
//           break;

//         case "string":
//         case "text":
//         case "varchar":
//           value = convertToString(value);
//           break;

//         default:
//           value = convertToString(value);
//       }

//       cleanedRow[col] = value;
//     });
//     return cleanedRow;
//   });
// }
// function cleanDataWithSchemaAwareness(rows, activeColumns, schemaDetails) {
//   // Create a map of column data types from schema
//   const columnTypes = {};
//   schemaDetails.forEach((col) => {
//     if (col.is_active) {
//       columnTypes[col.column_name] = col.data_type;
//     }
//   });

//   return rows.map((row) => {
//     const cleanedRow = {};
//     activeColumns.forEach((col) => {
//       let value = row[col];
//       const expectedType = columnTypes[col] || "string";
//       const columnName = col.toLowerCase();

//       // Handle null/undefined/empty strings
//       if (value === null || value === undefined || value === "") {
//         cleanedRow[col] = null;
//         return;
//       }

//       // 🚨 CRITICAL FIX: Handle Shopify GraphQL API IDs
//       if (columnName.includes('admin_graphql_api_id') ||
//           columnName.includes('graphql') ||
//           (typeof value === 'string' && value.startsWith('gid://'))) {
//         // Keep GraphQL IDs as strings - they're URIs, not numbers
//         cleanedRow[col] = value;
//         return;
//       }

//       // 🚨 SPECIAL HANDLING FOR REGULAR ID COLUMNS (BIGINT)
//       if ((columnName === 'id' || columnName.endsWith('_id')) &&
//           typeof value === 'string' &&
//           !isNaN(value) &&
//           !value.includes('/')) {
//         // This is a pure numeric ID (like "14862863991156")
//         value = convertToBigInt(value);
//         cleanedRow[col] = value;
//         return;
//       }

//       // Type-specific cleaning for other columns
//       switch (expectedType.toLowerCase()) {
//         case "integer":
//         case "int":
//         case "number":
//         case "bigint":
//         case "numeric":
//           value = convertToBigInt(value);
//           break;

//         case "float":
//         case "double":
//         case "decimal":
//         case "numeric":
//           value = convertToFloat(value);
//           break;

//         case "boolean":
//         case "bool":
//           value = convertToBoolean(value);
//           break;

//         case "string":
//         case "text":
//         case "varchar":
//         default:
//           value = convertToString(value);
//           break;
//       }

//       cleanedRow[col] = value;
//     });
//     return cleanedRow;
//   });
// }

function cleanDataWithSchemaAwareness(rows, activeColumns, schemaDetails) {
  // Create a map of column data types from schema
  const columnTypes = {};
  schemaDetails.forEach((col) => {
    if (col.is_active) {
      columnTypes[col.column_name] = col.data_type;
    }
  });
  console.log("🔍 DEBUG: Schema column types:", columnTypes);
  console.log("🔍 DEBUG: Active columns:", activeColumns);
  return rows.map((row, rowIndex) => {
    if (rowIndex === 0) {
      console.log("🔍 DEBUG: First row data:", JSON.stringify(row, null, 2));
    }
    const cleanedRow = {};
    activeColumns.forEach((col) => {
      let value = row[col];
      const expectedType = columnTypes[col] || "string";
      const columnName = col.toLowerCase();

      // Handle null/undefined/empty strings
      if (value === null || value === undefined || value === "") {
        cleanedRow[col] = null;
        return;
      }

      // 🚨 DETECT SHOPIFY-SPECIFIC COLUMNS
      const shopifyType = detectShopifyColumnType(col, value);
      if (shopifyType === "string") {
        cleanedRow[col] = value; // Keep as string
        return;
      }

      // 🚨 CRITICAL FIX: Handle arrays and empty arrays
      if (
        Array.isArray(value) ||
        value === "[]" ||
        (typeof value === "string" &&
          value.startsWith("[") &&
          value.endsWith("]"))
      ) {
        // Convert arrays to JSON strings for storage
        try {
          if (typeof value === "string") {
            // If it's already a string representation of array, keep it as is
            cleanedRow[col] = value;
          } else {
            // Convert actual array to JSON string
            cleanedRow[col] = JSON.stringify(value);
          }
        } catch (e) {
          console.warn(`Could not stringify array for column ${col}:`, value);
          cleanedRow[col] = null;
        }
        return;
      }

      // 🚨 CRITICAL FIX: Handle Shopify GraphQL API IDs
      if (
        columnName.includes("admin_graphql_api_id") ||
        columnName.includes("graphql") ||
        columnName.includes("gid_") ||
        (typeof value === "string" && value.startsWith("gid://"))
      ) {
        // Keep GraphQL IDs as strings - they're URIs, not numbers
        cleanedRow[col] = value;
        return;
      }

      // 🚨 SPECIAL HANDLING FOR REGULAR ID COLUMNS (BIGINT)
      if (
        (columnName === "id" || columnName.endsWith("_id")) &&
        typeof value === "string" &&
        !isNaN(value) &&
        !value.includes("/") &&
        !value.includes("://") &&
        value !== "[]"
      ) {
        // This is a pure numeric ID (like "14862863991156")
        value = convertToBigInt(value);
        cleanedRow[col] = value;
        return;
      }

      // Type-specific cleaning for other columns
      switch (expectedType.toLowerCase()) {
        case "integer":
        case "int":
        case "number":
        case "bigint":
        case "numeric":
          value = convertToBigInt(value);
          break;

        case "float":
        case "double":
        case "decimal":
        case "numeric":
          value = convertToFloat(value);
          break;

        case "boolean":
        case "bool":
          value = convertToBoolean(value);
          break;

        case "string":
        case "text":
        case "varchar":
        default:
          value = convertToString(value);
          break;
      }

      cleanedRow[col] = value;
    });
    return cleanedRow;
  });
}
// New helper function for BIGINT conversion
// function convertToBigInt(value) {
//   if (typeof value === "number") return value;
//   if (typeof value === "string") {
//     const numericString = value.replace(/[$,]/g, "").trim();

//     // Use BigInt for very large numbers, regular number for smaller ones
//     if (numericString.length > 15 || parseInt(numericString) > 2147483647) {
//       // For very large numbers (like Shopify IDs), use BigInt
//       try {
//         return BigInt(numericString).toString(); // Return as string to avoid precision issues
//       } catch (e) {
//         console.warn(`Could not convert ${numericString} to BigInt:`, e.message);
//         return numericString; // Fallback to string
//       }
//     } else {
//       const parsed = parseInt(numericString, 10);
//       return isNaN(parsed) ? null : parsed;
//     }
//   }
//   return null;
// }

function detectShopifyColumnType(columnName, value) {
  const colName = columnName.toLowerCase();

  // Shopify string fields that should NEVER be converted to numbers
  const shopifyStringFields = [
    "weight_unit",
    "inventory_policy",
    "fulfillment_service",
    "inventory_management",
    "option1",
    "option2",
    "option3",
    "barcode",
    "sku",
    "title",
    "status",
    "financial_status",
    "fulfillment_status",
    "gateway",
    "source_name",
    "landing_site",
    "browser_ip",
    "currency",
    "customer_locale",
    "order_status_url",
    "product_type",
    "vendor",
    "tags",
    "template_suffix",
    "published_scope",
    "admin_graphql_api_id",
    "phone",
    "email",
    "first_name",
    "last_name",
    "company",
    "address1",
    "address2",
    "city",
    "province",
    "country",
    "zip",
    "country_code",
    "province_code",
  ];

  // Check if this is a known Shopify string field
  if (shopifyStringFields.some((field) => colName.includes(field))) {
    return "string";
  }

  // Check the actual value - if it's "kg", "deny", "manual", etc., treat as string
  if (typeof value === "string") {
    const stringValues = [
      "kg",
      "lb",
      "oz",
      "g",
      "deny",
      "continue",
      "manual",
      "shopify",
    ];
    if (stringValues.includes(value.toLowerCase())) {
      return "string";
    }

    // If it's a string that contains non-numeric characters, treat as string
    if (isNaN(value) && value.trim() !== "" && !value.match(/^\d+$/)) {
      return "string";
    }
  }

  return null; // Let default logic handle it
}
function convertToBigInt(value) {
  if (value === null || value === undefined) return null;

  // If it's already a number, return it
  if (typeof value === "number") return value;

  if (typeof value === "string") {
    const numericString = value.replace(/[$,]/g, "").trim();

    // 🚨 CRITICAL: Skip conversion for GraphQL IDs and URIs
    if (
      numericString.includes("/") ||
      numericString.includes("://") ||
      numericString.includes("gid://") ||
      isNaN(numericString)
    ) {
      return value; // Return as string for GraphQL IDs
    }

    // Use BigInt for very large numbers, regular number for smaller ones
    if (numericString.length > 15 || parseInt(numericString) > 2147483647) {
      try {
        return BigInt(numericString).toString(); // Return as string to avoid precision issues
      } catch (e) {
        console.warn(
          `Could not convert ${numericString} to BigInt:`,
          e.message
        );
        return numericString; // Fallback to string
      }
    } else {
      const parsed = parseInt(numericString, 10);
      return isNaN(parsed) ? null : parsed;
    }
  }
  return null;
}

function convertToInteger(value) {
  if (typeof value === "number") return Math.floor(value);
  if (typeof value === "string") {
    const numericString = value.replace(/[$,]/g, "").trim();
    const parsed = parseInt(numericString, 10);
    return isNaN(parsed) ? null : parsed;
  }
  return null;
}

function convertToFloat(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const numericString = value.replace(/[$,]/g, "").trim();
    const parsed = parseFloat(numericString);
    return isNaN(parsed) ? null : parsed;
  }
  return null;
}

function convertToBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.toLowerCase() === "true" || value === "1";
  }
  if (typeof value === "number") {
    return value === 1;
  }
  return false;
}

function convertToString(value) {
  if (value === null || value === undefined) return null;
  return String(value);
}
// Data validation function
// function validateDataBeforeInsertion(rows, schemaDetails) {
//   console.log("🔍 VALIDATING DATA BEFORE INSERTION:");

//   // Check for NULL in required columns
//   const requiredColumns = schemaDetails
//     .filter((col) => !col.is_nullable) // Assuming you have is_nullable in schemaDetails
//     .map((col) => col.column_name);

//   if (requiredColumns.length > 0) {
//     console.log("Required columns (cannot be NULL):", requiredColumns);

//     const invalidRows = rows.filter((row) => {
//       return requiredColumns.some(
//         (col) => row[col] === null || row[col] === undefined || row[col] === ""
//       );
//     });

//     if (invalidRows.length > 0) {
//       console.error(
//         `❌ Found ${invalidRows.length} rows with NULL/empty values in required columns`
//       );
//       console.log("Required columns:", requiredColumns);
//       console.log("Sample invalid rows:", invalidRows.slice(0, 2));
//       throw new Error(
//         `Cannot insert rows with NULL values in required columns. Found ${invalidRows.length} invalid rows.`
//       );
//     }
//   }

//   // Check data types
//   rows.forEach((row, index) => {
//     Object.keys(row).forEach((col) => {
//       const value = row[col];
//       if (value !== null && value !== undefined) {
//         // Add any specific data type validations here
//         if (col === "week_id" && typeof value !== "number") {
//           console.warn(
//             `⚠️ Row ${index}: week_id should be number but got ${typeof value}:`,
//             value
//           );
//         }
//       }
//     });
//   });

//   console.log("✅ Data validation passed");
//   return rows;
// }

function validateDataBeforeInsertion(rows, schemaDetails) {
  console.log("🔍 VALIDATING DATA BEFORE INSERTION:");

  // Only validate required columns if they exist in schema
  const requiredColumns = schemaDetails
    .filter((col) => col.is_nullable === false)
    .map((col) => col.column_name);

  if (requiredColumns.length > 0) {
    console.log("Required columns (cannot be NULL):", requiredColumns);

    const invalidRows = rows.filter((row) => {
      return requiredColumns.some(
        (col) => row[col] === null || row[col] === undefined || row[col] === ""
      );
    });

    if (invalidRows.length > 0) {
      console.error(
        `❌ Found ${invalidRows.length} rows with NULL/empty values in required columns`
      );
      console.log("Required columns:", requiredColumns);
      console.log("Sample invalid rows:", invalidRows.slice(0, 2));
      throw new Error(
        `Cannot insert rows with NULL values in required columns. Found ${invalidRows.length} invalid rows.`
      );
    }
  }

  console.log("✅ Data validation passed");
  return rows;
}
// Overwrite (truncate + insert) - Enhanced version
// async function overwrite(sequelize, tableName, activeColumns, rows) {
//   console.log(`🗑️ Truncating table ${tableName} for full refresh overwrite`);
//   await sequelize.query(`TRUNCATE TABLE "${tableName}";`);
//   await bulkInsert(sequelize, tableName, activeColumns, rows);
//   console.log(`✅ Overwrote ${rows.length} rows in ${tableName}`);
// }

// Overwrite + Dedup
// async function overwriteDedup(
//   sequelize,
//   tableName,
//   activeColumns,
//   rows,
//   schemaDetails
// ) {
//   console.log(`🗑️ Truncating table ${tableName} for overwrite + dedup`);

//   // FIX: Properly detect primary key columns
//   const pkCols = schemaDetails
//     .filter(
//       (col) => col.primary_key_column_name === col.column_name && col.is_active
//     )
//     .map((col) => col.column_name);

//   console.log(`🔑 Primary key columns detected:`, pkCols);

//   if (pkCols.length === 0) {
//     throw new Error("No primary key defined for deduplication");
//   }

//   await sequelize.query(`TRUNCATE TABLE "${tableName}";`);

//   // Use the upsertData function instead of incrementalAppendDedup
//   await upsertData(sequelize, tableName, activeColumns, rows, pkCols);

//   console.log(`✅ Overwrote + Deduped ${rows.length} rows in ${tableName}`);
// }

async function overwriteDedup(
  sequelize,
  tableName,
  activeColumns,
  rows,
  schemaDetails
) {
  console.log(`🗑️ Truncating table ${tableName} for overwrite + dedup`);

  // FIXED: Better primary key detection
  const pkCols = schemaDetails
    .filter((col) => {
      // Multiple ways to detect primary keys
      return (
        (col.primary_key_column_name &&
          col.primary_key_column_name === col.column_name) ||
        col.is_primary_key ||
        col.primary_key
      );
    })
    .map((col) => col.column_name)
    .filter((pk, index, array) => array.indexOf(pk) === index);

  console.log(`🔑 Primary key columns detected:`, pkCols);

  if (pkCols.length === 0) {
    console.warn(
      `⚠️ No primary key defined for deduplication in table ${tableName}, using regular overwrite`
    );
    // Fallback to regular overwrite
    await overwrite(sequelize, tableName, activeColumns, rows);
    return;
  }

  await sequelize.query(`TRUNCATE TABLE ${quoteIdent(tableName)};`);

  // Use upsertData for deduplication during insert
  await upsertData(sequelize, tableName, activeColumns, rows, pkCols);

  console.log(`✅ Overwrote + Deduped ${rows.length} rows in ${tableName}`);
}
// Bulk Insert - Enhanced version
// async function bulkInsert(sequelize, tableName, activeColumns, rows, chunkSize = 1000) {
//   if (!rows.length) return;

//   console.log(`🔄 Bulk inserting ${rows.length} rows in chunks of ${chunkSize}`);

//   for (let i = 0; i < rows.length; i += chunkSize) {
//     const chunk = rows.slice(i, i + chunkSize);

//     const placeholders = chunk
//       .map(() => `(${activeColumns.map(() => "?").join(", ")})`)
//       .join(", ");

//     const sql = `INSERT INTO "${tableName}" (${activeColumns
//       .map((col) => `"${col}"`)
//       .join(", ")}) VALUES ${placeholders}`;

//     const values = chunk.flatMap((row) =>
//       activeColumns.map((c) => row[c] ?? null)
//     );

//     await sequelize.query(sql, { replacements: values });

//     console.log(`✅ Inserted chunk: ${chunk.length} rows (Progress: ${i + chunkSize}/${rows.length})`);

//     if (i + chunkSize < rows.length) {
//       await new Promise((resolve) => setTimeout(resolve, 50));
//     }
//   }
// }

/**
 * -------------------------------------------------Start Bulk Insert with Chunking ----------------------------
 */
// Enhanced bulkInsert function with better error handling
// async function bulkInsert(
//   sequelize,
//   tableName,
//   activeColumns,
//   rows,
//   chunkSize = 1000
// ) {
//   if (!rows.length) return;

//   console.log(
//     `🔄 Bulk inserting ${rows.length} rows in chunks of ${chunkSize}`
//   );
//   // 🚨 EMERGENCY FIX: Force string conversion for problematic columns
//   const cleanedRows = rows.map(row => {
//     const cleanedRow = { ...row };
//     activeColumns.forEach(col => {
//       const colName = col.toLowerCase();
//       if (colName.includes('weight_unit') || colName.includes('unit')) {
//         // Force string conversion
//         if (cleanedRow[col] !== null && cleanedRow[col] !== undefined) {
//           cleanedRow[col] = String(cleanedRow[col]);
//         }
//       }
//     });
//     return cleanedRow;
//   });

//   for (let i = 0; i < rows.length; i += chunkSize) {
//     const chunk = rows.slice(i, i + chunkSize);

//     try {
//       // Log first row for debugging
//       if (i === 0) {
//         console.log("📋 First row sample:", JSON.stringify(chunk[0], null, 2));
//         console.log("🔧 Active columns:", activeColumns);
//       }

//       const placeholders = chunk
//         .map(() => `(${activeColumns.map(() => "?").join(", ")})`)
//         .join(", ");

//       const sql = `INSERT INTO "${tableName}" (${activeColumns
//         .map((col) => `"${col}"`)
//         .join(", ")}) VALUES ${placeholders}`;

//       const values = chunk.flatMap((row) =>
//         activeColumns.map((c) => {
//           const value = row[c];
//           // Additional safety check
//           if (value === undefined) {
//             console.warn(`⚠️ Undefined value for column ${c} in row:`, row);
//             return null;
//           }
//           return value;
//         })
//       );

//       console.log(
//         `📦 Executing bulk insert for chunk ${Math.floor(i / chunkSize) + 1}`
//       );
//       console.log(`🔍 SQL Preview: ${sql.substring(0, 200)}...`);

//       await sequelize.query(sql, { replacements: values });

//       console.log(
//         `✅ Inserted chunk: ${chunk.length} rows (Progress: ${Math.min(
//           i + chunkSize,
//           rows.length
//         )}/${rows.length})`
//       );

//       if (i + chunkSize < rows.length) {
//         await new Promise((resolve) => setTimeout(resolve, 50));
//       }
//     } catch (chunkError) {
//       console.error(
//         `❌ Error in bulk insert chunk ${Math.floor(i / chunkSize) + 1}:`,
//         chunkError.message
//       );

//       // Enhanced error logging
//       console.log(
//         "🔍 Problematic chunk data (first 2 rows):",
//         JSON.stringify(chunk.slice(0, 2), null, 2)
//       );
//       console.log("📊 Chunk size:", chunk.length);
//       console.log("🏷️ Table:", tableName);
//       console.log("📝 Columns:", activeColumns);

//       // Try to get more detailed error info
//       if (chunkError.original) {
//         console.log("🐘 PostgreSQL Error Details:", chunkError.original);
//         console.log("🔍 Error Code:", chunkError.original.code);
//         console.log("📝 Error Detail:", chunkError.original.detail);
//       }

//       throw new Error(`Bulk insert failed: ${chunkError.message}`);
//     }
//   }

//   console.log(
//     `🎉 Successfully bulk inserted all ${rows.length} rows into ${tableName}`
//   );
// }
/**
 * -------------------------------------------------End Bulk Insert with Chunking ----------------------------
 */
// Incremental + Dedup (UPSERT) - Enhanced version
async function incrementalAppendDedup(
  sequelize,
  tableName,
  activeColumns,
  rows,
  schemaDetails
) {
  const pkCols = schemaDetails
    .filter((col) => col.primary_key_column_name === col.column_name)
    .map((col) => col.column_name);

  if (pkCols.length === 0) {
    console.log(
      "⚠️ No primary key defined for deduplication, using bulk insert instead"
    );
    await bulkInsert(sequelize, tableName, activeColumns, rows);
    return;
  }

  console.log(`🔑 Using primary keys for deduplication: ${pkCols.join(", ")}`);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const cols = activeColumns;
    const vals = cols.map((c) => row[c] ?? null);
    const updateSet = cols.map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`).join(", ");

    const sql = `
      INSERT INTO ${quoteIdent(tableName)} (${cols.map((col) => quoteIdent(col)).join(", ")})
      VALUES (${cols.map(() => "?").join(", ")})
      ON CONFLICT (${pkCols.map((pk) => quoteIdent(pk)).join(", ")})
      DO UPDATE SET ${updateSet};
    `;

    await sequelize.query(sql, { replacements: vals });

    if ((i + 1) % 100 === 0 || i === rows.length - 1) {
      console.log(
        `✅ Processed ${i + 1}/${rows.length} rows with deduplication`
      );
    }
  }
  console.log(`✅ Incremental Append + Dedup applied to ${rows.length} rows`);
}

/**
 * -------------------------------------------------Start Bulk Insert with Chunking ----------------------------
 */
// async function bulkInsert(
//   sequelize,
//   tableName,
//   activeColumns,
//   rows,
//   chunkSize = 1000
// ) {
//   if (!rows.length) return;

//   console.log(`🔄 Bulk inserting ${rows.length} rows in chunks`);

//   for (let i = 0; i < rows.length; i += chunkSize) {
//     const chunk = rows.slice(i, i + chunkSize);

//     const placeholders = chunk
//       .map(() => `(${activeColumns.map(() => "?").join(", ")})`)
//       .join(", ");

//     const sql = `INSERT INTO "${tableName}" (${activeColumns
//       .map((col) => `"${col}"`)
//       .join(", ")}) VALUES ${placeholders}`;

//     const values = chunk.flatMap((row) =>
//       activeColumns.map((c) => row[c] ?? null)
//     );

//     await sequelize.query(sql, { replacements: values });

//     console.log(`✅ Bulk inserted chunk: ${chunk.length} rows`);
//   }
// }
/**
 * -------------------------------------------------End Bulk Insert with Chunking ----------------------------
 */

async function simpleBulkInsert(
  sequelize,
  tableName,
  activeColumns,
  rows,
  chunkSize = 500
) {
  if (!rows.length) return;

  console.log(`🔄 Simple bulk insert for ${rows.length} rows`);

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);

    const columns = activeColumns.map((col) => quoteIdent(col)).join(", ");
    const placeholders = chunk
      .map(() => `(${activeColumns.map(() => "?").join(", ")})`)
      .join(", ");

    const sql = `INSERT INTO ${quoteIdent(tableName)} (${columns}) VALUES ${placeholders}`;

    const values = chunk.flatMap((row) =>
      activeColumns.map((col) => {
        const value = row[col];
        // Basic cleaning
        if (value === undefined) return null;
        if (value === "") return null;
        return value;
      })
    );

    try {
      await sequelize.query(sql, { replacements: values });
      console.log(`✅ Inserted chunk: ${chunk.length} rows`);
    } catch (error) {
      console.error(`❌ Failed to insert chunk:`, error.message);
      console.log("Problematic chunk sample:", chunk.slice(0, 2));
      throw error;
    }
  }
}
// Overwrite (truncate + insert)
// async function overwrite(sequelize, tableName, activeColumns, rows) {
//   await sequelize.query(`TRUNCATE TABLE ${tableName};`);
//   await bulkInsert(sequelize, tableName, activeColumns, rows);
//   console.log(`✅ Overwrote ${rows.length} rows in ${tableName}`);
// }

async function overwrite(sequelize, tableName, activeColumns, rows) {
  console.log(`🗑️ Truncating table ${tableName} for full refresh overwrite`);
  try {
    await sequelize.query(`TRUNCATE TABLE ${quoteIdent(tableName)};`);
    console.log(`✅ Table ${tableName} truncated successfully`);
  } catch (error) {
    console.log(`⚠️ Could not truncate table ${tableName}:`, error.message);
    // Continue with insert anyway
  }

  await bulkInsert(sequelize, tableName, activeColumns, rows);
  console.log(`✅ Overwrote ${rows.length} rows in ${tableName}`);
}

// Overwrite + Dedup
// async function overwriteDedup(
//   sequelize,
//   tableName,
//   activeColumns,
//   rows,
//   schemaDetails
// ) {
//   await sequelize.query(`TRUNCATE TABLE ${tableName};`);
//   await incrementalAppendDedup(
//     sequelize,
//     tableName,
//     activeColumns,
//     rows,
//     schemaDetails
//   );
//   console.log(`✅ Overwrote + Deduped ${rows.length} rows in ${tableName}`);
// }
async function overwriteDedup(
  sequelize,
  tableName,
  activeColumns,
  rows,
  schemaDetails
) {
  console.log(`🗑️ Truncating table ${tableName} for overwrite + dedup`);

  // FIXED: Properly detect primary key columns
  const pkCols = schemaDetails
    .filter((col) => col.primary_key_column_name && col.is_active)
    .map((col) => col.primary_key_column_name)
    .filter((pk, index, array) => array.indexOf(pk) === index); // Remove duplicates

  console.log(`🔑 Primary key columns detected:`, pkCols);

  if (pkCols.length === 0) {
    throw new Error("No primary key defined for deduplication");
  }

  // Verify primary key columns exist in active columns
  const missingPkCols = pkCols.filter((pk) => !activeColumns.includes(pk));
  if (missingPkCols.length > 0) {
    console.warn(
      `⚠️ Some primary key columns not in active columns:`,
      missingPkCols
    );
  }

  await sequelize.query(`TRUNCATE TABLE ${quoteIdent(tableName)};`);

  // Use upsertData for deduplication during insert
  await upsertData(sequelize, tableName, activeColumns, rows, pkCols);

  console.log(`✅ Overwrote + Deduped ${rows.length} rows in ${tableName}`);
}
// Incremental + Dedup (UPSERT)
async function incrementalAppendDedup(
  sequelize,
  tableName,
  activeColumns,
  rows,
  schemaDetails
) {
  const pkCols = schemaDetails
    .filter((c) => c.is_primary_key)
    .map((c) => c.column_name);
  if (pkCols.length === 0)
    throw new Error("No primary key defined for deduplication");

  for (const row of rows) {
    const cols = activeColumns;
    const vals = cols.map((c) => row[c] ?? null);
    const updateSet = cols
      .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
      .join(", ");

    const sql = `
      INSERT INTO ${quoteIdent(tableName)} (${cols.map(quoteIdent).join(", ")})
      VALUES (${cols.map(() => "?").join(", ")})
      ON CONFLICT (${pkCols.map(quoteIdent).join(", ")}) DO UPDATE SET ${updateSet};
    `;

    await sequelize.query(sql, { replacements: vals });
  }
  console.log(`✅ Incremental Append + Dedup applied to ${rows.length} rows`);
}

// exports.syncConnection = async (req, res) => {
//   try {
//     const { connectionId } = req.params;

//     const connection = await Connection.findOne({
//       where: { connection_id: connectionId },
//       include: [
//         {
//           model: Source,
//           as: "source"
//         },
//         {
//           model: Destination,
//           as: "destination"
//         }
//       ]
//     });

//     if (!connection) {
//       return res.status(404).json({
//         success: false,
//         message: "Connection not found"
//       });
//     }

//     // Check if destination is Excel
//     if (connection.destination.connector_name.toLowerCase() === 'excel') {
//       // Run ETL with response object for file download
//       await runETL(
//         connection.source_id,
//         connection.connection_id,
//         connection.destination_id,
//         res
//       );
//     } else {
//       // For non-Excel destinations, normal sync
//       await runETL(
//         connection.source_id,
//         connection.connection_id,
//         connection.destination_id
//       );

//       return res.status(200).json({
//         success: true,
//         message: "Sync completed successfully"
//       });
//     }
//   } catch (error) {
//     console.error("Error syncing connection:", error);
//     return res.status(500).json({
//       success: false,
//       message: "Sync failed: " + error.message
//     });
//   }
// };

exports.syncConnection = async (req, res) => {
  try {
    const { connectionId } = req.params;

    let scopedWhere;
    try { scopedWhere = withTenantScope(req, { connection_id: connectionId }); }
    catch (e) { return sendAuthError(res, e); }

    const connection = await Connection.findOne({ where: scopedWhere });

    if (!connection) {
      return res.status(404).json({
        success: false,
        message: "Connection not found",
      });
    }

    // FIX: Get source and destination separately
    const source = await Source.findOne({
      where: { id: connection.source_id },
    });

    const destination = await Destination.findOne({
      where: { id: connection.destination_id },
    });

    if (!source || !destination) {
      return res.status(404).json({
        success: false,
        message: "Source or Destination not found",
      });
    }

    // Update last_sync timestamp
    await Connection.update(
      { last_sync: new Date() },
      { where: { connection_id: connectionId } }
    );
    // 🔄 PASS true TO ENABLE SYNC STRATEGIES
    // Run ETL with response object - let runETL handle the response
    await runETL(
      connection.source_id,
      connection.connection_id,
      connection.destination_id,
      res, // Pass response object to runETL
      true // This enables sync strategies!
    );

    // Note: No return here since runETL will handle the response
    // for both JSON responses and file downloads
  } catch (error) {
    console.error("Error in syncConnection:", error);
    return res.status(500).json({
      success: false,
      message: "Sync failed: " + error.message,
    });
  }
};

/**
 * Read data from QuickBooks API with multiple entities and chunking support
 */
// async function readQuickBooksData(settings, entityType, activeColumns, chunkSize = 1000) {
//   try {
//     console.log(`📖 Reading QuickBooks data for entity: ${entityType}`);

//     const {
//       client_id,
//       client_secret,
//       access_token,
//       refresh_token,
//       realm_id,
//       sandbox = true,
//       start_date
//     } = settings;

//     if (!client_id || !access_token || !realm_id) {
//       throw new Error('QuickBooks credentials missing. Required: client_id, access_token, realm_id');
//     }

//     const baseUrl = sandbox
//       ? 'https://sandbox-quickbooks.api.intuit.com'
//       : 'https://quickbooks.api.intuit.com';

//     // Map all QuickBooks entities to API endpoints
//     // const entityMap = {
//     //   'customers': 'Customer',
//     //   'invoices': 'Invoice',
//     //   'payments': 'Payment',
//     //   'items': 'Item',
//     //   'accounts': 'Account',
//     //   'vendors': 'Vendor',
//     //   'bills': 'Bill',
//     //   'employees': 'Employee',
//     //   'estimates': 'Estimate',
//     //   'sales_receipts': 'SalesReceipt',
//     //   'credit_memos': 'CreditMemo',
//     //   'purchases': 'Purchase',
//     //   'deposits': 'Deposit',
//     //   'journal_entries': 'JournalEntry',
//     //   'tax_rates': 'TaxRate',
//     //   'tax_codes': 'TaxCode',
//     //   'classes': 'Class',
//     //   'departments': 'Department'
//     // };
//     const entityMap = getEntityMapForETL();
//     const entity = entityMap[entityType.toLowerCase()] || entityType;
//      // Validate entity
//     if (!isValidQuickBooksEntity(entity)) {
//       console.warn(`⚠️ Unknown QuickBooks entity: ${entityType} → ${entity}`);
//       return [];
//     }

//     let allEntities = [];
//     let startPosition = 1;
//     const maxResults = 1000; // QuickBooks API max per request

//     console.log(`🔍 Fetching ${entity} data from QuickBooks in chunks...`);

//     // Fetch data in chunks
//     do {
//       const query = `SELECT * FROM ${entity} ORDER BY Id STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;

//       const encodedQuery = encodeURIComponent(query);
//       const url = `${baseUrl}/v3/company/${realm_id}/query?query=${encodedQuery}`;

//       console.log(`📥 Fetching chunk: ${url.substring(0, 100)}...`);

//       const response = await fetch(url, {
//         method: 'GET',
//         headers: {
//           'Authorization': `Bearer ${access_token}`,
//           'Accept': 'application/json',
//           'Content-Type': 'application/json'
//         }
//       });

//       if (!response.ok) {
//         const errorText = await response.text();

//         // Handle token expiration
//         if (response.status === 401) {
//           throw new Error('QuickBooks access token expired. Please reconnect.');
//         }

//         throw new Error(`QuickBooks API error: ${response.status} - ${errorText}`);
//       }

//       const data = await response.json();

//       if (!data.QueryResponse || !data.QueryResponse[entity]) {
//         console.log(`No more data found for QuickBooks entity: ${entity}`);
//         break;
//       }

//       const entities = data.QueryResponse[entity];
//       console.log(`✅ Fetched chunk: ${entities.length} ${entity} records`);

//       // Transform QuickBooks data to match column structure
//       const transformedChunk = entities.map(qbEntity => {
//         const row = {};

//         activeColumns.forEach(column => {
//           // Handle nested properties (e.g., Customer.DisplayName, Invoice.CustomerRef.value)
//           const value = getNestedQuickBooksValue(qbEntity, column);
//           row[column] = value !== undefined ? value : null;
//         });

//         return row;
//       });

//       allEntities = allEntities.concat(transformedChunk);
//       startPosition += entities.length;

//       // If we got less than max results, we've reached the end
//       if (entities.length < maxResults) {
//         break;
//       }

//       // Small delay to respect API rate limits
//       await new Promise(resolve => setTimeout(resolve, 200));

//     } while (true);

//     console.log(`🎉 Total ${allEntities.length} ${entity} records fetched from QuickBooks`);
//     return allEntities;

//   } catch (error) {
//     console.error('❌ Error reading QuickBooks data:', error.message);

//     // Enhanced error handling for common QuickBooks issues
//     if (error.message.includes('token expired') || error.message.includes('401')) {
//       throw new Error('QuickBooks authentication failed. Please refresh your connection.');
//     } else if (error.message.includes('rate limit') || error.message.includes('429')) {
//       throw new Error('QuickBooks API rate limit exceeded. Please try again later.');
//     }

//     throw error;
//   }
// }

/**
 * Enhanced QuickBooks data reader with universal object handling
 */
async function readQuickBooksData(
  settings,
  entityType,
  activeColumns,
  chunkSize = 1000
) {
  try {
    console.log(`📖 Reading QuickBooks data for entity: ${entityType}`);

    const {
      client_id,
      client_secret,
      access_token,
      refresh_token,
      realm_id,
      sandbox = true,
      start_date,
      end_date,
    } = settings;

    if (!client_id || !access_token || !realm_id) {
      throw new Error(
        "QuickBooks credentials missing. Required: client_id, access_token, realm_id"
      );
    }

    const baseUrl = sandbox
      ? "https://sandbox-quickbooks.api.intuit.com"
      : "https://quickbooks.api.intuit.com";

    const entityDetails = getEntityDetails(entityType);
    const entity = entityDetails ? entityDetails.apiName : entityType;

    if (!isValidQuickBooksEntity(entity)) {
      console.warn(`⚠️ Unknown QuickBooks entity: ${entityType} → ${entity}`);
      return [];
    }

    const isReport = entityDetails && entityDetails.category === "reports";

    if (isReport) {
      const reportData = await readQuickBooksReportData(
        settings,
        entity,
        activeColumns
      );
      return cleanDataForUniversalInsertion(reportData, activeColumns);
    } else {
      const entityData = await readQuickBooksEntityData(
        settings,
        entity,
        activeColumns,
        chunkSize
      );
      return cleanDataForUniversalInsertion(entityData, activeColumns);
    }
  } catch (error) {
    console.error("❌ Error reading QuickBooks data:", error.message);

    if (
      error.message.includes("token expired") ||
      error.message.includes("401")
    ) {
      throw new Error(
        "QuickBooks authentication failed. Please refresh your connection."
      );
    } else if (
      error.message.includes("rate limit") ||
      error.message.includes("429")
    ) {
      throw new Error(
        "QuickBooks API rate limit exceeded. Please try again later."
      );
    }

    throw error;
  }
}
// Add this debug function to check available data
async function checkQuickBooksDataAvailability(settings, entityType) {
  const { access_token, realm_id, sandbox = true } = settings;

  const baseUrl = sandbox
    ? "https://sandbox-quickbooks.api.intuit.com"
    : "https://quickbooks.api.intuit.com";

  try {
    console.log(`🔍 Checking data availability for: ${entityType}`);

    const entityDetails = getEntityDetails(entityType);
    const isReport = entityDetails && entityDetails.category === "reports";

    if (isReport) {
      // For reports, use a simpler approach - just try to fetch
      console.log(`📊 ${entityType} is a report - will attempt to fetch data`);
      return true; // Always try to fetch reports
    } else {
      // For regular entities, check count
      const query = `SELECT COUNT(*) FROM ${entityType}`;
      const encodedQuery = encodeURIComponent(query);
      const url = `${baseUrl}/v3/company/${realm_id}/query?query=${encodedQuery}`;

      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${access_token}`,
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        console.log(`⚠️ ${entityType} query failed: ${response.status}`);
        return false;
      }

      const data = await response.json();
      const count = data.QueryResponse?.totalCount || 0;
      console.log(`📊 ${entityType} has ${count} records`);
      return count > 0;
    }
  } catch (error) {
    console.error(`❌ Error checking ${entityType}:`, error.message);
    // For reports, don't fail the entire process - let the actual fetch handle errors
    const entityDetails = getEntityDetails(entityType);
    if (entityDetails && entityDetails.category === "reports") {
      return true; // Still try to fetch reports even if check fails
    }
    return false;
  }
}
/**
 * Read QuickBooks Report Data (for reports that generate Excel-like structured data)
 */
async function readQuickBooksReportData(settings, reportType, activeColumns) {
  const {
    access_token,
    realm_id,
    sandbox = true,
    start_date,
    end_date,
  } = settings;

  const baseUrl = sandbox
    ? "https://sandbox-quickbooks.api.intuit.com"
    : "https://quickbooks.api.intuit.com";

  console.log(`📊 Fetching QuickBooks report: ${reportType}`);

  // Build report URL with parameters
  let reportUrl = `${baseUrl}/v3/company/${realm_id}/reports/${reportType}?minorversion=75`;

  // Add date parameters if provided
  if (start_date) {
    reportUrl += `&start_date=${formatQbDate(start_date)}`;
  }
  if (end_date) {
    reportUrl += `&end_date=${formatQbDate(end_date)}`;
  }

  // Add common report parameters for better data structure
  reportUrl +=
    "&columns=term,name,amount,date,account,tx_date,due_date,balance,customer,vendor,item,quantity,rate,memo,description";
  reportUrl += "&sort_order=asc";

  console.log(`📥 Report URL: ${reportUrl.substring(0, 100)}...`);

  try {
    const response = await fetch(reportUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${access_token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();

      // Handle token expiration
      if (response.status === 401) {
        throw new Error("QuickBooks access token expired. Please reconnect.");
      }

      throw new Error(
        `QuickBooks Report API error: ${response.status} - ${errorText}`
      );
    }

    const reportData = await response.json();

    if (!reportData.Report) {
      console.log(`No report data found for: ${reportType}`);
      return [];
    }

    // Transform report data to match column structure
    const transformedData = transformQuickBooksReportData(
      reportData.Report,
      activeColumns,
      reportType
    );

    console.log(
      `✅ Fetched ${transformedData.length} rows from ${reportType} report`
    );
    return transformedData;
  } catch (error) {
    console.error(
      `❌ Error fetching QuickBooks report ${reportType}:`,
      error.message
    );
    throw error;
  }
}

/**
 * Transform QuickBooks report data to match expected column structure
 */
function transformQuickBooksReportData(reportData, activeColumns, reportName) {
  const rows = [];

  // Extract columns from report
  const columns = reportData.Columns?.Column || [];
  const columnNames = columns.map(
    (col) => col.ColTitle || col.ColType || col.ColName
  );

  console.log(`📋 Report columns detected: ${columnNames.join(", ")}`);
  console.log(`🎯 Active columns requested: ${activeColumns.join(", ")}`);

  // Process rows based on report structure
  if (reportData.Rows && reportData.Rows.Row) {
    processReportRows(
      reportData.Rows.Row,
      rows,
      columnNames,
      activeColumns,
      reportName
    );
  }

  // If no rows processed but we have header data, create a basic structure
  if (rows.length === 0 && columnNames.length > 0) {
    console.log("📝 Creating basic row structure from columns");
    const basicRow = {};
    columnNames.forEach((colName, index) => {
      const cleanColName = cleanColumnName(colName);
      basicRow[cleanColName] = `Sample ${colName}`;
    });
    rows.push(basicRow);
  }

  return rows;
}

/**
 * Process report rows recursively (handles nested row structures)
 */
function processReportRows(
  rows,
  outputArray,
  columnNames,
  activeColumns,
  reportName,
  level = 0
) {
  if (!rows) return;

  // Handle single row object
  if (!Array.isArray(rows)) {
    rows = [rows];
  }

  for (const row of rows) {
    // Skip summary/total rows if they don't have detailed data
    const rowType = row.type || "";
    if (rowType === "Summary" || rowType === "Section" || rowType === "Total") {
      // Process nested rows in sections
      if (row.Rows && row.Rows.Row) {
        processReportRows(
          row.Rows.Row,
          outputArray,
          columnNames,
          activeColumns,
          reportName,
          level + 1
        );
      }
      continue;
    }

    // Process data rows (Data, SubData, etc.)
    if (row.ColData && Array.isArray(row.ColData)) {
      const rowData = {};

      // Map column data to row object
      row.ColData.forEach((colData, index) => {
        if (index < columnNames.length) {
          const colName = columnNames[index];
          const value = colData.value || "";
          const id = colData.id || "";

          // Clean column name for use as object key
          const cleanColName = cleanColumnName(colName);

          // Store both raw and cleaned values
          rowData[cleanColName] = value;
          rowData[`${cleanColName}_id`] = id;

          // Also store with original column name for reference
          rowData[`_raw_${cleanColName}`] = value;
        }
      });

      // Add report metadata
      rowData["report_type"] = reportName;
      rowData["report_name"] = getEntityDisplayName(reportName) || reportName;
      rowData["row_id"] = row.id || generateRowId();
      rowData["row_type"] = rowType || "Data";
      rowData["row_level"] = level;

      // Add header information if available
      if (row.Header) {
        rowData["header_col_data"] = JSON.stringify(row.Header.ColData || []);
      }

      // Filter to only active columns if specified
      if (activeColumns && activeColumns.length > 0) {
        const filteredRow = mapColumnsToActiveColumns(rowData, activeColumns);
        if (Object.keys(filteredRow).length > 0) {
          outputArray.push(filteredRow);
        }
      } else {
        // If no active columns specified, return all data
        outputArray.push(rowData);
      }
    }

    // Process nested rows
    if (row.Rows && row.Rows.Row) {
      processReportRows(
        row.Rows.Row,
        outputArray,
        columnNames,
        activeColumns,
        reportName,
        level + 1
      );
    }
  }
}

/**
 * Clean column name for use as object key
 */
function cleanColumnName(colName) {
  if (!colName) return "unknown_column";

  return (
    colName
      .toString()
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_]/g, "")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "") || "column"
  );
}

/**
 * Map row data to active columns with flexible matching
 */
function mapColumnsToActiveColumns(rowData, activeColumns) {
  const filteredRow = {};

  activeColumns.forEach((activeCol) => {
    const activeColClean = cleanColumnName(activeCol);

    // Try exact match first
    if (rowData[activeColClean] !== undefined) {
      filteredRow[activeCol] = rowData[activeColClean];
      return;
    }

    // Try case-insensitive match
    const matchingKey = Object.keys(rowData).find(
      (key) => key.toLowerCase() === activeColClean.toLowerCase()
    );

    if (matchingKey) {
      filteredRow[activeCol] = rowData[matchingKey];
      return;
    }

    // Try partial match for nested properties
    const partialMatch = Object.keys(rowData).find(
      (key) => key.includes(activeColClean) || activeColClean.includes(key)
    );

    if (partialMatch) {
      filteredRow[activeCol] = rowData[partialMatch];
      return;
    }

    // If no match found, set to null
    filteredRow[activeCol] = null;
  });

  return filteredRow;
}

/**
 * Generate unique row ID for report rows
 */
function generateRowId() {
  return `row_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Read regular QuickBooks entity data (existing functionality)
 */
async function readQuickBooksEntityData(
  settings,
  entityType,
  activeColumns,
  chunkSize = 1000
) {
  const { access_token, realm_id, sandbox = true } = settings;

  const baseUrl = sandbox
    ? "https://sandbox-quickbooks.api.intuit.com"
    : "https://quickbooks.api.intuit.com";

  let allEntities = [];
  let startPosition = 1;
  const maxResults = 1000;

  console.log(`🔍 Fetching ${entityType} data from QuickBooks in chunks...`);

  // Fetch data in chunks
  do {
    const query = `SELECT * FROM ${entityType} ORDER BY Id STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;

    const encodedQuery = encodeURIComponent(query);
    const url = `${baseUrl}/v3/company/${realm_id}/query?query=${encodedQuery}`;

    console.log(`📥 Fetching chunk: ${url.substring(0, 100)}...`);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${access_token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();

      if (response.status === 401) {
        throw new Error("QuickBooks access token expired. Please reconnect.");
      }

      throw new Error(
        `QuickBooks API error: ${response.status} - ${errorText}`
      );
    }

    const data = await response.json();

    if (!data.QueryResponse || !data.QueryResponse[entityType]) {
      console.log(`No more data found for QuickBooks entity: ${entityType}`);
      break;
    }

    const entities = data.QueryResponse[entityType];
    console.log(`✅ Fetched chunk: ${entities.length} ${entityType} records`);

    // Transform QuickBooks data to match column structure
    const transformedChunk = entities.map((qbEntity) => {
      const row = {};

      activeColumns.forEach((column) => {
        // Handle nested properties
        const value = getNestedQuickBooksValue(qbEntity, column);
        row[column] = value !== undefined ? value : null;
      });

      return row;
    });

    allEntities = allEntities.concat(transformedChunk);
    startPosition += entities.length;

    // If we got less than max results, we've reached the end
    if (entities.length < maxResults) {
      break;
    }

    // Small delay to respect API rate limits
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (true);

  console.log(
    `🎉 Total ${allEntities.length} ${entityType} records fetched from QuickBooks`
  );
  return allEntities;
}

/**
 * Enhanced helper function to get nested QuickBooks object values
 */
function getNestedQuickBooksValue(obj, path) {
  try {
    return path.split(".").reduce((current, key) => {
      if (current && typeof current === "object") {
        // Handle array indices
        if (key.includes("[") && key.includes("]")) {
          const arrayKey = key.split("[")[0];
          const index = parseInt(key.match(/\[(\d+)\]/)[1]);
          return current[arrayKey] && current[arrayKey][index] !== undefined
            ? current[arrayKey][index]
            : undefined;
        }
        // Handle regular nested properties
        return current[key] !== undefined ? current[key] : undefined;
      }
      return undefined;
    }, obj);
  } catch (error) {
    console.warn(`⚠️ Could not access path ${path} in QuickBooks object`);
    return undefined;
  }
}

/**
 * Enhanced universal data cleaner with JSON handling
 */
function cleanDataForUniversalInsertion(rows, activeColumns) {
  return rows.map((row) => {
    const cleanedRow = {};

    activeColumns.forEach((col) => {
      let value = row[col];

      // Handle null/undefined
      if (value === null || value === undefined || value === "") {
        cleanedRow[col] = null;
        return;
      }

      // Handle complex objects (like QuickBooks currency objects)
      if (typeof value === "object" && value !== null) {
        cleanedRow[col] = handleComplexObject(value, col);
        return;
      }

      // Handle arrays
      if (Array.isArray(value)) {
        cleanedRow[col] = handleArray(value, col);
        return;
      }

      // SPECIAL HANDLING FOR JSON COLUMNS
      // If column name suggests it should be JSON but contains simple string
      if (isJsonColumn(col) && typeof value === "string") {
        // Try to parse as JSON first, if it fails, wrap as JSON string
        try {
          JSON.parse(value);
          // If it parses successfully, keep as is
          cleanedRow[col] = value;
        } catch (e) {
          // If it's a simple string, convert to proper JSON string
          cleanedRow[col] = `"${value}"`;
        }
        return;
      }

      // Handle basic types
      cleanedRow[col] = handleBasicType(value, col);
    });

    return cleanedRow;
  });
}

/**
 * Check if column should be treated as JSON based on name or content
 */
function isJsonColumn(columnName) {
  const jsonIndicators = [
    "json",
    "metadata",
    "settings",
    "config",
    "ref",
    "data",
  ];
  return jsonIndicators.some((indicator) =>
    columnName.toLowerCase().includes(indicator)
  );
}

/**
 * Enhanced complex object handler for QuickBooks data
 */
function handleComplexObject(obj, columnName) {
  // Special handling for common QuickBooks object patterns
  if (obj.value !== undefined && obj.name !== undefined) {
    // For currency objects: { value: 'USD', name: 'United States Dollar' }
    // Return as proper JSON object
    return JSON.stringify({ value: obj.value, name: obj.name });
  }

  if (obj.Id !== undefined && obj.DisplayName !== undefined) {
    // For reference objects: { Id: '123', DisplayName: 'Customer Name' }
    return JSON.stringify({ Id: obj.Id, DisplayName: obj.DisplayName });
  }

  if (obj.Address !== undefined) {
    // For address objects
    return JSON.stringify(obj.Address);
  }

  if (obj.CurrencyRef !== undefined) {
    // For currency references - handle nested objects
    if (typeof obj.CurrencyRef === "string") {
      return JSON.stringify({ value: obj.CurrencyRef });
    }
    return JSON.stringify(obj.CurrencyRef);
  }

  // Default: convert to JSON string for storage
  try {
    return JSON.stringify(obj);
  } catch (error) {
    console.warn(`Could not stringify object for column ${columnName}:`, obj);
    return null;
  }
}

/**
 * Handle arrays by converting to JSON string
 */
function handleArray(arr, columnName) {
  if (arr.length === 0) return null;

  // If array contains simple values, join them
  if (arr.every((item) => typeof item !== "object")) {
    return arr.join(", ");
  }

  // If array contains objects, stringify
  try {
    return JSON.stringify(arr);
  } catch (error) {
    console.warn(`Could not stringify array for column ${columnName}:`, arr);
    return null;
  }
}

/**
 * Handle basic data types with proper conversion
 */
function handleBasicType(value, columnName) {
  // Handle boolean strings
  if (value === "true" || value === "TRUE") return true;
  if (value === "false" || value === "FALSE") return false;

  // Handle numeric strings
  if (typeof value === "string") {
    // Check if it's a number
    if (!isNaN(value) && value.trim() !== "") {
      return value.includes(".") ? parseFloat(value) : parseInt(value);
    }

    // Check if it's a date string
    if (value.match(/^\d{4}-\d{2}-\d{2}/)) {
      return value; // Let PostgreSQL handle date parsing
    }
  }

  // Return as-is for other types
  return value;
}
/**
 * Enhanced helper function to get nested QuickBooks object values
 */
// function getNestedQuickBooksValue(obj, path) {
//   try {
//     return path.split('.').reduce((current, key) => {
//       if (current && typeof current === 'object') {
//         // Handle array indices
//         if (key.includes('[') && key.includes(']')) {
//           const arrayKey = key.split('[')[0];
//           const index = parseInt(key.match(/\[(\d+)\]/)[1]);
//           return current[arrayKey] && current[arrayKey][index] !== undefined
//             ? current[arrayKey][index]
//             : undefined;
//         }
//         // Handle regular nested properties
//         return current[key] !== undefined ? current[key] : undefined;
//       }
//       return undefined;
//     }, obj);
//   } catch (error) {
//     console.warn(`⚠️ Could not access path ${path} in QuickBooks object`);
//     return undefined;
//   }
// }

// exports.getConnections = async (req, res) => {
//   try {
//     const {
//       status,
//       latestSyncJobStatus,
//       sourceName,
//       destinationName,
//       search,
//       sourceId,
//       redis,
//     } = req.query;

//     console.log("redis", redis);

//     let connections;

//     // if (redis && (await getCache("connection"))) {
//     //   console.log("getting connection list from cache...");
//     //   connections = JSON.parse(await getCache("connection"));
//     // } else {
//     console.log("else part is running - fetching from database with SQL join");

//     // Build WHERE conditions
//     let whereConditions = [];
//     let params = [];

//     if (status && status !== "all") {
//       whereConditions.push(`c.is_active = $${params.length + 1}`);
//       params.push(status);
//     }

//     if (sourceId) {
//       whereConditions.push(`c.source_id = $${params.length + 1}`);
//       params.push(sourceId);
//     }

//     if (sourceName && sourceName !== "all") {
//       whereConditions.push(
//         `(s.source_name = $${params.length + 1} OR s.source_name = $${
//           params.length + 1
//         })`
//       );
//       params.push(sourceName);
//     }

//     if (destinationName && destinationName !== "all") {
//       whereConditions.push(
//         `(d.destination_name = $${params.length + 1} OR d.destination_name = $${
//           params.length + 1
//         })`
//       );
//       params.push(destinationName);
//     }

//     if (search) {
//       whereConditions.push(`c.connection_name ILIKE $${params.length + 1}`);
//       params.push(`%${search}%`);
//     }

//     const whereClause =
//       whereConditions.length > 0
//         ? `WHERE ${whereConditions.join(" AND ")}`
//         : "";

//     // Build the SQL query with joins
//     const query = `
//         SELECT DISTINCT ON (c.connection_id)
//           c.connection_id,
//           c.connection_name,
//           c.is_active,
//           c.source_id,
//           c.destination_id,
//           c.created_at,
//           c.last_sync,
//           s.id as source_id,
//           s.source_name,
//           d.id as destination_id,
//           d.destination_name
//         FROM connections c
//         LEFT JOIN source s ON c.source_id::varchar = s.id::varchar
//         LEFT JOIN destination d ON c.destination_id::varchar = d.id::varchar

//         ${whereClause}
//         ORDER BY c.connection_id, c.created_at DESC
//       `;

//     // Execute the raw SQL query
//     const [connectionsResponse] = await Connection.sequelize.query(query, {
//       bind: params,
//     });

//     // Transform to match your expected response format
//     connections = {
//       connections: connectionsResponse.map((conn) => ({
//         id: conn.id,
//         connectionId: conn.connection_id || conn.id,
//         name: conn.connection_name,
//         status: conn.is_active,
//         sourceId: conn.source_id,
//         destinationId: conn.destination_id,
//         createdAt: conn.created_at,
//         updatedAt: conn.updated_at,
//         source: conn.source_id
//           ? {
//               id: conn.source_id,
//               sourceId: conn.source_id,
//               sourceName: conn.source_name || conn.source_display_name,
//               name: conn.source_display_name,
//               sourceType: conn.source_type,
//               status: conn.source_status,
//             }
//           : null,
//         destination: conn.destination_id
//           ? {
//               id: conn.destination_id,
//               destinationId: conn.destination_id,
//               destinationName:
//                 conn.destination_name || conn.destination_display_name,
//               name: conn.destination_display_name,
//               destinationType: conn.destination_type,
//               status: conn.destination_status,
//             }
//           : null,
//         latestSyncJobStatus:
//           conn.latest_sync_job_status || conn.status || "pending",
//         latestSyncJob: conn.latest_sync_job_status
//           ? {
//               status: conn.latest_sync_job_status,
//               startedAt: conn.latest_sync_started_at,
//               finishedAt: conn.latest_sync_finished_at,
//             }
//           : null,
//       })),
//     };

//     console.log("creating connection list cache...");
//     await createCache("connection", connections);
//     // }

//     const allConnections = connections?.connections || [];

//     // Apply any additional client-side filters if needed
//     let filteredConnections = allConnections;

//     // 🔷 Apply latestSyncJobStatus filter (if not already applied in SQL)
//     if (latestSyncJobStatus && latestSyncJobStatus !== "all") {
//       filteredConnections = filteredConnections.filter((conn) => {
//         return conn.latestSyncJobStatus === latestSyncJobStatus;
//       });
//     }

//     const paginatedConnections = filteredConnections;
//     return res.status(200).json({
//       success: true,
//       data: {
//         connections: paginatedConnections,
//         totalConnections: filteredConnections.length,
//         // Add items array for compatibility with frontend delete fallback
//         items: paginatedConnections.map((conn) => ({
//           ...conn,
//           id: conn.id,
//           connectionId: conn.connectionId || conn.id,
//           _id: conn.id,
//         })),
//       },
//       message:
//         "Connections fetched successfully" +
//         (status ||
//         sourceName ||
//         destinationName ||
//         search ||
//         sourceId ||
//         latestSyncJobStatus
//           ? " with filters"
//           : ""),
//     });
//   } catch (error) {
//     console.error("error", error);
//     return res.status(500).json({
//       success: false,
//       data: null,
//       message: "Something went wrong",
//     });
//   }
// };

// exports.getConnections = async (req, res) => {
//   try {
//     const {
//       status,
//       latestSyncJobStatus,
//       sourceName,
//       destinationName,
//       search,
//       sourceId,
//       redis,
//     } = req.query;

//     let connections;

//     // if (redis && (await getCache("connection"))) {
//     //   console.log("getting connection list from cache...");
//     //   connections = JSON.parse(await getCache("connection"));
//     // } else {
//     console.log("else part is running - fetching from database with SQL join");

//     // Build WHERE conditions
//     let whereConditions = [];
//     let params = [];

//     if (status && status !== "all") {
//       whereConditions.push(`c.is_active = $${params.length + 1}`);
//       params.push(status);
//     }

//     if (sourceId) {
//       whereConditions.push(`c.source_id = $${params.length + 1}`);
//       params.push(sourceId);
//     }

//     if (sourceName && sourceName !== "all") {
//       whereConditions.push(`s.source_name = $${params.length + 1}`);
//       params.push(sourceName);
//     }

//     if (destinationName && destinationName !== "all") {
//       whereConditions.push(`d.destination_name = $${params.length + 1}`);
//       params.push(destinationName);
//     }

//     if (search) {
//       whereConditions.push(`c.connection_name ILIKE $${params.length + 1}`);
//       params.push(`%${search}%`);
//     }

//     // Add filter for latestSyncJobStatus if provided
//     if (latestSyncJobStatus && latestSyncJobStatus !== "all") {
//       whereConditions.push(`csr.status = $${params.length + 1}`);
//       params.push(latestSyncJobStatus);
//     }

//     const whereClause =
//       whereConditions.length > 0
//         ? `WHERE ${whereConditions.join(" AND ")}`
//         : "";

//     // Build the SQL query with joins including connection_sync_runs
//     const query = `
//         SELECT DISTINCT ON (c.connection_id)
//           c.connection_id,
//           c.connection_name,
//           c.is_active,
//           c.source_id,
//           c.destination_id,
//           c.created_at,
//           c.last_sync,
//           s.id as source_id,
//           s.source_name,
//           d.id as destination_id,
//           d.destination_name,
//           csr.status as latest_sync_job_status,
//           csr.started_at as latest_sync_started_at,
//           csr.ended_at as latest_sync_ended_at,
//           csr.rows_processed as latest_sync_rows_processed,
//           csr.error_message as latest_sync_error_message,
//           csr.duration_seconds as latest_sync_duration
//         FROM connections c
//         LEFT JOIN source s ON c.source_id::varchar = s.id::varchar
//         LEFT JOIN destination d ON c.destination_id::varchar = d.id::varchar
//         LEFT JOIN (
//           SELECT DISTINCT ON (connection_id)
//             connection_id,
//             status,
//             started_at,
//             ended_at,
//             rows_processed,
//             error_message,
//             duration_seconds
//           FROM connection_sync_runs
//           ORDER BY connection_id, started_at DESC
//         ) csr ON c.connection_id = csr.connection_id
//         ${whereClause}
//         ORDER BY c.connection_id, c.created_at DESC
//       `;

//     // Execute the raw SQL query
//     const [connectionsResponse] = await Connection.sequelize.query(query, {
//       bind: params,
//     });

//     // Transform to match your expected response format
//     connections = {
//       connections: connectionsResponse.map((conn) => ({
//         id: conn.connection_id,
//         connectionId: conn.connection_id,
//         name: conn.connection_name,
//         status: conn.is_active,
//         sourceId: conn.source_id,
//         destinationId: conn.destination_id,
//         // createdAt: conn.created_at,
//         // updatedAt: conn.updated_at,
//         lastSync: conn.latest_sync_ended_at || conn.last_sync,
//         createdAt: conn.created_at
//           ? new Date(conn.created_at).toISOString()
//           : null,
//         updatedAt: conn.updated_at
//           ? new Date(conn.updated_at).toISOString()
//           : null,
//         source: conn.source_id
//           ? {
//               id: conn.source_id,
//               sourceId: conn.source_id,
//               sourceName: conn.source_name,
//               name: conn.source_name,
//               status: "active", // You might want to get this from source table
//             }
//           : null,
//         destination: conn.destination_id
//           ? {
//               id: conn.destination_id,
//               destinationId: conn.destination_id,
//               destinationName: conn.destination_name,
//               name: conn.destination_name,
//               status: "active", // You might want to get this from destination table
//             }
//           : null,
//         latestSyncJobStatus: conn.latest_sync_job_status || "pending",
//         latestSyncJob: conn.latest_sync_job_status
//           ? {
//               status: conn.latest_sync_job_status,
//               startedAt: conn.latest_sync_started_at,
//               finishedAt: conn.latest_sync_ended_at,
//               rowsProcessed: conn.latest_sync_rows_processed,
//               errorMessage: conn.latest_sync_error_message,
//               durationSeconds: conn.latest_sync_duration,
//             }
//           : null,
//       })),
//     };

//     console.log("creating connection list cache...");
//     await createCache("connection", connections);
//     // }
// console.log("latestSyncJobStatus 123",connections)
//     const allConnections = connections?.connections || [];

//     // Apply any additional client-side filters if needed
//     let filteredConnections = allConnections;

//     // Note: latestSyncJobStatus filter is now applied in SQL, but you can keep this as backup
//     if (latestSyncJobStatus && latestSyncJobStatus !== "all") {
//       filteredConnections = filteredConnections.filter((conn) => {
//         return conn.latestSyncJobStatus === latestSyncJobStatus;
//       });
//     }
//     console.log("latestSyncJobStatus 234",latestSyncJobStatus)

//     const paginatedConnections = filteredConnections;
//     return res.status(200).json({
//       success: true,
//       data: {
//         connections: paginatedConnections,
//         totalConnections: filteredConnections.length,
//         // Add items array for compatibility with frontend delete fallback
//         items: paginatedConnections.map((conn) => ({
//           ...conn,
//           id: conn.id,
//           connectionId: conn.connectionId || conn.id,
//           _id: conn.id,
//         })),
//       },
//       message:
//         "Connections fetched successfully" +
//         (status ||
//         sourceName ||
//         destinationName ||
//         search ||
//         sourceId ||
//         latestSyncJobStatus
//           ? " with filters"
//           : ""),
//     });
//   } catch (error) {
//     console.error("error", error);
//     return res.status(500).json({
//       success: false,
//       data: null,
//       message: "Something went wrong",
//     });
//   }
// };

exports.getConnections = async (req, res) => {
  try {
    let companyId;
    try { companyId = tenantId(req); } catch (e) { return sendAuthError(res, e); }

    const {
      status,
      latestSyncJobStatus,
      sourceName,
      destinationName,
      search,
      sourceId,
      redis,
    } = req.query;
    let connections;

    // Build WHERE conditions — tenant filter is the FIRST predicate.
    let whereConditions = [];
    let params = [];

    whereConditions.push(`c.company_id = $${params.length + 1}`);
    params.push(companyId);

    if (status && status !== "all") {
      whereConditions.push(`c.is_active = $${params.length + 1}`);
      params.push(status);
    }

    if (sourceId) {
      whereConditions.push(`c.source_id = $${params.length + 1}`);
      params.push(sourceId);
    }

    if (sourceName && sourceName !== "all") {
      whereConditions.push(`s.connector_name = $${params.length + 1}`);
      params.push(sourceName?.toLowerCase());
    }

    if (destinationName && destinationName !== "all") {
      whereConditions.push(`d.connector_name = $${params.length + 1}`);
      params.push(destinationName?.toLowerCase());
    }

    if (search) {
      whereConditions.push(`c.connection_name ILIKE $${params.length + 1}`);
      params.push(`%${search}%`);
    }

    // Handle latestSyncJobStatus filter for FAILED, SUCCESS, and ALL
    if (latestSyncJobStatus && latestSyncJobStatus !== "all") {
      if (latestSyncJobStatus === "FAILED") {
        // Include both FAILED status and NULL values (connections with no sync runs)
        whereConditions.push(
          `(csr.status = $${params.length + 1} OR csr.status IS NULL)`
        );
        params.push(latestSyncJobStatus);
      } else if (latestSyncJobStatus === "SUCCESS") {
        // Only include SUCCESS status
        whereConditions.push(`csr.status = $${params.length + 1}`);
        params.push(latestSyncJobStatus);
      }
      // For "all", no filter is applied
    }

    const whereClause =
      whereConditions.length > 0
        ? `WHERE ${whereConditions.join(" AND ")}`
        : "";

    // Build the SQL query with joins including connection_sync_runs
    const query = `
        SELECT DISTINCT ON (c.connection_id)          
          c.connection_id,
          c.connection_name,
          c.is_active,
          c.source_id,
          c.destination_id,
          c.created_at,
          c.last_sync,
          c.replication_frequency,
          s.id as source_id,
          s.source_name,        
          d.id as destination_id,
          d.destination_name,
          csr.status as latest_sync_job_status,
          csr.started_at as latest_sync_started_at,
          csr.ended_at as latest_sync_ended_at,
          csr.rows_processed as latest_sync_rows_processed,
          csr.error_message as latest_sync_error_message,
          csr.duration_seconds as latest_sync_duration
        FROM connections c
        LEFT JOIN source s ON c.source_id::varchar = s.id::varchar
        LEFT JOIN destination d ON c.destination_id::varchar = d.id::varchar
        LEFT JOIN (
          SELECT DISTINCT ON (connection_id) 
            connection_id,
            status,
            started_at,
            ended_at,
            rows_processed,
            error_message,
            duration_seconds
          FROM connection_sync_runs 
          ORDER BY connection_id, started_at DESC
        ) csr ON c.connection_id = csr.connection_id
        ${whereClause}
        ORDER BY c.connection_id, c.created_at DESC
      `;

    // Execute the raw SQL query
    const [connectionsResponse] = await Connection.sequelize.query(query, {
      bind: params,
    });

    // Transform to match your expected response format
    connections = {
      connections: connectionsResponse.map((conn) => ({
        id: conn.connection_id,
        connectionId: conn.connection_id,
        name: conn.connection_name,
        status: conn.is_active,
        sourceId: conn.source_id,
        destinationId: conn.destination_id,
        replication_frequency: conn.replication_frequency,
        lastSync: conn.latest_sync_ended_at || conn.last_sync,
        createdAt: conn.created_at
          ? new Date(conn.created_at).toISOString()
          : null,
        updatedAt: conn.updated_at
          ? new Date(conn.updated_at).toISOString()
          : null,
        source: conn.source_id
          ? {
              id: conn.source_id,
              sourceId: conn.source_id,
              sourceName: conn.source_name,
              name: conn.source_name,
              status: "active",
            }
          : null,
        destination: conn.destination_id
          ? {
              id: conn.destination_id,
              destinationId: conn.destination_id,
              destinationName: conn.destination_name,
              name: conn.destination_name,
              status: "active",
            }
          : null,
        latestSyncJobStatus: conn.latest_sync_job_status || "PENDING",
        latestSyncJob: conn.latest_sync_job_status
          ? {
              status: conn.latest_sync_job_status,
              startedAt: conn.latest_sync_started_at,
              finishedAt: conn.latest_sync_ended_at,
              rowsProcessed: conn.latest_sync_rows_processed,
              errorMessage: conn.latest_sync_error_message,
              durationSeconds: conn.latest_sync_duration,
            }
          : null,
      })),
    };

    console.log("creating connection list cache...");
    await createCache("connection", connections);

    // console.log("latestSyncJobStatus 123", connections);
    const allConnections = connections?.connections || [];

    // Use all connections directly since filtering is already done in SQL
    const filteredConnections = allConnections;

    console.log("latestSyncJobStatus 234", latestSyncJobStatus);

    const paginatedConnections = filteredConnections;
    return res.status(200).json({
      success: true,
      data: {
        connections: paginatedConnections,
        totalConnections: filteredConnections.length,
        // Add items array for compatibility with frontend delete fallback
        items: paginatedConnections.map((conn) => ({
          ...conn,
          id: conn.id,
          connectionId: conn.connectionId || conn.id,
          _id: conn.id,
        })),
      },
      message:
        "Connections fetched successfully" +
        (status ||
        sourceName ||
        destinationName ||
        search ||
        sourceId ||
        latestSyncJobStatus
          ? " with filters"
          : ""),
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

exports.deleteConnection = async (req, res) => {
  const connectionId = req.params.connectionId;

  let scopedWhere;
  try { scopedWhere = withTenantScope(req, { connection_id: connectionId }); }
  catch (e) { return sendAuthError(res, e); }

  const transaction = await Connection.sequelize.transaction();

  try {
    const connection = await Connection.findOne({ where: scopedWhere, transaction });
    if (!connection) {
      await transaction.rollback();
      return res.status(404).json({
        success: false,
        data: null,
        message: "Connection not found",
      });
    }

    // Delete related sync runs first
    await SchemaDetail.destroy({
      where: { connection_id: connectionId },
      transaction,
    });
    // Delete related sync runs first
    await ConnectionSyncRun.destroy({
      where: { connection_id: connectionId },
      transaction,
    });

    // Delete the connection
    await connection.destroy({ transaction });

    // Commit transaction
    await transaction.commit();

    // Basic schema cleanup
    // try {
    //   // Delete any temporary files
    //   const tempPattern = `./temp/${connectionId}_*`;
    //   await deleteFilesByPattern(tempPattern);
    // } catch (cleanupError) {
    //   console.warn(`Basic cleanup failed for connection ${connectionId}:`, cleanupError.message);
    // }

    // Invalidate caches
    await invalidateConnectionCaches();

    return res.status(200).json({
      success: true,
      data: null,
      message: "Connection and related data deleted successfully.",
    });
  } catch (error) {
    await transaction.rollback();
    console.error("deleteConnection error:", error);
    return res.status(500).json({
      success: false,
      data: null,
      message:
        error.message || "Something went wrong while deleting the connection",
    });
  }
};

// Cache invalidation for connections
async function invalidateConnectionCaches() {
  try {
    await client.del("connection");
    await client.del("connectionListDB");
    // Also invalidate source and destination caches since they might show connection counts
    // await invalidateSourceCache();
    // await invalidateDestinationCache();
  } catch (e) {
    console.error("connection cache invalidate error:", e);
  }
}
// exports.getConnectionDetails = async (req, res) => {
//   try {
//     const { connectionId } = req.params;

//     if (!connectionId) {
//       return res.status(400).json({
//         success: false,
//         data: null,
//         message: "please enter required field",
//       });
//     }

//     // Fetch connection with source and destination
//     const connectionDetails = await Connection.findOne({
//       where: { connection_id: connectionId },
//       include: [
//         {
//           model: Source,
//           as: "source",
//           on: {
//             col1: Sequelize.where(
//               Sequelize.cast(Sequelize.col("Connection.source_id"), "INTEGER"),
//               "=",
//               Sequelize.col("source.id")
//             ),
//           },
//         },
//         {
//           model: Destination,
//           as: "destination",
//           on: {
//             col1: Sequelize.where(
//               Sequelize.cast(
//                 Sequelize.col("Connection.destination_id"),
//                 "INTEGER"
//               ),
//               "=",
//               Sequelize.col("destination.id")
//             ),
//           },
//         },
//       ],
//     });

//     if (!connectionDetails) {
//       return res.status(404).json({
//         success: false,
//         data: null,
//         message: "Connection not found",
//       });
//     }

//     // Fetch schema configuration from connection_schema_details
//     const schemaDetails = await SchemaDetail.findAll({
//       where: {
//         connection_id: connectionId,
//         is_active: true,
//       },
//       attributes: [
//         "detail_id", // Using detail_id is a primary key
//         "table_name", // Using table_name instead of stream_name
//         "column_name", // Using column instead of field_name
//         "data_type",
//         "insertion_type", // Using insertion_type instead of sync_mode
//         "primary_key_column_name", // Using primary_key_column_name instead of is_primary_key
//         "cursor_column", // Using cursor_column instead of is_cursor_field
//         "is_active", // Using is_active
//       ],
//     });

//     // Transform schema details into the format your frontend expects
//     console.log("detail1234", schemaDetails )
//     const streamConfig = {};
//     schemaDetails.forEach((detail) => {
//       const streamName = detail.table_name; // Use table_name as stream identifier

//       if (!streamConfig[streamName]) {
//         streamConfig[streamName] = {
//           fields: [],
//           syncMode: detail.insertion_type, // Map insertion_type to syncMode
//           primaryKeys: [],
//           cursorField:  null,
//         };
//       }

//       // Add field information
//       streamConfig[streamName].fields.push({
//         name: detail.column_name, // Use column as field name
//         type: detail.data_type,
//       });

//       // Check if this column is a primary key
//       if (detail.primary_key_column_name === detail.column_name) {
//         streamConfig[streamName].primaryKeys.push(detail.column_name);
//       }

//       // Check if this column is a cursor field
//       console.log("detail.cursor_column", detail.cursor_column === detail.column_name,detail.cursor_column, detail.column_name)
//       if (detail.cursor_column === detail.column_name) {
//         streamConfig[streamName].cursorField = detail.column_name;
//       }
//     });

//     return res.status(200).json({
//       success: true,
//       data: {
//         connection: connectionDetails,
//         streamConfig: Object.keys(streamConfig).map((streamName) => ({
//           name: streamName,
//           ...streamConfig[streamName],
//         })),
//       },
//       message: "connection fetched successfully.",
//     });
//   } catch (error) {
//     console.error("error", error);
//     return res.status(500).json({
//       success: false,
//       data: null,
//       message: "Something went wrong",
//     });
//   }
// };

// In your connection controller file

exports.getConnectionDetails = async (req, res) => {
  try {
    const { connectionId } = req.params;

    if (!connectionId) {
      return res.status(400).json({
        success: false,
        data: null,
        message: "please enter required field",
      });
    }

    let scopedWhere;
    try { scopedWhere = withTenantScope(req, { connection_id: connectionId }); }
    catch (e) { return sendAuthError(res, e); }

    const connectionDetails = await Connection.findOne({
      where: scopedWhere,
      include: [
        {
          model: Source,
          as: "source",
          on: {
            col1: Sequelize.where(
              Sequelize.cast(Sequelize.col("Connection.source_id"), "INTEGER"),
              "=",
              Sequelize.col("source.id")
            ),
          },
        },
        {
          model: Destination,
          as: "destination",
          on: {
            col1: Sequelize.where(
              Sequelize.cast(
                Sequelize.col("Connection.destination_id"),
                "INTEGER"
              ),
              "=",
              Sequelize.col("destination.id")
            ),
          },
        },
      ],
    });

    if (!connectionDetails) {
      return res.status(404).json({
        success: false,
        data: null,
        message: "Connection not found",
      });
    }

    // Fetch schema configuration from connection_schema_details
    const schemaDetails = await SchemaDetail.findAll({
      where: {
        connection_id: connectionId,
        is_active: true,
      },
      attributes: [
        "detail_id",
        "table_name",
        "column_name",
        "data_type",
        "insertion_type",
        "primary_key_column_name",
        "cursor_column",
        "is_active",
      ],
    });

    // Transform schema details into the format your frontend expects
    // console.log("detail1234", schemaDetails)
    const streamConfig = {};

    schemaDetails.forEach((detail) => {
      const streamName = detail.table_name;

      if (!streamConfig[streamName]) {
        streamConfig[streamName] = {
          fields: [],
          syncMode: detail.insertion_type,
          primaryKeys: [],
          cursorField: null, // Initialize as null
        };
      }

      // Add field information
      streamConfig[streamName].fields.push({
        name: detail.column_name,
        type: detail.data_type,
      });

      // Check if this column is a primary key
      if (detail.primary_key_column_name === detail.column_name) {
        streamConfig[streamName].primaryKeys.push(detail.column_name);
      }

      // FIXED: Check if this column is a cursor field
      // cursor_column is a boolean indicating if this column is the cursor column
      if (detail.cursor_column === true) {
        streamConfig[streamName].cursorField = detail.column_name;
      }
    });

    return res.status(200).json({
      success: true,
      data: {
        connection: connectionDetails,
        streamConfig: Object.keys(streamConfig).map((streamName) => ({
          name: streamName,
          ...streamConfig[streamName],
        })),
      },
      message: "connection fetched successfully.",
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

exports.updateConnection = async (req, res) => {
  let scopedWhere;
  try { scopedWhere = withTenantScope(req, { connection_id: req.params.connectionId }); }
  catch (e) { return sendAuthError(res, e); }

  const t = await Connection.sequelize.transaction();
  try {
    const connectionId = req.params.connectionId;
    const payload = req.body;

    const existingConnection = await Connection.findOne({
      where: scopedWhere,
      transaction: t,
    });

    if (!existingConnection) {
      await t.rollback();
      return res.status(404).json({
        success: false,
        data: null,
        message: "Connection not found",
      });
    }

    // 2️⃣ Update the connection (scoped — never updates another tenant's row)
    await Connection.update(
      {
        connection_name: payload.name,
        source_id: payload.sourceId,
        destination_id: payload.destinationId,
        schedule_type: payload.scheduleType,
        replication_frequency: payload.replication_frequency || "1 hours",
        destination_schema: payload.namespaceDefinition || "public",
        updated_at: new Date(),
      },
      {
        where: scopedWhere,
        transaction: t,
      }
    );

    // 3️⃣ Get existing schema records for this connection
    const existingSchemaRecords = await SchemaDetail.findAll({
      where: { connection_id: connectionId },
      transaction: t,
    });

    // 4️⃣ Process schema updates
    if (payload.syncCatalog && payload.syncCatalog.streams) {
      const updates = [];
      const newRecords = [];

      // Create a map of existing records for quick lookup
      const existingMap = new Map();
      existingSchemaRecords.forEach((record) => {
        const key = `${record.table_name}-${record.column_name}`;
        existingMap.set(key, record);
      });

      payload.syncCatalog.streams.forEach((streamItem) => {
        const streamConfig = streamItem.config;

        if (streamConfig.selected) {
          const tableName = streamItem.stream.name;
          const allColumns = Object.keys(
            streamItem.stream.jsonSchema?.properties || {}
          );

          allColumns.forEach((colName) => {
            const key = `${tableName}-${colName}`;
            const isPrimaryKey =
              streamItem.stream.primaryKeys &&
              Array.isArray(streamItem.stream.primaryKeys) &&
              streamItem.stream.primaryKeys.includes(colName);

            const isActive =
              Array.isArray(streamConfig.fields) &&
              streamConfig.fields.includes(colName);

            if (existingMap.has(key)) {
              // Update existing record
              const existingRecord = existingMap.get(key);
              updates.push(
                SchemaDetail.update(
                  {
                    data_type:
                      streamItem.stream.jsonSchema?.properties?.[colName]
                        ?.type || "string",
                    insertion_type: streamConfig.syncMode || null,
                    cursor_column: colName === streamConfig.cursorField,
                    primary_key_column_name: isPrimaryKey ? colName : null,
                    is_active: isActive,
                    updated_at: new Date(),
                  },
                  {
                    where: { detail_id: existingRecord.detail_id },
                    transaction: t,
                  }
                )
              );
            } else {
              // Create new record
              newRecords.push({
                connection_id: connectionId,
                table_name: tableName,
                column_name: colName,
                data_type:
                  streamItem.stream.jsonSchema?.properties?.[colName]?.type ||
                  "string",
                insertion_type: streamConfig.syncMode || null,
                cursor_column: colName === streamConfig.cursorField,
                primary_key_column_name: isPrimaryKey ? colName : null,
                is_active: isActive,
                created_at: new Date(),
              });
            }
          });
        }
      });

      // Execute all updates and inserts
      await Promise.all(updates);
      if (newRecords.length > 0) {
        await SchemaDetail.bulkCreate(newRecords, { transaction: t });
      }

      // Mark records that are no longer selected as inactive
      const selectedFields = new Set();
      payload.syncCatalog.streams.forEach((streamItem) => {
        if (streamItem.config.selected) {
          const tableName = streamItem.stream.name;
          Object.keys(streamItem.stream.jsonSchema?.properties || {}).forEach(
            (colName) => {
              selectedFields.add(`${tableName}-${colName}`);
            }
          );
        }
      });

      const recordsToDeactivate = existingSchemaRecords.filter((record) => {
        const key = `${record.table_name}-${record.column_name}`;
        return !selectedFields.has(key) && record.is_active;
      });

      if (recordsToDeactivate.length > 0) {
        await SchemaDetail.update(
          { is_active: false, updated_at: new Date() },
          {
            where: {
              detail_id: recordsToDeactivate.map((r) => r.detail_id),
            },
            transaction: t,
          }
        );
      }
    }

    await t.commit();

    // 5️⃣ Get destination details to check if it's Excel
    const destination = await Destination.findOne({
      where: { id: payload.destinationId },
    });

    // 6️⃣ Trigger ETL run after successful update
    try {
      if (destination && destination.connector_name.toLowerCase() === "excel") {
        // For Excel destination, run ETL and send file for download
        const etlResult = await runETL(
          payload.sourceId,
          connectionId,
          payload.destinationId,
          res // Pass response object for file download
        );

        // If ETL returned a result (not Excel download), send normal response
        if (etlResult) {
          return res.status(200).json({
            success: true,
            data: {
              connection: {
                connection_id: connectionId,
                ...payload,
              },
              etlResult,
            },
            message: "Connection updated and ETL completed successfully.",
          });
        }
        // If Excel download was initiated, response is already sent
      } else {
        // For non-Excel destinations, normal ETL
        await runETL(payload.sourceId, connectionId, payload.destinationId);

        return res.status(200).json({
          success: true,
          data: {
            connection: {
              connection_id: connectionId,
              ...payload,
            },
          },
          message: "Connection and schema details updated successfully.",
        });
      }
    } catch (etlError) {
      console.error("❌ ETL failed after connection update:", etlError.message);

      // Even if ETL fails, connection was updated successfully
      return res.status(200).json({
        success: true,
        data: {
          connection: {
            connection_id: connectionId,
            ...payload,
          },
        },
        message:
          "Connection updated but ETL failed. Please try syncing manually.",
      });
    }
  } catch (error) {
    await t.rollback();
    console.error("Error updating connection:", error);

    // Send JSON error response
    return res.status(500).json({
      success: false,
      data: null,
      message: "Something went wrong while updating connection",
      error: error.message,
    });
  }
};

// exports.getConnectionDetails = async (req, res) => {
//   try {
//     const { connectionId } = req.params;

//     if (!connectionId) {
//       return res.status(400).json({
//         success: false,
//         data: null,
//         message: "please enter required field",
//       });
//     }

//     // Fetch from DB with explicit casting for joins
//     const connectionDetails = await Connection.findOne({
//       where: {connection_id: connectionId },
//       include: [
//         {
//           model: Source,
//           as: "source",
//           on: {
//             // Explicitly cast to match data types
//             col1: Sequelize.where(
//               Sequelize.cast(Sequelize.col('Connection.source_id'), 'INTEGER'),
//               '=',
//               Sequelize.col('source.id')
//             )
//           }
//         },
//         {
//           model: Destination,
//           as: "destination",
//           on: {
//             col1: Sequelize.where(
//               Sequelize.cast(Sequelize.col('Connection.destination_id'), 'INTEGER'),
//               '=',
//               Sequelize.col('destination.id')
//             )
//           }
//         },
//       ],
//     });

//     if (!connectionDetails) {
//       return res.status(404).json({
//         success: false,
//         data: null,
//         message: "Connection not found",
//       });
//     }

//     return res.status(200).json({
//       success: false,
//       data: {
//         connection: connectionDetails,
//       },
//       message: "connection fetched successfully.",
//     });
//   } catch (error) {
//     console.error("error", error);
//     return res.status(500).json({
//       success: false,
//       data: null,
//       message: "Something went wrong",
//     });
//   }
// };

// exports.getConnectionDetails = async (req, res) => {
//   try {
//     const { connectionId } = req.params;

//     if (!connectionId) {
//       return res.status(400).json({
//         success: false,
//         data: null,
//         message: "please enter required field",
//       });
//     }

//     // Fetch connection with source and destination
//     const connectionDetails = await Connection.findOne({
//       where: { connection_id: connectionId },
//       include: [
//         {
//           model: Source,
//           as: "source",
//           on: {
//             col1: Sequelize.where(
//               Sequelize.cast(Sequelize.col('Connection.source_id'), 'INTEGER'),
//               '=',
//               Sequelize.col('source.id')
//             )
//           }
//         },
//         {
//           model: Destination,
//           as: "destination",
//           on: {
//             col1: Sequelize.where(
//               Sequelize.cast(Sequelize.col('Connection.destination_id'), 'INTEGER'),
//               '=',
//               Sequelize.col('destination.id')
//             )
//           }
//         },
//       ],
//     });

//     if (!connectionDetails) {
//       return res.status(404).json({
//         success: false,
//         data: null,
//         message: "Connection not found",
//       });
//     }

//     // Fetch schema configuration from connection_schema_details
//     const schemaDetails = await SchemaDetail.findAll({
//       where: {
//         connection_id: connectionId,
//         is_active: true
//       },
//       attributes: ['stream_name', 'field_name', 'data_type', 'sync_mode', 'is_primary_key', 'is_cursor_field']
//     });

//     // Transform schema details into the format your frontend expects
//     const streamConfig = {};
//     schemaDetails.forEach(detail => {
//       if (!streamConfig[detail.stream_name]) {
//         streamConfig[detail.stream_name] = {
//           fields: [],
//           syncMode: detail.sync_mode,
//           primaryKeys: [],
//           cursorField: ''
//         };
//       }

//       streamConfig[detail.stream_name].fields.push({
//         name: detail.field_name,
//         type: detail.data_type
//       });

//       if (detail.is_primary_key) {
//         streamConfig[detail.stream_name].primaryKeys.push(detail.field_name);
//       }

//       if (detail.is_cursor_field) {
//         streamConfig[detail.stream_name].cursorField = detail.field_name;
//       }
//     });

//     return res.status(200).json({
//       success: true,
//       data: {
//         connection: connectionDetails,
//         streamConfig: Object.keys(streamConfig).map(streamName => ({
//           name: streamName,
//           ...streamConfig[streamName]
//         }))
//       },
//       message: "connection fetched successfully.",
//     });
//   } catch (error) {
//     console.error("error", error);
//     return res.status(500).json({
//       success: false,
//       data: null,
//       message: "Something went wrong",
//     });
//   }
// };

// exports.updateConnection = async (req, res) => {
//   try {
//     const connectionId = req.params.connectionId;
//     const payload = req.body;
//     payload.connectionId = connectionId;
//     console.log("payload", payload);
//     const response = await Airbyte.post("/connections/update", payload);
//     return res.status(200).json({
//       success: true,
//       message: `Connection update successfully`,
//       data: response.data,
//     });
//   } catch (error) {
//     console.log("error", error);
//     return res.status(500).json({
//       success: false,
//       data: null,
//       message: "Something went wrong",
//     });
//   }
// };
// exports.updateConnection = async (req, res) => {
//   const t = await Connection.sequelize.transaction();
//   try {
//     const connectionId = req.params.connectionId;
//     const payload = req.body;

//     console.log("Update connection payload:", payload);
//     console.log("Update connection payload:", connectionId);

//     // 1️⃣ Check if connection exists
//     const existingConnection = await Connection.findOne({
//       where: { connection_id: connectionId },
//       transaction: t
//     });

//     if (!existingConnection) {
//       await t.rollback();
//       return res.status(404).json({
//         success: false,
//         data: null,
//         message: "Connection not found",
//       });
//     }

//     // 2️⃣ Update the connection
//     await Connection.update(
//       {
//         connection_name: payload.name,
//         source_id: payload.sourceId,
//         destination_id: payload.destinationId,
//         schedule_type: payload.scheduleType,
//         replication_frequency: payload.scheduleData?.basicSchedule?.timeUnit || "hours",
//         destination_schema: payload.namespaceDefinition || "public",
//         // is_active: payload.status === "active",
//         updated_at: new Date()
//       },
//       {
//         where: { connection_id: connectionId },
//         transaction: t
//       }
//     );

//     // 3️⃣ Get existing schema records for this connection
//     const existingSchemaRecords = await SchemaDetail.findAll({
//       where: { connection_id: connectionId },
//       transaction: t
//     });

//     // 4️⃣ Process schema updates
//     if (payload.syncCatalog && payload.syncCatalog.streams) {
//       const updates = [];
//       const newRecords = [];

//       // Create a map of existing records for quick lookup
//       const existingMap = new Map();
//       existingSchemaRecords.forEach(record => {
//         const key = `${record.table_name}-${record.column_name}`;
//         existingMap.set(key, record);
//       });

//       payload.syncCatalog.streams.forEach((streamItem) => {
//         const streamConfig = streamItem.config;

//         if (streamConfig.selected) {
//           const tableName = streamItem.stream.name;
//           const allColumns = Object.keys(
//             streamItem.stream.jsonSchema?.properties || {}
//           );

//           allColumns.forEach((colName) => {
//             const key = `${tableName}-${colName}`;
//             const isPrimaryKey =
//               streamItem.stream.primaryKeys &&
//               Array.isArray(streamItem.stream.primaryKeys) &&
//               streamItem.stream.primaryKeys.includes(colName);

//             const isActive = Array.isArray(streamConfig.fields) &&
//                             streamConfig.fields.includes(colName);

//             if (existingMap.has(key)) {
//               // Update existing record
//               const existingRecord = existingMap.get(key);
//               console.log("existingRecord",existingRecord)
//               updates.push(
//                 SchemaDetail.update(
//                   {
//                     data_type: streamItem.stream.jsonSchema?.properties?.[colName]?.type || "string",
//                     insertion_type: streamConfig.syncMode || null,
//                     cursor_column: colName === streamConfig.cursorField,
//                     primary_key_column_name: isPrimaryKey ? colName : null,
//                     is_active: isActive,
//                     updated_at: new Date()
//                   },
//                   {
//                     where: { detail_id: existingRecord.detail_id },
//                     transaction: t
//                   }
//                 )
//               );
//             } else {
//               // Create new record
//               newRecords.push({
//                 connection_id: connectionId,
//                 table_name: tableName,
//                 column_name: colName,
//                 data_type: streamItem.stream.jsonSchema?.properties?.[colName]?.type || "string",
//                 insertion_type: streamConfig.syncMode || null,
//                 cursor_column: colName === streamConfig.cursorField,
//                 primary_key_column_name: isPrimaryKey ? colName : null,
//                 is_active: isActive,
//                 created_at: new Date()
//               });
//             }
//           });
//         }
//       });

//       // Execute all updates and inserts
//       await Promise.all(updates);
//       if (newRecords.length > 0) {
//         await SchemaDetail.bulkCreate(newRecords, { transaction: t });
//       }

//       // Mark records that are no longer selected as inactive
//       const selectedFields = new Set();
//       payload.syncCatalog.streams.forEach(streamItem => {
//         if (streamItem.config.selected) {
//           const tableName = streamItem.stream.name;
//           Object.keys(streamItem.stream.jsonSchema?.properties || {}).forEach(colName => {
//             selectedFields.add(`${tableName}-${colName}`);
//           });
//         }
//       });

//       const recordsToDeactivate = existingSchemaRecords.filter(record => {
//         const key = `${record.table_name}-${record.column_name}`;
//         return !selectedFields.has(key) && record.is_active;
//       });
//       console.log("recordsToDeactivate",recordsToDeactivate)
//       if (recordsToDeactivate.length > 0) {
//         await SchemaDetail.update(
//           { is_active: false, updated_at: new Date() },
//           {
//             where: {
//               detail_id: recordsToDeactivate.map(r => r.detail_id)
//             },
//             transaction: t
//           }
//         );
//       }
//     }

//     await t.commit();

//     // 5️⃣ Trigger ETL run after successful update
//     try {
//       await runETL(payload.sourceId, connectionId, payload.destinationId);
//       console.log(`✅ ETL run completed after updating connection ${connectionId}`);
//     } catch (etlError) {
//       console.error("❌ ETL failed after connection update:", etlError.message);
//     }

//     return res.status(200).json({
//       success: true,
//       data: {
//         connection: {
//           connection_id: connectionId,
//           ...payload
//         }
//       },
//       message: "Connection and schema details updated successfully.",
//     });
//   } catch (error) {
//     await t.rollback();
//     console.error("Error updating connection:", error);
//     return res.status(500).json({
//       success: false,
//       data: null,
//       message: "Something went wrong while updating connection",
//     });
//   }
// };

exports.getLastJobDetails = async (req, res) => {
  try {
    const connectionId = req.params.connectionId;
    if (!connectionId) {
      return res.status(400).json({
        success: false,
        data: null,
        message: "connectionId is required",
      });
    }

    let scopedWhere;
    try { scopedWhere = withTenantScope(req, { connection_id: connectionId }); }
    catch (e) { return sendAuthError(res, e); }

    const owned = await Connection.findOne({ where: scopedWhere, attributes: ['connection_id'] });
    if (!owned) {
      return res.status(404).json({ success: false, data: null, message: 'Connection not found' });
    }

    const response = await Airbyte.post("/jobs/list", {
      configId: connectionId,
      configTypes: ["sync"],
    });
    return res.status(200).json({
      success: true,
      data: response.data,
      message: "all sources fetch successfully",
    });
  } catch (error) {
    console.log("error", error);
    return res.status(500).json({
      success: false,
      data: null,
      message: "Something went wrong",
    });
  }
};

// exports.updateConnectionStatus = async (req, res) => {
//   try {
//     const { error } = updateConnectionStatusValidation.validate(req.body, {
//       abortEarly: false,
//     });
//     if (error) {
//       return res.status(400).json({
//         success: false,
//         data: null,
//         message: error.message,
//       });
//     }
//     const { connectionId, status } = req.body;
//     const response = await Airbyte.post("/connections/update", {
//       connectionId: connectionId,
//       status: status,
//     });
//     return res.status(200).json({
//       success: true,
//       message: `Connection ${status} successfully`,
//       data: response.data,
//     });
//   } catch (error) {
//     console.log("error", error);
//     return res.status(500).json({
//       success: false,
//       data: null,
//       message: "Something went wrong",
//     });
//   }
// };

exports.updateConnectionStatus = async (req, res) => {
  try {
    console.log("ajsdsiausdgasdd", req.body);
    // ✅ Validate input
    const { error } = updateConnectionStatusValidation.validate(req.body, {
      abortEarly: false,
    });
    if (error) {
      return res.status(400).json({
        success: false,
        data: null,
        message: error.message,
      });
    }

    const { connectionId, status } = req.body; // 👈 expecting isActive instead of "status"
    const isActive = status == "active" ? true : false;

    let scopedWhere;
    try { scopedWhere = withTenantScope(req, { connection_id: connectionId }); }
    catch (e) { return sendAuthError(res, e); }

    const [updatedRows] = await Connection.update(
      { is_active: isActive },
      { where: scopedWhere }
    );

    if (updatedRows === 0) {
      return res.status(404).json({
        success: false,
        data: null,
        message: "Connection not found",
      });
    }

    const updatedConnection = await Connection.findOne({ where: scopedWhere });

    return res.status(200).json({
      success: true,
      message: `Connection status updated successfully`,
      data: updatedConnection,
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

/* ============================================================================================================================================ */
/*                                                 SHOPIFY FUNCTION START                   */
/* ============================================================================================================================================*/

/**
 * Shopify Entity Map for ETL
 */
function getShopifyEntityMap() {
  return {
    // Core entities
    products: "products",
    variants: "variants",
    orders: "orders",
    customers: "customers",
    collections: "custom_collections",
    inventory_items: "inventory_items",
    locations: "locations",

    // Additional entities
    fulfillments: "fulfillments",
    transactions: "transactions",
    refunds: "refunds",
    draft_orders: "draft_orders",
    price_rules: "price_rules",
    discounts: "discount_codes",
    pages: "pages",
    blogs: "blogs",
    articles: "articles",
    themes: "themes",
    assets: "assets",
  };
}

/**
 * Check if Shopify entity is valid
 */
function isValidShopifyEntity(entity) {
  const entityMap = getShopifyEntityMap();
  return (
    Object.values(entityMap).includes(entity) ||
    Object.keys(entityMap).includes(entity.toLowerCase())
  );
}

/**
 * Get Shopify entity details
 */
function getShopifyEntityDetails(entityType) {
  const entityMap = getShopifyEntityMap();
  const entity = entityMap[entityType.toLowerCase()] || entityType;

  return {
    apiName: entity,
    displayName: entityType
      .replace(/_/g, " ")
      .replace(/\b\w/g, (l) => l.toUpperCase()),
    category: getShopifyEntityCategory(entity),
  };
}

/**
 * Categorize Shopify entities
 */
function getShopifyEntityCategory(entity) {
  const salesEntities = ["orders", "transactions", "refunds", "draft_orders"];
  const productEntities = [
    "products",
    "variants",
    "collections",
    "inventory_items",
  ];
  const customerEntities = ["customers"];
  const contentEntities = ["pages", "blogs", "articles", "themes", "assets"];
  const marketingEntities = ["price_rules", "discounts"];

  if (salesEntities.includes(entity)) return "sales";
  if (productEntities.includes(entity)) return "products";
  if (customerEntities.includes(entity)) return "customers";
  if (contentEntities.includes(entity)) return "content";
  if (marketingEntities.includes(entity)) return "marketing";

  return "other";
}

/**
 * Check Shopify data availability
 */
async function checkShopifyDataAvailability(settings, entityType) {
  const { shop, credentials } = settings; // Use 'shop' instead of 'shop_domain'
  const access_token = credentials.access_token;
  console.log("setting", settings);
  if (!shop || !access_token) {
    throw new Error(
      "Shopify credentials missing. Required: shop domain, access_token"
    );
  }

  try {
    console.log(`🔍 Checking data availability for: ${entityType}`);

    const entityDetails = getShopifyEntityDetails(entityType);
    const entity = entityDetails.apiName;

    // For Shopify, we'll attempt to fetch a small sample to check availability
    const baseUrl = `https://${shop}/admin/api/2024-01`;
    const url = `${baseUrl}/${entity}.json?limit=1`;
    console.log("url", url);
    console.log("baseUrl,entity", baseUrl, entity);

    const response = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": access_token,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.log(`⚠️ ${entityType} query failed: ${response.status}`);
      return false;
    }

    const data = await response.json();
    const count = data[entity] ? data[entity].length : 0;
    console.log(`📊 ${entityType} has data available: ${count > 0}`);

    return count > 0;
  } catch (error) {
    console.error(`❌ Error checking ${entityType}:`, error.message);
    return false;
  }
}

/**
 * Read data from Shopify API with environment detection
 */

// Updated main function with proper credential handling
async function readShopifyData(
  settings,
  entityType,
  activeColumns,
  limit = 250
) {
  try {
    console.log(`📖 Reading Shopify data for entity: ${entityType}`);

    // Use the correct property names from your settings object
    const { shop, credentials } = settings;
    const access_token = credentials.access_token;
    const api_version = "2024-01";

    if (!shop || !access_token) {
      throw new Error(
        "Shopify credentials missing. Required: shop, access_token"
      );
    }

    // Environment check with your actual shop data
    const envCheck = await checkShopifyEnvironment(settings);
    console.log(`🏪 Shopify Store: ${envCheck.environment}`);
    console.log(`🌐 Is Live Store: ${envCheck.isLive}`);

    if (envCheck.environment === "trial") {
      console.warn("⚠️ Working with TRIAL store - features may be limited");
    } else if (!envCheck.isLive) {
      console.warn("⚠️ Working with development store - data may be test data");
    } else {
      console.log("🚨 WORKING WITH LIVE PRODUCTION STORE!");
    }

    const entityDetails = getShopifyEntityDetails(entityType);
    const entity = entityDetails.apiName;

    if (!isValidShopifyEntity(entity)) {
      console.warn(`⚠️ Unknown Shopify entity: ${entityType} → ${entity}`);
      return [];
    }

    const baseUrl = `https://${shop}/admin/api/${api_version}`;
    let allEntities = [];
    let nextPage = null;
    let page = 1;

    console.log(`🔍 Fetching ${entity} data from Shopify...`);

    do {
      let url;
      if (nextPage) {
        url = nextPage;
      } else {
        // Build URL with appropriate query parameters
        url = `${baseUrl}/${entity}.json?limit=${limit}`;

        // Add status filter for orders if applicable
        if (entity === "orders") {
          url += "&status=any";
        }
      }

      console.log(`📥 Fetching page ${page}...`);

      const response = await fetch(url, {
        method: "GET",
        headers: {
          "X-Shopify-Access-Token": access_token,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        const enhancedError = handleShopifyAPIError(
          new Error(`HTTP ${response.status}: ${errorText}`),
          envCheck.environment
        );

        if (enhancedError.actionable) {
          console.error(`❌ ${enhancedError.type}: ${enhancedError.message}`);
          console.log(`💡 Solution: ${enhancedError.solution}`);
        }

        throw new Error(enhancedError.message);
      }

      const data = await response.json();
      let entities = data[entity] || [];

      console.log(`✅ Fetched page ${page}: ${entities.length} records`);

      // Transform data
      const transformedChunk = entities.map((shopifyEntity) => {
        const row = {};
        activeColumns.forEach((column) => {
          const value = getNestedShopifyValue(shopifyEntity, column);
          row[column] = value !== undefined ? value : null;
        });

        // Add metadata
        row["_shopify_environment"] = envCheck.environment;
        row["_shopify_store_domain"] = shop;
        row["_data_source"] = `shopify_${envCheck.environment}`;
        row["_extracted_at"] = new Date().toISOString();

        return row;
      });

      allEntities = allEntities.concat(transformedChunk);
      page++;

      // Pagination
      const linkHeader = response.headers.get("link");
      nextPage = extractNextPageUrl(linkHeader);

      // Rate limiting
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (nextPage && allEntities.length < 1000); // Safety limit

    console.log(`🎉 Total ${allEntities.length} ${entity} records fetched`);
    return allEntities;
  } catch (error) {
    console.error("❌ Error reading Shopify data:", error.message);
    throw error;
  }
}

// Helper function to extract next page URL from Link header
function extractNextPageUrl(linkHeader) {
  if (!linkHeader) return null;

  const links = linkHeader.split(",");
  for (const link of links) {
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

/**
 * Enhanced helper function to get nested Shopify object values
 */
function getNestedShopifyValue(obj, path) {
  try {
    return path.split(".").reduce((current, key) => {
      if (current && typeof current === "object") {
        // Handle array indices
        if (key.includes("[") && key.includes("]")) {
          const arrayKey = key.split("[")[0];
          const index = parseInt(key.match(/\[(\d+)\]/)[1]);
          return current[arrayKey] && current[arrayKey][index] !== undefined
            ? current[arrayKey][index]
            : undefined;
        }
        // Handle regular nested properties
        return current[key] !== undefined ? current[key] : undefined;
      }
      return undefined;
    }, obj);
  } catch (error) {
    console.warn(`⚠️ Could not access path ${path} in Shopify object`);
    return undefined;
  }
}

/**
 * Enhanced data cleaner with Shopify-specific handling
 */
function cleanDataForUniversalInsertion(rows, activeColumns) {
  return rows.map((row) => {
    const cleanedRow = {};

    activeColumns.forEach((col) => {
      let value = row[col];

      // Handle null/undefined
      if (value === null || value === undefined || value === "") {
        cleanedRow[col] = null;
        return;
      }

      // Handle Shopify-specific objects
      if (typeof value === "object" && value !== null) {
        cleanedRow[col] = handleShopifyComplexObject(value, col);
        return;
      }

      // Handle arrays (common in Shopify for variants, options, etc.)
      if (Array.isArray(value)) {
        cleanedRow[col] = handleShopifyArray(value, col);
        return;
      }

      // SPECIAL HANDLING FOR SHOPIFY METAFIELDS AND JSON DATA
      if (isShopifyJsonColumn(col) && typeof value === "string") {
        try {
          JSON.parse(value);
          cleanedRow[col] = value;
        } catch (e) {
          cleanedRow[col] = `"${value}"`;
        }
        return;
      }

      // Handle Shopify-specific data types
      cleanedRow[col] = handleShopifyBasicType(value, col);
    });

    return cleanedRow;
  });
}

/**
 * Check if column should be treated as JSON for Shopify data
 */
function isShopifyJsonColumn(columnName) {
  const shopifyJsonIndicators = [
    "metafield",
    "metadata",
    "properties",
    "attributes",
    "note_attributes",
    "shipping_lines",
    "discount_codes",
    "line_items",
    "fulfillments",
    "refunds",
    "tax_lines",
  ];
  return shopifyJsonIndicators.some((indicator) =>
    columnName.toLowerCase().includes(indicator)
  );
}

/**
 * Handle Shopify complex objects (metafields, addresses, etc.)
 */
function handleShopifyComplexObject(obj, columnName) {
  // Handle Shopify metafields
  if (obj.namespace && obj.key && obj.value) {
    return JSON.stringify({
      namespace: obj.namespace,
      key: obj.key,
      value: obj.value,
      value_type: obj.value_type,
    });
  }

  // Handle Shopify addresses
  if (obj.address1 && obj.city && obj.country) {
    return JSON.stringify({
      address1: obj.address1,
      address2: obj.address2,
      city: obj.city,
      province: obj.province,
      country: obj.country,
      zip: obj.zip,
      phone: obj.phone,
    });
  }

  // Handle Shopify money formats
  if (obj.amount && obj.currency_code) {
    return JSON.stringify({
      amount: obj.amount,
      currency_code: obj.currency_code,
    });
  }

  // Default: convert to JSON string for storage
  try {
    return JSON.stringify(obj);
  } catch (error) {
    console.warn(
      `Could not stringify Shopify object for column ${columnName}:`,
      obj
    );
    return null;
  }
}

/**
 * Handle Shopify arrays (variants, options, line items, etc.)
 */
function handleShopifyArray(arr, columnName) {
  if (arr.length === 0) return null;

  // If array contains simple values, join them
  if (arr.every((item) => typeof item !== "object")) {
    return arr.join(", ");
  }

  // If array contains objects, stringify with Shopify context
  try {
    // For variants, extract key information
    if (columnName.includes("variant")) {
      const simplified = arr.map((variant) => ({
        id: variant.id,
        title: variant.title,
        price: variant.price,
        sku: variant.sku,
        inventory_quantity: variant.inventory_quantity,
      }));
      return JSON.stringify(simplified);
    }

    // For line items, extract key information
    if (columnName.includes("line_item")) {
      const simplified = arr.map((item) => ({
        id: item.id,
        title: item.title,
        quantity: item.quantity,
        price: item.price,
        sku: item.sku,
      }));
      return JSON.stringify(simplified);
    }

    return JSON.stringify(arr);
  } catch (error) {
    console.warn(
      `Could not stringify Shopify array for column ${columnName}:`,
      arr
    );
    return null;
  }
}

/**
 * Handle Shopify basic data types with proper conversion
 */

function handleShopifyBasicType(value, columnName) {
  const colName = columnName.toLowerCase();

  // Handle boolean strings
  if (value === "true" || value === "TRUE") return true;
  if (value === "false" || value === "FALSE") return false;

  // Handle numeric strings (prices, quantities, etc.)
  if (typeof value === "string") {
    // Skip numeric conversion for specific Shopify fields that should remain strings
    const stringFields = [
      "sku",
      "barcode",
      "handle",
      "fulfillment_service",
      "inventory_policy",
    ];
    if (stringFields.some((field) => colName.includes(field))) {
      return value;
    }

    // Remove currency symbols and commas for numeric conversion
    const numericString = value
      .replace(/[$,£€]/g, "")
      .replace(/,/g, "")
      .trim();

    // Check if it's a valid number
    if (
      !isNaN(numericString) &&
      numericString !== "" &&
      !numericString.includes("/")
    ) {
      return numericString.includes(".")
        ? parseFloat(numericString)
        : parseInt(numericString);
    }

    // Handle date strings
    if (value.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)) {
      return value; // Let PostgreSQL handle ISO date parsing
    }
  }

  // Return as-is for other types
  return value;
}
/**
 * Check Shopify store environment (live vs development)
 */
async function checkShopifyEnvironment(settings) {
  const { shop_domain, access_token } = settings;

  try {
    const baseUrl = `https://${shop_domain}.myshopify.com/admin/api/2024-01`;
    const shopUrl = `${baseUrl}/shop.json`;

    const response = await fetch(shopUrl, {
      headers: {
        "X-Shopify-Access-Token": access_token,
        "Content-Type": "application/json",
      },
    });

    if (response.ok) {
      const shopData = await response.json();
      const shop = shopData.shop;

      return {
        isLive: analyzeShopForProduction(shop),
        shopDetails: shop,
        environment: getShopEnvironment(shop),
      };
    }
  } catch (error) {
    console.error("Error checking Shopify environment:", error);
  }

  return { isLive: false, environment: "unknown" };
}

function analyzeShopForProduction(shop) {
  if (!shop) return false;

  const indicators = {
    hasCustomDomain: shop.domain && !shop.domain.includes(".myshopify.com"),
    hasPaidPlan: !["trial", "development", "partner_test", "staff"].includes(
      shop.plan_name?.toLowerCase()
    ),
    isNotTrial: shop.plan_name?.toLowerCase() !== "trial",
    hasStorefront: shop.has_storefront === true,
    financesEnabled: shop.finances === true,
    createdAgo: shop.created_at
      ? new Date() - new Date(shop.created_at) > 30 * 24 * 60 * 60 * 1000
      : false, // Older than 30 days
  };

  const score = Object.values(indicators).filter(Boolean).length;
  return score >= 3; // Require multiple indicators
}

function getShopEnvironment(shop) {
  if (!shop) return "unknown";

  const plan = shop.plan_name?.toLowerCase();
  const domain = shop.myshopify_domain || shop.domain || "";

  if (plan?.includes("development") || plan?.includes("partner_test")) {
    return "development";
  } else if (plan?.includes("trial")) {
    return "trial";
  } else if (
    plan?.includes("staff") ||
    domain.includes("-dev") ||
    domain.includes("-staging")
  ) {
    return "staging";
  } else if (
    plan?.includes("basic") ||
    plan?.includes("professional") ||
    plan?.includes("enterprise")
  ) {
    return "production";
  } else {
    return "unknown";
  }
}

/**
 * Get detailed Shopify store information
 */
async function getShopifyStoreInfo(settings) {
  const { shop_domain, access_token } = settings;

  try {
    const baseUrl = `https://${shop_domain}.myshopify.com/admin/api/2024-01`;
    const shopUrl = `${baseUrl}/shop.json`;

    const response = await fetch(shopUrl, {
      headers: {
        "X-Shopify-Access-Token": access_token,
        "Content-Type": "application/json",
      },
    });

    if (response.ok) {
      const shopData = await response.json();
      return {
        success: true,
        store: shopData.shop,
        environment: getShopEnvironment(shopData.shop),
        isLive: analyzeShopForProduction(shopData.shop),
      };
    }
  } catch (error) {
    console.error("Error getting Shopify store info:", error);
  }

  return { success: false, environment: "unknown", isLive: false };
}

/* ============================================================================================================================================ */
/*                                                 SHOPIFY FUNCTION END                   */
/* ============================================================================================================================================*/

/* ============================================================================================================================================ */
/*                                                 ZOHO BOOK FUNCTION START                   */
/* ============================================================================================================================================*/

/**
 * Zoho Books Entity Map for ETL
 */
// function getZohoBooksEntityMap() {
//   return {
//     // Core entities (matching your Airbyte schema)
//     "bank_accounts": "bankaccounts",
//     "bills": "bills",
//     "contacts": "contacts",
//     "credit_notes": "creditnotes",
//     "customer_payments": "customerpayments",
//     "estimates": "estimates",
//     "expenses": "expenses",
//     "invoices": "invoices",
//     "items": "items",
//     "journals": "journals",
//     "organizations": "organizations",
//     "purchase_orders": "purchaseorders",
//     "sales_orders": "salesorders",
//     "taxes": "taxes",
//     "transactions": "banktransactions",
//     "vendors": "vendors",
//     "vendor_payments": "vendorpayments",

//     // ✅ NEW: Additional entities from your list
//     "customers": "customers",
//     "chart_of_accounts": "chartofaccounts",
//     "projects": "projects",
//     "vendor_credits": "vendorcredits",
//     "recurring_invoices": "recurringinvoices",
//     "retainer_invoices": "retainerinvoices",
//     "users": "users",

//     // ✅ ALIASES for consistency
//     "bank_transactions": "banktransactions",
//     "creditnotes": "creditnotes",
//     "salesorders": "salesorders",
//     "purchaseorders": "purchaseorders",
//     "vendorcredits": "vendorcredits",
//     "recurringinvoices": "recurringinvoices",
//     "retainerinvoices": "retainerinvoices",
//     "chartofaccounts": "chartofaccounts"
//   };
// }

// /**
//  * Get Zoho Books entity details
//  */
// function getZohoBooksEntityDetails(entityType) {
//   const entityMap = getZohoBooksEntityMap();

//   // Try exact match first
//   let entity = entityMap[entityType];

//   // If not found, try case-insensitive match
//   if (!entity) {
//     const lowerEntityType = entityType.toLowerCase();
//     entity = entityMap[lowerEntityType];
//   }

//   // If still not found, use the original entity type
//   if (!entity) {
//     entity = entityType;
//     console.warn(`⚠️ No mapping found for entity: ${entityType}, using as-is`);
//   }

//   return {
//     apiName: entity,
//     displayName: entityType
//       .replace(/_/g, " ")
//       .replace(/\b\w/g, (l) => l.toUpperCase()),
//     category: getZohoBooksEntityCategory(entity),
//   };
// }

// /**
//  * Categorize Zoho Books entities
//  */
// function getZohoBooksEntityCategory(entity) {
//   const salesEntities = [
//     "invoices", "salesorders", "estimates", "creditnotes",
//     "customerpayments", "recurringinvoices", "retainerinvoices"
//   ];
//   const purchaseEntities = [
//     "bills", "purchaseorders", "vendorpayments", "vendors", "vendorcredits"
//   ];
//   const accountingEntities = [
//     "journals", "banktransactions", "bankaccounts", "chartofaccounts"
//   ];
//   const masterEntities = [
//     "contacts", "customers", "items", "organizations", "taxes", "users"
//   ];
//   const projectEntities = ["projects", "expenses"];

//   if (salesEntities.includes(entity)) return "sales";
//   if (purchaseEntities.includes(entity)) return "purchases";
//   if (accountingEntities.includes(entity)) return "accounting";
//   if (masterEntities.includes(entity)) return "master";
//   if (projectEntities.includes(entity)) return "projects";

//   return "other";
// }

/**
 * Enhanced Zoho Books data availability check this function is also work but this function is not refresh token when access token is expired
 */

// async function checkZohoBooksDataAvailability(settings, entityType) {
//   const { access_token, organization_id, region = "in" } = settings;

//   if (!access_token || !organization_id) {
//     throw new Error("Zoho Books credentials missing. Required: access_token, organization_id");
//   }

//   try {
//     console.log(`🔍 Checking data availability for: ${entityType}`);

//     const entityDetails = getZohoBooksEntityDetails(entityType);
//     const entity = entityDetails.apiName;

//     // Skip problematic endpoints that require special handling
//     const skipEndpoints = ['settings', 'taxgroups', 'basecurrencyadjustments'];
//     if (skipEndpoints.includes(entity)) {
//       console.log(`⏭️ Skipping availability check for ${entity} - requires special parameters`);
//       return true; // Still try to fetch, but handle errors gracefully
//     }

//     const baseURL = `https://www.zohoapis.${region}/books/v3`;
//     const url = `${baseURL}/${entity}?organization_id=${organization_id}&per_page=1`;

//     const response = await fetch(url, {
//       method: "GET",
//       headers: {
//         Authorization: `Zoho-oauthtoken ${access_token}`,
//         Accept: "application/json",
//         "Content-Type": "application/json",
//       },
//     });

//     if (!response.ok) {
//       // Don't throw error for 400 - some entities might not be accessible
//       if (response.status === 400) {
//         console.log(`⚠️ ${entityType} not accessible via simple query: ${response.status}`);
//         return false;
//       }
//       console.log(`⚠️ ${entityType} query failed: ${response.status}`);
//       return false;
//     }

//     const data = await response.json();
//     const entityKey = findEntityKeyInResponse(data, entity);

//     const count = entityKey && data[entityKey] ? data[entityKey].length : 0;
//     console.log(`📊 ${entityType} has data available: ${count > 0}`);

//     return count > 0;
//   } catch (error) {
//     console.error(`❌ Error checking ${entityType}:`, error.message);

//     // For certain errors, still attempt to fetch data
//     if (error.message.includes('400') || error.message.includes('Invalid URL')) {
//       console.log(`⏭️ ${entityType} may require special parameters, will attempt fetch`);
//       return true;
//     }

//     return false;
//   }
// }

// async function checkZohoBooksDataAvailability(settings, entityType) {
//   let { access_token, refresh_token, client_id, client_secret, organization_id, region = "in" } = settings;

//   if (!access_token || !organization_id) {
//     throw new Error("Zoho Books credentials missing. Required: access_token, organization_id");
//   }

//   try {
//     console.log(`🔍 Checking data availability for: ${entityType}`);

//     const entityDetails = getZohoBooksEntityDetails(entityType);
//     const entity = entityDetails.apiName;

//     // Skip problematic endpoints that require special handling
//     const skipEndpoints = ['settings', 'taxgroups', 'basecurrencyadjustments'];
//     if (skipEndpoints.includes(entity)) {
//       console.log(`⏭️ Skipping availability check for ${entity} - requires special parameters`);
//       return true; // Still try to fetch, but handle errors gracefully
//     }

//     const baseURL = `https://www.zohoapis.${region}/books/v3`;
//     const url = `${baseURL}/${entity}?organization_id=${organization_id}&per_page=1`;

//     // First attempt with current access token
//     let response = await fetch(url, {
//       method: "GET",
//       headers: {
//         Authorization: `Zoho-oauthtoken ${access_token}`,
//         Accept: "application/json",
//         "Content-Type": "application/json",
//       },
//     });

//     // If token is expired, try to refresh it
//     if (response.status === 401 && refresh_token && client_id && client_secret) {
//       console.log('🔄 Access token expired, attempting refresh...');

//       try {
//         const newToken = await refreshZohoAccessToken(refresh_token, client_id, client_secret, region);

//         if (newToken && newToken.access_token) {
//           // Update the access token in settings for future calls
//           settings.access_token = newToken.access_token;
//           if (newToken.refresh_token) {
//             settings.refresh_token = newToken.refresh_token;
//           }

//           console.log('✅ Access token refreshed successfully');

//           // Retry the request with new token
//           response = await fetch(url, {
//             method: "GET",
//             headers: {
//               Authorization: `Zoho-oauthtoken ${newToken.access_token}`,
//               Accept: "application/json",
//               "Content-Type": "application/json",
//             },
//           });
//         }
//       } catch (refreshError) {
//         console.error('❌ Failed to refresh access token:', refreshError.message);
//         throw new Error('Authentication failed - unable to refresh access token');
//       }
//     }

//     if (!response.ok) {
//       // Don't throw error for 400 - some entities might not be accessible
//       if (response.status === 400) {
//         console.log(`⚠️ ${entityType} not accessible via simple query: ${response.status}`);
//         return false;
//       }
//       console.log(`⚠️ ${entityType} query failed: ${response.status}`);
//       return false;
//     }

//     const data = await response.json();
//     const entityKey = findEntityKeyInResponse(data, entity);

//     const count = entityKey && data[entityKey] ? data[entityKey].length : 0;
//     console.log(`📊 ${entityType} has data available: ${count > 0}`);

//     return count > 0;
//   } catch (error) {
//     console.error(`❌ Error checking ${entityType}:`, error.message);

//     // For certain errors, still attempt to fetch data
//     if (error.message.includes('400') || error.message.includes('Invalid URL')) {
//       console.log(`⏭️ ${entityType} may require special parameters, will attempt fetch`);
//       return true;
//     }

//     return false;
//   }
// }

// // Helper function to refresh Zoho access token
// async function refreshZohoAccessToken(refresh_token, client_id, client_secret, region = "in") {
//   const tokenURL = `https://accounts.zoho.${region}/oauth/v2/token`;

//   const params = new URLSearchParams({
//     refresh_token: refresh_token,
//     client_id: client_id,
//     client_secret: client_secret,
//     grant_type: 'refresh_token'
//   });

//   const response = await fetch(tokenURL, {
//     method: "POST",
//     headers: {
//       "Content-Type": "application/x-www-form-urlencoded",
//     },
//     body: params
//   });

//   if (!response.ok) {
//     const errorText = await response.text();
//     throw new Error(`Token refresh failed: ${response.status} - ${errorText}`);
//   }

//   const tokenData = await response.json();

//   // Note: Zoho may not always return a new refresh_token
//   // If they don't, you should continue using the existing refresh_token
//   return {
//     access_token: tokenData.access_token,
//     refresh_token: tokenData.refresh_token || refresh_token, // Use new if provided, else keep old
//     expires_in: tokenData.expires_in
//   };
// }

// /**
//  * Read data from Zoho Books API with enhanced entity support
//  */
// async function readZohoBooksData(settings, entityType, activeColumns, limit = 100) {
//   try {
//     console.log(`🔍 DEBUG: Starting Zoho Books data fetch for: ${entityType}`);
//     console.log(`🔍 DEBUG: Active columns:`, activeColumns);

//     const { access_token, organization_id, region = "in" } = settings;

//     if (!access_token || !organization_id) {
//       throw new Error("Zoho Books credentials missing. Required: access_token, organization_id");
//     }

//     // Special debug for bills
//     if (entityType.toLowerCase() === 'bills') {
//       await debugZohoBooksBills(settings);
//     }

//     const entityDetails = getZohoBooksEntityDetails(entityType);
//     const entity = entityDetails.apiName;

//     console.log(`🔍 DEBUG: Entity details:`, entityDetails);

//     const baseURL = `https://www.zohoapis.${region}/books/v3`;
//     let allEntities = [];
//     let page = 1;
//     let hasMore = true;

//     console.log(`🔍 DEBUG: Base URL: ${baseURL}/${entity}`);

//     while (hasMore && page <= 10) { // Safety limit
//       const url = `${baseURL}/${entity}?organization_id=${organization_id}&per_page=${limit}&page=${page}`;

//       console.log(`📥 DEBUG: Fetching page ${page}: ${url}`);

//       const response = await fetch(url, {
//         method: "GET",
//         headers: {
//           Authorization: `Zoho-oauthtoken ${access_token}`,
//           Accept: "application/json",
//           "Content-Type": "application/json",
//         },
//       });

//       console.log(`🔍 DEBUG: Response status: ${response.status}`);

//       if (!response.ok) {
//         const errorText = await response.text();
//         console.error(`❌ DEBUG: API Error ${response.status}:`, errorText);

//         if (response.status === 401) {
//           throw new Error("Zoho Books access token expired. Please reconnect.");
//         } else if (response.status === 429) {
//           throw new Error("Zoho Books API rate limit exceeded. Please try again later.");
//         } else if (response.status === 400) {
//           // Try to get more specific error info
//           try {
//             const errorData = JSON.parse(errorText);
//             console.error(`❌ DEBUG: Zoho Books 400 Error:`, errorData);
//           } catch (e) {
//             console.error(`❌ DEBUG: Zoho Books 400 Error (raw):`, errorText);
//           }

//           if (entity === 'bills') {
//             console.log("🔍 DEBUG: Trying bills with different parameters...");
//             // Try with different parameters
//             const altUrl = `${baseURL}/bills?organization_id=${organization_id}&per_page=${limit}&page=${page}&sort_column=date&sort_order=D`;
//             const altResponse = await fetch(altUrl, {
//               method: "GET",
//               headers: {
//                 Authorization: `Zoho-oauthtoken ${access_token}`,
//                 Accept: "application/json",
//                 "Content-Type": "application/json",
//               },
//             });

//             if (altResponse.ok) {
//               const altData = await altResponse.json();
//               console.log(`✅ DEBUG: Alternative request successful`);
//               const entityKey = findEntityKeyInResponse(altData, entity);
//               if (entityKey && altData[entityKey]) {
//                 const entities = altData[entityKey];
//                 console.log(`✅ DEBUG: Found ${entities.length} bills via alternative request`);

//                 const transformedChunk = transformZohoBooksData(entities, activeColumns, entity);
//                 allEntities = allEntities.concat(transformedChunk);

//                 if (entities.length < limit) hasMore = false;
//                 page++;
//                 await new Promise((resolve) => setTimeout(resolve, 1000));
//                 continue;
//               }
//             }
//           }
//           return []; // Return empty array instead of throwing for 400 errors
//         }

//         throw new Error(`Zoho Books API error: ${response.status} - ${errorText}`);
//       }

//       const data = await response.json();
//       console.log(`🔍 DEBUG: Raw API response keys:`, Object.keys(data));

//       // Enhanced entity key detection
//       const entityKey = findEntityKeyInResponse(data, entity);
//       console.log(`🔍 DEBUG: Detected entity key: ${entityKey}`);

//       if (!entityKey || !data[entityKey]) {
//         console.log(`❌ DEBUG: No data found for entity ${entity}. Available keys:`, Object.keys(data));
//         break;
//       }

//       const entities = data[entityKey];
//       console.log(`✅ DEBUG: Fetched page ${page}: ${entities.length} ${entity} records`);

//       if (entities.length > 0) {
//         console.log(`🔍 DEBUG: First record sample:`, JSON.stringify(entities[0], null, 2));
//       }

//       // Transform Zoho Books data
//       const transformedChunk = transformZohoBooksData(entities, activeColumns, entity);
//       allEntities = allEntities.concat(transformedChunk);

//       console.log(`✅ DEBUG: Transformed ${transformedChunk.length} records`);

//       // Check if we have more pages
//       if (entities.length < limit) {
//         hasMore = false;
//       } else {
//         page++;
//       }

//       // Rate limiting
//       await new Promise((resolve) => setTimeout(resolve, 1000));
//     }

//     console.log(`🎉 DEBUG: Total ${allEntities.length} ${entity} records fetched from Zoho Books`);

//     if (allEntities.length > 0) {
//       console.log(`🔍 DEBUG: First transformed record:`, JSON.stringify(allEntities[0], null, 2));
//     }

//     return allEntities;
//   } catch (error) {
//     console.error("❌ DEBUG: Error reading Zoho Books data:", error.message);
//     console.error("❌ DEBUG: Error stack:", error.stack);
//     throw error;
//   }
// }

/**
 * Enhanced entity key detection in Zoho Books response
 */
// function findEntityKeyInResponse(data, entity) {
//   const possibleKeys = [
//     entity, // Exact match
//     entity + 's', // Plural form
//     entity.slice(0, -1), // Singular form (remove 's')
//     entity.toLowerCase(),
//     entity.toLowerCase() + 's',
//     // Special cases
//     ...getSpecialEntityKeys(entity)
//   ];

//   for (const key of possibleKeys) {
//     if (data[key] && Array.isArray(data[key])) {
//       return key;
//     }
//   }

//   // If no array found, look for any array in the response
//   for (const key in data) {
//     if (Array.isArray(data[key])) {
//       console.log(`🔍 Using alternative key: ${key} for entity ${entity}`);
//       return key;
//     }
//   }

//   return null;
// }

// /**
//  * Handle special entity key mappings
//  */
// function getSpecialEntityKeys(entity) {
//   const specialMappings = {
//     'salesorders': ['salesorders', 'salesorder'],
//     'purchaseorders': ['purchaseorders', 'purchaseorder'],
//     'creditnotes': ['creditnotes', 'creditnote'],
//     'vendorcredits': ['vendorcredits', 'vendorcredit'],
//     'recurringinvoices': ['recurringinvoices', 'recurringinvoice'],
//     'retainerinvoices': ['retainerinvoices', 'retainerinvoice'],
//     'chartofaccounts': ['chartofaccounts', 'chartofaccount'],
//     'banktransactions': ['banktransactions', 'banktransaction']
//   };

//   return specialMappings[entity] || [];
// }
// /**
//  * Helper function to get nested Zoho Books object values
//  */
// function getNestedZohoBooksValue(obj, path) {
//   try {
//     return path.split(".").reduce((current, key) => {
//       if (current && typeof current === "object") {
//         // Handle array indices
//         if (key.includes("[") && key.includes("]")) {
//           const arrayKey = key.split("[")[0];
//           const index = parseInt(key.match(/\[(\d+)\]/)[1]);
//           return current[arrayKey] && current[arrayKey][index] !== undefined
//             ? current[arrayKey][index]
//             : undefined;
//         }
//         // Handle regular nested properties
//         return current[key] !== undefined ? current[key] : undefined;
//       }
//       return undefined;
//     }, obj);
//   } catch (error) {
//     console.warn(`⚠️ Could not access path ${path} in Zoho Books object`);
//     return undefined;
//   }
// }

// /**
//  * Enhanced Zoho Books data cleaner with proper handling
//  */
// function cleanZohoBooksDataForPostgres(rows, activeColumns) {
//   console.log("🧹 Converting Zoho Books data for PostgreSQL...");

//   return rows.map((row, index) => {
//     const cleanedRow = {};

//     activeColumns.forEach((col) => {
//       let value = row[col];

//       // Handle null/undefined/empty strings
//       if (value === null || value === undefined || value === "") {
//         cleanedRow[col] = null;
//         return;
//       }

//       // ✅ Handle Zoho Books specific data types
//       if (typeof value === 'object' && value !== null) {
//         // For Zoho Books objects, stringify them
//         try {
//           // Special handling for common Zoho Books object structures
//           if (value.name !== undefined && value.id !== undefined) {
//             // This is likely a reference object like {name: "Customer", id: "123"}
//             cleanedRow[col] = JSON.stringify(value);
//           } else if (Array.isArray(value)) {
//             // Handle arrays
//             cleanedRow[col] = JSON.stringify(value);
//           } else {
//             // Generic object
//             cleanedRow[col] = JSON.stringify(value);
//           }
//         } catch (error) {
//           console.warn(`⚠️ Could not stringify object for column ${col}:`, value);
//           cleanedRow[col] = String(value);
//         }
//       } else if (typeof value === 'boolean') {
//         // Convert booleans to string for consistency
//         cleanedRow[col] = value ? 'true' : 'false';
//       } else if (typeof value === 'number') {
//         // Keep numbers as numbers for potential numeric operations
//         cleanedRow[col] = value;
//       } else {
//         // String values - ensure they're properly formatted
//         cleanedRow[col] = String(value).trim();
//       }
//     });

//     // Log first few rows for debugging
//     if (index < 2) {
//       console.log(`🔍 Sample cleaned row ${index + 1}:`, JSON.stringify(cleanedRow, null, 2));
//     }

//     return cleanedRow;
//   });
// }

/**
 * Zoho Books-specific: Improved table schema with proper primary key handling
 */
async function ensureZohoBooksTableFromSchema(
  sequelize,
  tableName,
  schemaDetails
) {
  const queryInterface = sequelize.getQueryInterface();

  try {
    // Check if table exists
    const tables = await queryInterface.showAllTables();

    if (tables.includes(tableName)) {
      console.log(
        `🔄 Table ${tableName} already exists - checking schema compatibility`
      );
      await queryInterface.dropTable(tableName);
    }

    console.log(`🆕 Creating Zoho Books table: ${tableName}`);

    // ✅ IMPROVED: Better primary key detection
    const attributes = {};
    let primaryKeys = [];

    schemaDetails?.forEach((col) => {
      if (!col.is_active) return;

      // Everything becomes TEXT for Zoho Books for simplicity
      attributes[col.column_name] = {
        type: DataTypes.TEXT,
        allowNull: true,
      };

      console.log(`📝 ${col.column_name} → TEXT (Zoho Books)`);

      // ✅ FIXED: Better primary key detection logic
      if (
        col.primary_key_column_name &&
        col.primary_key_column_name === col.column_name
      ) {
        // Only add if not already in the array (avoid duplicates)
        if (!primaryKeys.includes(col.column_name)) {
          primaryKeys.push(col.column_name);
          console.log(`🔑 Marking as primary key: ${col.column_name}`);
        }
      }
    });

    console.log(
      `📋 Creating Zoho Books table with ${primaryKeys.length} primary keys`
    );

    // Create table
    await queryInterface.createTable(tableName, attributes);

    // Add primary key constraint only if we have exactly one primary key
    if (primaryKeys.length === 1) {
      console.log(`🔑 Adding primary key constraint: ${primaryKeys[0]}`);
      await sequelize.query(
        `ALTER TABLE ${quoteIdent(tableName)} ADD PRIMARY KEY (${quoteIdent(primaryKeys[0])});`
      );
    } else if (primaryKeys.length > 1) {
      console.warn(
        `⚠️ Multiple primary keys detected (${primaryKeys.length}). Using first one: ${primaryKeys[0]}`
      );
      await sequelize.query(
        `ALTER TABLE ${quoteIdent(tableName)} ADD PRIMARY KEY (${quoteIdent(primaryKeys[0])});`
      );
    } else {
      console.log(`ℹ️ No primary key defined for table ${tableName}`);
    }

    console.log(`✅ Zoho Books table ${tableName} created successfully`);
  } catch (error) {
    console.error(
      `❌ Error ensuring Zoho Books table ${tableName}:`,
      error.message
    );
    throw error;
  }
}

// async function debugZohoBooksBills(settings) {
//   try {
//     const { access_token, organization_id, region = "in" } = settings;
//     const baseURL = `https://www.zohoapis.${region}/books/v3`;
//     const url = `${baseURL}/bills?organization_id=${organization_id}&per_page=5`;

//     console.log("🔍 Debug: Checking Zoho Books bills endpoint:", url);

//     const response = await fetch(url, {
//       method: "GET",
//       headers: {
//         Authorization: `Zoho-oauthtoken ${access_token}`,
//         Accept: "application/json",
//         "Content-Type": "application/json",
//       },
//     });

//     if (!response.ok) {
//       console.error("❌ Zoho Books API error:", response.status, response.statusText);
//       return null;
//     }

//     const data = await response.json();
//     console.log("🔍 Debug: Zoho Books bills response:", JSON.stringify(data, null, 2));

//     return data;
//   } catch (error) {
//     console.error("❌ Debug error:", error.message);
//     return null;
//   }
// }

// function transformZohoBooksData(entities, activeColumns, entityType) {
//   return entities.map((zohoEntity, index) => {
//     const row = {};

//     activeColumns.forEach((column) => {
//       const value = getNestedZohoBooksValue(zohoEntity, column);

//       // Special handling for common Zoho Books fields
//       if (value === undefined || value === null) {
//         row[column] = null;
//       } else if (typeof value === 'object') {
//         // Stringify objects for storage
//         try {
//           row[column] = JSON.stringify(value);
//         } catch (error) {
//           console.warn(`⚠️ Could not stringify object for ${column}:`, value);
//           row[column] = String(value);
//         }
//       } else {
//         row[column] = value;
//       }
//     });

//     // Add metadata
//     row["_zoho_books_entity_type"] = entityType;
//     row["_zoho_books_record_id"] = zohoEntity.bill_id || zohoEntity.bill_number || zohoEntity.id || `record_${index}`;
//     row["_extracted_at"] = new Date().toISOString();

//     return row;
//   });
// }

// Add this debug function to check your schema configuration


async function debugSchemaConfiguration(connection_id, tableName) {
  try {
    const schemaDetails = await SchemaDetail.findAll({
      where: {
        connection_id,
        table_name: tableName,
        is_active: true,
      },
    });

    console.log(
      `🔍 DEBUG: Schema details for ${tableName}:`,
      schemaDetails.map((col) => ({
        column: col.column_name,
        active: col.is_active,
        primary_key: col.primary_key_column_name,
        data_type: col.data_type,
      }))
    );

    return schemaDetails;
  } catch (error) {
    console.error("❌ DEBUG: Error checking schema:", error.message);
    return [];
  }
}

async function testZohoBooksBillsIntegration(settings, connection_id) {
  console.log("🧪 TEST: Starting Zoho Books Bills Integration Test");

  // 1. Check schema
  const schemaDetails = await debugSchemaConfiguration(connection_id, "bills");

  // 2. Check data availability
  const hasData = await checkZohoBooksDataAvailability(settings, "bills");
  console.log(`🧪 TEST: Bills data available: ${hasData}`);

  // 3. Try to read data
  if (hasData) {
    const activeColumns = schemaDetails.map((col) => col.column_name);
    const billsData = await readZohoBooksData(
      settings,
      "bills",
      activeColumns,
      10
    );
    console.log(`🧪 TEST: Retrieved ${billsData.length} bills`);

    if (billsData.length > 0) {
      console.log(
        "🧪 TEST: Sample bill data:",
        JSON.stringify(billsData[0], null, 2)
      );
    }

    return billsData;
  }

  return [];
}

// IN WHICH USING HELPER FUNCTIONS FROM ABOVE TO MAKE ZOHO BOOKS FUNCTIONALITIES WORKING PROPERLY AND THOSE ABOVE FUNCTION IS COMETING ALL FUNCTION WORK PROPERLY */

/**
 * Enhanced Zoho Books data availability check
 */
async function checkZohoBooksDataAvailability(settings, entityType) {
  let {
    access_token,
    refresh_token,
    client_id,
    client_secret,
    organization_id,
    region = "in",
  } = settings;

  if (!access_token || !organization_id) {
    throw new Error(
      "Zoho Books credentials missing. Required: access_token, organization_id"
    );
  }

  try {
    console.log(`🔍 Checking data availability for: ${entityType}`);

    const entityDetails = getZohoBooksEntityDetails(entityType);
    const entity = entityDetails.apiName;

    // Skip problematic endpoints that require special handling
    const skipEndpoints = ["settings", "taxgroups", "basecurrencyadjustments"];
    if (skipEndpoints.includes(entity)) {
      console.log(
        `⏭️ Skipping availability check for ${entity} - requires special parameters`
      );
      return true; // Still try to fetch, but handle errors gracefully
    }

    const baseURL = `https://www.zohoapis.${region}/books/v3`;
    const url = `${baseURL}/${entity}?organization_id=${organization_id}&per_page=1`;

    // First attempt with current access token
    let response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Zoho-oauthtoken ${access_token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });

    // If token is expired, try to refresh it
    if (
      response.status === 401 &&
      refresh_token &&
      client_id &&
      client_secret
    ) {
      console.log("🔄 Access token expired, attempting refresh...");

      try {
        const newToken = await refreshZohoAccessToken(
          refresh_token,
          client_id,
          client_secret,
          region
        );

        if (newToken && newToken.access_token) {
          // Update the access token in settings for future calls
          settings.access_token = newToken.access_token;
          if (newToken.refresh_token) {
            settings.refresh_token = newToken.refresh_token;
          }

          console.log("✅ Access token refreshed successfully");

          // Retry the request with new token
          response = await fetch(url, {
            method: "GET",
            headers: {
              Authorization: `Zoho-oauthtoken ${newToken.access_token}`,
              Accept: "application/json",
              "Content-Type": "application/json",
            },
          });
        }
      } catch (refreshError) {
        console.error(
          "❌ Failed to refresh access token:",
          refreshError.message
        );
        throw new Error(
          "Authentication failed - unable to refresh access token"
        );
      }
    }

    if (!response.ok) {
      // Don't throw error for 400 - some entities might not be accessible
      if (response.status === 400) {
        console.log(
          `⚠️ ${entityType} not accessible via simple query: ${response.status}`
        );
        return false;
      }
      console.log(`⚠️ ${entityType} query failed: ${response.status}`);
      return false;
    }

    const data = await response.json();
    const entityKey = findEntityKeyInResponse(data, entity);

    const count = entityKey && data[entityKey] ? data[entityKey].length : 0;
    console.log(`📊 ${entityType} has data available: ${count > 0}`);

    return count > 0;
  } catch (error) {
    console.error(`❌ Error checking ${entityType}:`, error.message);

    // For certain errors, still attempt to fetch data
    if (
      error.message.includes("400") ||
      error.message.includes("Invalid URL")
    ) {
      console.log(
        `⏭️ ${entityType} may require special parameters, will attempt fetch`
      );
      return true;
    }

    return false;
  }
}

/**
 * Read data from Zoho Books API with enhanced entity support
 */
async function readZohoBooksData(
  settings,
  entityType,
  activeColumns,
  limit = 100
) {
  try {
    console.log(`🔍 DEBUG: Starting Zoho Books data fetch for: ${entityType}`);
    console.log(`🔍 DEBUG: Active columns:`, activeColumns);

    const { access_token, organization_id, region = "in" } = settings;

    if (!access_token || !organization_id) {
      throw new Error(
        "Zoho Books credentials missing. Required: access_token, organization_id"
      );
    }

    // Special debug for bills
    if (entityType.toLowerCase() === "bills") {
      await debugZohoBooksBills(settings);
    }

    const entityDetails = getZohoBooksEntityDetails(entityType);
    const entity = entityDetails.apiName;

    console.log(`🔍 DEBUG: Entity details:`, entityDetails);

    const baseURL = `https://www.zohoapis.${region}/books/v3`;
    let allEntities = [];
    let page = 1;
    let hasMore = true;

    console.log(`🔍 DEBUG: Base URL: ${baseURL}/${entity}`);

    while (hasMore && page <= 10) {
      // Safety limit
      const url = `${baseURL}/${entity}?organization_id=${organization_id}&per_page=${limit}&page=${page}`;

      console.log(`📥 DEBUG: Fetching page ${page}: ${url}`);

      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Zoho-oauthtoken ${access_token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      });

      console.log(`🔍 DEBUG: Response status: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ DEBUG: API Error ${response.status}:`, errorText);

        if (response.status === 401) {
          throw new Error("Zoho Books access token expired. Please reconnect.");
        } else if (response.status === 429) {
          throw new Error(
            "Zoho Books API rate limit exceeded. Please try again later."
          );
        } else if (response.status === 400) {
          // Try to get more specific error info
          try {
            const errorData = JSON.parse(errorText);
            console.error(`❌ DEBUG: Zoho Books 400 Error:`, errorData);
          } catch (e) {
            console.error(`❌ DEBUG: Zoho Books 400 Error (raw):`, errorText);
          }

          if (entity === "bills") {
            console.log("🔍 DEBUG: Trying bills with different parameters...");
            // Try with different parameters
            const altUrl = `${baseURL}/bills?organization_id=${organization_id}&per_page=${limit}&page=${page}&sort_column=date&sort_order=D`;
            const altResponse = await fetch(altUrl, {
              method: "GET",
              headers: {
                Authorization: `Zoho-oauthtoken ${access_token}`,
                Accept: "application/json",
                "Content-Type": "application/json",
              },
            });

            if (altResponse.ok) {
              const altData = await altResponse.json();
              console.log(`✅ DEBUG: Alternative request successful`);
              const entityKey = findEntityKeyInResponse(altData, entity);
              if (entityKey && altData[entityKey]) {
                const entities = altData[entityKey];
                console.log(
                  `✅ DEBUG: Found ${entities.length} bills via alternative request`
                );

                const transformedChunk = transformZohoBooksData(
                  entities,
                  activeColumns,
                  entity
                );
                allEntities = allEntities.concat(transformedChunk);

                if (entities.length < limit) hasMore = false;
                page++;
                await new Promise((resolve) => setTimeout(resolve, 1000));
                continue;
              }
            }
          }
          return []; // Return empty array instead of throwing for 400 errors
        }

        throw new Error(
          `Zoho Books API error: ${response.status} - ${errorText}`
        );
      }

      const data = await response.json();
      console.log(`🔍 DEBUG: Raw API response keys:`, Object.keys(data));

      // Enhanced entity key detection
      const entityKey = findEntityKeyInResponse(data, entity);
      console.log(`🔍 DEBUG: Detected entity key: ${entityKey}`);

      if (!entityKey || !data[entityKey]) {
        console.log(
          `❌ DEBUG: No data found for entity ${entity}. Available keys:`,
          Object.keys(data)
        );
        break;
      }

      const entities = data[entityKey];
      console.log(
        `✅ DEBUG: Fetched page ${page}: ${entities.length} ${entity} records`
      );

      if (entities.length > 0) {
        console.log(
          `🔍 DEBUG: First record sample:`,
          JSON.stringify(entities[0], null, 2)
        );
      }

      // Transform Zoho Books data
      const transformedChunk = transformZohoBooksData(
        entities,
        activeColumns,
        entity
      );
      allEntities = allEntities.concat(transformedChunk);

      console.log(`✅ DEBUG: Transformed ${transformedChunk.length} records`);

      // Check if we have more pages
      if (entities.length < limit) {
        hasMore = false;
      } else {
        page++;
      }

      // Rate limiting
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    console.log(
      `🎉 DEBUG: Total ${allEntities.length} ${entity} records fetched from Zoho Books`
    );

    if (allEntities.length > 0) {
      console.log(
        `🔍 DEBUG: First transformed record:`,
        JSON.stringify(allEntities[0], null, 2)
      );
    }

    return allEntities;
  } catch (error) {
    console.error("❌ DEBUG: Error reading Zoho Books data:", error.message);
    console.error("❌ DEBUG: Error stack:", error.stack);
    throw error;
  }
}

/* ============================================================================================================================================ */
/*                                                 ZOHO BOOK FUNCTION END                   */
/* ============================================================================================================================================*/
