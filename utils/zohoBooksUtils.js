// Zoho Books API Utility Functions

/**
 * Zoho Books Entity Map for ETL
 */
function getZohoBooksEntityMap() {
  return {
    // Core entities (matching your Airbyte schema)
    bank_accounts: "bankaccounts",
    bills: "bills",
    contacts: "contacts",
    credit_notes: "creditnotes",
    customer_payments: "customerpayments",
    estimates: "estimates",
    expenses: "expenses",
    invoices: "invoices",
    items: "items",
    journals: "journals",
    organizations: "organizations",
    purchase_orders: "purchaseorders",
    sales_orders: "salesorders",
    taxes: "taxes",
    transactions: "banktransactions",
    vendors: "vendors",
    vendor_payments: "vendorpayments",

    // ✅ NEW: Additional entities from your list
    customers: "customers",
    chart_of_accounts: "chartofaccounts",
    projects: "projects",
    vendor_credits: "vendorcredits",
    recurring_invoices: "recurringinvoices",
    retainer_invoices: "retainerinvoices",
    users: "users",

    // ✅ ALIASES for consistency
    bank_transactions: "banktransactions",
    creditnotes: "creditnotes",
    salesorders: "salesorders",
    purchaseorders: "purchaseorders",
    vendorcredits: "vendorcredits",
    recurringinvoices: "recurringinvoices",
    retainerinvoices: "retainerinvoices",
    chartofaccounts: "chartofaccounts",
  };
}

/**
 * Get Zoho Books entity details
 */
function getZohoBooksEntityDetails(entityType) {
  const entityMap = getZohoBooksEntityMap();

  // Try exact match first
  let entity = entityMap[entityType];

  // If not found, try case-insensitive match
  if (!entity) {
    const lowerEntityType = entityType.toLowerCase();
    entity = entityMap[lowerEntityType];
  }

  // If still not found, use the original entity type
  if (!entity) {
    entity = entityType;
    console.warn(`⚠️ No mapping found for entity: ${entityType}, using as-is`);
  }

  return {
    apiName: entity,
    displayName: entityType
      .replace(/_/g, " ")
      .replace(/\b\w/g, (l) => l.toUpperCase()),
    category: getZohoBooksEntityCategory(entity),
  };
}

/**
 * Categorize Zoho Books entities
 */
function getZohoBooksEntityCategory(entity) {
  const salesEntities = [
    "invoices",
    "salesorders",
    "estimates",
    "creditnotes",
    "customerpayments",
    "recurringinvoices",
    "retainerinvoices",
  ];
  const purchaseEntities = [
    "bills",
    "purchaseorders",
    "vendorpayments",
    "vendors",
    "vendorcredits",
  ];
  const accountingEntities = [
    "journals",
    "banktransactions",
    "bankaccounts",
    "chartofaccounts",
  ];
  const masterEntities = [
    "contacts",
    "customers",
    "items",
    "organizations",
    "taxes",
    "users",
  ];
  const projectEntities = ["projects", "expenses"];

  if (salesEntities.includes(entity)) return "sales";
  if (purchaseEntities.includes(entity)) return "purchases";
  if (accountingEntities.includes(entity)) return "accounting";
  if (masterEntities.includes(entity)) return "master";
  if (projectEntities.includes(entity)) return "projects";

  return "other";
}

/**
 * Helper function to refresh Zoho access token
 */
async function refreshZohoAccessToken(
  refresh_token,
  client_id,
  client_secret,
  region = "in"
) {
  const tokenURL = `https://accounts.zoho.${region}/oauth/v2/token`;

  const params = new URLSearchParams({
    refresh_token: refresh_token,
    client_id: client_id,
    client_secret: client_secret,
    grant_type: "refresh_token",
  });

  const response = await fetch(tokenURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed: ${response.status} - ${errorText}`);
  }

  const tokenData = await response.json();

  // Note: Zoho may not always return a new refresh_token
  // If they don't, you should continue using the existing refresh_token
  return {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token || refresh_token, // Use new if provided, else keep old
    expires_in: tokenData.expires_in,
  };
}

/**
 * Enhanced entity key detection in Zoho Books response
 */
function findEntityKeyInResponse(data, entity) {
  const possibleKeys = [
    entity, // Exact match
    entity + "s", // Plural form
    entity.slice(0, -1), // Singular form (remove 's')
    entity.toLowerCase(),
    entity.toLowerCase() + "s",
    // Special cases
    ...getSpecialEntityKeys(entity),
  ];

  for (const key of possibleKeys) {
    if (data[key] && Array.isArray(data[key])) {
      return key;
    }
  }

  // If no array found, look for any array in the response
  for (const key in data) {
    if (Array.isArray(data[key])) {
      console.log(`🔍 Using alternative key: ${key} for entity ${entity}`);
      return key;
    }
  }

  return null;
}

/**
 * Handle special entity key mappings
 */
function getSpecialEntityKeys(entity) {
  const specialMappings = {
    salesorders: ["salesorders", "salesorder"],
    purchaseorders: ["purchaseorders", "purchaseorder"],
    creditnotes: ["creditnotes", "creditnote"],
    vendorcredits: ["vendorcredits", "vendorcredit"],
    recurringinvoices: ["recurringinvoices", "recurringinvoice"],
    retainerinvoices: ["retainerinvoices", "retainerinvoice"],
    chartofaccounts: ["chartofaccounts", "chartofaccount"],
    banktransactions: ["banktransactions", "banktransaction"],
  };

  return specialMappings[entity] || [];
}

/**
 * Helper function to get nested Zoho Books object values
 */
function getNestedZohoBooksValue(obj, path) {
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
    console.warn(`⚠️ Could not access path ${path} in Zoho Books object`);
    return undefined;
  }
}

/**
 * Transform Zoho Books data for database storage
 */
function transformZohoBooksData(entities, activeColumns, entityType) {
  return entities.map((zohoEntity, index) => {
    const row = {};

    activeColumns.forEach((column) => {
      const value = getNestedZohoBooksValue(zohoEntity, column);

      // Special handling for common Zoho Books fields
      if (value === undefined || value === null) {
        row[column] = null;
      } else if (typeof value === "object") {
        // Stringify objects for storage
        try {
          row[column] = JSON.stringify(value);
        } catch (error) {
          console.warn(`⚠️ Could not stringify object for ${column}:`, value);
          row[column] = String(value);
        }
      } else {
        row[column] = value;
      }
    });

    // Add metadata
    row["_zoho_books_entity_type"] = entityType;
    row["_zoho_books_record_id"] =
      zohoEntity.bill_id ||
      zohoEntity.bill_number ||
      zohoEntity.id ||
      `record_${index}`;
    row["_extracted_at"] = new Date().toISOString();

    return row;
  });
}

/**
 * Debug function for Zoho Books bills
 */
async function debugZohoBooksBills(settings) {
  try {
    const { access_token, organization_id, region = "in" } = settings;
    const baseURL = `https://www.zohoapis.${region}/books/v3`;
    const url = `${baseURL}/bills?organization_id=${organization_id}&per_page=5`;

    console.log("🔍 Debug: Checking Zoho Books bills endpoint:", url);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Zoho-oauthtoken ${access_token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.error(
        "❌ Zoho Books API error:",
        response.status,
        response.statusText
      );
      return null;
    }

    const data = await response.json();
    console.log(
      "🔍 Debug: Zoho Books bills response:",
      JSON.stringify(data, null, 2)
    );

    return data;
  } catch (error) {
    console.error("❌ Debug error:", error.message);
    return null;
  }
}
/**
 * Enhanced Zoho Books data cleaner with primary key handling
 */
function cleanZohoBooksDataForPostgres(
  rows,
  activeColumns,
  primaryKeyColumn = null
) {
  console.log("🧹 Converting Zoho Books data for PostgreSQL...");

  return rows.map((row, index) => {
    const cleanedRow = {};

    activeColumns.forEach((col) => {
      let value = row[col];

      // Handle null/undefined/empty strings
      if (value === null || value === undefined || value === "") {
        cleanedRow[col] = null;
        return;
      }

      // ✅ Handle Zoho Books specific data types
      if (typeof value === "object" && value !== null) {
        // For Zoho Books objects, stringify them
        try {
          // Special handling for common Zoho Books object structures
          if (value.name !== undefined && value.id !== undefined) {
            // This is likely a reference object like {name: "Customer", id: "123"}
            cleanedRow[col] = JSON.stringify(value);
          } else if (Array.isArray(value)) {
            // Handle arrays
            cleanedRow[col] = JSON.stringify(value);
          } else {
            // Generic object
            cleanedRow[col] = JSON.stringify(value);
          }
        } catch (error) {
          console.warn(
            `⚠️ Could not stringify object for column ${col}:`,
            value
          );
          cleanedRow[col] = String(value);
        }
      } else if (typeof value === "boolean") {
        // Convert booleans to string for consistency
        cleanedRow[col] = value ? "true" : "false";
      } else if (typeof value === "number") {
        // Keep numbers as numbers for potential numeric operations
        cleanedRow[col] = value;
      } else {
        // String values - ensure they're properly formatted
        cleanedRow[col] = String(value).trim();
      }
    });

    // Handle empty primary key - generate random NUMBER (4-5 digits) instead of null
    if (
      primaryKeyColumn &&
      (!cleanedRow[primaryKeyColumn] ||
        cleanedRow[primaryKeyColumn] === null ||
        cleanedRow[primaryKeyColumn] === "")
    ) {
      const randomId = generateRandomPrimaryKey();
      console.log(
        `🔑 Generated random primary key for row ${index}: ${randomId}`
      );
      cleanedRow[primaryKeyColumn] = randomId;
    }

    // Log first few rows for debugging
    if (index < 2) {
      console.log(
        `🔍 Sample cleaned row ${index + 1}:`,
        JSON.stringify(cleanedRow, null, 2)
      );
    }

    return cleanedRow;
  });
}


/**
 * Airbyte-style cursor field configuration
 */
function getCursorFieldForTable(tableName) {
  const cursorFieldMap = {
    // Zoho Books specific cursor fields
    bank_transactions: 'last_modified_date',
    bankaccounts: 'last_modified_date',
    bills: 'last_modified_time',
    contacts: 'updated_time',
    credit_notes: 'last_modified_time',
    creditnotes: 'last_modified_time',
    customer_payments: 'last_modified_time',
    estimates: 'last_modified_time',
    expenses: 'last_modified_time',
    invoices: 'last_modified_time',
    items: 'last_modified_time',
    journals: 'last_modified_time',
    organizations: 'updated_time',
    purchase_orders: 'last_modified_time',
    purchaseorders: 'last_modified_time',
    sales_orders: 'last_modified_time',
    salesorders: 'last_modified_time',
    taxes: 'updated_time',
    transactions: 'last_modified_date',
    vendors: 'updated_time',
    vendor_payments: 'last_modified_time',
    
    // Additional entities
    customers: 'updated_time',
    chart_of_accounts: 'last_modified_time',
    chartofaccounts: 'last_modified_time',
    projects: 'last_modified_time',
    vendor_credits: 'last_modified_time',
    vendorcredits: 'last_modified_time',
    recurring_invoices: 'last_modified_time',
    recurringinvoices: 'last_modified_time',
    retainer_invoices: 'last_modified_time',
    retainerinvoices: 'last_modified_time',
    users: 'updated_time'
  };

  const cursorField = cursorFieldMap[tableName] || 'updated_at';
  console.log(`⏰ Using cursor field '${cursorField}' for table '${tableName}'`);
  
  return cursorField;
}



module.exports = {
  getZohoBooksEntityMap,
  getZohoBooksEntityDetails,
  getZohoBooksEntityCategory,
  refreshZohoAccessToken,
  findEntityKeyInResponse,
  getSpecialEntityKeys,
  getNestedZohoBooksValue,
  transformZohoBooksData,
  debugZohoBooksBills,
  cleanZohoBooksDataForPostgres,
   getCursorFieldForTable
  
};
