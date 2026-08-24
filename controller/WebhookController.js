const axios = require('axios');
const crypto = require('crypto');
const { QuickBooksConnection, Source } = require('../model/index');
const getRawEntityModel = require('../model/warehouse/RawEntityModel');
const DimAccount      = require('../model/warehouse/DimAccount');
const DimCustomer     = require('../model/warehouse/DimCustomer');
const FactTransaction = require('../model/warehouse/FactTransaction');

const DimVendor   = require('../model/warehouse/DimVendor');
const FactInvoice = require('../model/warehouse/FactInvoice');
const FactBill    = require('../model/warehouse/FactBill');

// ✅ v2 dual-write targets (Step 2 of legacy->v2 migration — see conversation).
// Legacy models above stay untouched/unchanged; these write the same webhook
// updates into quickbooks_domain.* alongside them. No source_type filtering
// needed here (v2 is single-source per schema).
const { getDomainModel } = require('../model/warehouse/DomainModelFactory');
require('../services/warehouse/transformers/quickbooksTransformer'); // registers quickbooks_domain models
const DimAccountV2      = getDomainModel('quickbooks', 'dim_accounts');
const DimCustomerV2     = getDomainModel('quickbooks', 'dim_customers');
const DimVendorV2       = getDomainModel('quickbooks', 'dim_vendors');
const FactInvoiceV2     = getDomainModel('quickbooks', 'fact_invoices');
const FactBillV2        = getDomainModel('quickbooks', 'fact_bills');
const FactTransactionV2 = getDomainModel('quickbooks', 'fact_transactions');
// Top pe add karo
const { isTokenExpired, refreshQuickBooksToken } = require('../utils/tokenHelper');
// ── Signature verify karo — QB ka genuine request hai ya nahi
// const verifyWebhookSignature = (payload, signature) => {
//   const token = process.env.QB_WEBHOOK_VERIFIER_TOKEN;
//   const hash = crypto
//     .createHmac('sha256', token)
//     .update(payload)
//     .digest('base64');
//   return hash === signature;
// };
// const verifyWebhookSignature = (rawBody, signature) => {
//   const token = process.env.QB_WEBHOOK_VERIFIER_TOKEN;
  
//   // ✅ Buffer ko string mein convert karo pehle
//   const bodyString = Buffer.isBuffer(rawBody) 
//     ? rawBody.toString('utf8') 
//     : rawBody;

//   const hash = crypto
//     .createHmac('sha256', token)
//     .update(bodyString)
//     .digest('base64');

//   console.log('[WEBHOOK] Expected signature:', hash);
//   console.log('[WEBHOOK] Received signature:', signature);
//   console.log('[WEBHOOK] Token used:', token);

//   return hash === signature;
// };


const verifyWebhookSignature = (rawBody, signature) => {
  const token = process.env.QB_WEBHOOK_VERIFIER_TOKEN;
  
  // ✅ Token debug
  console.log('[WEBHOOK] Token length:', token.length);
  console.log('[WEBHOOK] Token chars:', JSON.stringify(token));
  
  const bodyBuffer = Buffer.isBuffer(rawBody) 
    ? rawBody 
    : Buffer.from(rawBody);

  console.log('[WEBHOOK] Body length:', bodyBuffer.length);

  const hash = crypto
    .createHmac('sha256', token)
    .update(bodyBuffer)
    .digest('base64');

  console.log('[WEBHOOK] Expected:', hash);
  console.log('[WEBHOOK] Received:', signature);

  return hash === signature;
};




// ── Main webhook handler
// exports.quickBooksWebhook = async (req, res) => {
//   try {
//     console.log('[WEBHOOK] Received QuickBooks webhook:', JSON.stringify(req.body).substring(0, 500)); // log karo for debugging
//     // 1. Signature verify karo
//     const signature = req.headers['intuit-signature'];
//     const rawBody   = JSON.stringify(req.body);

//     if (!verifyWebhookSignature(rawBody, signature)) {
//       console.error('[WEBHOOK] Invalid signature — request rejected');
//       return res.status(401).send('Unauthorized');
//     }

//     // 2. QB ko turant 200 do — warna QB retry karega
//     res.status(200).send('OK');

//     // 3. Background mein process karo
//     const notifications = req.body.eventNotifications || [];

//     for (const notification of notifications) {
//       const realmId  = notification.realmId;
//       const entities = notification.dataChangeEvent?.entities || [];

//       console.log(`[WEBHOOK] realmId: ${realmId}, changes: ${entities.length}`);

//       await processChangedEntities(realmId, entities);
//     }

//   } catch (error) {
//     console.error('[WEBHOOK] Error:', error.message);
//   }
// };


exports.quickBooksWebhook = async (req, res) => {
  try {
    const signature = req.headers['intuit-signature'];
    
    // ✅ rawBody directly use karo — already Buffer hai
    const rawBody = req.body;

    console.log('[WEBHOOK] Signature received:', signature);

    if (!signature) {
      console.error('[WEBHOOK] No signature header found');
      return res.status(401).send('Unauthorized');
    }

    if (!verifyWebhookSignature(rawBody, signature)) {
      console.error('[WEBHOOK] Invalid signature — request rejected');
      return res.status(401).send('Unauthorized');
    }

    // ✅ Buffer ko JSON parse karo
    const bodyString = Buffer.isBuffer(rawBody) 
      ? rawBody.toString('utf8') 
      : rawBody;
    const payload = JSON.parse(bodyString);

    console.log('[WEBHOOK] Parsed payload:', JSON.stringify(payload));

    // ✅ QB ko turant 200 do
    res.status(200).send('OK');

    // Background mein process karo
    const notifications = payload.eventNotifications || [];
    for (const notification of notifications) {
      const realmId  = notification.realmId;
      const entities = notification.dataChangeEvent?.entities || [];
      console.log(`[WEBHOOK] realmId: ${realmId}, changes: ${entities.length}`);
      await processChangedEntities(realmId, entities);
    }

  } catch (error) {
    console.error('[WEBHOOK] Error:', error.message);
    res.status(500).send('Error');
  }
};
// ── Changed entities process karo
// const processChangedEntities = async (realmId, entities) => {
//   try {
//     // Company dhundo
//     const connection = await QuickBooksConnection.findOne({
//       where: { realm_id: realmId }
//     });
//     if (!connection) {
//       console.error(`[WEBHOOK] No connection found for realmId: ${realmId}`);
//       return;
//     }

//     const companyId    = connection.company_id;
//     const access_token = connection.access_token;

//     const baseUrl = process.env.QB_ENVIRONMENT === 'sandbox'
//       ? 'https://sandbox-quickbooks.api.intuit.com'
//       : 'https://quickbooks.api.intuit.com';

//     for (const entity of entities) {
//       const { id, name, operation } = entity;
//       // operation: 'Create' | 'Update' | 'Delete' | 'Merge' | 'Reactivate'

//       console.log(`[WEBHOOK] ${operation} → ${name} #${id}`);

//       try {
//         if (operation === 'Delete') {
//           // RAW mein deleted mark karo
//           const RawModel = await getRawEntityModel(name);
//           await RawModel.update(
//             { is_deleted: true },
//             { where: { company_id: companyId, source_id: id } }
//           );

//         } else {
//           // QB se fresh data fetch karo
//           const response = await axios.get(
//             `${baseUrl}/v3/company/${realmId}/${name.toLowerCase()}/${id}`,
//             {
//               headers: {
//                 Authorization: `Bearer ${access_token}`,
//                 Accept: 'application/json'
//               }
//             }
//           );

//           const entityData = response.data[name];
//           if (!entityData) continue;

//           // RAW layer update
//           const RawModel = await getRawEntityModel(name);
//           await RawModel.upsert({
//             company_id:  companyId,
//             source_type: 'quickbooks',
//             source_id:   entityData.Id,
//             raw_payload: entityData,
//             sync_token:  entityData.SyncToken || null,
//             ingested_at: new Date()
//           }, { conflictFields: ['company_id', 'source_type', 'source_id'] });

//           // GOLD layer update
//           await updateGoldLayer(companyId, name, entityData);

//           console.log(`[WEBHOOK] ✓ ${name} #${id} updated in warehouse`);
//         }

//       } catch (err) {
//         console.error(`[WEBHOOK] Error processing ${name} #${id}:`, err.message);
//       }
//     }

//   } catch (error) {
//     console.error('[WEBHOOK] processChangedEntities error:', error.message);
//   }
// };
// const processChangedEntities = async (realmId, entities) => {
//   try {
//     const connection = await QuickBooksConnection.findOne({
//       where: { realm_id: String(realmId) }
//     });

//     if (!connection) {
//       console.error(`[WEBHOOK] No connection found for realmId: ${realmId}`);
//       return;
//     }

//     const companyId = connection.company_id;
//     let access_token = connection.access_token;

//     // ✅ Token expired check karo — refresh karo
//     if (isTokenExpired(connection)) {
//       console.log('[WEBHOOK] Token expired — refreshing...');
//       const refreshed = await refreshQuickBooksToken(connection);
      
//       if (!refreshed) {
//         console.error('[WEBHOOK] Token refresh failed');
//         return;
//       }

//       // Fresh token lo DB se
//       const updatedConnection = await QuickBooksConnection.findOne({
//         where: { realm_id: String(realmId) }
//       });
//       access_token = updatedConnection.access_token;
//       console.log('[WEBHOOK] Token refreshed ✓');
//     }

//     const baseUrl = process.env.QB_ENVIRONMENT === 'sandbox'
//       ? 'https://sandbox-quickbooks.api.intuit.com'
//       : 'https://quickbooks.api.intuit.com';

//     for (const entity of entities) {
//       const { id, name, operation } = entity;
//       console.log(`[WEBHOOK] ${operation} → ${name} #${id}`);

//       try {
//         if (operation === 'Delete') {
//           const RawModel = await getRawEntityModel(name);
//           await RawModel.update(
//             { is_deleted: true },
//             { where: { company_id: companyId, source_id: id } }
//           );
//           console.log(`[WEBHOOK] ✓ ${name} #${id} marked deleted`);

//         } else {
//           // ✅ Fresh token se fetch karo
//           const response = await axios.get(
//             `${baseUrl}/v3/company/${realmId}/${name.toLowerCase()}/${id}`,
//             {
//               headers: {
//                 Authorization: `Bearer ${access_token}`,
//                 Accept: 'application/json'
//               }
//             }
//           );

//           const entityData = response.data[name];
//           if (!entityData) {
//             console.error(`[WEBHOOK] No data returned for ${name} #${id}`);
//             continue;
//           }

//           // RAW update
//           const RawModel = await getRawEntityModel(name);
//           await RawModel.upsert({
//             company_id:  companyId,
//             source_type: 'quickbooks',
//             source_id:   entityData.Id,
//             raw_payload: entityData,
//             sync_token:  entityData.SyncToken || null,
//             ingested_at: new Date()
//           }, { conflictFields: ['company_id', 'source_type', 'source_id'] });

//           // GOLD update
//           await updateGoldLayer(companyId, name, entityData);

//           console.log(`[WEBHOOK] ✓ ${name} #${id} updated in warehouse`);
//         }

//       } catch (err) {
//         // ✅ 401 specifically handle karo
//         if (err.response?.status === 401) {
//           console.error(`[WEBHOOK] 401 — Token invalid for ${name} #${id}. Re-syncing token...`);
          
//           // Force refresh karo
//           await refreshQuickBooksToken(connection);
//           console.log('[WEBHOOK] Token force refreshed — next webhook will work');
//         } else {
//           console.error(`[WEBHOOK] Error processing ${name} #${id}:`, err.message);
//         }
//       }
//     }

//   } catch (error) {
//     console.error('[WEBHOOK] processChangedEntities error:', error.message);
//   }
// };

// const processChangedEntities = async (realmId, entities) => {
//   try {
//     const connection = await QuickBooksConnection.findOne({
//       where: { realm_id: String(realmId) }
//     });
//     if (!connection) return;

//     const companyId    = connection.company_id;
//     let access_token   = connection.access_token;

//     // Token refresh
//     if (isTokenExpired(connection)) {
//       const refreshed = await refreshQuickBooksToken(connection);
//       if (!refreshed) return;
//       const updated  = await QuickBooksConnection.findOne({ where: { realm_id: String(realmId) } });
//       access_token   = updated.access_token;
//     }

//     const baseUrl = process.env.QB_ENVIRONMENT === 'sandbox'
//       ? 'https://sandbox-quickbooks.api.intuit.com'
//       : 'https://quickbooks.api.intuit.com';

//     for (const entity of entities) {
//       const { id, name, operation } = entity;

//       try {
//         if (operation === 'Delete') {
//           const RawModel = await getRawEntityModel(name);
//           await RawModel.update(
//             { is_deleted: true },
//             { where: { company_id: companyId, source_id: id } }
//           );
//         } else {
//           const response = await axios.get(
//             `${baseUrl}/v3/company/${realmId}/${name.toLowerCase()}/${id}`,
//             { headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json' } }
//           );

//           const entityData = response.data[name];
//           if (!entityData) continue;

//           // RAW update
//           const RawModel = await getRawEntityModel(name);
//           await RawModel.upsert({
//             company_id:  companyId,
//             source_type: 'quickbooks',
//             source_id:   entityData.Id,
//             raw_payload: entityData,
//             sync_token:  entityData.SyncToken || null,
//             ingested_at: new Date()
//           }, { conflictFields: ['company_id', 'source_type', 'source_id'] });

//           // GOLD update
//           await updateGoldLayer(companyId, name, entityData);

//           console.log(`[WEBHOOK] ✓ ${name} #${id} updated`);
//         }

//         // ✅ Frontend ko notify karo — real-time update
//         if (global.io) {
//           global.io.to(`company_${companyId}`).emit('data_updated', {
//             entity:    name,
//             operation: operation,
//             id:        id,
//             timestamp: new Date()
//           });
//           console.log(`[WS] Notified company_${companyId} — ${name} ${operation}`);
//         }

//       } catch (err) {
//         if (err.response?.status === 401) {
//           await refreshQuickBooksToken(connection);
//         } else {
//           console.error(`[WEBHOOK] Error ${name} #${id}:`, err.message);
//         }
//       }
//     }

//   } catch (error) {
//     console.error('[WEBHOOK] Error:', error.message);
//   }
// };


// WebhookController.js mein processChangedEntities ke end mein add karo

const processChangedEntities = async (realmId, entities) => {
  try {
    const connection = await QuickBooksConnection.findOne({
      where: { realm_id: String(realmId) }
    });
    if (!connection) return;

    const companyId    = connection.company_id;
    let access_token   = connection.access_token;

    // Token refresh
    if (isTokenExpired(connection)) {
      const refreshed = await refreshQuickBooksToken(connection);
      if (!refreshed) return;
      const updated  = await QuickBooksConnection.findOne({ where: { realm_id: String(realmId) } });
      access_token   = updated.access_token;
    }

    const baseUrl = process.env.QB_ENVIRONMENT === 'sandbox'
      ? 'https://sandbox-quickbooks.api.intuit.com'
      : 'https://quickbooks.api.intuit.com';

    for (const entity of entities) {
      const { id, name, operation } = entity;
      console.log(`[WEBHOOK] ${operation} → ${name} #${id}`);

      try {
        if (operation === 'Delete') {
          const RawModel = await getRawEntityModel(name);
          await RawModel.update(
            { is_deleted: true },
            { where: { company_id: companyId, source_id: id } }
          );
        } else {
          const response = await axios.get(
            `${baseUrl}/v3/company/${realmId}/${name.toLowerCase()}/${id}`,
            { headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json' } }
          );

          const entityData = response.data[name];
          if (!entityData) continue;

          // RAW update
          const RawModel = await getRawEntityModel(name);
          await RawModel.upsert({
            company_id:  companyId,
            source_type: 'quickbooks',
            source_id:   entityData.Id,
            raw_payload: entityData,
            sync_token:  entityData.SyncToken || null,
            ingested_at: new Date()
          }, { conflictFields: ['company_id', 'source_type', 'source_id'] });

          // GOLD update — v2 primary (Step 5, legacy retirement: dashboard
          // reads only quickbooks_domain now). Legacy write kept below,
          // isolated, for rollback safety.
          await updateGoldLayerV2(companyId, name, entityData);

          try {
            await updateGoldLayer(companyId, name, entityData); // legacy
          } catch (legacyErr) {
            console.error(`[WEBHOOK] legacy GOLD update error ${name} #${id}:`, legacyErr.message);
          }
        }

        // Frontend notify
        if (global.io) {
          global.io.to(`company_${companyId}`).emit('data_updated', {
            entity: name, operation, id, timestamp: new Date()
          });
        }

      } catch (err) {
        if (err.response?.status === 401) {
          await refreshQuickBooksToken(connection);
        } else {
          console.error(`[WEBHOOK] Error ${name} #${id}:`, err.message);
        }
      }
    }

    // ✅ SAFETY NET — har webhook ke baad agg table refresh karo
    await refreshAggregates(companyId);

  } catch (error) {
    console.error('[WEBHOOK] Error:', error.message);
  }
};

// ✅ Aggregates refresh function
const refreshAggregates = async (companyId) => {
  try {
    const { warehouseDB } = require('../connection/dbConnection');
    await warehouseDB.query(`
      INSERT INTO domain_tables.agg_revenue_monthly 
        (company_id, year, month, month_label, revenue, expenses, net_profit, invoice_count, source_type)
      SELECT
        company_id,
        EXTRACT(YEAR  FROM transaction_date)::int,
        EXTRACT(MONTH FROM transaction_date)::int,
        TO_CHAR(transaction_date, 'Mon YYYY'),
        SUM(CASE WHEN transaction_type = 'revenue' THEN amount ELSE 0 END),
        SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END),
        SUM(CASE WHEN transaction_type = 'revenue' THEN amount ELSE 0 END) -
        SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END),
        COUNT(CASE WHEN transaction_type = 'revenue' THEN 1 END),
        source_type
      FROM domain_tables.fact_transactions
      WHERE company_id = ${companyId}
      GROUP BY company_id, EXTRACT(YEAR FROM transaction_date), 
               EXTRACT(MONTH FROM transaction_date),
               TO_CHAR(transaction_date, 'Mon YYYY'), source_type
      ON CONFLICT (company_id, year, month, source_type)
      DO UPDATE SET
        revenue       = EXCLUDED.revenue,
        expenses      = EXCLUDED.expenses,
        net_profit    = EXCLUDED.net_profit,
        invoice_count = EXCLUDED.invoice_count,
        updated_at    = NOW();
    `);
    console.log(`[WEBHOOK] Aggregates refreshed for company ${companyId}`);
  } catch (error) {
    console.error('[WEBHOOK] Aggregate refresh error:', error.message);
  }
};

// ── GOLD layer — sirf changed entity update karo
const updateGoldLayer = async (companyId, entityType, entityData) => {
  switch (entityType) {

    case 'Invoice':
      await FactTransaction.upsert({
        company_id:       companyId,
        transaction_date: entityData.TxnDate,
        amount:           entityData.TotalAmt || 0,
        transaction_type: 'revenue',
        account_id:       entityData.DepositToAccountRef?.value || null,
        customer_id:      entityData.CustomerRef?.value || null,
        source_type:      'quickbooks',
        source_ref_id:    `invoice_${entityData.Id}`,
        currency:         entityData.CurrencyRef?.value || 'USD',
        is_paid:          entityData.Balance === 0
      }, { conflictFields: ['company_id', 'source_type', 'source_ref_id'] });
      break;

    case 'Bill':
      await FactTransaction.upsert({
        company_id:       companyId,
        transaction_date: entityData.TxnDate,
        amount:           entityData.TotalAmt || 0,
        transaction_type: 'expense',
        account_id:       entityData.APAccountRef?.value || null,
        customer_id:      null,
        source_type:      'quickbooks',
        source_ref_id:    `bill_${entityData.Id}`,
        currency:         entityData.CurrencyRef?.value || 'USD',
        is_paid:          entityData.Balance === 0
      }, { conflictFields: ['company_id', 'source_type', 'source_ref_id'] });
      break;

    case 'Payment':
      await FactTransaction.upsert({
        company_id:       companyId,
        transaction_date: entityData.TxnDate,
        amount:           entityData.TotalAmt || 0,
        transaction_type: 'payment',
        account_id:       entityData.DepositToAccountRef?.value || null,
        customer_id:      entityData.CustomerRef?.value || null,
        source_type:      'quickbooks',
        source_ref_id:    `payment_${entityData.Id}`,
        currency:         entityData.CurrencyRef?.value || 'USD',
        is_paid:          true
      }, { conflictFields: ['company_id', 'source_type', 'source_ref_id'] });
      break;

    case 'Account':
      await DimAccount.upsert({
        company_id:       companyId,
        account_id:       entityData.Id,
        account_name:     entityData.Name,
        account_type:     entityData.AccountType,
        account_sub_type: entityData.AccountSubType || null,
        current_balance:  entityData.CurrentBalance || 0,
        currency:         entityData.CurrencyRef?.value || 'USD',
        is_active:        entityData.Active !== false,
        updated_at:       new Date()
      }, { conflictFields: ['company_id', 'account_id'] });
      break;

    // case 'Customer':
    //   await DimCustomer.upsert({
    //     company_id:   companyId,
    //     customer_id:  entityData.Id,
    //     display_name: entityData.DisplayName,
    //     email:        entityData.PrimaryEmailAddr?.Address || null,
    //     balance:      entityData.Balance || 0,
    //     is_active:    entityData.Active !== false,
    //     updated_at:   new Date()
    //   }, { conflictFields: ['company_id', 'customer_id'] });
    //   break;

// case 'Customer':
//       await DimCustomer.upsert({
//         company_id:   companyId,
//         customer_id:  entityData.Id,
//         display_name: entityData.DisplayName,
//         email:        entityData.PrimaryEmailAddr?.Address || null,
//         balance:      entityData.Balance  || 0,
//         is_active:    entityData.Active !== false,
//         updated_at:   new Date()
//       }, { conflictFields: ['company_id', 'customer_id'] });

//       // ✅ fact_invoices mein bhi customer_name update karo
//       await FactInvoice.update(
//         { customer_name: entityData.DisplayName },
//         { where: { company_id: companyId, customer_id: entityData.Id } }
//       );
//       console.log(`[WEBHOOK] ✓ Customer ${entityData.DisplayName} updated`);
//       break;

case 'Customer':
  await DimCustomer.upsert({
    company_id:   companyId,
    customer_id:  entityData.Id,
    display_name: entityData.DisplayName,
    email:        entityData.PrimaryEmailAddr?.Address || null,
    balance:      parseFloat(entityData.Balance  || 0),
    is_active:    entityData.Active === false ? false : true, // ✅ fix
    updated_at:   new Date()
  }, { conflictFields: ['company_id', 'customer_id'] });

  await FactInvoice.update(
    { customer_name: entityData.DisplayName },
    { where: { company_id: companyId, customer_id: entityData.Id } }
  );
  console.log(`[WEBHOOK] ✓ DimCustomer saved: ${entityData.Id} — ${entityData.DisplayName}`);
  break;
    case 'Vendor':
      await DimVendor.upsert({
        company_id:   companyId,
        vendor_id:    entityData.Id,
        display_name: entityData.DisplayName,
        email:        entityData.PrimaryEmailAddr?.Address    || null,
        phone:        entityData.PrimaryPhone?.FreeFormNumber || null,
        balance:      entityData.Balance  || 0,
        is_active:    entityData.Active !== false,
        updated_at:   new Date()
      }, { conflictFields: ['company_id', 'vendor_id'] });

      // ✅ fact_bills mein bhi vendor_name update karo
      await FactBill.update(
        { vendor_name: entityData.DisplayName },
        { where: { company_id: companyId, vendor_id: entityData.Id } }
      );
      console.log(`[WEBHOOK] ✓ Vendor ${entityData.DisplayName} updated`);
      break;


    default:
      console.log(`[WEBHOOK] GOLD update skipped for: ${entityType}`);
  }
};

// ── v2 GOLD layer (quickbooks_domain) — mirrors updateGoldLayer above.
// No source_type on the conflict fields (v2 schema is single-source).
const updateGoldLayerV2 = async (companyId, entityType, entityData) => {
  switch (entityType) {

    case 'Invoice':
      await FactTransactionV2.upsert({
        company_id:       companyId,
        transaction_date: entityData.TxnDate,
        amount:           entityData.TotalAmt || 0,
        transaction_type: 'revenue',
        account_id:       entityData.DepositToAccountRef?.value || null,
        customer_id:      entityData.CustomerRef?.value || null,
        source_ref_id:    `invoice_${entityData.Id}`,
        currency:         entityData.CurrencyRef?.value || 'USD',
        is_paid:          entityData.Balance === 0
      }, { conflictFields: ['company_id', 'source_ref_id'] });

      await FactInvoiceV2.upsert({
        company_id:       companyId,
        invoice_id:       entityData.Id,
        doc_number:       entityData.DocNumber || null,
        customer_id:      entityData.CustomerRef?.value || null,
        customer_name:    entityData.CustomerRef?.name || null,
        transaction_date: entityData.TxnDate,
        due_date:         entityData.DueDate || null,
        amount:           entityData.TotalAmt || 0,
        balance:          entityData.Balance || 0,
        currency:         entityData.CurrencyRef?.value || 'USD'
      }, { conflictFields: ['company_id', 'invoice_id'] });
      break;

    case 'Bill':
      await FactTransactionV2.upsert({
        company_id:       companyId,
        transaction_date: entityData.TxnDate,
        amount:           entityData.TotalAmt || 0,
        transaction_type: 'expense',
        account_id:       entityData.APAccountRef?.value || null,
        customer_id:      null,
        source_ref_id:    `bill_${entityData.Id}`,
        currency:         entityData.CurrencyRef?.value || 'USD',
        is_paid:          entityData.Balance === 0
      }, { conflictFields: ['company_id', 'source_ref_id'] });

      await FactBillV2.upsert({
        company_id:       companyId,
        bill_id:          entityData.Id,
        doc_number:       entityData.DocNumber || null,
        vendor_id:        entityData.VendorRef?.value || null,
        vendor_name:      entityData.VendorRef?.name || null,
        transaction_date: entityData.TxnDate,
        due_date:         entityData.DueDate || null,
        amount:           entityData.TotalAmt || 0,
        balance:          entityData.Balance || 0,
        currency:         entityData.CurrencyRef?.value || 'USD'
      }, { conflictFields: ['company_id', 'bill_id'] });
      break;

    case 'Payment':
      await FactTransactionV2.upsert({
        company_id:       companyId,
        transaction_date: entityData.TxnDate,
        amount:           entityData.TotalAmt || 0,
        transaction_type: 'payment',
        account_id:       entityData.DepositToAccountRef?.value || null,
        customer_id:      entityData.CustomerRef?.value || null,
        source_ref_id:    `payment_${entityData.Id}`,
        currency:         entityData.CurrencyRef?.value || 'USD',
        is_paid:          true
      }, { conflictFields: ['company_id', 'source_ref_id'] });
      break;

    case 'Account':
      await DimAccountV2.upsert({
        company_id:       companyId,
        account_id:       entityData.Id,
        account_name:     entityData.Name,
        account_type:     entityData.AccountType,
        account_sub_type: entityData.AccountSubType || null,
        current_balance:  entityData.CurrentBalance || 0,
        currency:         entityData.CurrencyRef?.value || 'USD',
        is_active:        entityData.Active !== false,
        updated_at:       new Date()
      }, { conflictFields: ['company_id', 'account_id'] });
      break;

    case 'Customer':
      await DimCustomerV2.upsert({
        company_id:   companyId,
        customer_id:  entityData.Id,
        display_name: entityData.DisplayName,
        email:        entityData.PrimaryEmailAddr?.Address || null,
        balance:      parseFloat(entityData.Balance || 0),
        is_active:    entityData.Active !== false,
        updated_at:   new Date()
      }, { conflictFields: ['company_id', 'customer_id'] });

      await FactInvoiceV2.update(
        { customer_name: entityData.DisplayName },
        { where: { company_id: companyId, customer_id: entityData.Id } }
      );
      break;

    case 'Vendor':
      await DimVendorV2.upsert({
        company_id:   companyId,
        vendor_id:    entityData.Id,
        display_name: entityData.DisplayName,
        email:        entityData.PrimaryEmailAddr?.Address    || null,
        phone:        entityData.PrimaryPhone?.FreeFormNumber || null,
        balance:      entityData.Balance || 0,
        is_active:    entityData.Active !== false,
        updated_at:   new Date()
      }, { conflictFields: ['company_id', 'vendor_id'] });

      await FactBillV2.update(
        { vendor_name: entityData.DisplayName },
        { where: { company_id: companyId, vendor_id: entityData.Id } }
      );
      break;

    default:
      // no v2 dim/fact table for this entity type yet — nothing to dual-write
      break;
  }
};


