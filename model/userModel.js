// model/User.js (update your existing user model)
const { DataTypes } = require('sequelize');
const {mainDB} = require('../connection/dbConnection');

const User = mainDB.define('User', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  email: {
    type: DataTypes.STRING(255),
    unique: true,
    allowNull: false
  },
  password: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
 user_name: {
        type: DataTypes.STRING,
        unique: true,
        allowNull: false
    },
  role_id: {
    type: DataTypes.INTEGER,
    references: {
      model: 'roles',
      key: 'id'
    }
  },
  company_id: {
    type: DataTypes.INTEGER,
    references: {
      model: 'companies',
      key: 'id'
    }
  },
  first_name: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  last_name: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  display_name: {
    type: DataTypes.STRING(200),
    allowNull: true
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  last_login: {
    type: DataTypes.DATE
  },
  default_dashboard_slug: {
    type: DataTypes.STRING(100),
    allowNull: true,
    defaultValue: null,
    comment: 'nav_slug of the Power BI report the user has pinned as their default landing page',
  },
}, {
  tableName: 'users',
  timestamps: true,
  createdAt: 'created_on',
  updatedAt: 'updated_on'
});

User.associate = (models) => {
    User.belongsTo(models.Role, { 
        foreignKey: 'role_id',
        as: 'role' 
    });
};
mainDB.sync()
module.exports = User;