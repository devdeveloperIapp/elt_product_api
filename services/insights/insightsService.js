// services/insights/insightsService.js
// Computes pure-numeric insights from the v2 warehouse. No AI here — the
// AI controller (controllers/insightsController.js) calls these helpers,
// then optionally hands the structured result to Claude for a narrative.

const { warehouseV2DB } = require('../../connection/dbConnection');
const { QueryTypes } = require('sequelize');
const { normaliseSource } = require('../../model/warehouse/schemaMap');

// All queries use replacements — companyId is never interpolated.
const monthlyRevenue = async (source, companyId) => {
  const canonical = normaliseSource(source);
  const sql = `
    SELECT month::date AS month, revenue
    FROM ${canonical}_domain.vw_revenue_monthly
    WHERE company_id = :companyId
    ORDER BY month
  `;
  return warehouseV2DB.query(sql, { type: QueryTypes.SELECT, replacements: { companyId } });
};

const summary = async (source, companyId, months = 12) => {
  const rows = await monthlyRevenue(source, companyId);
  const last = rows.slice(-months);
  if (last.length === 0) {
    return { months: 0, totalRevenue: 0, avgRevenue: 0, growthRatePct: null, trend: 'flat' };
  }

  const totals = last.map((r) => Number(r.revenue || 0));
  const totalRevenue = totals.reduce((a, b) => a + b, 0);
  const avgRevenue = totalRevenue / totals.length;

  const first = totals[0];
  const lastVal = totals[totals.length - 1];
  const growthRatePct =
    first === 0 ? null : ((lastVal - first) / first) * 100;

  let trend = 'flat';
  if (growthRatePct != null) {
    if (growthRatePct > 5)  trend = 'growing';
    else if (growthRatePct < -5) trend = 'declining';
  }

  return {
    months: last.length,
    totalRevenue,
    avgRevenue,
    minMonth: { month: last[totals.indexOf(Math.min(...totals))].month, revenue: Math.min(...totals) },
    maxMonth: { month: last[totals.indexOf(Math.max(...totals))].month, revenue: Math.max(...totals) },
    growthRatePct,
    trend,
    series: last,
  };
};

module.exports = { summary, monthlyRevenue };
