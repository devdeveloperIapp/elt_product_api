const { DataTypes } = require('sequelize');
const {mainDB} = require('../connection/dbConnection');


const Question = mainDB.define('Question', {
    question: {
        type: DataTypes.STRING,
        unique: true,
        allowNull: false
    },
    type: {
        type: DataTypes.ENUM('user', 'category', 'report'),
        allowNull: false

    }
},
    {
        tableName: 'questions',
        timestamps: true,
        createdAt: 'created_on', // ✅ map to your column
        updatedAt: 'updated_on', // ✅ map to your column
    }
);
sequelize.sync()


module.exports = Question;