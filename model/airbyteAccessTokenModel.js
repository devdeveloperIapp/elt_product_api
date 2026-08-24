const { DataTypes } = require('sequelize');
const {mainDB} = require('../connection/dbConnection');


const AirbyteAccessToken = mainDB.define('Airbyte_access_token', {
    access_token: {
        type: DataTypes.TEXT,
        allowNull: false
    }
},
    {
        tableName: 'airbyte_access_token',
        timestamps: true,
        createdAt: 'created_on', // ✅ map to your column
        updatedAt: 'updated_on', // ✅ map to your column
    }
);
mainDB.sync()


module.exports = AirbyteAccessToken;