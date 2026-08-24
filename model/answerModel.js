const { DataTypes } = require('sequelize');
const {mainDB} = require('../connection/dbConnection');


const Answer = mainDB.define('Answer', {
    answer: {
        type: DataTypes.STRING,
        unique: true,
        allowNull: false
    },
},
    {
        tableName: 'answers',
        timestamps: true,
        createdAt: 'created_on', // ✅ map to your column
        updatedAt: 'updated_on', // ✅ map to your column
    }
);
mainDB.sync()


module.exports = Answer;