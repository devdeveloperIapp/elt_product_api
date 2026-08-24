// services/warehouse/index.js
// Public entry point. Require this once at server boot to register all transformers.
//
//   const { insertRawData, transformToDomain } = require('./services/warehouse');
//
// Adding a new source = create a new transformer file under transformers/ and require it here.

require('./transformers/quickbooksTransformer');
require('./transformers/zohobooksTransformer');
require('./transformers/shopifyTransformer');
require('./transformers/googleSheetsTransformer');
require('./transformers/googleDriveTransformer');
require('./transformers/excelTransformer');

const { insertRawData, transformToDomain, registerTransformer } = require('./ingestionService');
const { schemaMap, getSchemas, supportedSources } = require('../../model/warehouse/schemaMap');

module.exports = {
  insertRawData,
  transformToDomain,
  registerTransformer,
  schemaMap,
  getSchemas,
  supportedSources,
};
