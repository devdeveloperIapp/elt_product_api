// // model/index.js
// const sequelize = require('../connection/dbConnection');
// const User = require('./userModel'); // Your existing user model
// const Source = require('./sourceModel'); // Your existing source model
// const Company = require('./Company');
// const QuickBooksConnection = require('./QuickBooksConnection');
// const QuickBooksData = require('./QuickBooksData');
// const FinancialReport = require('./FinancialReport');
// const DashboardConfig = require('./DashboardConfig');
// const ChartConfig = require('./ChartConfig');
// const ScheduledReport = require('./ScheduledReport');
// const Role = require('./Role');
// const Permission = require('./Permission');
// const RolePermission = require('./RolePermission');
// const NavigationItem = require('./NavigationItem');
// const NavigationPermission = require('./NavigationPermission');
// // Define associations
// Company.hasMany(User, { foreignKey: 'company_id' });
// User.belongsTo(Company, { foreignKey: 'company_id' });

// Company.hasOne(QuickBooksConnection, { foreignKey: 'company_id' });
// QuickBooksConnection.belongsTo(Company, { foreignKey: 'company_id' });

// Company.hasMany(QuickBooksData, { foreignKey: 'company_id' });
// QuickBooksData.belongsTo(Company, { foreignKey: 'company_id' });
// QuickBooksData.belongsTo(Source, { foreignKey: 'source_id' });

// Company.hasMany(FinancialReport, { foreignKey: 'company_id' });
// FinancialReport.belongsTo(Company, { foreignKey: 'company_id' });

// Company.hasMany(DashboardConfig, { foreignKey: 'company_id' });
// DashboardConfig.belongsTo(Company, { foreignKey: 'company_id' });
// DashboardConfig.belongsTo(User, { foreignKey: 'user_id' });

// Company.hasMany(ChartConfig, { foreignKey: 'company_id' });
// ChartConfig.belongsTo(Company, { foreignKey: 'company_id' });
// ChartConfig.belongsTo(User, { foreignKey: 'user_id' });

// Company.hasMany(ScheduledReport, { foreignKey: 'company_id' });
// ScheduledReport.belongsTo(Company, { foreignKey: 'company_id' });

// // Sync all models
// const syncDatabase = async () => {
//   try {
//     await sequelize.sync({ alter: false });
//     console.log('Database synced successfully');
//   } catch (error) {
//     console.error('Error syncing database:', error);
//   }
// };
// // Role Associations
// Role.belongsToMany(Permission, { 
//   through: RolePermission, 
//   foreignKey: 'role_id',
//   otherKey: 'permission_id'
// });
// Permission.belongsToMany(Role, { 
//   through: RolePermission, 
//   foreignKey: 'permission_id',
//   otherKey: 'role_id'
// });

// Role.hasMany(User, { foreignKey: 'role_id' });
// User.belongsTo(Role, { foreignKey: 'role_id' });

// // Navigation Associations
// NavigationItem.belongsToMany(Permission, { 
//   through: NavigationPermission, 
//   foreignKey: 'navigation_id',
//   otherKey: 'permission_id'
// });
// Permission.belongsToMany(NavigationItem, { 
//   through: NavigationPermission, 
//   foreignKey: 'permission_id',
//   otherKey: 'navigation_id'
// });
// // User-Company Associations
// Company.hasMany(User, { foreignKey: 'company_id' });
// User.belongsTo(Company, { foreignKey: 'company_id' });

// module.exports = {
//   sequelize,
//   User,
//   Source,
//   Company,
//   QuickBooksConnection,
//   QuickBooksData,
//   FinancialReport,
//   DashboardConfig,
//   ChartConfig,
//   ScheduledReport,
//   syncDatabase,
//    Role,
//   Permission,
//   RolePermission,
//   NavigationItem,
//   NavigationPermission,
  
// };


// model/index.js - Fixed version
const sequelize = require('../connection/dbConnection');
const User = require('./userModel');
const Role = require('./Role');
const Permission = require('./Permission');
const RolePermission = require('./RolePermission');
const NavigationItem = require('./NavigationItem');
const NavigationPermission = require('./NavigationPermission');
const Company = require('./Company');
const QuickBooksConnection = require('./QuickBooksConnection');
const QuickBooksData = require('./QuickBooksData');
const FinancialReport = require('./FinancialReport');
const DashboardConfig = require('./DashboardConfig');
const ChartConfig = require('./ChartConfig');
const ScheduledReport = require('./ScheduledReport');
const Source = require('./sourceModel'); // Make sure to import Source
const RefreshToken = require('./RefreshToken');
const UserQbCompany = require('./UserQbCompany');
const UserNavigationOverride = require('./UserNavigationOverride');

// Phase 1 — refresh-token <-> user
User.hasMany(RefreshToken, { foreignKey: 'user_id', as: 'refreshTokens' });
RefreshToken.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

// Define associations - ONLY HERE, not in individual model files

// Role-Permission associations (many-to-many)
Role.belongsToMany(Permission, { 
  through: RolePermission, 
  foreignKey: 'role_id',
  otherKey: 'permission_id',
  as: 'rolePermissions' // Add unique alias
});

Permission.belongsToMany(Role, { 
  through: RolePermission, 
  foreignKey: 'permission_id',
  otherKey: 'role_id',
  as: 'roles' // Add unique alias
});

// Role-User associations
Role.hasMany(User, { foreignKey: 'role_id', as: 'roleUsers' });
User.belongsTo(Role, { foreignKey: 'role_id', as: 'userRole' });

// Navigation-Permission associations (many-to-many)
NavigationItem.belongsToMany(Permission, { 
  through: NavigationPermission, 
  foreignKey: 'navigation_id',
  otherKey: 'permission_id',
  as: 'navigationPermissions' 
});

Permission.belongsToMany(NavigationItem, { 
  through: NavigationPermission, 
  foreignKey: 'permission_id',
  otherKey: 'navigation_id',
  as: 'permissionNavigationItems' 
});

// Self-referential associations for NavigationItem (parent-child)
NavigationItem.belongsTo(NavigationItem, { 
  as: 'parentItem', 
  foreignKey: 'parent_id',
  onDelete: 'CASCADE'
});

NavigationItem.hasMany(NavigationItem, { 
  as: 'childItems', 
  foreignKey: 'parent_id',
  onDelete: 'CASCADE'
});

// Company-User associations
// NOTE: user.company_id remains the "currently-active" company pointer.
//       The full set of companies a user can access lives in user_qb_companies (M:N).
Company.hasMany(User, { foreignKey: 'company_id', as: 'users' });
User.belongsTo(Company, { foreignKey: 'company_id', as: 'company' });

// Multi-company support: User <-> Company through user_qb_companies
User.belongsToMany(Company, {
  through: UserQbCompany,
  foreignKey: 'user_id',
  otherKey:   'company_id',
  as: 'qbCompanies',
});
Company.belongsToMany(User, {
  through: UserQbCompany,
  foreignKey: 'company_id',
  otherKey:   'user_id',
  as: 'qbUsers',
});
UserQbCompany.belongsTo(User,    { foreignKey: 'user_id',    as: 'user' });
UserQbCompany.belongsTo(Company, { foreignKey: 'company_id', as: 'company' });
User.hasMany(UserQbCompany,      { foreignKey: 'user_id',    as: 'companyLinks' });
Company.hasMany(UserQbCompany,   { foreignKey: 'company_id', as: 'userLinks' });

// Company-QuickBooksConnection associations
Company.hasOne(QuickBooksConnection, { 
  foreignKey: 'company_id', 
  as: 'quickbooksConnection' 
});
QuickBooksConnection.belongsTo(Company, { 
  foreignKey: 'company_id', 
  as: 'company' 
});

// Company-QuickBooksData associations
Company.hasMany(QuickBooksData, { 
  foreignKey: 'company_id', 
  as: 'quickbooksData' 
});
QuickBooksData.belongsTo(Company, { 
  foreignKey: 'company_id', 
  as: 'company' 
});

// Source-QuickBooksData associations
QuickBooksData.belongsTo(Source, { 
  foreignKey: 'source_id', 
  as: 'source' 
});
Source.hasMany(QuickBooksData, { 
  foreignKey: 'source_id', 
  as: 'quickbooksData' 
});

// Company-FinancialReport associations
Company.hasMany(FinancialReport, { 
  foreignKey: 'company_id', 
  as: 'financialReports' 
});
FinancialReport.belongsTo(Company, { 
  foreignKey: 'company_id', 
  as: 'company' 
});

// Company-DashboardConfig associations
Company.hasMany(DashboardConfig, { 
  foreignKey: 'company_id', 
  as: 'dashboardConfigs' 
});
DashboardConfig.belongsTo(Company, { 
  foreignKey: 'company_id', 
  as: 'company' 
});

// User-DashboardConfig associations
DashboardConfig.belongsTo(User, { 
  foreignKey: 'user_id', 
  as: 'user' 
});
User.hasMany(DashboardConfig, { 
  foreignKey: 'user_id', 
  as: 'dashboardConfigs' 
});

// Company-ChartConfig associations
Company.hasMany(ChartConfig, { 
  foreignKey: 'company_id', 
  as: 'chartConfigs' 
});
ChartConfig.belongsTo(Company, { 
  foreignKey: 'company_id', 
  as: 'company' 
});

// User-ChartConfig associations
ChartConfig.belongsTo(User, { 
  foreignKey: 'user_id', 
  as: 'user' 
});
User.hasMany(ChartConfig, { 
  foreignKey: 'user_id', 
  as: 'chartConfigs' 
});

// Company-ScheduledReport associations
Company.hasMany(ScheduledReport, { 
  foreignKey: 'company_id', 
  as: 'scheduledReports' 
});
ScheduledReport.belongsTo(Company, { 
  foreignKey: 'company_id', 
  as: 'company' 
});

// Safe sync function
const syncDatabase = async () => {
  try {
    console.log('Attempting to sync database...');
    await sequelize.sync({ alter: false });
    console.log('Database synced successfully');
  } catch (error) {
    if ((error.name === 'SequelizeDatabaseError' &&
        error.message.includes('already exists')) ||
        (error.name === 'SequelizeUniqueConstraintError' &&
        error.parent && error.parent.code === '23505' &&
        error.parent.table === 'pg_type')) {
      console.log('Tables/types already exist, continuing...');
    } else {
      console.error('Unexpected error during sync:', error);
      throw error;
    }
  }
};

module.exports = {
  sequelize,
  User,
  Role,
  Permission,
  RolePermission,
  NavigationItem,
  NavigationPermission,
  Company,
  QuickBooksConnection,
  QuickBooksData,
  FinancialReport,
  DashboardConfig,
  ChartConfig,
  ScheduledReport,
  Source,
  RefreshToken,
  UserQbCompany,
  UserNavigationOverride,
  syncDatabase
};