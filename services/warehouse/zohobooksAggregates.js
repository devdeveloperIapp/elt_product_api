// services/warehouse/zohobooksAggregates.js
// Same live monthly-rollup approach as quickbooksAggregates.js, against
// `zohobooks_domain.fact_transactions`. See that file for rationale.

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
      SUM(CASE WHEN transaction_type = 'revenue' THEN amount ELSE 0 END) AS revenue,
      SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END) AS expenses,
      SUM(CASE WHEN transaction_type = 'revenue' THEN amount ELSE 0 END) -
      SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END) AS net_profit,
      COUNT(CASE WHEN transaction_type = 'revenue' THEN 1 END) AS invoice_count
    FROM zohobooks_domain.fact_transactions
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
