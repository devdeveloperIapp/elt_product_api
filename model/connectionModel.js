const { DataTypes } = require("sequelize");
const {mainDB} = require("../connection/dbConnection");
const Source = require("./sourceModel");
const Destination = require("./destinationModel");

// ---------------- ELT Connections ----------------
const Connection = mainDB.define(
  "Connection",
  {
    connection_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    connection_name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    source_id: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    destination_id: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    schedule_type: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    replication_frequency: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    destination_schema: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    last_sync: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    company_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'companies', key: 'id' },
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
     updated_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: "connections",
    timestamps: false,
  }
);

// ---------------- ELT Schema Details ----------------
const SchemaDetail = mainDB.define(
  "SchemaDetail",
  {
    detail_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    connection_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: Connection,
        key: "connection_id",
      },
      onDelete: "CASCADE",
    },
    table_name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    column_name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    data_type: {
      // ✅ new column
      type: DataTypes.STRING(100),
      allowNull: false,
      defaultValue: "string",
    },
    insertion_type: {
      // ✅ new column (sync mode)
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    cursor_column: {
      // ✅ new column (cursor column)
      type: DataTypes.BOOLEAN(255),
      allowNull: true,
    },
    primary_key_column_name: {
      // ✅ new column (primary column)
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    company_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'companies', key: 'id' },
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: "connection_schema_details",
    timestamps: false,
  }
);

// ---------------- Associations ----------------
Connection.hasMany(SchemaDetail, { foreignKey: "connection_id" });
SchemaDetail.belongsTo(Connection, { foreignKey: "connection_id" });
// connection.js
Connection.belongsTo(Source, { foreignKey: "source_id", as: "source" });
Connection.belongsTo(Destination, { foreignKey: "destination_id", as: "destination" });

module.exports = { Connection, SchemaDetail };
