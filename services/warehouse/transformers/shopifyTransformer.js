// services/warehouse/transformers/shopifyTransformer.js
// Shopify raw -> domain pipeline. Tables live in `shopify_domain`.
//
// Conventional Shopify entity names you should pass to insertRawData:
//   'Customer', 'Product', 'Order', 'Transaction',
//   'CustomCollection', 'SmartCollection', 'DraftOrder', 'PriceRule'

const { DataTypes } = require('sequelize');
const { defineDomainModel } = require('../../../model/warehouse/DomainModelFactory');
const { getRawModel } = require('../../../model/warehouse/RawModelFactory');
const { registerTransformer } = require('../ingestionService');

const SOURCE = 'shopify';

// ---------- existing models ----------

const DimCustomer = defineDomainModel(SOURCE, 'dim_customers', {
  customer_sk:  { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:   { type: DataTypes.INTEGER, allowNull: false },
  customer_id:  { type: DataTypes.STRING, allowNull: false },
  display_name: { type: DataTypes.STRING },
  email:        { type: DataTypes.STRING },
  phone:        { type: DataTypes.STRING },
  total_spent:  { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  orders_count: { type: DataTypes.BIGINT, defaultValue: 0 },   // BIGINT: large stores exceed INTEGER
  state:        { type: DataTypes.STRING(32) },
  updated_at:   { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, { indexes: [{ unique: true, fields: ['company_id', 'customer_id'] }] });
DimCustomer.sync({ force: false }).catch(e => console.warn('[sync] dim_customers:', e.message));

const DimProduct = defineDomainModel(SOURCE, 'dim_products', {
  product_sk:   { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:   { type: DataTypes.INTEGER, allowNull: false },
  product_id:   { type: DataTypes.STRING, allowNull: false },
  title:        { type: DataTypes.STRING },
  vendor:       { type: DataTypes.STRING },
  product_type: { type: DataTypes.STRING },
  status:       { type: DataTypes.STRING(16) },
  price:        { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  sku:          { type: DataTypes.STRING },
  inventory_qty:{ type: DataTypes.BIGINT, defaultValue: 0 },   // BIGINT: Shopify uses 9999999999 for "unlimited"
  updated_at:   { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, { indexes: [{ unique: true, fields: ['company_id', 'product_id'] }] });
DimProduct.sync({ force: false }).catch(e => console.warn('[sync] dim_products:', e.message));

const FactOrder = defineDomainModel(SOURCE, 'fact_orders', {
  order_sk:         { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:       { type: DataTypes.INTEGER, allowNull: false },
  order_id:         { type: DataTypes.STRING, allowNull: false },
  order_number:     { type: DataTypes.STRING },
  customer_id:      { type: DataTypes.STRING },
  customer_email:   { type: DataTypes.STRING },
  transaction_date: { type: DataTypes.DATE },
  subtotal:         { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  tax_amount:       { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  shipping_amount:  { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  discount_amount:  { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  total_amount:     { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  financial_status: { type: DataTypes.STRING(32) },
  fulfillment_status:{ type: DataTypes.STRING(32) },
  currency:         { type: DataTypes.STRING(8), defaultValue: 'USD' },
  line_items_count: { type: DataTypes.BIGINT, defaultValue: 0 },
  created_at:       { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [
    { unique: true, fields: ['company_id', 'order_id'] },
    { fields: ['transaction_date'] },
    { fields: ['financial_status'] },
  ],
});
FactOrder.sync({ force: false }).catch(e => console.warn('[sync] fact_orders:', e.message));

const FactOrderLine = defineDomainModel(SOURCE, 'fact_order_lines', {
  order_line_sk:    { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:       { type: DataTypes.INTEGER, allowNull: false },
  order_id:         { type: DataTypes.STRING, allowNull: false },
  line_item_id:     { type: DataTypes.STRING, allowNull: false },
  product_id:       { type: DataTypes.STRING },
  variant_id:       { type: DataTypes.STRING },
  title:            { type: DataTypes.STRING },
  sku:              { type: DataTypes.STRING },
  quantity:         { type: DataTypes.BIGINT, defaultValue: 0 },
  price:            { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  total_discount:   { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  line_total:       { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  currency:         { type: DataTypes.STRING(8), defaultValue: 'USD' },
  transaction_date: { type: DataTypes.DATE },
}, {
  indexes: [
    { unique: true, fields: ['company_id', 'line_item_id'] },
    { fields: ['order_id'] },
    { fields: ['product_id'] },
  ],
});
FactOrderLine.sync({ force: false }).catch(e => console.warn('[sync] fact_order_lines:', e.message));

// ---------- new models ----------

const DimCollection = defineDomainModel(SOURCE, 'dim_collections', {
  collection_sk:   { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:      { type: DataTypes.INTEGER, allowNull: false },
  collection_id:   { type: DataTypes.STRING, allowNull: false },
  title:           { type: DataTypes.STRING },
  handle:          { type: DataTypes.STRING },
  collection_type: { type: DataTypes.STRING(16) },
  products_count:  { type: DataTypes.BIGINT, defaultValue: 0 },
  is_published:    { type: DataTypes.BOOLEAN, defaultValue: true },
  updated_at:      { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'collection_id'] }],
});
DimCollection.sync({ force: false }).catch(e => console.warn('[sync] dim_collections:', e.message));

const FactDraftOrder = defineDomainModel(SOURCE, 'fact_draft_orders', {
  draft_order_sk: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:     { type: DataTypes.INTEGER, allowNull: false },
  draft_order_id: { type: DataTypes.STRING, allowNull: false },
  order_number:   { type: DataTypes.STRING },
  customer_id:    { type: DataTypes.STRING, allowNull: true },
  customer_email: { type: DataTypes.STRING, allowNull: true },
  total_amount:   { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  currency:       { type: DataTypes.STRING(8), defaultValue: 'USD' },
  status:         { type: DataTypes.STRING(16) },
  created_at:     { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  completed_at:   { type: DataTypes.DATE, allowNull: true },
  updated_at:     { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'draft_order_id'] }],
});
FactDraftOrder.sync({ force: false }).catch(e => console.warn('[sync] fact_draft_orders:', e.message));

const DimPriceRule = defineDomainModel(SOURCE, 'dim_price_rules', {
  price_rule_sk: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:    { type: DataTypes.INTEGER, allowNull: false },
  price_rule_id: { type: DataTypes.STRING, allowNull: false },
  title:         { type: DataTypes.STRING },
  value_type:    { type: DataTypes.STRING(32) },
  value:         { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  target_type:   { type: DataTypes.STRING(32) },
  starts_at:     { type: DataTypes.DATE, allowNull: true },
  ends_at:       { type: DataTypes.DATE, allowNull: true },
  usage_limit:   { type: DataTypes.BIGINT, allowNull: true },
  is_active:     { type: DataTypes.BOOLEAN, defaultValue: true },
  updated_at:    { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'price_rule_id'] }],
});
DimPriceRule.sync({ force: false }).catch(e => console.warn('[sync] dim_price_rules:', e.message));

const DimLocation = defineDomainModel(SOURCE, 'dim_locations', {
  location_sk: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:  { type: DataTypes.INTEGER, allowNull: false },
  location_id: { type: DataTypes.STRING, allowNull: false },
  name:        { type: DataTypes.STRING },
  address1:    { type: DataTypes.STRING },
  city:        { type: DataTypes.STRING },
  province:    { type: DataTypes.STRING },
  country:     { type: DataTypes.STRING },
  zip:         { type: DataTypes.STRING },
  phone:       { type: DataTypes.STRING },
  is_active:   { type: DataTypes.BOOLEAN, defaultValue: true },
  updated_at:  { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'location_id'] }],
});
DimLocation.sync({ force: false }).catch(e => console.warn('[sync] dim_locations:', e.message));

const FactCollect = defineDomainModel(SOURCE, 'fact_collects', {
  collect_sk:    { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:    { type: DataTypes.INTEGER, allowNull: false },
  collect_id:    { type: DataTypes.STRING, allowNull: false },
  collection_id: { type: DataTypes.STRING },
  product_id:    { type: DataTypes.STRING },
  position:      { type: DataTypes.BIGINT, defaultValue: 0 },
  created_at:    { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'collect_id'] }],
});
FactCollect.sync({ force: false }).catch(e => console.warn('[sync] fact_collects:', e.message));

const FactAbandonedCheckout = defineDomainModel(SOURCE, 'fact_abandoned_checkouts', {
  checkout_sk:    { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:     { type: DataTypes.INTEGER, allowNull: false },
  checkout_id:    { type: DataTypes.STRING, allowNull: false },
  cart_token:     { type: DataTypes.STRING },
  customer_email: { type: DataTypes.STRING },
  total_price:    { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  currency:       { type: DataTypes.STRING(8), defaultValue: 'USD' },
  created_at:     { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  updated_at:     { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'checkout_id'] }],
});
FactAbandonedCheckout.sync({ force: false }).catch(e => console.warn('[sync] fact_abandoned_checkouts:', e.message));

const FactTenderTransaction = defineDomainModel(SOURCE, 'fact_tender_transactions', {
  tender_sk:      { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:     { type: DataTypes.INTEGER, allowNull: false },
  tender_id:      { type: DataTypes.STRING, allowNull: false },
  order_id:       { type: DataTypes.STRING },
  amount:         { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  currency:       { type: DataTypes.STRING(8), defaultValue: 'USD' },
  payment_method: { type: DataTypes.STRING },
  processed_at:   { type: DataTypes.DATEONLY },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'tender_id'] }],
});
FactTenderTransaction.sync({ force: false }).catch(e => console.warn('[sync] fact_tender_transactions:', e.message));

const DimGiftCard = defineDomainModel(SOURCE, 'dim_gift_cards', {
  gift_card_sk:  { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  company_id:    { type: DataTypes.INTEGER, allowNull: false },
  gift_card_id:  { type: DataTypes.STRING, allowNull: false },
  initial_value: { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  balance:       { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  currency:      { type: DataTypes.STRING(8), defaultValue: 'USD' },
  status:        { type: DataTypes.STRING(16) },
  created_at:    { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  expires_on:    { type: DataTypes.DATEONLY, allowNull: true },
}, {
  indexes: [{ unique: true, fields: ['company_id', 'gift_card_id'] }],
});
DimGiftCard.sync({ force: false }).catch(e => console.warn('[sync] dim_gift_cards:', e.message));

// ---------- helpers ----------
const fetchRaw = async (entity, companyId) => {
  const Model = getRawModel(SOURCE, entity);
  // Ensure table exists (no-op if already created; handles empty-fetch entities)
  await Model.sync({ force: false });
  return Model.findAll({ where: { company_id: companyId, is_deleted: false }, raw: true });
};

// ---------- existing transforms ----------
const transformDimCustomers = async (companyId) => {
  const rows = await fetchRaw('Customer', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:   companyId,
    customer_id:  String(d.id),
    display_name: [d.first_name, d.last_name].filter(Boolean).join(' ').trim() || null,
    email:        d.email || null,
    phone:        d.phone || null,
    total_spent:  Number(d.total_spent || 0),
    orders_count: Number(d.orders_count || 0),
    state:        d.state || null,
    updated_at:   new Date(),
  }));
  await DimCustomer.bulkCreate(mapped, {
    updateOnDuplicate: ['display_name', 'email', 'phone', 'total_spent', 'orders_count', 'state', 'updated_at'],
  });
  return mapped.length;
};

const transformDimProducts = async (companyId) => {
  const rows = await fetchRaw('Product', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => {
    const variant = (d.variants && d.variants[0]) || {};
    return {
      company_id:   companyId,
      product_id:   String(d.id),
      title:        d.title || null,
      vendor:       d.vendor || null,
      product_type: d.product_type || null,
      status:       d.status || null,
      price:        Number(variant.price || 0),
      sku:          variant.sku || null,
      inventory_qty:Number(variant.inventory_quantity || 0),
      updated_at:   new Date(),
    };
  });
  await DimProduct.bulkCreate(mapped, {
    updateOnDuplicate: ['title', 'vendor', 'product_type', 'status', 'price', 'sku', 'inventory_qty', 'updated_at'],
  });
  return mapped.length;
};

const transformFactOrders = async (companyId) => {
  const rows = await fetchRaw('Order', companyId);
  if (!rows.length) return { orders: 0, lines: 0 };

  const orderRows = [];
  const lineRows  = [];

  for (const { raw_payload: d } of rows) {
    orderRows.push({
      company_id:        companyId,
      order_id:          String(d.id),
      order_number:      String(d.order_number || d.name || ''),
      customer_id:       d.customer?.id ? String(d.customer.id) : null,
      customer_email:    d.email || d.customer?.email || null,
      transaction_date:  d.created_at || d.processed_at || null,
      subtotal:          Number(d.subtotal_price || 0),
      tax_amount:        Number(d.total_tax || 0),
      shipping_amount:   Number(d.total_shipping_price_set?.shop_money?.amount || 0),
      discount_amount:   Number(d.total_discounts || 0),
      total_amount:      Number(d.total_price || 0),
      financial_status:  d.financial_status || null,
      fulfillment_status:d.fulfillment_status || null,
      currency:          d.currency || 'USD',
      line_items_count:  (d.line_items || []).length,
    });

    for (const li of (d.line_items || [])) {
      lineRows.push({
        company_id:       companyId,
        order_id:         String(d.id),
        line_item_id:     String(li.id),
        product_id:       li.product_id ? String(li.product_id) : null,
        variant_id:       li.variant_id ? String(li.variant_id) : null,
        title:            li.title || null,
        sku:              li.sku || null,
        quantity:         Number(li.quantity || 0),
        price:            Number(li.price || 0),
        total_discount:   Number(li.total_discount || 0),
        line_total:       Number(li.price || 0) * Number(li.quantity || 0) - Number(li.total_discount || 0),
        currency:         d.currency || 'USD',
        transaction_date: d.created_at || d.processed_at || null,
      });
    }
  }

  await FactOrder.bulkCreate(orderRows, {
    updateOnDuplicate: ['order_number', 'customer_id', 'customer_email', 'transaction_date', 'subtotal', 'tax_amount', 'shipping_amount', 'discount_amount', 'total_amount', 'financial_status', 'fulfillment_status', 'currency', 'line_items_count'],
  });
  if (lineRows.length) {
    await FactOrderLine.bulkCreate(lineRows, {
      updateOnDuplicate: ['order_id', 'product_id', 'variant_id', 'title', 'sku', 'quantity', 'price', 'total_discount', 'line_total', 'currency', 'transaction_date'],
    });
  }

  return { orders: orderRows.length, lines: lineRows.length };
};

// ---------- new transforms ----------

const transformDimCollections = async (companyId) => {
  const [customRows, smartRows] = await Promise.all([
    fetchRaw('CustomCollection', companyId),
    fetchRaw('SmartCollection', companyId),
  ]);

  if (!customRows.length && !smartRows.length) return 0;

  const mapRow = (type) => ({ raw_payload: d }) => ({
    company_id:      companyId,
    collection_id:   String(d.id),
    title:           d.title || null,
    handle:          d.handle || null,
    collection_type: type,
    products_count:  Number(d.products_count || 0),
    is_published:    d.published_at != null,
    updated_at:      new Date(),
  });

  const customMapped = customRows.map(mapRow('custom'));
  const smartMapped  = smartRows.map(mapRow('smart'));

  // Merge and dedup by collection_id (last write wins — prefer smart if duplicate id, unlikely in practice)
  const byId = new Map();
  for (const row of [...customMapped, ...smartMapped]) {
    byId.set(row.collection_id, row);
  }
  const merged = Array.from(byId.values());

  await DimCollection.bulkCreate(merged, {
    updateOnDuplicate: ['title', 'handle', 'collection_type', 'products_count', 'is_published', 'updated_at'],
  });
  return merged.length;
};

const transformFactDraftOrders = async (companyId) => {
  const rows = await fetchRaw('DraftOrder', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:     companyId,
    draft_order_id: String(d.id),
    order_number:   d.name || null,
    customer_id:    d.customer?.id ? String(d.customer.id) : null,
    customer_email: d.email || null,
    total_amount:   Number(d.total_price || 0),
    currency:       d.currency || 'USD',
    status:         d.status || null,
    created_at:     d.created_at ? new Date(d.created_at) : new Date(),
    completed_at:   d.completed_at ? new Date(d.completed_at) : null,
    updated_at:     new Date(),
  }));
  await FactDraftOrder.bulkCreate(mapped, {
    updateOnDuplicate: ['order_number', 'customer_id', 'customer_email', 'total_amount', 'currency', 'status', 'completed_at', 'updated_at'],
  });
  return mapped.length;
};

const transformDimPriceRules = async (companyId) => {
  const rows = await fetchRaw('PriceRule', companyId);
  if (!rows.length) return 0;
  const now = new Date();
  const mapped = rows.map(({ raw_payload: d }) => {
    const endsAt = d.ends_at ? new Date(d.ends_at) : null;
    return {
      company_id:    companyId,
      price_rule_id: String(d.id),
      title:         d.title || null,
      value_type:    d.value_type || null,
      value:         Math.abs(Number(d.value || 0)),
      target_type:   d.target_type || null,
      starts_at:     d.starts_at ? new Date(d.starts_at) : null,
      ends_at:       endsAt,
      usage_limit:   d.usage_limit != null ? Number(d.usage_limit) : null,
      is_active:     endsAt === null || endsAt > now,
      updated_at:    new Date(),
    };
  });
  await DimPriceRule.bulkCreate(mapped, {
    updateOnDuplicate: ['title', 'value_type', 'value', 'target_type', 'starts_at', 'ends_at', 'usage_limit', 'is_active', 'updated_at'],
  });
  return mapped.length;
};

const transformDimLocations = async (companyId) => {
  const rows = await fetchRaw('Location', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:  companyId,
    location_id: String(d.id),
    name:        d.name || null,
    address1:    d.address1 || null,
    city:        d.city || null,
    province:    d.province || null,
    country:     d.country || null,
    zip:         d.zip || null,
    phone:       d.phone || null,
    is_active:   Boolean(d.active),
    updated_at:  new Date(),
  }));
  await DimLocation.bulkCreate(mapped, {
    updateOnDuplicate: ['name', 'address1', 'city', 'province', 'country', 'zip', 'phone', 'is_active', 'updated_at'],
  });
  return mapped.length;
};

const transformFactCollects = async (companyId) => {
  const rows = await fetchRaw('Collect', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:    companyId,
    collect_id:    String(d.id),
    collection_id: d.collection_id ? String(d.collection_id) : null,
    product_id:    d.product_id ? String(d.product_id) : null,
    position:      Number(d.position || 0),
    created_at:    d.created_at ? new Date(d.created_at) : new Date(),
  }));
  await FactCollect.bulkCreate(mapped, {
    updateOnDuplicate: ['collection_id', 'product_id', 'position'],
  });
  return mapped.length;
};

const transformFactAbandonedCheckouts = async (companyId) => {
  const rows = await fetchRaw('AbandonedCheckout', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:     companyId,
    checkout_id:    String(d.token),
    cart_token:     d.cart_token || null,
    customer_email: d.email || null,
    total_price:    Number(d.total_price || 0),
    currency:       d.currency || 'USD',
    created_at:     d.created_at ? new Date(d.created_at) : new Date(),
    updated_at:     d.updated_at ? new Date(d.updated_at) : new Date(),
  }));
  await FactAbandonedCheckout.bulkCreate(mapped, {
    updateOnDuplicate: ['cart_token', 'customer_email', 'total_price', 'currency', 'updated_at'],
  });
  return mapped.length;
};

const transformFactTenderTransactions = async (companyId) => {
  const rows = await fetchRaw('TenderTransaction', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:     companyId,
    tender_id:      String(d.id),
    order_id:       d.order_id ? String(d.order_id) : null,
    amount:         Number(d.amount || 0),
    currency:       d.currency || 'USD',
    payment_method: d.payment_method || null,
    processed_at:   d.processed_at ? d.processed_at.slice(0, 10) : null,
  }));
  await FactTenderTransaction.bulkCreate(mapped, {
    updateOnDuplicate: ['order_id', 'amount', 'currency', 'payment_method', 'processed_at'],
  });
  return mapped.length;
};

const transformDimGiftCards = async (companyId) => {
  const rows = await fetchRaw('GiftCard', companyId);
  if (!rows.length) return 0;
  const mapped = rows.map(({ raw_payload: d }) => ({
    company_id:    companyId,
    gift_card_id:  String(d.id),
    initial_value: Number(d.initial_value || 0),
    balance:       Number(d.balance || 0),
    currency:      d.currency || 'USD',
    status:        d.status || null,
    created_at:    d.created_at ? new Date(d.created_at) : new Date(),
    expires_on:    d.expires_on || null,
  }));
  await DimGiftCard.bulkCreate(mapped, {
    updateOnDuplicate: ['initial_value', 'balance', 'currency', 'status', 'expires_on'],
  });
  return mapped.length;
};

const runPipeline = async ({ companyId, entities }) => {
  const all = !entities || entities.length === 0;
  const wants = (n) => all || entities.includes(n);
  const summary = {};
  if (wants('dim_customers'))            summary.dim_customers            = await transformDimCustomers(companyId);
  if (wants('dim_products'))             summary.dim_products             = await transformDimProducts(companyId);
  if (wants('fact_orders'))              summary.fact_orders              = await transformFactOrders(companyId);
  if (wants('dim_collections'))          summary.dim_collections          = await transformDimCollections(companyId);
  if (wants('fact_draft_orders'))        summary.fact_draft_orders        = await transformFactDraftOrders(companyId);
  if (wants('dim_price_rules'))          summary.dim_price_rules          = await transformDimPriceRules(companyId);
  if (wants('dim_locations'))            summary.dim_locations            = await transformDimLocations(companyId);
  if (wants('fact_collects'))            summary.fact_collects            = await transformFactCollects(companyId);
  if (wants('fact_abandoned_checkouts')) summary.fact_abandoned_checkouts = await transformFactAbandonedCheckouts(companyId);
  if (wants('fact_tender_transactions')) summary.fact_tender_transactions = await transformFactTenderTransactions(companyId);
  if (wants('dim_gift_cards'))           summary.dim_gift_cards           = await transformDimGiftCards(companyId);
  return summary;
};

registerTransformer(SOURCE, runPipeline);

module.exports = { runPipeline };
