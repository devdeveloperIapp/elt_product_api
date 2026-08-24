// services/warehouse/quickbooksAggregates.js
//
// v2 replacement for the legacy `domain_tables.agg_revenue_monthly` table.
// There is no v2 equivalent stored table (and no webhook-driven refresh job
// for one yet), so instead of maintaining a second copy of this data we
// compute the same monthly revenue/expense/profit rollup live from
// `quickbooks_domain.fact_transactions` — same shape as the legacy rows
// (month_label, revenue, expenses, net_profit, invoice_count), single
// source (quickbooks) only. Mirrors the SQL in
// controller/WebhookController.js::refreshAggregates (legacy path).

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
    FROM quickbooks_domain.fact_transactions
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
