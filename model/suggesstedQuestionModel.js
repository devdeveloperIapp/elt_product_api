const { DataTypes } = require('sequelize');
const {mainDB} = require('../connection/dbConnection');

const SuggestedQuestion = mainDB.define('SuggestedQuestion', {
    question: {
        type: DataTypes.STRING,
        unique: true,
        allowNull: false
    },
    user_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    category_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    report_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    company_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'companies', key: 'id' },
    }
},
    {
        tableName: 'suggested_question',
        timestamps: true,
        createdAt: 'created_on', // ✅ map to your column
        updatedAt: 'updated_on', // ✅ map to your column
    }
);

module.exports = SuggestedQuestion;