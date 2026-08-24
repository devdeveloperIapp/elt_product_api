// // model/QuickBooksData.js
// const { DataTypes } = require('sequelize');
// const sequelize = require('../connection/dbConnection');

// const QuickBooksData = sequelize.define('QuickBooksData', {
//   id: {
//     type: DataTypes.INTEGER,
//     primaryKey: true,
//     autoIncrement: true
//   },
//   company_id: {
//     type: DataTypes.INTEGER,
//     allowNull: false,
//     references: {
//       model: 'companies',
//       key: 'id'
//     },
//      validate: {
//         notNull: { msg: 'Company ID is required' }
//       }
//   },
//   source_id: {
//     type: DataTypes.INTEGER,
//     allowNull: false,
//     references: {
//       model: 'sources',
//       key: 'id'
//     },
//     validate: {
//         notNull: { msg: 'Source ID is required' }
//       }
//   },
//   data_type: {
//       type: DataTypes.TEXT, // or ENUM
//       allowNull: false,
//       validate: {
//         notNull: { msg: 'Data type is required' },
//         isIn: {
//           args: [['account', 'customer', 'vendor', 'invoice', 'bill', 'payment', /* etc */]],
//           msg: 'Invalid data type'
//         }
//       }
//     },
// //   data_type: {
// //     type: DataTypes.STRING, // Changed from ENUM to STRING to avoid previous error
// //     allowNull: false
// //   },
//   quickbooks_id: {
//     type: DataTypes.STRING,
//     allowNull: false,
//      validate: {
//         notNull: { msg: 'QuickBooks ID is required' }
//       }
//   },
//   data: {
//     type: DataTypes.JSON,
//     allowNull: false,
//      validate: {
//         notNull: { msg: 'Data is required' }
//       }
//   },
//   sync_version: {
//     type: DataTypes.STRING(50)
//   },
//   sync_token: {
//     type: DataTypes.STRING(50)
//   },
//   is_active: {
//     type: DataTypes.BOOLEAN,
//     defaultValue: true
//   }
// }, {
//   tableName: 'quickbooks_data',
//   timestamps: true,
//   createdAt: 'created_at',
//   updatedAt: 'updated_at',
//   // Remove the indexes section completely or comment it out
//   // indexes: [
//   //   {
//   //     unique: true,
//   //     fields: ['company_id', 'data_type', 'quickbooks_id']
//   //   }
//   // ]
// });

// module.exports = QuickBooksData;


// model/QuickBooksData.js
const { DataTypes } = require('sequelize');
const {mainDB} = require('../connection/dbConnection');

const QuickBooksData = mainDB.define('QuickBooksData', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  company_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'companies',
      key: 'id'
    },
    validate: {
      notNull: { msg: 'Company ID is required' }
    }
  },
  source_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'sources',
      key: 'id'
    },
    validate: {
      notNull: { msg: 'Source ID is required' }
    }
  },
  data_type: {
    type: DataTypes.TEXT,
    allowNull: false,
    validate: {
      notNull: { msg: 'Data type is required' },
      isIn: {
        args: [[
          'account', 'bill', 'billpayment', 'customer', 'department',
          'deposit', 'employee', 'estimate', 'invoice', 'item',
          'journalentry', 'payment', 'paymentmethod', 'purchase',
          'purchaseorder', 'refundreceipt', 'salesreceipt', 'taxcode',
          'taxrate', 'term', 'timeactivity', 'transfer', 'vendor', 'vendorcredit'
        ]],
        msg: 'Invalid data type'
      }
    }
  },
  quickbooks_id: {
    type: DataTypes.STRING,
    allowNull: false,
    validate: {
      notNull: { msg: 'QuickBooks ID is required' }
    }
  },
  data: {
    type: DataTypes.JSON,
    allowNull: false,
    validate: {
      notNull: { msg: 'Data is required' }
    }
  },
  sync_version: {
    type: DataTypes.STRING(50)
  },
  sync_token: {
    type: DataTypes.STRING(50)
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  // Timestamp when the record was soft-deleted (QB no longer has it).
  // Cleanup job hard-deletes rows where deactivated_at < NOW() - 30 days.
  deactivated_at: {
    type:         DataTypes.DATE,
    allowNull:    true,
    defaultValue: null,
  },
}, {
  tableName: 'quickbooks_data',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = QuickBooksData;