const { DataTypes } = require('sequelize');
const {mainDB} = require('../connection/dbConnection');


const Report = mainDB.define('Report', {
    name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    embeded_url: {
        type: DataTypes.STRING,
        allowNull: false
    },
    category_id: {
        type: DataTypes.INTEGER,
        allowNull: true   // optional — nav_slug flow doesn't need a category
    },
    // nav_slug links this report to a navigation item path segment.
    // e.g. nav_slug="cash-flow" maps to /reports/cash-flow navigation path.
    // Each company can have its own embed URL for the same nav_slug.
    nav_slug: {
        type: DataTypes.STRING(100),
        allowNull: true,
    },
    is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
    },
    position: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
    },
    company_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'companies', key: 'id' },
    }
},
    {
        tableName: 'reports',
        timestamps: true,
        createdAt: 'created_on', // ✅ map to your column
        updatedAt: 'updated_on', // ✅ map to your column
    }
);


module.exports = Report;