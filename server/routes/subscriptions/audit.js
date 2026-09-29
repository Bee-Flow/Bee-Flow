/**
 * The subscription-changes audit log read.
 */

const express = require('express');
const userStore = require('../../stores/userStore');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

const router = express.Router();

// ── What a caller may send ──────────────────────────────────────────
//
// `.strict()` is the whole point on this route. `targetType` / `targetId` are
// the ONLY narrowing this log has, and a dropped one widens the answer instead
// of failing: `?targetTyp=org_subscription` used to return every subscription
// audit row in the deployment — every org, every consumer — under a 200.
//
// `limit` stays CLAMPED rather than refused (the handler keeps its Math.min),
// so a caller asking for more rows than the page shows is not a 400.

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const one = (name, what) => worded(`${name} is ${what}.`).trim().min(1, `${name} is ${what}.`).optional();
const whole = (name) => z.coerce.number({ invalid_type_error: `${name} must be a number.` })
    .int(`${name} must be a whole number.`)
    .min(0, `${name} cannot be negative.`)
    .optional();

// The vocabulary grows with each new audited action (trial_config,
// currency_rates, …), so the VALUE is deliberately free-form — an unknown one
// simply matches nothing. It is the unknown KEY that had to be closed.
const AuditQuery = z.object({
    targetType: one('targetType', 'the kind of thing the entry is about'),
    targetId: one('targetId', 'the id of the thing the entry is about'),
    limit: whole('limit'),
    offset: whole('offset'),
}).strict();

// ═══════════════════════════════════════
//  Audit Log
// ═══════════════════════════════════════

// GET /api/subscriptions/audit — subscription changes audit log
router.get('/audit', validate({ query: AuditQuery }), async (req, res) => {
    const { targetType, targetId, limit = 50, offset = 0 } = req.query;
    const logs = await userStore.getAuditLog({
        targetType, targetId,
        limit: Math.min(limit, 200),
        offset,
    });
    res.json(logs);
});

module.exports = router;
