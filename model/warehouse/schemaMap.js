// model/warehouse/schemaMap.js
// Single source of truth for source -> schema routing in elt_warehouse_v2.
// Adding a new source = add one entry here. NO controller code should ever
// hardcode a schema name.

const schemaMap = Object.freeze({
  quickbooks:   { raw: 'quickbooks_raw',    domain: 'quickbooks_domain'   },
  zohobooks:    { raw: 'zohobooks_raw',     domain: 'zohobooks_domain'    },
  shopify:      { raw: 'shopify_raw',       domain: 'shopify_domain'      },
  googlesheets: { raw: 'google_sheets_raw', domain: 'google_sheets_domain' },
  googledrive:  { raw: 'google_drive_raw',  domain: 'google_drive_domain' },
  excel:        { raw: 'excel_raw',         domain: 'excel_domain'        },
});

// Normalises any incoming source label ("Zoho Books", "QUICKBOOKS", "shopify")
// to the canonical key used in schemaMap.
const normaliseSource = (source) => {
  if (!source) throw new Error('source is required');
  const key = String(source).trim().toLowerCase().replace(/\s+/g, '');
  // map common aliases
  const aliases = {
    quickbooks:      'quickbooks',
    qb:              'quickbooks',
    zohobooks:       'zohobooks',
    zoho:            'zohobooks',
    shopify:         'shopify',
    googlesheets:    'googlesheets',
    'google-sheets': 'googlesheets',
    google_sheets:   'googlesheets',
    gsheets:         'googlesheets',
    googledrive:     'googledrive',
    'google-drive':  'googledrive',
    google_drive:    'googledrive',
    gdrive:          'googledrive',
    drive:           'googledrive',
    excel:           'excel',
    xlsx:            'excel',
    xls:             'excel',
    csv:             'excel',
  };
  const canonical = aliases[key];
  if (!canonical) {
    throw new Error(`Unknown source "${source}". Supported: ${Object.keys(schemaMap).join(', ')}`);
  }
  return canonical;
};

const getSchemas = (source) => {
  const canonical = normaliseSource(source);
  return schemaMap[canonical];
};

const supportedSources = () => Object.keys(schemaMap);

module.exports = { schemaMap, normaliseSource, getSchemas, supportedSources };
