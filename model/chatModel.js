const { DataTypes } = require('sequelize');
const {mainDB} = require('../connection/dbConnection');


const Connector = mainDB.define('Connector', {
    name: {
        type: DataTypes.STRING,
        unique: true,
        allowNull: false
    },
    icon: {
        type: DataTypes.STRING,

        allowNull: false,
    },
    type: {
        type: DataTypes.ENUM('source', 'destination', 'both'),
        allowNull: false

    }
},
    {
        tableName: 'connectors',
        timestamps: true,
        createdAt: 'created_on', // ✅ map to your column
        updatedAt: 'updated_on', // ✅ map to your column
    }
);
sequelize.sync()


module.exports = Connector;