// model/warehouse/RawEntityModel.js
const { DataTypes } = require('sequelize');
const { warehouseDB } = require('../../connection/dbConnection');

const modelCache = {};

const getRawEntityModel = async (entityType) => {  // ✅ async banao
  const tableName = `raw_${entityType.toLowerCase()}`;

  if (modelCache[tableName]) return modelCache[tableName];

  const model = warehouseDB.define(tableName, {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    company_id: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    source_type: {
      type: DataTypes.STRING,
      allowNull: false
    },
    source_id: {
      type: DataTypes.STRING,
      allowNull: false
    },
    raw_payload: {
      type: DataTypes.JSONB,
      allowNull: false
    },
    sync_token: {
      type: DataTypes.STRING
    },
    ingested_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    },
    is_deleted: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    }
  }, {
    tableName,
    schema: 'public',
    timestamps: false,
    indexes: [
      {
        unique: true,
        fields: ['company_id', 'source_type', 'source_id']
      }
    ]
  });

  await model.sync({ force: false, alter: true }); // ✅ await lagao — table pehle banega

  modelCache[tableName] = model;
  return model;
};

module.exports = getRawEntityModel;