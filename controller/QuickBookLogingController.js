// controllers/QuickBookLogingController.js (updated version)


const Source = require("../model/sourceModel");
const axios = require("axios");
// Import new models
const {
  Company,
  QuickBooksConnection,
  QuickBooksData,
  FinancialReport,
  DashboardConfig,
  ChartConfig,
  ScheduledReport,
  User,
  UserQbCompany,
} = require("../model/index");
// At the top of QuickBookLogingController.js, add warehouse model imports
// const RawTransaction     = require('../model/warehouse/RawTransaction');
// const RawChartOfAccounts = require('../model/warehouse/RawChartOfAccounts');
const FactTransaction    = require('../model/warehouse/FactTransaction');
const DimAccount         = require('../model/warehouse/DimAccount');
const DimCustomer        = require('../model/warehouse/DimCustomer');
const getFinancialReportModel = require('../model/warehouse/FinancialReportModel');
// ✅ v2 dual-write target (Step 1 of legacy->v2 migration — see V2FinancialReportModel.js)
const getV2FinancialReportModel = require('../model/warehouse/V2FinancialReportModel');
// ✅ YE ADD KARO — triggerQuickBooksSync se PEHLE
const getRawEntityModel = require('../model/warehouse/RawEntityModel');
// ✅ NEW v2 warehouse pipeline (per-source schemas in elt_warehouse_v2)
const { insertRawData, transformToDomain } = require('../services/warehouse');
const {
  buildQuickBooksSyncProgress,
  emitQuickBooksSyncProgress,
} = require("../utils/quickbooksSyncProgress");

// QuickBookLogingController.js mein replace karo
const { isTokenExpired, refreshQuickBooksToken, refreshSourceQuickBooksToken } = require('../utils/tokenHelper');

// Ab duplicate functions hata sakte ho controller se
/* ====================================================================== */
/*                      COMPANY MANAGEMENT FUNCTIONS                       */
/* ====================================================================== */

// Create a new company
exports.createCompany = async (req, res) => {
  try {
    const { name, domain, subscription_plan, currency, timezone } = req.body;

    const company = await Company.create({
      name,
      domain,
      subscription_plan: subscription_plan || 'basic',
      subscription_status: 'trial',
      subscription_expiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days trial
      currency: currency || 'USD',
      timezone: timezone || 'UTC',
      fiscal_year_start: new Date(new Date().getFullYear(), 0, 1) // Jan 1st of current year
    });

    // Create default dashboard config for the company
    await DashboardConfig.create({
      company_id: company.id,
      config_name: 'Default Dashboard',
      layout: {
        widgets: [
          { id: 'revenue', position: { x: 0, y: 0, w: 6, h: 2 } },
          { id: 'expenses', position: { x: 6, y: 0, w: 6, h: 2 } },
          { id: 'profitLoss', position: { x: 0, y: 2, w: 8, h: 4 } },
          { id: 'expensesChart', position: { x: 8, y: 2, w: 4, h: 4 } }
        ]
      },
      widgets: {
        revenue: { type: 'metric', title: 'Revenue', dataSource: 'revenue' },
        expenses: { type: 'metric', title: 'Expenses', dataSource: 'expenses' },
        profitLoss: { type: 'chart', title: 'Profit & Loss', chartType: 'line', dataSource: 'profit_loss' },
        expensesChart: { type: 'chart', title: 'Expenses by Category', chartType: 'pie', dataSource: 'expenses_by_category' }
      },
      is_default: true
    });

    res.status(201).json({
      success: true,
      message: 'Company created successfully',
      data: company
    });
  } catch (error) {
    console.error('Error creating company:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get all companies
exports.getAllCompanies = async (req, res) => {
  try {
    const companies = await Company.findAll({
      include: [
        {
          model: QuickBooksConnection,
          attributes: ['realm_id', 'sync_status', 'last_sync_at']
        }
      ]
    });

    res.json({
      success: true,
      data: companies
    });
  } catch (error) {
    console.error('Error fetching companies:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get company by ID
exports.getCompanyById = async (req, res) => {
  try {
    const { companyId } = req.params;

    const company = await Company.findByPk(companyId, {
      include: [
        {
          model: QuickBooksConnection,
          attributes: ['realm_id', 'sync_status', 'last_sync_at', 'access_token', 'refresh_token', 'expires_in']
        },
        {
          model: DashboardConfig,
          where: { is_default: true },
          required: false
        }
      ]
    });

    if (!company) {
      return res.status(404).json({ success: false, message: 'Company not found' });
    }

    res.json({
      success: true,
      data: company
    });
  } catch (error) {
    console.error('Error fetching company:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Update company
exports.updateCompany = async (req, res) => {
  try {
    const { companyId } = req.params;
    const updateData = req.body;

    const company = await Company.findByPk(companyId);

    if (!company) {
      return res.status(404).json({ success: false, message: 'Company not found' });
    }

    await company.update(updateData);

    res.json({
      success: true,
      message: 'Company updated successfully',
      data: company
    });
  } catch (error) {
    console.error('Error updating company:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Delete company
exports.deleteCompany = async (req, res) => {
  try {
    const { companyId } = req.params;

    const company = await Company.findByPk(companyId);

    if (!company) {
      return res.status(404).json({ success: false, message: 'Company not found' });
    }

    await company.destroy();

    res.json({
      success: true,
      message: 'Company deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting company:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/* ====================================================================== */
/*                      QUICKBOOKS CONNECTION FUNCTIONS                    */
/* ====================================================================== */

/**
 * Fetch the connected QuickBooks company's profile (name, legal name, currency,
 * fiscal-year-start, timezone) using the freshly issued access token. Falls
 * back to {} on any network/parse error so the OAuth flow is never blocked.
 *
 * Reference: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/companyinfo
 */
const fetchQuickBooksCompanyInfo = async (accessToken, realmId) => {
  try {
    const baseUrl = process.env.QB_ENVIRONMENT === 'sandbox'
      ? 'https://sandbox-quickbooks.api.intuit.com'
      : 'https://quickbooks.api.intuit.com';

    const url = `${baseUrl}/v3/company/${realmId}/companyinfo/${realmId}?minorversion=65`;
    const resp = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      timeout: 10000,
    });

    const info = resp.data?.CompanyInfo || {};
    // FiscalYearStartMonth is a month name ('January', 'April', etc.).
    // Convert to a Date for the column (year is irrelevant — we only care about the month).
    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const fiscalMonthIdx = MONTHS.indexOf(info.FiscalYearStartMonth);
    const fiscalYearStart = fiscalMonthIdx >= 0
      ? new Date(Date.UTC(new Date().getUTCFullYear(), fiscalMonthIdx, 1))
      : null;

    return {
      companyName:     info.CompanyName || null,
      legalName:       info.LegalName || null,
      country:         info.Country || null,
      currency:        info.SupportedLanguages || info.CurrencyRef?.value || null,
      currencyCode:    info.CurrencyRef?.value || null,
      fiscalYearStart,
      timezone:        info.TimeZone || null,
    };
  } catch (err) {
    console.warn('[QB CompanyInfo] fetch failed:', err.response?.data || err.message);
    return {};
  }
};

// Updated QuickBooks callback with company association
exports.quickBooksCallback = async (req, res) => {
  try {
    const { code, realmId, state } = req.query;
    console.log("QuickBooks callback received:", { code, realmId, state });

    // Exchange code for tokens
    const response = await axios.post(
      "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.QB_REDIRECT_URI
      }),
      {
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              `${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`
            ).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded"
        }
      }
    );

    const { access_token, refresh_token, expires_in, x_refresh_token_expires_in } = response.data;

    // 🟢 Pull the connected QuickBooks company's real name/profile via CompanyInfo
    //    so we can persist it on `qb_companies` (model: Company, table: qb_companies).
    //    Always re-fetched on reconnect per product decision.
    const qbInfo = await fetchQuickBooksCompanyInfo(access_token, realmId);
    console.log('[QB CompanyInfo]', { realmId, name: qbInfo.companyName, legal: qbInfo.legalName });

    const user = await User.findByPk(state);
    if (!user) {
      throw new Error('User not found');
    }

    // ── Tareeka B: attach QB to the user's EXISTING signup company ──────────
    //    We do NOT create a second company. The name the user typed at signup
    //    stays in `name`; QuickBooks' own company name goes in `qbc_name`.
    //    QB-derived fields (currency/timezone/fiscal) get refreshed.
    const qbDerived = {
      ...(qbInfo.currencyCode    ? { currency: qbInfo.currencyCode }    : {}),
      ...(qbInfo.timezone        ? { timezone: qbInfo.timezone }        : {}),
      ...(qbInfo.fiscalYearStart ? { fiscal_year_start: qbInfo.fiscalYearStart } : {}),
    };

    let company = null;

    // Step 1 — Is this QB account (realmId) already linked to a company?
    //          (reconnect, or the same QB account shared by another user)
    const existingByRealm = await Company.findOne({ where: { quickbooks_realm_id: realmId } });

    if (existingByRealm) {
      // Reuse it — refresh qbc_name + QB fields. Do NOT touch user's `name`.
      company = existingByRealm;
      const patch = { qbc_name: qbInfo.companyName || company.qbc_name, ...qbDerived };
      // If this company never had a custom name, keep `name` synced to QB name.
      if (!company.name_is_custom && qbInfo.companyName) patch.name = qbInfo.companyName;
      await company.update(patch);
    } else if (user.company_id) {
      // Step 2 — Attach QB to the user's signup company.
      company = await Company.findByPk(user.company_id);
      if (company) {
        const patch = {
          quickbooks_realm_id: realmId,
          qbc_name:            qbInfo.companyName || null,
          ...qbDerived,
        };
        // User did NOT type a company name (e.g. Gmail login) → use QB name as the
        // display name. If they typed one, keep it untouched.
        if (!company.name_is_custom && qbInfo.companyName) patch.name = qbInfo.companyName;
        await company.update(patch);
      }
    }

    // Step 3 — Fallback: user somehow has no company → create one from QB.
    if (!company) {
      company = await Company.create({
        name:                qbInfo.companyName || `Company_${user.id}`,
        qbc_name:            qbInfo.companyName || null,
        name_is_custom:      false, // came from QB, not user-typed
        quickbooks_realm_id: realmId,
        ...qbDerived,
      });
    }

    const companyId = company.id;

    // Step 3 — link this user to the company (idempotent). 'owner' on first link.
    const [link, linkCreated] = await UserQbCompany.findOrCreate({
      where:    { user_id: user.id, company_id: companyId },
      defaults: { role: 'owner', is_default: !user.company_id },
    });

    // Step 4 — Always update user.company_id to the QB company.
    //    The signup flow creates a placeholder company; QB OAuth creates the real one.
    //    Without this update the user's JWT keeps the placeholder company_id and
    //    hasConnectedSource / withTenantScope never find the QB source.
    await user.update({ company_id: companyId });
    await UserQbCompany.update(
      { is_default: false },
      { where: { user_id: user.id, company_id: { [require('sequelize').Op.ne]: companyId } } }
    );
    if (!link.is_default) await link.update({ is_default: true });

    // Save QuickBooks connection
    const [connection, created] = await QuickBooksConnection.findOrCreate({
      where: { company_id: companyId },
      defaults: {
        company_id: companyId,
        realm_id: realmId,
        access_token,
        refresh_token,
        token_type: 'bearer',
        expires_in,
        x_refresh_token_expires_in,
        sync_status: 'pending'
      }
    });

    if (!created) {
      await connection.update({
        realm_id: realmId,
        access_token,
        refresh_token,
        expires_in,
        x_refresh_token_expires_in,
        sync_status: 'pending'
      });
    }

    // Update company with realm ID
    await Company.update(
      { quickbooks_realm_id: realmId },
      { where: { id: companyId } }
    );

    // Save in Source model (for backward compatibility).
    // 🟢 Deduplicated: one row per (company_id, realmId). Previously Source.create
    //    fired on every reconnect — that's why we saw 7 rows for company_id=1.
    //    Postgres JSONB containment lets us match on the `realmId` key inside
    //    connector_settings_json without a dedicated column.
    const sourceSettings = {
      userId: state,
      companyId: companyId,
      type: "quickbooks",
      realmId,
      access_token,
      refresh_token,
      expires_at: Date.now() + expires_in * 1000,
      qbCompanyName:  qbInfo.companyName || null,
      qbLegalName:    qbInfo.legalName   || null,
      qbCountry:      qbInfo.country     || null,
    };

    const [createdSource, sourceCreated] = await Source.findOrCreate({
      where: {
        company_id: companyId,
        connector_name: "Quickbooks login",
        connector_settings_json: { [require('sequelize').Op.contains]: { realmId } },
      },
      defaults: {
        company_id: companyId,
        source_name: qbInfo.companyName || "Quickbooks login",
        connector_name: "Quickbooks login",
        connector_settings_json: sourceSettings,
        sandbox: true,
      },
    });

    if (!sourceCreated) {
      // Same QB company being reconnected — refresh tokens + QB meta in place.
      await createdSource.update({
        source_name: qbInfo.companyName || createdSource.source_name,
        connector_settings_json: sourceSettings,
      });
    }

    const sourceId = createdSource.id;

    // Trigger initial sync in the background so OAuth callback can return immediately.
    launchQuickBooksSyncInBackground(companyId, sourceId, access_token, realmId, { triggeredBy: 'initial' });

    res.redirect(
      `${process.env.FRONTEND_URL}/?quickbooks=success&realmId=${realmId}&sourceId=${sourceId}&companyId=${companyId}&syncStatus=pending`
    );

  } catch (err) {
    console.log(err.response?.data || err.message);
    res.redirect(
      `${process.env.FRONTEND_URL}?quickbooks=error&message=${encodeURIComponent(err.message)}`
    );
  }
};

// Trigger QuickBooks sync
// const triggerQuickBooksSync = async (companyId, sourceId, access_token, realmId) => {
//   try {
//     // Update sync status
//     await QuickBooksConnection.update(
//       { sync_status: 'in_progress' },
//       { where: { company_id: companyId } }
//     );

//     // Define entity types to sync
//     const entityTypes = [
//       'Account', 'Customer', 'Vendor', 'Invoice', 'Bill', 'Payment',
//       'JournalEntry', 'Estimate', 'BillPayment', 'Department', 'Deposit',
//       'Employee', 'Item', 'PaymentMethod', 'Purchase', 'PurchaseOrder',
//       'RefundReceipt', 'SalesReceipt', 'TaxCode', 'TaxRate', 'Term',
//       'TimeActivity', 'Transfer', 'VendorCredit'
//     ];

//     const baseUrl = process.env.QB_ENVIRONMENT === "sandbox"
//       ? "https://sandbox-quickbooks.api.intuit.com"
//       : "https://quickbooks.api.intuit.com";

//     // Sync each entity type
//     for (const entityType of entityTypes) {
//       try {
//         console.log(`Syncing ${entityType} for company ${companyId}...`);
        
//         let allEntities = [];
//         let startPosition = 1;
//         const maxResults = 1000;
//         let hasMore = true;

//         while (hasMore) {
//           const query = `SELECT * FROM ${entityType} STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;
          
//           const response = await axios.get(
//             `${baseUrl}/v3/company/${realmId}/query`,
//             {
//               params: { query },
//               headers: {
//                 Authorization: `Bearer ${access_token}`,
//                 Accept: "application/json"
//               }
//             }
//           );

//           const entities = response.data.QueryResponse[entityType] || [];
//           allEntities = [...allEntities, ...entities];

//           if (entities.length < maxResults) {
//             hasMore = false;
//           } else {
//             startPosition += maxResults;
//           }
//         }

//         // Save entities to database
//         await saveQuickBooksEntities(companyId, sourceId, entityType, allEntities);

//       } catch (error) {
//         console.error(`Error syncing ${entityType}:`, error.message);
//       }
//     }

//     // Generate financial reports
//     await generateFinancialReports(companyId, access_token, realmId);

//     // Update sync status
//     await QuickBooksConnection.update(
//       { 
//         sync_status: 'completed',
//         last_sync_at: new Date()
//       },
//       { where: { company_id: companyId } }
//     );

//   } catch (error) {
//     console.error('Error in triggerQuickBooksSync:', error);
//     await QuickBooksConnection.update(
//       { 
//         sync_status: 'failed',
//         error_message: error.message
//       },
//       { where: { company_id: companyId } }
//     );
//   }
// };








// Save QuickBooks entities to database
// const saveQuickBooksEntities = async (companyId, sourceId, entityType, entities) => {
//   const dataType = entityType.toLowerCase();
//   const batchSize = 100;

//   for (let i = 0; i < entities.length; i += batchSize) {
//     const batch = entities.slice(i, i + batchSize);
    
//     const records = batch.map(entity => ({
//       company_id: companyId,
//       source_id: sourceId,
//       data_type: dataType,
//       quickbooks_id: entity.Id,
//       data: entity,
//       sync_token: entity.SyncToken,
//       sync_version: entity.SyncToken,
//       is_active: entity.Active !== false
//     }));

//     // Use bulkCreate with update on duplicate
//     await QuickBooksData.bulkCreate(records, {
//       updateOnDuplicate: ['data', 'sync_token', 'sync_version', 'is_active', 'updated_at']
//     });
//   }

//   console.log(`Saved ${entities.length} ${entityType} records for company ${companyId}`);
// };
// In your QuickBookLogingController.js, update the saveQuickBooksEntities function
// const saveQuickBooksEntities = async (companyId, sourceId, entityType, entities) => {
//   const dataType = entityType.toLowerCase();
//   const batchSize = 100;

//   for (let i = 0; i < entities.length; i += batchSize) {
//     const batch = entities.slice(i, i + batchSize);
    
//     const records = batch.map(entity => ({
//       company_id: companyId,
//       source_id: sourceId,
//       data_type: dataType,
//       quickbooks_id: entity.Id,
//       data: entity,
//       sync_token: entity.SyncToken,
//       sync_version: entity.SyncToken,
//       is_active: entity.Active !== false
//     }));

//     try {
//       // Use bulkCreate with update on duplicate
//       await QuickBooksData.bulkCreate(records, {
//         updateOnDuplicate: ['data', 'sync_token', 'sync_version', 'is_active', 'updated_at'],
//         validate: true
//       });
//       console.log(`Saved ${records.length} ${entityType} records for company ${companyId}`);
//     } catch (error) {
//       console.error(`Error saving ${entityType} batch:`, {
//         message: error.message,
//         errors: error.errors?.map(e => ({
//           message: e.message,
//           type: e.type,
//           path: e.path,
//           value: e.value
//         })),
//         firstRecord: records[0] // Log first record to see structure
//       });
//       throw error;
//     }
//   }
// };

// ── FIX 1: concurrent upserts in batches of 50 ──────────────────────────────
// bulkCreate + updateOnDuplicate requires a DB-level unique constraint which
// is commented out in the model. Using upsert() with conflictFields is correct
// and was already working — we just run 50 at a time concurrently instead of
// one by one, giving a 30-50x speedup over the original serial loop.
const saveQuickBooksEntities = async (companyId, sourceId, entityType, entities) => {
  if (!entities.length) return;

  const dataType  = entityType.toLowerCase();
  const CONCURRENT = 50; // upserts running in parallel per batch

  const records = entities.map(entity => ({
    company_id:    companyId,
    source_id:     sourceId,
    data_type:     dataType,
    quickbooks_id: entity.Id,
    data:          entity,
    sync_token:    entity.SyncToken,
    sync_version:  entity.SyncToken,
    is_active:     entity.Active !== false,
  }));

  for (let i = 0; i < records.length; i += CONCURRENT) {
    const batch = records.slice(i, i + CONCURRENT);
    await Promise.all(
      batch.map(record =>
        QuickBooksData.upsert(record, {
          conflictFields: ['company_id', 'data_type', 'quickbooks_id'],
        }).catch(err =>
          console.error(`[SYNC] ${entityType} record ${record.quickbooks_id} skipped:`, err.message)
        )
      )
    );
  }

  console.log(`[SYNC] ${entityType}: upserted ${records.length} records`);
};
// Generate financial reports from synced data
// const generateFinancialReports = async (companyId, access_token, realmId) => {
//   try {
//     const baseUrl = process.env.QB_ENVIRONMENT === "sandbox"
//       ? "https://sandbox-quickbooks.api.intuit.com"
//       : "https://quickbooks.api.intuit.com";

//     // Define report types to generate
//     const reportTypes = [
//       { type: 'profit_loss', endpoint: 'ProfitAndLoss' },
//       { type: 'balance_sheet', endpoint: 'BalanceSheet' },
//       { type: 'cash_flow', endpoint: 'CashFlow' }
//     ];

//     const startDate = new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0]; // Jan 1
//     const endDate = new Date().toISOString().split('T')[0]; // Today

//     for (const report of reportTypes) {
//       try {
//         const response = await axios.get(
//           `${baseUrl}/v3/company/${realmId}/reports/${report.endpoint}`,
//           {
//             params: {
//               start_date: startDate,
//               end_date: endDate
//             },
//             headers: {
//               Authorization: `Bearer ${access_token}`,
//               Accept: "application/json"
//             }
//           }
//         );

//         // Save report to database
//         await FinancialReport.create({
//           company_id: companyId,
//           report_type: report.type,
//           report_name: `${report.type} Report`,
//           report_data: response.data,
//           date_range_start: startDate,
//           date_range_end: endDate
//         });

//       } catch (error) {
//         console.error(`Error generating ${report.type} report:`, error.message);
//       }
//     }

//   } catch (error) {
//     console.error('Error generating financial reports:', error);
//   }
// };



const saveToRawLayer = async (companyId, entityType, entities) => {
  if (!entities.length) return;

  try {
    // ✅ v2: routes into elt_warehouse_v2.quickbooks_raw.raw_<entity>
    const { inserted } = await insertRawData('quickbooks', entityType, entities, {
      companyId,
      sourceIdField: 'Id',
      syncTokenField: 'SyncToken',
    });
    console.log(`[WAREHOUSE RAW v2] quickbooks_raw.raw_${entityType.toLowerCase()}: ${inserted} records`);
  } catch (error) {
    console.error(`[WAREHOUSE RAW v2] Error saving ${entityType}:`, error.message);
  }
};

// ── FIX 2: bulk gold layer — collect all rows then one bulkCreate per table ──
const transformToGoldLayer = async (companyId, allFetched) => {
  const now = new Date();
  try {

    // ── dim_accounts ──────────────────────────────────────────────────────
    const accounts = allFetched['Account'] || [];
    if (accounts.length) {
      await DimAccount.bulkCreate(
        accounts.map(acc => ({
          company_id:       companyId,
          account_id:       acc.Id,
          account_name:     acc.Name,
          account_type:     acc.AccountType,
          account_sub_type: acc.AccountSubType || null,
          current_balance:  acc.CurrentBalance || 0,
          currency:         acc.CurrencyRef?.value || 'USD',
          is_active:        acc.Active !== false,
          updated_at:       now,
        })),
        { updateOnDuplicate: ['account_name','account_type','account_sub_type','current_balance','currency','is_active','updated_at'] }
      );
    }
    console.log(`[WAREHOUSE GOLD] dim_accounts: ${accounts.length} records`);

    // ── dim_customers ─────────────────────────────────────────────────────
    const customers = allFetched['Customer'] || [];
    if (customers.length) {
      await DimCustomer.bulkCreate(
        customers.map(cust => ({
          company_id:   companyId,
          customer_id:  cust.Id,
          display_name: cust.DisplayName,
          email:        cust.PrimaryEmailAddr?.Address || null,
          balance:      cust.Balance || 0,
          is_active:    cust.Active !== false,
          updated_at:   now,
        })),
        { updateOnDuplicate: ['display_name','email','balance','is_active','updated_at'] }
      );
    }
    console.log(`[WAREHOUSE GOLD] dim_customers: ${customers.length} records`);

    // ── fact_transactions — invoices + bills + payments in one shot ────────
    const invoiceRows = (allFetched['Invoice'] || []).map(inv => ({
      company_id:       companyId,
      transaction_date: inv.TxnDate,
      amount:           inv.TotalAmt || 0,
      transaction_type: 'revenue',
      account_id:       inv.DepositToAccountRef?.value || null,
      customer_id:      inv.CustomerRef?.value || null,
      source_type:      'quickbooks',
      source_ref_id:    `invoice_${inv.Id}`,
      currency:         inv.CurrencyRef?.value || 'USD',
      is_paid:          inv.Balance === 0,
    }));

    const billRows = (allFetched['Bill'] || []).map(bill => ({
      company_id:       companyId,
      transaction_date: bill.TxnDate,
      amount:           bill.TotalAmt || 0,
      transaction_type: 'expense',
      account_id:       bill.APAccountRef?.value || null,
      customer_id:      null,
      source_type:      'quickbooks',
      source_ref_id:    `bill_${bill.Id}`,
      currency:         bill.CurrencyRef?.value || 'USD',
      is_paid:          bill.Balance === 0,
    }));

    const paymentRows = (allFetched['Payment'] || []).map(pay => ({
      company_id:       companyId,
      transaction_date: pay.TxnDate,
      amount:           pay.TotalAmt || 0,
      transaction_type: 'payment',
      account_id:       pay.DepositToAccountRef?.value || null,
      customer_id:      pay.CustomerRef?.value || null,
      source_type:      'quickbooks',
      source_ref_id:    `payment_${pay.Id}`,
      currency:         pay.CurrencyRef?.value || 'USD',
      is_paid:          true,
    }));

    const allTxRows = [...invoiceRows, ...billRows, ...paymentRows];
    if (allTxRows.length) {
      await FactTransaction.bulkCreate(allTxRows, {
        updateOnDuplicate: ['transaction_date','amount','transaction_type','account_id','customer_id','currency','is_paid'],
      });
    }
    console.log(`[WAREHOUSE GOLD] fact_transactions: ${invoiceRows.length} invoices + ${billRows.length} bills + ${paymentRows.length} payments`);

  } catch (error) {
    console.error('[WAREHOUSE GOLD] Transform error:', error.message);
  }
};
// const generateFinancialReports = async (companyId, access_token, realmId) => {
//   try {
//     const baseUrl = process.env.QB_ENVIRONMENT === 'sandbox'
//       ? 'https://sandbox-quickbooks.api.intuit.com'
//       : 'https://quickbooks.api.intuit.com';

//     const reportTypes = [
//       { type: 'profit_loss',   endpoint: 'ProfitAndLoss' },
//       { type: 'balance_sheet', endpoint: 'BalanceSheet'  },
//       { type: 'cash_flow',     endpoint: 'CashFlow'      }
//     ];

//     const startDate = new Date(new Date().getFullYear(), 0, 1)
//       .toISOString().split('T')[0]; // Jan 1
//     const endDate = new Date()
//       .toISOString().split('T')[0]; // Today

//     for (const report of reportTypes) {
//       try {
//         const response = await axios.get(
//           `${baseUrl}/v3/company/${realmId}/reports/${report.endpoint}`,
//           {
//             params: { start_date: startDate, end_date: endDate },
//             headers: {
//               Authorization: `Bearer ${access_token}`,
//               Accept: 'application/json'
//             }
//           }
//         );

//         // ✅ Warehouse mein save — Main DB mein nahi
//         const ReportModel = getFinancialReportModel(report.type);

//         await ReportModel.upsert({
//           company_id:       companyId,
//           report_type:      report.type,
//           report_name:      `${report.type} Report`,
//           report_data:      response.data,   // poora QB report JSON
//           date_range_start: startDate,
//           date_range_end:   endDate,
//           generated_at:     new Date()
//         }, {
//           conflictFields: ['company_id', 'report_type', 'date_range_start', 'date_range_end']
//         });

//         console.log(`[WAREHOUSE REPORT] report_${report.type}: saved`);

//       } catch (error) {
//         console.error(`[WAREHOUSE REPORT] Error generating ${report.type}:`, error.message);
//       }
//     }

//   } catch (error) {
//     console.error('[WAREHOUSE REPORT] Fatal error:', error);
//   }
// };

const generateFinancialReports = async (companyId, access_token, realmId) => {
  try {
    const baseUrl = process.env.QB_ENVIRONMENT === 'sandbox'
      ? 'https://sandbox-quickbooks.api.intuit.com'
      : 'https://quickbooks.api.intuit.com';

    const reportTypes = [
      { type: 'profit_loss',   endpoint: 'ProfitAndLoss' },
      { type: 'balance_sheet', endpoint: 'BalanceSheet'  },
      { type: 'cash_flow',     endpoint: 'CashFlow'      }
    ];

    const startDate = new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0];
    const endDate   = new Date().toISOString().split('T')[0];

    for (const report of reportTypes) {
      try {
        const response = await axios.get(
          `${baseUrl}/v3/company/${realmId}/reports/${report.endpoint}`,
          {
            params: { start_date: startDate, end_date: endDate },
            headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json' }
          }
        );

        // Step 5 (legacy retirement, see conversation): v2 is now the primary
        // write — dashboard reads only quickbooks_domain.report_* (verified
        // byte-identical to legacy in Step 4). Legacy write kept below,
        // isolated, only for rollback safety until fully confident.
        const V2ReportModel = getV2FinancialReportModel(report.type);
        await V2ReportModel.upsert({
          company_id:       companyId,
          report_type:      report.type,
          report_name:      `${report.type} Report`,
          report_data:      response.data,
          date_range_start: startDate,
          date_range_end:   endDate,
          generated_at:     new Date()
        }, {
          conflictFields: ['company_id', 'report_type', 'date_range_start', 'date_range_end']
        });
        console.log(`[WAREHOUSE REPORT v2] report_${report.type}: saved`);

        try {
          const ReportModel = await getFinancialReportModel(report.type); // legacy
          await ReportModel.upsert({
            company_id:       companyId,
            report_type:      report.type,
            report_name:      `${report.type} Report`,
            report_data:      response.data,
            date_range_start: startDate,
            date_range_end:   endDate,
            generated_at:     new Date()
          }, {
            conflictFields: ['company_id', 'report_type', 'date_range_start', 'date_range_end']
          });
          console.log(`[WAREHOUSE REPORT] report_${report.type}: saved (legacy, rollback-only)`);
        } catch (legacyError) {
          console.error(`[WAREHOUSE REPORT] legacy write error ${report.type}:`, legacyError.message);
        }

      } catch (error) {
        console.error(`[WAREHOUSE REPORT] Error generating ${report.type}:`, error.message);
      }
    }
  } catch (error) {
    console.error('[WAREHOUSE REPORT] Fatal error:', error);
  }
};


/* ======================================================================
   SYNC HELPERS
   ====================================================================== */

const { Op } = require('sequelize');

// Retry an async fn on TRANSIENT failures (network error, 429 rate-limit, 5xx).
// Permanent errors (401/403/400) throw immediately — retrying won't help.
const withRetry = async (fn, { retries = 3, label = 'QB request' } = {}) => {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status    = err.response?.status;
      const transient = !status || status === 429 || status >= 500; // network / rate-limit / server
      if (!transient || attempt === retries) throw err;
      const delayMs = 1000 * attempt; // backoff: 1s, 2s, 3s
      console.warn(`[RETRY] ${label} failed (attempt ${attempt}/${retries}, ${status || 'network'}) — retrying in ${delayMs}ms`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
};

// ── Soft delete: records in DB but missing from QB → mark inactive ────────────
// Only runs when we have a full list of QB IDs (full sync only).
// Safety: if QB returned 0 records (API error?), skip soft delete to avoid
// wiping everything.
const softDeleteMissingRecords = async (companyId, entityType, qbIds) => {
  if (!qbIds || qbIds.length === 0) return; // never wipe all records on empty response

  const dataType = entityType.toLowerCase();
  const result   = await QuickBooksData.update(
    { is_active: false, deactivated_at: new Date() },
    {
      where: {
        company_id:    companyId,
        data_type:     dataType,
        quickbooks_id: { [Op.notIn]: qbIds },
        is_active:     true,
        // Don't re-stamp already deactivated rows
        deactivated_at: null,
      },
    }
  );
  if (result[0] > 0) {
    console.log(`[SYNC SOFT-DELETE] ${entityType}: ${result[0]} records marked inactive`);
  }
};

// ── Incremental sync via QB CDC (Change Data Capture) ────────────────────────
// CDC returns ALL changes (creates/updates/deletes) since a given timestamp.
// This replaces the full per-entity query loop for subsequent syncs.
const runIncrementalSync = async ({
  companyId, sourceId, access_token, realmId, baseUrl,
  entityTypes, sinceDate, onProgress,
}) => {
  const sinceISO = sinceDate.toISOString().split('.')[0]; // QB wants no milliseconds

  console.log(`[INCREMENTAL SYNC] changedSince: ${sinceISO}`);

  // QB CDC accepts comma-separated entity names
  const cdcResponse = await withRetry(
    () => axios.get(
      `${baseUrl}/v3/company/${realmId}/cdc`,
      {
        params:  { entities: entityTypes.join(','), changedSince: sinceISO },
        headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json' },
        timeout: 30000,
      }
    ),
    { label: 'CDC incremental' }
  );

  // CDC response shape:
  // { CDCResponse: [{ QueryResponse: [{ Invoice: [...], Customer: [...] }] }] }
  const queryResponses = cdcResponse.data?.CDCResponse?.[0]?.QueryResponse || [];
  const changesMap = {}; // { Invoice: [records], Customer: [records], ... }
  for (const qr of queryResponses) {
    for (const [entity, records] of Object.entries(qr)) {
      if (Array.isArray(records)) {
        changesMap[entity] = (changesMap[entity] || []).concat(records);
      }
    }
  }

  let completedCount = 0;
  let totalRecords   = 0;

  for (const entityType of entityTypes) {
    const allRecords    = changesMap[entityType] || [];
    // QB marks deleted records with status:"Deleted"
    const activeRecords = allRecords.filter(r => r.status !== 'Deleted');
    const deletedIds    = allRecords
      .filter(r => r.status === 'Deleted')
      .map(r => r.Id);

    // Upsert active/updated records
    if (activeRecords.length > 0) {
      await Promise.all([
        saveQuickBooksEntities(companyId, sourceId, entityType, activeRecords),
        saveToRawLayer(companyId, entityType, activeRecords),
      ]);
      totalRecords += activeRecords.length;
    }

    // Soft delete records QB says are deleted — stamp deactivated_at
    if (deletedIds.length > 0) {
      await QuickBooksData.update(
        { is_active: false, deactivated_at: new Date() },
        {
          where: {
            company_id:     companyId,
            data_type:      entityType.toLowerCase(),
            quickbooks_id:  { [Op.in]: deletedIds },
            deactivated_at: null, // only stamp once
          },
        }
      );
      console.log(`[INCREMENTAL SYNC] ${entityType}: ${deletedIds.length} soft-deleted`);
    }

    completedCount++;
    console.log(
      `[INCREMENTAL SYNC] ${entityType}: ${activeRecords.length} updated, ` +
      `${deletedIds.length} deleted (${completedCount}/${entityTypes.length})`
    );
    onProgress?.({ entityType, completedCount, totalRecords });
  }

  return { completedCount, totalRecords };
};

/* ======================================================================
   MAIN SYNC ORCHESTRATOR
   ====================================================================== */
const triggerQuickBooksSync = async (companyId, sourceId, access_token, realmId, opts = {}) => {
  // ── Sync log — single source of truth for ALL syncs (manual/initial/scheduled) ──
  const SyncLog   = require('../model/SyncLog');
  const startedAt = Date.now();
  let logEntry    = null;
  try {
    // ── Determine: full sync or incremental? ─────────────────────────────────
    const connection = await QuickBooksConnection.findOne({
      where:      { company_id: companyId },
      attributes: ['last_sync_at'],
    });

    const lastSyncAt  = connection?.last_sync_at ?? null;
    const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    const isFullSync  =
      !lastSyncAt ||                              // first ever sync
      Date.now() - new Date(lastSyncAt) > ONE_WEEK_MS; // weekly safety re-sync

    const syncLabel = isFullSync
      ? (!lastSyncAt ? 'FULL (first time)' : 'FULL (weekly re-sync)')
      : `INCREMENTAL (since ${lastSyncAt})`;
    console.log(`[SYNC] Mode: ${syncLabel} — company ${companyId} (triggered: ${opts.triggeredBy || 'manual'})`);

    // Create the sync log row (status = running)
    logEntry = await SyncLog.create({
      company_id:   companyId,
      source_id:    sourceId,
      source_type:  'quickbooks',
      sync_type:    isFullSync ? 'full' : 'incremental',
      triggered_by: opts.triggeredBy || 'manual',
      status:       'running',
      started_at:   new Date(),
    });

    await QuickBooksConnection.update(
      { sync_status: 'in_progress' },
      { where: { company_id: companyId } }
    );

    const baseUrl = process.env.QB_ENVIRONMENT === 'sandbox'
      ? 'https://sandbox-quickbooks.api.intuit.com'
      : 'https://quickbooks.api.intuit.com';

    const entityTypes = [
      'Account', 'Customer', 'Vendor', 'Invoice', 'Bill', 'Payment',
      'JournalEntry', 'Estimate', 'BillPayment', 'Department', 'Deposit',
      'Employee', 'Item', 'PaymentMethod', 'Purchase', 'PurchaseOrder',
      'RefundReceipt', 'SalesReceipt', 'TaxCode', 'TaxRate', 'Term',
      'TimeActivity', 'Transfer', 'VendorCredit',
    ];

    emitQuickBooksSyncProgress(
      buildQuickBooksSyncProgress({
        companyId, sourceId,
        stage:         isFullSync ? 'full_sync' : 'incremental_sync',
        syncStatus:    'in_progress',
        currentIndex:  0,
        totalEntities: entityTypes.length,
      })
    );

    const allFetched   = {}; // kept for gold-layer transform
    let completedCount = 0;
    let totalRecords   = 0;
    let doFullSync     = isFullSync; // may flip to true if CDC fails

    /* ── INCREMENTAL PATH ──────────────────────────────────────────────────── */
    if (!doFullSync) {
      try {
        const result = await runIncrementalSync({
          companyId, sourceId, access_token, realmId, baseUrl,
          entityTypes, sinceDate: new Date(lastSyncAt),
          onProgress: ({ entityType, completedCount: cc, totalRecords: tr }) => {
            emitQuickBooksSyncProgress(
              buildQuickBooksSyncProgress({
                companyId, sourceId,
                stage:            'incremental_sync',
                syncStatus:       'in_progress',
                currentEntity:    entityType,
                currentIndex:     cc,
                totalEntities:    entityTypes.length,
                recordsProcessed: tr,
              })
            );
          },
        });
        completedCount = result.completedCount;
        totalRecords   = result.totalRecords;
        console.log(`[INCREMENTAL SYNC] Done — ${totalRecords} records changed`);

      } catch (cdcErr) {
        // CDC failed (sandbox limitation / token issue / changedSince too old)
        // → automatically fall back to a full sync
        console.warn('[INCREMENTAL SYNC] CDC failed — falling back to full sync:', cdcErr.message);
        completedCount = 0;
        totalRecords   = 0;
        doFullSync     = true; // ← triggers the full sync block below
        emitQuickBooksSyncProgress(
          buildQuickBooksSyncProgress({
            companyId, sourceId,
            stage: 'full_sync', syncStatus: 'in_progress',
            currentIndex: 0, totalEntities: entityTypes.length,
          })
        );
      }
    }

    /* ── FULL SYNC PATH ────────────────────────────────────────────────────── */
    if (doFullSync) {
      const PARALLEL = 4;

      const fetchAndSaveEntity = async (entityType) => {
        try {
          let entities      = [];
          let startPosition = 1;
          let hasMore       = true;

          while (hasMore) {
            const query    = `SELECT * FROM ${entityType} STARTPOSITION ${startPosition} MAXRESULTS 1000`;
            const response = await withRetry(
              () => axios.get(
                `${baseUrl}/v3/company/${realmId}/query`,
                {
                  params:  { query },
                  headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json' },
                  timeout: 30000,
                }
              ),
              { label: `fetch ${entityType}` }
            );
            const chunk = response.data.QueryResponse[entityType] || [];
            entities    = [...entities, ...chunk];
            hasMore     = chunk.length === 1000;
            startPosition += 1000;
          }

          allFetched[entityType] = entities;

          // Save to main DB + warehouse raw layer in parallel
          await Promise.all([
            saveQuickBooksEntities(companyId, sourceId, entityType, entities),
            saveToRawLayer(companyId, entityType, entities),
          ]);

          // ── SOFT DELETE: records in DB but no longer in QB ────────────────
          const qbIds = entities.map(e => e.Id);
          await softDeleteMissingRecords(companyId, entityType, qbIds);

          completedCount++;
          totalRecords += entities.length;
          console.log(`[FULL SYNC] ${entityType}: ${entities.length} records (${completedCount}/${entityTypes.length})`);

          emitQuickBooksSyncProgress(
            buildQuickBooksSyncProgress({
              companyId, sourceId,
              stage:           'entity_sync',
              syncStatus:      'in_progress',
              currentEntity:   entityType,
              currentIndex:    completedCount,
              totalEntities:   entityTypes.length,
              recordsProcessed: totalRecords,
            })
          );
        } catch (err) {
          console.error(`[FULL SYNC] Error on ${entityType}:`, err.message);
          completedCount++;
        }
      };

      for (let i = 0; i < entityTypes.length; i += PARALLEL) {
        const batch = entityTypes.slice(i, i + PARALLEL);
        await Promise.all(batch.map(fetchAndSaveEntity));
      }
    }

    // ── RAW → GOLD transformation ─────────────────────────────────────────────
    emitQuickBooksSyncProgress(
      buildQuickBooksSyncProgress({
        companyId, sourceId,
        stage: 'transforming', syncStatus: 'in_progress',
        currentIndex: entityTypes.length, totalEntities: entityTypes.length,
      })
    );
    // Step 5 (legacy retirement, see conversation): dashboard now reads only
    // v2 (quickbooks_domain) — legacy domain_tables was found stale/unreliable
    // after incremental syncs (transformToGoldLayer only ran on full syncs;
    // v2's transformToDomain always re-derives from the full raw table, so it
    // stayed accurate regardless of sync type). transformToGoldLayer() is kept
    // below (unused) only for rollback; safe to delete once fully confident.
    try {
      const transformSummary = await transformToDomain('quickbooks', { companyId });
      console.log('[WAREHOUSE DOMAIN v2]', transformSummary);
    } catch (v2Error) {
      console.error('[WAREHOUSE DOMAIN v2] Error:', v2Error.message);
    }
    // await transformToGoldLayer(companyId, allFetched); // retired — see comment above

    // ── Financial reports ─────────────────────────────────────────────────────
    emitQuickBooksSyncProgress(
      buildQuickBooksSyncProgress({
        companyId, sourceId,
        stage: 'reports', syncStatus: 'in_progress',
        currentIndex: entityTypes.length, totalEntities: entityTypes.length,
      })
    );
    await generateFinancialReports(companyId, access_token, realmId);

    // ── Mark complete ─────────────────────────────────────────────────────────
    const completedAt = new Date();
    await QuickBooksConnection.update(
      { sync_status: 'completed', last_sync_at: completedAt, error_message: null },
      { where: { company_id: companyId } }
    );

    // Update sync log → completed
    if (logEntry) {
      await logEntry.update({
        status:           'completed',
        completed_at:     completedAt,
        duration_seconds: Math.round((Date.now() - startedAt) / 1000),
        total_records:    totalRecords,
      });
    }

    emitQuickBooksSyncProgress(
      buildQuickBooksSyncProgress({
        companyId, sourceId,
        stage: 'completed', syncStatus: 'completed',
        currentIndex: entityTypes.length, totalEntities: entityTypes.length,
        lastSyncAt: completedAt.toISOString(),
      })
    );

  } catch (error) {
    console.error('[SYNC] Fatal error:', error);
    await QuickBooksConnection.update(
      { sync_status: 'failed', error_message: error.message },
      { where: { company_id: companyId } }
    );

    // Update sync log → failed
    if (logEntry) {
      await logEntry.update({
        status:           'failed',
        completed_at:     new Date(),
        duration_seconds: Math.round((Date.now() - startedAt) / 1000),
        error_message:    error.message,
      });
    }

    emitQuickBooksSyncProgress(
      buildQuickBooksSyncProgress({
        companyId, sourceId,
        stage: 'failed', syncStatus: 'failed',
        errorMessage: error.message,
      })
    );
  }
};

/* ====================================================================== */
/*                      DASHBOARD DATA FUNCTIONS                           */
/* ====================================================================== */

// Get dashboard data for a company
// exports.getCompanyDashboardData = async (req, res) => {
//   try {
//     const { companyId } = req.params;

//     // Get company with connection
//     const company = await Company.findByPk(companyId, {
//       include: [
//         {
//           model: QuickBooksConnection,
//           attributes: ['realm_id', 'sync_status', 'last_sync_at']
//         }
//       ]
//     });

//     if (!company) {
//       return res.status(404).json({ success: false, message: 'Company not found' });
//     }

//     // Get latest financial data
//     const recentReports = await FinancialReport.findAll({
//       where: { company_id: companyId },
//       order: [['created_at', 'DESC']],
//       limit: 3
//     });

//     // Get dashboard config
//     const dashboardConfig = await DashboardConfig.findOne({
//       where: { 
//         company_id: companyId,
//         is_default: true 
//       }
//     });

//     // Get key metrics from QuickBooks data
//     const keyMetrics = await calculateKeyMetrics(companyId);

//     res.json({
//       success: true,
//       data: {
//         company,
//         quickBooksConnected: !!company.QuickBooksConnection,
//         lastSync: company.QuickBooksConnection?.last_sync_at,
//         syncStatus: company.QuickBooksConnection?.sync_status,
//         keyMetrics,
//         recentReports,
//         dashboardConfig
//       }
//     });

//   } catch (error) {
//     console.error('Error getting dashboard data:', error);
//     res.status(500).json({ success: false, message: error.message });
//   }
// };

// Replace your existing getCompanyDashboardData (lines 404-448) with this:

exports.getCompanyDashboardData = async (req, res) => {
  try {
    const { companyId } = req.params;

    // Get company with connection
    const company = await Company.findByPk(companyId, {
      include: [
        {
          model: QuickBooksConnection,
          as: 'quickbooksConnection',
          attributes: ['id', 'realm_id', 'sync_status', 'last_sync_at']
        }
      ]
    });

    if (!company) {
      return res.status(404).json({ success: false, message: 'Company not found' });
    }

    const quickBooksConnected = !!company.quickbooksConnection;
    const sourceId = company.quickbooksConnection?.id || null;

    console.log('Company QB Connection:', company.quickbooksConnection);
    console.log('Source ID:', sourceId);
    // Get key metrics from QuickBooks data
    let keyMetrics = {
      totalRevenue: 0,
      totalExpenses: 0,
      netIncome: 0,
      accountsReceivable: 0,
      accountsPayable: 0,
      totalCustomers: 0,
      totalInvoices: 0
    };

    // Get monthly data for charts
    let monthlyData = [];
    let expensesByCategory = [];
    let profitLossSummary = [];
    let balanceSheetSummary = [];

    if (quickBooksConnected && sourceId) {
      // Calculate key metrics
      keyMetrics = await calculateKeyMetrics(companyId);
      
      // Get monthly data for revenue/expenses chart
      monthlyData = await generateMonthlyData(companyId);
      
      // Get expenses by category for pie chart
      expensesByCategory = await generateExpensesByCategory(companyId);
      
      // Get profit/loss summary
      profitLossSummary = await generateProfitLossSummary(companyId);
      
      // Get balance sheet summary
      balanceSheetSummary = await generateBalanceSheetSummary(companyId);
    }

    // Get latest financial reports
    const recentReports = await FinancialReport.findAll({
      where: { company_id: companyId },
      order: [['created_at', 'DESC']],
      limit: 3
    });

    // Get dashboard config
    const dashboardConfig = await DashboardConfig.findOne({
      where: { 
        company_id: companyId,
        is_default: true 
      }
    });

    // Return data in the format your frontend expects
    res.json({
      success: true,
      company: {
        id: company.id,
        name: company.name,
        domain: company.domain,
        subscription_plan: company.subscription_plan,
        subscription_status: company.subscription_status,
        currency: company.currency,
        timezone: company.timezone,
        sourceId: sourceId,
        quickbooks_realm_id: company.quickbooks_realm_id
      },
      quickBooksConnected,
      lastSync: company.quickbooksConnection?.last_sync_at,
      syncStatus: company.quickbooksConnection?.sync_status,
      financialData: {
        revenue: keyMetrics.totalRevenue,
        expenses: keyMetrics.totalExpenses,
        netIncome: keyMetrics.netIncome,
        cashBalance: keyMetrics.accountsReceivable - keyMetrics.accountsPayable,
        monthlyData: monthlyData,
        expensesByCategory: expensesByCategory,
        profitLossSummary: profitLossSummary,
        balanceSheetSummary: balanceSheetSummary
      },
      recentReports,
      dashboardConfig
    });

  } catch (error) {
    console.error('Error getting dashboard data:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Add these helper functions to generate chart data

const generateMonthlyData = async (companyId) => {
  try {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthlyMap = {};

    // Get invoices for revenue
    const invoices = await QuickBooksData.findAll({
      where: { 
        company_id: companyId,
        data_type: 'invoice'
      }
    });

    invoices.forEach(item => {
      const invoiceData = item.data;
      if (invoiceData.TxnDate) {
        const date = new Date(invoiceData.TxnDate);
        const monthKey = `${months[date.getMonth()]} ${date.getFullYear()}`;
        
        if (!monthlyMap[monthKey]) {
          monthlyMap[monthKey] = { month: monthKey, revenue: 0, expenses: 0 };
        }
        monthlyMap[monthKey].revenue += invoiceData.TotalAmt || 0;
      }
    });

    // Get bills for expenses
    const bills = await QuickBooksData.findAll({
      where: { 
        company_id: companyId,
        data_type: 'bill'
      }
    });

    bills.forEach(item => {
      const billData = item.data;
      if (billData.TxnDate) {
        const date = new Date(billData.TxnDate);
        const monthKey = `${months[date.getMonth()]} ${date.getFullYear()}`;
        
        if (!monthlyMap[monthKey]) {
          monthlyMap[monthKey] = { month: monthKey, revenue: 0, expenses: 0 };
        }
        monthlyMap[monthKey].expenses += billData.TotalAmt || 0;
      }
    });

    return Object.values(monthlyMap).sort((a, b) => {
      const dateA = new Date(a.month);
      const dateB = new Date(b.month);
      return dateA - dateB;
    }).slice(-12); // Last 12 months

  } catch (error) {
    console.error('Error generating monthly data:', error);
    return [];
  }
};

const generateExpensesByCategory = async (companyId) => {
  try {
    const categoryMap = {};

    const bills = await QuickBooksData.findAll({
      where: { 
        company_id: companyId,
        data_type: 'bill'
      }
    });

    bills.forEach(item => {
      const billData = item.data;
      const category = billData.Line?.[0]?.AccountBasedExpenseLineDetail?.AccountRef?.name || 'Other';
      
      if (!categoryMap[category]) {
        categoryMap[category] = { name: category, value: 0 };
      }
      categoryMap[category].value += billData.TotalAmt || 0;
    });

    return Object.values(categoryMap)
      .sort((a, b) => b.value - a.value)
      .slice(0, 5); // Top 5 categories

  } catch (error) {
    console.error('Error generating expenses by category:', error);
    return [];
  }
};

const generateProfitLossSummary = async (companyId) => {
  try {
    const summary = [];

    const accounts = await QuickBooksData.findAll({
      where: { 
        company_id: companyId,
        data_type: 'account'
      }
    });

    accounts.forEach(item => {
      const accountData = item.data;
      if (accountData.AccountType === 'Revenue') {
        summary.push({
          category: accountData.Name || 'Revenue',
          amount: accountData.CurrentBalance || 0,
          type: 'Revenue'
        });
      } else if (accountData.AccountType === 'Expense') {
        summary.push({
          category: accountData.Name || 'Expense',
          amount: (accountData.CurrentBalance || 0) * -1,
          type: 'Expense'
        });
      }
    });

    return summary.slice(0, 8); // Limit to 8 items

  } catch (error) {
    console.error('Error generating profit/loss summary:', error);
    return [];
  }
};

const generateBalanceSheetSummary = async (companyId) => {
  try {
    const summary = [];

    const accounts = await QuickBooksData.findAll({
      where: { 
        company_id: companyId,
        data_type: 'account'
      }
    });

    let totalAssets = 0;
    let totalLiabilities = 0;
    let totalEquity = 0;

    accounts.forEach(item => {
      const accountData = item.data;
      const accountType = accountData.AccountType;
      const balance = accountData.CurrentBalance || 0;

      if (accountType === 'Asset' || accountType === 'Bank' || accountType === 'Accounts Receivable') {
        totalAssets += balance;
      } else if (accountType === 'Liability' || accountType === 'Accounts Payable' || accountType === 'CreditCard') {
        totalLiabilities += balance;
      } else if (accountType === 'Equity') {
        totalEquity += balance;
      }
    });

    summary.push({ category: 'Assets', amount: totalAssets });
    summary.push({ category: 'Liabilities', amount: totalLiabilities });
    summary.push({ category: 'Equity', amount: totalEquity });

    return summary;

  } catch (error) {
    console.error('Error generating balance sheet summary:', error);
    return [];
  }
};

// Calculate key metrics from QuickBooks data
const calculateKeyMetrics = async (companyId) => {
  try {
    // Get accounts data
    const accounts = await QuickBooksData.findAll({
      where: { 
        company_id: companyId,
        data_type: 'account'
      }
    });

    // Get invoices data
    const invoices = await QuickBooksData.findAll({
      where: { 
        company_id: companyId,
        data_type: 'invoice'
      }
    });

    // Get customers data
    const customers = await QuickBooksData.findAll({
      where: { 
        company_id: companyId,
        data_type: 'customer'
      }
    });

    // Calculate metrics
    let totalRevenue = 0;
    let totalExpenses = 0;
    let accountsReceivable = 0;
    let accountsPayable = 0;

    // Process accounts
    accounts.forEach(account => {
      const accountData = account.data;
      if (accountData.AccountType === 'Revenue') {
        totalRevenue += accountData.CurrentBalance || 0;
      } else if (accountData.AccountType === 'Expenses') {
        totalExpenses += accountData.CurrentBalance || 0;
      } else if (accountData.AccountType === 'Accounts Receivable') {
        accountsReceivable += accountData.CurrentBalance || 0;
      } else if (accountData.AccountType === 'Accounts Payable') {
        accountsPayable += accountData.CurrentBalance || 0;
      }
    });

    // Process invoices for outstanding amounts
    invoices.forEach(invoice => {
      const invoiceData = invoice.data;
      if (invoiceData.Balance > 0) {
        accountsReceivable += invoiceData.Balance;
      }
    });

    return {
      totalRevenue,
      totalExpenses,
      netIncome: totalRevenue - totalExpenses,
      accountsReceivable,
      accountsPayable,
      totalCustomers: customers.length,
      totalInvoices: invoices.length
    };

  } catch (error) {
    console.error('Error calculating key metrics:', error);
    return {
      totalRevenue: 0,
      totalExpenses: 0,
      netIncome: 0,
      accountsReceivable: 0,
      accountsPayable: 0,
      totalCustomers: 0,
      totalInvoices: 0
    };
  }
};

// Get chart data for a specific chart
exports.getChartData = async (req, res) => {
  try {
    const { companyId, chartId } = req.params;

    const chartConfig = await ChartConfig.findOne({
      where: { 
        id: chartId,
        company_id: companyId 
      }
    });

    if (!chartConfig) {
      return res.status(404).json({ success: false, message: 'Chart not found' });
    }

    let chartData = [];

    // Generate chart data based on configuration
    switch (chartConfig.data_source) {
      case 'profit_loss':
        chartData = await getProfitLossData(companyId, chartConfig.configuration);
        break;
      case 'sales':
        chartData = await getSalesData(companyId, chartConfig.configuration);
        break;
      case 'expenses':
        chartData = await getExpensesData(companyId, chartConfig.configuration);
        break;
      default:
        chartData = await getCustomQueryData(companyId, chartConfig.configuration);
    }

    res.json({
      success: true,
      data: {
        chartConfig,
        chartData
      }
    });

  } catch (error) {
    console.error('Error getting chart data:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Helper functions for chart data
const getProfitLossData = async (companyId, config) => {
  // Get monthly profit/loss data
  const reports = await FinancialReport.findAll({
    where: { 
      company_id: companyId,
      report_type: 'profit_loss'
    },
    order: [['date_range_start', 'ASC']],
    limit: 12
  });

  return reports.map(report => ({
    month: report.date_range_start.toLocaleString('default', { month: 'short' }),
    profit: report.report_data?.Income || 0,
    loss: report.report_data?.Expenses || 0
  }));
};

const getSalesData = async (companyId, config) => {
  // Get sales data from invoices
  const invoices = await QuickBooksData.findAll({
    where: { 
      company_id: companyId,
      data_type: 'invoice'
    },
    limit: 100
  });

  // Group by month and calculate totals
  const salesByMonth = {};

  invoices.forEach(invoice => {
    const invoiceData = invoice.data;
    const date = new Date(invoiceData.TxnDate);
    const monthKey = `${date.getFullYear()}-${date.getMonth() + 1}`;
    
    if (!salesByMonth[monthKey]) {
      salesByMonth[monthKey] = {
        month: date.toLocaleString('default', { month: 'short' }),
        total: 0
      };
    }
    
    salesByMonth[monthKey].total += invoiceData.TotalAmt || 0;
  });

  return Object.values(salesByMonth);
};

const getExpensesData = async (companyId, config) => {
  // Get expenses by category
  const expenses = await QuickBooksData.findAll({
    where: { 
      company_id: companyId,
      data_type: 'bill'
    },
    limit: 100
  });

  const expensesByCategory = {};

  expenses.forEach(expense => {
    const expenseData = expense.data;
    const category = expenseData.Line?.[0]?.AccountBasedExpenseLineDetail?.AccountRef?.name || 'Other';
    
    if (!expensesByCategory[category]) {
      expensesByCategory[category] = {
        category,
        amount: 0
      };
    }
    
    expensesByCategory[category].amount += expenseData.TotalAmt || 0;
  });

  return Object.values(expensesByCategory);
};

const getCustomQueryData = async (companyId, config) => {
  // Implement custom query logic based on configuration
  return [];
};

/* ====================================================================== */
/*                      REPORT FUNCTIONS                                   */
/* ====================================================================== */

// Generate PDF report
// Generate PDF report
exports.generateReportPDF = async (req, res) => {
  try {
    const { companyId, reportId } = req.params;

    const report = await FinancialReport.findOne({
      where: { 
        id: reportId,
        company_id: companyId 
      }
    });

    if (!report) {
      return res.status(404).json({ success: false, message: 'Report not found' });
    }

    // Generate PDF using your preferred library
    // This is a placeholder - implement actual PDF generation
    const pdfBuffer = await generatePDFFromReport(report);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=report-${reportId}.pdf`);
    res.send(pdfBuffer);

  } catch (error) {
    console.error('Error generating PDF:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Schedule a report
exports.scheduleReport = async (req, res) => {
  try {
    const { companyId } = req.params;
    const { report_name, report_type, frequency, recipients, format } = req.body;

    // Calculate next generation date
    const nextGenerationAt = calculateNextGenerationDate(frequency);

    const scheduledReport = await ScheduledReport.create({
      company_id: companyId,
      report_name,
      report_type,
      frequency,
      recipients: recipients || [],
      format: format || 'pdf',
      next_generation_at: nextGenerationAt,
      is_active: true
    });

    res.status(201).json({
      success: true,
      message: 'Report scheduled successfully',
      data: scheduledReport
    });

  } catch (error) {
    console.error('Error scheduling report:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

const calculateNextGenerationDate = (frequency) => {
  const now = new Date();
  switch (frequency) {
    case 'daily':
      return new Date(now.setDate(now.getDate() + 1));
    case 'weekly':
      return new Date(now.setDate(now.getDate() + 7));
    case 'monthly':
      return new Date(now.setMonth(now.getMonth() + 1));
    case 'quarterly':
      return new Date(now.setMonth(now.getMonth() + 3));
    case 'yearly':
      return new Date(now.setFullYear(now.getFullYear() + 1));
    default:
      return new Date(now.setDate(now.getDate() + 1));
  }
};

// Generate PDF from report (placeholder)
const generatePDFFromReport = async (report) => {
  // Implement PDF generation logic here
  // You can use libraries like pdfkit, jsPDF, etc.
  return Buffer.from('PDF content');
};


/* ====================================================================== */
/*                      QUICKBOOKS AUTH FUNCTIONS                          */
/* ====================================================================== */

// Generate QuickBooks OAuth URL
exports.quickBooksAuth = async (req, res) => {
  try {
    const state = req.user.id; // logged in user id
    console.log("QuickBooks auth initiated for user:", state);

    const authUrl = `https://appcenter.intuit.com/connect/oauth2?client_id=${process.env.QB_CLIENT_ID}&response_type=code&scope=com.intuit.quickbooks.accounting&redirect_uri=${process.env.QB_REDIRECT_URI}&state=${state}`;

    res.json({ 
      success: true, 
      url: authUrl 
    });

  } catch (err) {
    console.error("Error in quickBooksAuth:", err);
    res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
};

// QuickBooks Refresh Token
exports.quickBooksRefreshToken = async (req, res) => {
  try {
    const { sourceId } = req.body;

    const source = await Source.findByPk(sourceId);

    if (!source) {
      return res.status(404).json({ 
        success: false, 
        message: 'Source not found' 
      });
    }

    const settings = source.connector_settings_json;
    
    const response = await axios.post(
      "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: settings.refresh_token
      }),
      {
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              `${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`
            ).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded"
        }
      }
    );

    settings.access_token = response.data.access_token;
    settings.refresh_token = response.data.refresh_token;
    settings.expires_at = Date.now() + response.data.expires_in * 1000;
    
    source.connector_settings_json = settings;
    await source.save();

    res.json({ 
      success: true, 
      message: "Token refreshed successfully" 
    });

  } catch (err) {
    console.error("Error refreshing token:", err);
    res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
};

// Get QuickBooks data for a source
exports.getQuickBooksData = async (req, res) => {
  try {
    const { sourceId } = req.params;

    const source = await Source.findByPk(sourceId);

    if (!source) {
      return res.status(404).json({ 
        success: false, 
        message: 'Source not found' 
      });
    }

    const settings = source.connector_settings_json;

    const baseUrl =
      process.env.QB_ENVIRONMENT === "sandbox"
        ? "https://sandbox-quickbooks.api.intuit.com"
        : "https://quickbooks.api.intuit.com";

    const headers = {
      Authorization: `Bearer ${settings.access_token}`,
      Accept: "application/json"
    };

    const customers = await axios.get(
      `${baseUrl}/v3/company/${settings.realmId}/query?query=select * from Customer`,
      { headers }
    );

    const invoices = await axios.get(
      `${baseUrl}/v3/company/${settings.realmId}/query?query=select * from Invoice`,
      { headers }
    );

    res.json({
      success: true,
      data: {
        customers: customers.data.QueryResponse.Customer || [],
        invoices: invoices.data.QueryResponse.Invoice || []
      }
    });

  } catch (err) {
    console.error("Error fetching QuickBooks data:", err);
    res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
};

// Get all QuickBooks entities
// exports.getAllQuickBooksEntities = async (req, res) => {
//   try {
//     const { sourceId } = req.params;
//     const { entityTypes } = req.query;

//     const source = await Source.findByPk(sourceId);

//     if (!source) {
//       return res.status(404).json({ 
//         success: false, 
//         message: 'Source not found' 
//       });
//     }

//     const settings = source.connector_settings_json;
    
//     // Check if token is expired and refresh if needed
//     if (settings.expires_at < Date.now()) {
//       // You'll need to implement token refresh logic here
//       return res.status(401).json({ 
//         success: false, 
//         message: 'Token expired. Please reconnect QuickBooks.' 
//       });
//     }

//     // Define all QuickBooks entity types
//     const allEntityTypes = [
//       'Account', 'Bill', 'BillPayment', 'Customer', 'Department',
//       'Deposit', 'Employee', 'Estimate', 'Invoice', 'Item',
//       'JournalEntry', 'Payment', 'PaymentMethod', 'Purchase',
//       'PurchaseOrder', 'RefundReceipt', 'SalesReceipt', 'TaxCode',
//       'TaxRate', 'Term', 'TimeActivity', 'Transfer', 'Vendor', 'VendorCredit'
//     ];

//     const typesToFetch = entityTypes ? entityTypes.split(',') : allEntityTypes;
//     const results = {};

//     const baseUrl = process.env.QB_ENVIRONMENT === "sandbox"
//       ? "https://sandbox-quickbooks.api.intuit.com"
//       : "https://quickbooks.api.intuit.com";

//     // Fetch each entity type
//     for (const entityType of typesToFetch) {
//       try {
//         console.log(`Fetching ${entityType}...`);
        
//         let allEntities = [];
//         let startPosition = 1;
//         const maxResults = 1000;
//         let hasMore = true;

//         while (hasMore) {
//           const query = `SELECT * FROM ${entityType} STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;
          
//           const response = await axios.get(
//             `${baseUrl}/v3/company/${settings.realmId}/query`,
//             {
//               params: { query },
//               headers: {
//                 Authorization: `Bearer ${settings.access_token}`,
//                 Accept: "application/json"
//               }
//             }
//           );

//           const entities = response.data.QueryResponse[entityType] || [];
//           allEntities = [...allEntities, ...entities];

//           if (entities.length < maxResults) {
//             hasMore = false;
//           } else {
//             startPosition += maxResults;
//           }
//         }

//         results[entityType] = allEntities;
//         console.log(`Fetched ${allEntities.length} ${entityType} records`);

//       } catch (error) {
//         console.error(`Error fetching ${entityType}:`, error.message);
//         results[entityType] = { error: error.message };
//       }
//     }

//     res.json({
//       success: true,
//       sourceId: source.id,
//       realmId: settings.realmId,
//       data: results,
//       summary: Object.keys(results).reduce((acc, key) => {
//         acc[key] = Array.isArray(results[key]) ? results[key].length : 0;
//         return acc;
//       }, {})
//     });

//   } catch (err) {
//     console.error("Error fetching QuickBooks data:", err);
//     res.status(500).json({ 
//       success: false, 
//       message: err.message 
//     });
//   }
// };

// Update this function in your QuickBookLogingController.js

// Get all QuickBooks entities
exports.getAllQuickBooksEntities = async (req, res) => {
  try {
    const { sourceId } = req.params;
    
    // 🟢 ADD THIS VALIDATION
    if (!sourceId || sourceId === 'undefined' || sourceId === 'null') {
      return res.status(400).json({ 
        success: false, 
        message: 'Valid source ID is required' 
      });
    }

    console.log(`Fetching source with ID: ${sourceId}`);

    const source = await Source.findByPk(parseInt(sourceId)); // 🟢 Parse to integer

    if (!source) {
      return res.status(404).json({ 
        success: false, 
        message: `Source not found with ID: ${sourceId}` 
      });
    }

    let settings = source.connector_settings_json;

    // Silent QB token refresh — same pattern as syncQuickBooksData. Only
    // bubble QB_TOKEN_EXPIRED to the client when the refresh itself fails.
    const TOKEN_BUFFER_MS = 60 * 1000;
    if (!settings?.expires_at || settings.expires_at < (Date.now() + TOKEN_BUFFER_MS)) {
      console.log('[QB entities] access token expired — attempting refresh...');
      const refreshed = await refreshSourceQuickBooksToken(source);
      if (!refreshed) {
        return res.status(409).json({
          success: false,
          errorCode: 'QB_TOKEN_EXPIRED',
          requiresReconnect: true,
          message: 'QuickBooks access token expired and could not be refreshed automatically. Please reconnect QuickBooks.'
        });
      }
      settings = refreshed;
      console.log('[QB entities] token refreshed silently.');
    }

    // Rest of your function remains the same...
    const { entityTypes } = req.query;
    
    // Define all QuickBooks entity types
    const allEntityTypes = [
      'Account', 'Bill', 'BillPayment', 'Customer', 'Department',
      'Deposit', 'Employee', 'Estimate', 'Invoice', 'Item',
      'JournalEntry', 'Payment', 'PaymentMethod', 'Purchase',
      'PurchaseOrder', 'RefundReceipt', 'SalesReceipt', 'TaxCode',
      'TaxRate', 'Term', 'TimeActivity', 'Transfer', 'Vendor', 'VendorCredit'
    ];

    const typesToFetch = entityTypes ? entityTypes.split(',') : allEntityTypes;
    const results = {};

    const baseUrl = process.env.QB_ENVIRONMENT === "sandbox"
      ? "https://sandbox-quickbooks.api.intuit.com"
      : "https://quickbooks.api.intuit.com";

    // Fetch each entity type
    for (const entityType of typesToFetch) {
      try {
        console.log(`Fetching ${entityType}...`);
        
        let allEntities = [];
        let startPosition = 1;
        const maxResults = 1000;
        let hasMore = true;

        while (hasMore) {
          const query = `SELECT * FROM ${entityType} STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;
          
          const response = await axios.get(
            `${baseUrl}/v3/company/${settings.realmId}/query`,
            {
              params: { query },
              headers: {
                Authorization: `Bearer ${settings.access_token}`,
                Accept: "application/json"
              }
            }
          );

          const entities = response.data.QueryResponse[entityType] || [];
          allEntities = [...allEntities, ...entities];

          if (entities.length < maxResults) {
            hasMore = false;
          } else {
            startPosition += maxResults;
          }
        }

        results[entityType] = allEntities;
        console.log(`Fetched ${allEntities.length} ${entityType} records`);

      } catch (error) {
        console.error(`Error fetching ${entityType}:`, error.message);
        results[entityType] = { error: error.message };
      }
    }

    res.json({
      success: true,
      sourceId: source.id,
      realmId: settings.realmId,
      data: results,
      summary: Object.keys(results).reduce((acc, key) => {
        acc[key] = Array.isArray(results[key]) ? results[key].length : 0;
        return acc;
      }, {})
    });

  } catch (err) {
    console.error("Error fetching QuickBooks data:", err);
    res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
};

// Get specific QuickBooks entity
exports.getQuickBooksEntity = async (req, res) => {
  try {
    const { sourceId, entityType } = req.params;
    const { limit, offset, where } = req.query;

    const source = await Source.findByPk(sourceId);

    if (!source) {
      return res.status(404).json({ 
        success: false, 
        message: 'Source not found' 
      });
    }

    const settings = source.connector_settings_json;

    const baseUrl = process.env.QB_ENVIRONMENT === "sandbox"
      ? "https://sandbox-quickbooks.api.intuit.com"
      : "https://quickbooks.api.intuit.com";

    let query = `SELECT * FROM ${entityType}`;
    
    if (where) {
      query += ` WHERE ${where}`;
    }
    
    if (limit) {
      query += ` MAXRESULTS ${limit}`;
    }
    
    if (offset) {
      query += ` STARTPOSITION ${offset}`;
    }

    const response = await axios.get(
      `${baseUrl}/v3/company/${settings.realmId}/query`,
      {
        params: { query },
        headers: {
          Authorization: `Bearer ${settings.access_token}`,
          Accept: "application/json"
        }
      }
    );

    res.json({
      success: true,
      entityType,
      data: response.data.QueryResponse[entityType] || [],
      totalCount: response.data.QueryResponse.totalCount || 0
    });

  } catch (err) {
    console.error(`Error fetching ${req.params.entityType}:`, err);
    res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
};

// Sync QuickBooks data
exports.syncQuickBooksData = async (req, res) => {
  try {
    const { sourceId } = req.params;
    
    const source = await Source.findByPk(sourceId);

    if (!source) {
      return res.status(404).json({ 
        success: false, 
        message: 'Source not found' 
      });
    }

    let settings = source.connector_settings_json;

    // 🟢 QB access tokens expire every ~1 hour. If expired (or within 60s of
    //    expiry — small buffer to avoid race conditions), try a silent refresh
    //    using the long-lived refresh_token (~100 days). Only if the refresh
    //    itself fails do we surface QB_TOKEN_EXPIRED to the user.
    const TOKEN_BUFFER_MS = 60 * 1000;
    if (!settings?.expires_at || settings.expires_at < (Date.now() + TOKEN_BUFFER_MS)) {
      console.log('[QB sync] access token expired — attempting refresh...');
      const refreshed = await refreshSourceQuickBooksToken(source);
      if (!refreshed) {
        return res.status(409).json({
          success: false,
          errorCode: 'QB_TOKEN_EXPIRED',
          requiresReconnect: true,
          message: 'QuickBooks access token expired and could not be refreshed automatically. Please reconnect QuickBooks.'
        });
      }
      settings = refreshed; // use the freshly-issued tokens for the rest of the request
      console.log('[QB sync] token refreshed silently.');
    }

    const companyId = settings.companyId;
    const realmId = settings.realmId;
    const accessToken = settings.access_token;

    if (!companyId || !realmId || !accessToken) {
      return res.status(400).json({
        success: false,
        message: "QuickBooks source is missing sync configuration."
      });
    }

    await QuickBooksConnection.update(
      { sync_status: 'pending', error_message: null },
      { where: { company_id: companyId } }
    );

    launchQuickBooksSyncInBackground(companyId, source.id, accessToken, realmId, { triggeredBy: 'manual' });

    res.status(202).json({
      success: true,
      message: "QuickBooks sync started in background.",
      sourceId: source.id,
      companyId,
      syncStatus: "pending"
    });

  } catch (err) {
    console.error("Error syncing QuickBooks data:", err);
    res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
};


// exports.getRealmIdByUserId = async (req, res) => {
//     try {
//         const { userId } = req.params;
//         console.log("Fetching realm ID for user:", userId);

//         if (!userId) {
//             return res.status(400).json({
//                 success: false,
//                 data: null,
//                 message: "User ID is required."
//             });
//         }

//         // First get the user to find their company_id
//         const user = await User.findByPk(userId, {
//             attributes: ['id', 'company_id']
//         });

//         if (!user) {
//             return res.status(404).json({
//                 success: false,
//                 data: null,
//                 message: "User not found."
//             });
//         }

//         if (!user.company_id) {
//             return res.status(404).json({
//                 success: false,
//                 data: null,
//                 message: "User is not associated with any company."
//             });
//         }

//         // Directly query the QuickBooksConnection table using company_id
//         const quickbooksConnection = await QuickBooksConnection.findOne({
//             where: { 
//                 company_id: user.company_id 
//             },
//             attributes: ['id', 'realm_id',  'sync_status', 'last_sync_at'],
//             include: [{
//                 model: Company,
//                 as: 'company', // This should match your association
//                 attributes: ['id', 'name']
//             }]
//         });
// console.log("QuickBooks connection found:", quickbooksConnection.company?.id);
//         if (!quickbooksConnection) {
//             return res.status(404).json({
//                 success: false,
//                 data: null,
//                 message: "No QuickBooks connection found for this user's company."
//             });
//         }

//         return res.status(200).json({
//             success: true,
//             data: {
//                 realmId: quickbooksConnection.realm_id,
//                 connectionId: quickbooksConnection.id,
//                 companyId:quickbooksConnection.company?.id,
//                 companyName: quickbooksConnection.company?.name,
//                 // connectedAt: quickbooksConnection.connected_at,
//                 // lastSyncAt: quickbooksConnection.last_sync_at,
//                 // syncStatus: quickbooksConnection.sync_status,
//                 // status: quickbooksConnection.status
//             },
//             message: "Realm ID retrieved successfully."
//         });

//     } catch (error) {
//         console.error("Error fetching realm ID by user ID:", error);
//         return res.status(500).json({
//             success: false,
//             data: null,
//             message: "Something went wrong while fetching realm ID.",
//             error: process.env.NODE_ENV === 'development' ? error.message : undefined
//         });
//     }
// };



// Helper function to check if token is expired
// const isTokenExpired = (quickbooksConnection) => {
//   if (!quickbooksConnection || !quickbooksConnection.expires_in || !quickbooksConnection.updated_at) {
//     return true; // If no expiry info, assume expired
//   }

//   // Calculate expiry time based on when token was updated
//   const expiryTime = new Date(quickbooksConnection.updated_at);
//   expiryTime.setSeconds(expiryTime.getSeconds() + quickbooksConnection.expires_in);
  
//   // Check if current time is past expiry time
//   const now = new Date();
//   return now > expiryTime;
// };

// Helper function to refresh QuickBooks token
// const refreshQuickBooksToken = async (quickbooksConnection) => {
//   try {
//     console.log("Refreshing expired token for connection:", quickbooksConnection.id);
    
//     const response = await axios.post(
//       "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
//       new URLSearchParams({
//         grant_type: "refresh_token",
//         refresh_token: quickbooksConnection.refresh_token
//       }),
//       {
//         headers: {
//           Authorization:
//             "Basic " +
//             Buffer.from(
//               `${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`
//             ).toString("base64"),
//           "Content-Type": "application/x-www-form-urlencoded"
//         }
//       }
//     );

//     const { access_token, refresh_token, expires_in } = response.data;
    
//     // Update the connection with new tokens
//     await quickbooksConnection.update({
//       access_token: access_token,
//       refresh_token: refresh_token,
//       expires_in: expires_in,
//       updated_at: new Date()
//     });

//     console.log("Token refreshed successfully for connection:", quickbooksConnection.id);
    
//     return true;
//   } catch (error) {
//     console.error("Error refreshing token:", error.response?.data || error.message);
//     return false;
//   }
// }; 

exports.getRealmIdByUserId = async (req, res) => {
    try {
        const { userId } = req.params;
        console.log("Fetching realm ID for user:", userId);

        if (!userId) {
            return res.status(400).json({
                success: false,
                data: null,
                message: "User ID is required."
            });
        }

        // First get the user to find their company_id
        const user = await User.findByPk(userId, {
            attributes: ['id', 'company_id']
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                data: null,
                message: "User not found."
            });
        }

        if (!user.company_id) {
            return res.status(404).json({
                success: false,
                data: null,
                message: "User is not associated with any company."
            });
        }

        // Directly query the QuickBooksConnection table using company_id
        const quickbooksConnection = await QuickBooksConnection.findOne({
            where: { 
                company_id: user.company_id 
            },
            attributes: [
                'id', 'realm_id', 'access_token', 'refresh_token', 
                'expires_in', 'updated_at', 'sync_status', 'last_sync_at'
            ],
            include: [{
                model: Company,
                as: 'company',
                attributes: ['id', 'name']
            }]
        });

        console.log("QuickBooks connection found:", quickbooksConnection?.company?.id);

        if (!quickbooksConnection) {
            return res.status(404).json({
                success: false,
                data: null,
                message: "No QuickBooks connection found for this user's company."
            });
        }

        // Check if token is expired - ONLY refresh if actually expired
        let tokenRefreshed = false;
        if (isTokenExpired(quickbooksConnection)) {
            console.log("Token is expired, refreshing...");
            const refreshSuccess = await refreshQuickBooksToken(quickbooksConnection);
            
            if (!refreshSuccess) {
                // 409 (not 401) — this is a QuickBooks token problem, not a
                // user session problem. Using 401 would cause the frontend
                // apiClient interceptor to logout the user.
                return res.status(409).json({
                    success: false,
                    data: null,
                    errorCode: 'QB_TOKEN_EXPIRED',
                    message: "QuickBooks token expired and could not be refreshed. Please reconnect QuickBooks.",
                    requiresReconnect: true
                });
            }
            
            tokenRefreshed = true;
            console.log("Token refreshed successfully");
        } else {
            console.log("Token is still valid, no refresh needed");
        }

        // Get the latest data (refresh the connection object if token was refreshed)
        const connectionData = tokenRefreshed 
            ? await QuickBooksConnection.findByPk(quickbooksConnection.id, {
                attributes: ['realm_id', 'sync_status', 'last_sync_at'],
                include: [{
                    model: Company,
                    as: 'company',
                    attributes: ['id', 'name']
                }]
              })
            : quickbooksConnection;

        return res.status(200).json({
            success: true,
            data: {
                realmId: connectionData.realm_id,
                connectionId: connectionData.id,
                companyId: connectionData.company?.id || user.company_id,
                companyName: connectionData.company?.name,
                syncStatus: connectionData.sync_status,
                lastSyncAt: connectionData.last_sync_at,
                tokenRefreshed: tokenRefreshed // Inform frontend if token was refreshed
            },
            message: tokenRefreshed 
                ? "Realm ID retrieved successfully with refreshed token." 
                : "Realm ID retrieved successfully."
        });

    } catch (error) {
        console.error("Error fetching realm ID by user ID:", error);
        return res.status(500).json({
            success: false,
            data: null,
            message: "Something went wrong while fetching realm ID.",
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

// Export all functions
// Export all functions
module.exports = {
  getRealmIdByUserId: exports.getRealmIdByUserId,
  // Company functions
  createCompany: exports.createCompany,
  getAllCompanies: exports.getAllCompanies,
  getCompanyById: exports.getCompanyById,
  updateCompany: exports.updateCompany,
  deleteCompany: exports.deleteCompany,
  
  // QuickBooks functions
  quickBooksAuth: exports.quickBooksAuth,           // ✅ Now this exists
  quickBooksCallback: exports.quickBooksCallback,
  quickBooksRefreshToken: exports.quickBooksRefreshToken,
  getQuickBooksData: exports.getQuickBooksData,
  getAllQuickBooksEntities: exports.getAllQuickBooksEntities,
  getQuickBooksEntity: exports.getQuickBooksEntity,
  syncQuickBooksData: exports.syncQuickBooksData,
  
  // Dashboard functions
  getCompanyDashboardData: exports.getCompanyDashboardData,
  getChartData: exports.getChartData,
  
  // Report functions
  generateReportPDF: exports.generateReportPDF,
  scheduleReport:    exports.scheduleReport,
  // triggerQuickBooksSyncForScheduler is assigned below after its declaration
};

// ── Scheduler-callable wrapper ────────────────────────────────────────────────
// triggerQuickBooksSync now handles its OWN logging, so this is a thin delegate
// that just tags the sync as 'scheduled'. (No separate SyncLog here — avoids
// duplicate log rows.)
const triggerQuickBooksSyncForScheduler = async (companyId, sourceId, accessToken, realmId) => {
  return triggerQuickBooksSync(companyId, sourceId, accessToken, realmId, { triggeredBy: 'scheduled' });
};

// Assign after declaration so module.exports (defined earlier) can reference it
module.exports.triggerQuickBooksSyncForScheduler = triggerQuickBooksSyncForScheduler;

// triggeredBy: 'manual' (Sync Data button) | 'initial' (first QB connect) | 'scheduled'
const launchQuickBooksSyncInBackground = (companyId, sourceId, accessToken, realmId, opts = {}) => {
  emitQuickBooksSyncProgress(
    buildQuickBooksSyncProgress({
      companyId,
      sourceId,
      stage: "queued",
      syncStatus: "pending",
    })
  );
  setImmediate(async () => {
    try {
      await triggerQuickBooksSync(companyId, sourceId, accessToken, realmId, opts);
    } catch (error) {
      console.error("[SYNC] Background sync launcher failed:", error);
    }
  });
};
