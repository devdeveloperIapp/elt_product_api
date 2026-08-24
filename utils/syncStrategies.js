// ✅ FILE: syncStrategies.js (NEW FILE)

/**
 * Airbyte-style Incremental | Append + Deduped implementation
 */
async function executeAirbyteStyleIncrementalDeduped(params, transaction) {
  const {
    sequelize,
    tableName,
    activeColumns,
    rows,
    primaryKeyColumns,
    cursorField = 'last_modified_time'
  } = params;

  console.log(`🔄 Airbyte-style Incremental + Deduped for ${tableName}`);
  console.log(`   Primary Keys: ${primaryKeyColumns.join(', ')}`);
  console.log(`   Cursor Field: ${cursorField}`);
  console.log(`   Rows to process: ${rows.length}`);

  // Step 1: Create staging table
  const stagingTable = `${tableName}_staging_${Date.now()}`;
  await createStagingTable(sequelize, stagingTable, activeColumns, transaction);

  // Step 2: Insert all data into staging (including duplicates)
  await bulkInsert(sequelize, stagingTable, activeColumns, rows, 1000, transaction);

  // Step 3: Airbyte-style deduplication and merge
  let result;
  if (primaryKeyColumns.length > 0) {
    result = await mergeWithAirbyteDeduplication(
      sequelize,
      tableName,
      stagingTable,
      activeColumns,
      primaryKeyColumns,
      cursorField,
      transaction
    );
  } else {
    // Fallback: Simple append if no primary key
    console.warn(`⚠️ No primary key for deduplication, using simple append`);
    await bulkInsert(sequelize, tableName, activeColumns, rows, 1000, transaction);
    result = {
      rowsProcessed: rows.length,
      rowsDeleted: 0,
      rowsInserted: rows.length,
      duplicatesResolved: 0
    };
  }

  // Step 4: Cleanup staging table
  await dropStagingTable(sequelize, stagingTable, transaction);

  return {
    strategy: "airbyte_incremental_deduped",
    message: `Airbyte-style sync completed: ${result.rowsDeleted} deleted, ${result.rowsInserted} inserted, ${result.duplicatesResolved} duplicates resolved`,
    rowsProcessed: rows.length,
    ...result
  };
}

/**
 * Create staging table with same structure as target
 */
// async function createStagingTable(sequelize, tableName, columns, transaction) {
//   // Create a simple staging table with the same columns
//   const columnDefs = columns.map(col => `"${col}" TEXT`).join(', ');
  
//   const createQuery = `
//     CREATE TEMPORARY TABLE "${tableName}" (
//       ${columnDefs},
//       "_airbyte_extracted_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
//     ) ON COMMIT DROP
//   `;

//   await sequelize.query(createQuery, { transaction });
//   console.log(`📁 Created staging table: ${tableName}`);
// }

/**
 * Airbyte-style merge with proper deduplication
 */
async function mergeWithAirbyteDeduplication(
  sequelize,
  targetTable,
  stagingTable,
  columns,
  primaryKeyColumns,
  cursorField,
  transaction
) {
  const columnList = columns.map(col => `"${col}"`).join(', ');
  const pkList = primaryKeyColumns.map(pk => `"${pk}"`).join(', ');

  // Step 1: Identify and count duplicates in staging
  const duplicateStats = await sequelize.query(`
    SELECT COUNT(*) as total_rows,
           COUNT(DISTINCT (${pkList})) as unique_rows
    FROM "${stagingTable}"
  `, { transaction, type: sequelize.QueryTypes.SELECT });

  const totalRows = parseInt(duplicateStats[0].total_rows);
  const uniqueRows = parseInt(duplicateStats[0].unique_rows);
  const duplicatesResolved = totalRows - uniqueRows;

  console.log(`🔍 Deduplication stats: ${totalRows} total, ${uniqueRows} unique, ${duplicatesResolved} duplicates`);

  // Step 2: Delete existing records that match staging records
  const pkConditions = primaryKeyColumns.map(pk => `target."${pk}" = source."${pk}"`).join(' AND ');
  
  const deleteQuery = `
    DELETE FROM "${targetTable}" target
    WHERE EXISTS (
      SELECT 1 FROM "${stagingTable}" source
      WHERE ${pkConditions}
    )
  `;

  const deleteResult = await sequelize.query(deleteQuery, { transaction });
  const rowsDeleted = deleteResult[1]?.rowCount || 0;

  console.log(`🗑️  Deleted ${rowsDeleted} existing records from target table`);

  // Step 3: Insert deduplicated records using Airbyte's DISTINCT ON approach
  const orderByFields = [
    ...primaryKeyColumns.map(pk => `source."${pk}"`),
    `source."${cursorField}" DESC NULLS LAST`,
    `source."_airbyte_extracted_at" DESC`
  ].join(', ');

  const insertQuery = `
    INSERT INTO "${targetTable}" (${columnList})
    SELECT DISTINCT ON (${pkList}) 
      ${columns.map(col => `source."${col}"`).join(', ')}
    FROM "${stagingTable}" source
    ORDER BY ${orderByFields}
  `;

  const insertResult = await sequelize.query(insertQuery, { transaction });
  const rowsInserted = insertResult[1]?.rowCount || 0;

  console.log(`📥 Inserted ${rowsInserted} deduplicated records into target table`);

  return {
    rowsDeleted,
    rowsInserted,
    duplicatesResolved,
    totalProcessed: totalRows
  };
}

/**
 * Drop staging table
 */
async function dropStagingTable(sequelize, tableName, transaction) {
  // Using TEMPORARY table with ON COMMIT DROP, so this is just a safety check
  try {
    await sequelize.query(`DROP TABLE IF EXISTS "${tableName}"`, { transaction });
    console.log(`🧹 Cleaned up staging table: ${tableName}`);
  } catch (error) {
    // Table might already be automatically dropped due to TEMPORARY + ON COMMIT DROP
    console.log(`🔧 Staging table ${tableName} already cleaned up`);
  }
}

/**
 * Enhanced bulk insert for staging tables
 */
// async function bulkInsert(sequelize, tableName, columns, rows, batchSize = 1000, transaction) {
//   if (!rows || rows.length === 0) {
//     console.log(`ℹ️  No rows to insert into ${tableName}`);
//     return 0;
//   }

//   console.log(`📦 Inserting ${rows.length} rows into ${tableName} in batches of ${batchSize}`);

//   const columnList = columns.map(col => `"${col}"`).join(', ');
//   let totalInserted = 0;

//   for (let i = 0; i < rows.length; i += batchSize) {
//     const batch = rows.slice(i, i + batchSize);
//     const placeholders = [];
//     const values = [];

//     batch.forEach((row, batchIndex) => {
//       const rowPlaceholders = columns.map((col, colIndex) => {
//         const value = row[col];
//         const paramIndex = batchIndex * columns.length + colIndex + 1;
        
//         if (value === null || value === undefined) {
//           return 'NULL';
//         } else if (typeof value === 'number') {
//           return `$${paramIndex}`;
//         } else if (typeof value === 'boolean') {
//           return value ? 'TRUE' : 'FALSE';
//         } else {
//           return `$${paramIndex}`;
//         }
//       });

//       placeholders.push(`(${rowPlaceholders.join(', ')})`);
      
//       columns.forEach(col => {
//         let value = row[col];
        
//         // Convert objects to JSON strings
//         if (typeof value === 'object' && value !== null) {
//           try {
//             value = JSON.stringify(value);
//           } catch (error) {
//             value = String(value);
//           }
//         }
        
//         values.push(value);
//       });
//     });

//     const insertQuery = `
//       INSERT INTO "${tableName}" (${columnList})
//       VALUES ${placeholders.join(', ')}
//     `;

//     try {
//       await sequelize.query(insertQuery, {
//         bind: values,
//         transaction,
//         type: sequelize.QueryTypes.INSERT
//       });
      
//       totalInserted += batch.length;
//       console.log(`✅ Batch ${Math.floor(i/batchSize) + 1}: Inserted ${batch.length} rows`);
//     } catch (error) {
//       console.error(`❌ Failed to insert batch into ${tableName}:`, error.message);
//       throw error;
//     }
//   }

//   console.log(`🎉 Successfully inserted ${totalInserted} total rows into ${tableName}`);
//   return totalInserted;
// }


async function bulkInsert(sequelize, tableName, columns, rows, batchSize = 1000, transaction) {
  if (!rows || rows.length === 0) {
    console.log(`ℹ️  No rows to insert into ${tableName}`);
    return 0;
  }

  console.log(`📦 Inserting ${rows.length} rows into ${tableName} in batches of ${batchSize}`);

  const columnList = columns.map(col => `"${col}"`).join(', ');
  let totalInserted = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    
    try {
      // Use Sequelize's built-in bulkCreate instead of raw query
      const recordsToInsert = batch.map(row => {
        const record = {};
        columns.forEach(col => {
          let value = row[col];
          
          // Handle different data types properly
          if (value === null || value === undefined) {
            record[col] = null;
          } else if (typeof value === 'object') {
            // Stringify objects and arrays
            try {
              record[col] = JSON.stringify(value);
            } catch (error) {
              record[col] = String(value);
            }
          } else if (typeof value === 'boolean') {
            record[col] = value;
          } else if (typeof value === 'number') {
            record[col] = value;
          } else {
            record[col] = String(value);
          }
        });
        return record;
      });

      // Use Sequelize model for bulk insert (better type handling)
      const Model = getTemporaryModel(sequelize, tableName, columns);
      await Model.bulkCreate(recordsToInsert, { transaction });
      
      totalInserted += batch.length;
      console.log(`✅ Batch ${Math.floor(i/batchSize) + 1}: Inserted ${batch.length} rows`);
      
    } catch (error) {
      console.error(`❌ Failed to insert batch into ${tableName}:`, error.message);
      console.error(`🔍 Error details:`, error);
      throw error;
    }
  }

  console.log(`🎉 Successfully inserted ${totalInserted} total rows into ${tableName}`);
  return totalInserted;
}

/**
 * Create temporary Sequelize model for staging table
 */
function getTemporaryModel(sequelize, tableName, columns) {
  const attributes = {};
  
  columns.forEach(col => {
    attributes[col] = {
      type: sequelize.Sequelize.TEXT, // Use TEXT for flexibility
      allowNull: true
    };
  });
  
  attributes['_airbyte_extracted_at'] = {
    type: sequelize.Sequelize.DATE,
    allowNull: true
  };

  return sequelize.define(tableName, attributes, {
    tableName: tableName,
    timestamps: false,
    freezeTableName: true
  });
}

// ✅ FILE: syncStrategies.js - createStagingTable function KO REPLACE KARO

/**
 * Create staging table with proper data types
 */
async function createStagingTable(sequelize, tableName, columns, transaction) {
  // Use TEXT for all columns to avoid data type issues
  const columnDefs = columns.map(col => `"${col}" TEXT`).join(', ');
  
  const createQuery = `
    CREATE TEMPORARY TABLE "${tableName}" (
      ${columnDefs},
      "_airbyte_extracted_at" TIMESTAMPTZ DEFAULT NOW()
    ) ON COMMIT DROP
  `;

  try {
    await sequelize.query(createQuery, { transaction });
    console.log(`📁 Created staging table: ${tableName}`);
  } catch (error) {
    console.error(`❌ Failed to create staging table ${tableName}:`, error.message);
    throw error;
  }
}
module.exports = {
  executeAirbyteStyleIncrementalDeduped,
  createStagingTable,
  mergeWithAirbyteDeduplication,
  dropStagingTable,
  bulkInsert
};