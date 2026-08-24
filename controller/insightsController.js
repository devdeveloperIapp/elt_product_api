// controller/insightsController.js
// GET /api/insights/summary?source=quickbooks&months=12
//
// Returns numeric insights (always) + an optional AI-generated narrative
// when ANTHROPIC_API_KEY is configured.

const { tenantId, sendAuthError } = require('../utils/tenantScope');
const { summary } = require('../services/insights/insightsService');

const ALLOWED_SOURCES = ['quickbooks', 'zohobooks', 'shopify'];

exports.summary = async (req, res) => {
  try {
    let companyId;
    try { companyId = tenantId(req); } catch (e) { return sendAuthError(res, e); }

    const source = String(req.query.source || '').toLowerCase();
    if (!ALLOWED_SOURCES.includes(source)) {
      return res.status(400).json({
        success: false,
        data: null,
        message: `source must be one of: ${ALLOWED_SOURCES.join(', ')}`,
      });
    }
    const months = Math.min(36, Math.max(1, Number(req.query.months) || 12));

    const stats = await summary(source, companyId, months);

    let narrative = null;
    if (process.env.ANTHROPIC_API_KEY && stats.months > 0) {
      narrative = await generateNarrative(source, stats).catch((err) => {
        console.error('[insights] narrative failed:', err.message);
        return null;
      });
    }

    return res.status(200).json({
      success: true,
      data: { source, months, stats, narrative },
      message: 'Insights generated',
    });
  } catch (err) {
    console.error('[insights] error:', err);
    return res.status(500).json({ success: false, data: null, message: 'Something went wrong' });
  }
};

// ---------- AI narrative (Anthropic Messages API) ----------
const generateNarrative = async (source, stats) => {
  const axios = require('axios');
  const prompt = `You are a financial analyst. Write a tight, 3-bullet executive summary
of the following ${source} performance. Use numbers, no fluff, no greeting.

JSON:
${JSON.stringify({
  months: stats.months,
  totalRevenue: stats.totalRevenue,
  avgRevenue: stats.avgRevenue,
  growthRatePct: stats.growthRatePct,
  trend: stats.trend,
  minMonth: stats.minMonth,
  maxMonth: stats.maxMonth,
}, null, 2)}`;

  const { data } = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    },
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 15000,
    }
  );

  const text = data?.content?.[0]?.text;
  return text || null;
};
