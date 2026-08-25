const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const protect = require('../middleware/authmiddleware');
const { processQuestion } = require('../mcp/mcpService');
const { sanitizeUserInput } = require('../mcp/security');

// ── Rate limiter: max 20 requests per user per minute ───────────────────────
const chatLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    keyGenerator: (req) => req.auth?.userId ? `mcp_${req.auth.userId}` : ipKeyGenerator(req),
    handler: (req, res) =>
        res.status(429).json({
            success: false,
            message: 'Too many requests. Please wait a moment before asking again.',
        }),
    skip: (req) => false,
});

/**
 * POST /api/mcp/chat
 * Body: { message: string, history?: [{ role, content }] }
 *
 * Protected — requires valid JWT.
 * Rate limited — 20 req/min per user.
 */
router.post('/chat', protect, chatLimiter, async (req, res) => {
    try {
        const { message, history = [] } = req.body;
        const companyId = req.auth.companyId;

        if (!companyId) {
            return res.status(403).json({
                success: false,
                message: 'No company associated with this account.',
            });
        }

        // ── Layer: sanitise user input before anything else ──────────────────
        let safeMessage;
        try {
            safeMessage = sanitizeUserInput(message);
        } catch (err) {
            return res.status(400).json({ success: false, message: err.message });
        }

        // ── Check API key is configured ──────────────────────────────────────
        if (!process.env.GROQ_API_KEY) {
            return res.status(500).json({
                success: false,
                message: 'AI service is not configured. Please add GROQ_API_KEY to your .env file.',
            });
        }

        const { answer, queryRan } = await processQuestion(
            safeMessage,
            companyId,
            history
        );

        return res.status(200).json({
            success: true,
            data: {
                answer,
                queryRan: process.env.NODE_ENV === 'development' ? queryRan : undefined,
            },
        });
    } catch (err) {
        console.error('[mcpRoute] full error:', err);
        return res.status(500).json({
            success: false,
            message: process.env.NODE_ENV === 'development'
                ? err.message
                : 'Something went wrong. Please try again.',
        });
    }
});

module.exports = router;
