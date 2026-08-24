// services/warehouse/shopifyAggregates.js
// Live monthly revenue/order rollup from `shopify_domain.fact_orders`.
// Shopify has no revenue/expense transaction concept like the accounting
// sources — this is order-total based, not a P&L rollup.

const { warehouseV2DB } = require('../../connection/dbConnection');
const { QueryTypes } = require('sequelize');

const getMonthlyRevenue = async (companyId, { year, limit } = {}) => {
  const replacements = { companyId: Number(companyId) };
  let yearClause = '';
  if (year) {
    yearClause = 'AND EXTRACT(YEAR FROM transaction_date) = :year';
    replacements.year = Number(year);
  }
  const limitClause = limit ? 'LIMIT :limit' : '';
  if (limit) replacements.limit = Number(limit);

  return warehouseV2DB.query(
    `
    SELECT
      company_id,
      EXTRACT(YEAR  FROM transaction_date)::int AS year,
      EXTRACT(MONTH FROM transaction_date)::int AS month,
      TO_CHAR(transaction_date, 'Mon YYYY') AS month_label,
      SUM(total_amount) AS revenue,
      COUNT(*) AS order_count
    FROM shopify_domain.fact_orders
    WHERE company_id = :companyId ${yearClause}
    GROUP BY company_id, EXTRACT(YEAR FROM transaction_date),
             EXTRACT(MONTH FROM transaction_date), TO_CHAR(transaction_date, 'Mon YYYY')
    ORDER BY year ASC, month ASC
    ${limitClause};
    `,
    { replacements, type: QueryTypes.SELECT }
  );
};

module.exports = { getMonthlyRevenue };
