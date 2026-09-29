/**
 * Promo Code Admin Routes — list, create, deactivate and re-activate the
 * Stripe promotion codes offered at checkout. Admin-only (session admin flag,
 * or the RBAC 'all' permission).
 *
 * The two PUT routes take their whole input from `:id` on the path; there is
 * no body and no query, so neither carries a schema.
 */

const express = require('express');
const stripeService = require('../../services/stripeService');
const userStore = require('../../stores/userStore');
const { requireCloud, stripeIpLimiter, stripeUserLimiter } = require('./shared');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const log = require('../../telemetry/log');

const router = express.Router();

// ── What a caller may send ──────────────────────────────────────────
//
// Every field here ends up in a Stripe coupon or promotion code — an object
// that, once created, discounts real invoices. Three of them used to be read
// for truthiness only, which is how an admin's "no" became a "yes":
//
//   - `firstTimeOnly` was `!!firstTimeOnly`, so the string 'false' (what a
//     form-encoded or hand-written client sends) switched the
//     first_time_transaction restriction ON under a 200 that reported the
//     code created. Nothing in the promo list explains why the code is
//     rejected for existing customers.
//   - `limit` on the list was `parseInt(…) || 25` with no floor, so
//     `?limit=-5` reached Stripe as a negative page size.
//   - an unknown KEY was dropped in silence: `firstTimeOnly` misspelled, or
//     `durationInMonths` for `durationMonths`, produced a code whose
//     restrictions simply were not the ones asked for.
//
// `duration: 'repeating'` without `durationMonths` is refused here rather
// than at Stripe, which answered it with a raw API error.

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const CODE_TEXT = 'A promo code needs a code, e.g. LAUNCH20.';
const TYPE_TEXT = 'discountType must be "percent" or "fixed".';
const DURATION_TEXT = 'duration is once, repeating or forever.';

const count = (name) => z.coerce.number({ invalid_type_error: `${name} must be a number.` })
    .int(`${name} must be a whole number.`)
    .min(1, `${name} must be at least 1.`)
    .optional();

const PromoCodeQuery = z.object({
    limit: z.coerce.number({ invalid_type_error: 'limit must be a number.' })
        .int('limit must be a whole number.')
        .min(1, 'limit must be at least 1.')
        .optional(),
}).strict();

const PromoCodeBody = z.object({
    code: worded(CODE_TEXT).trim().min(1, CODE_TEXT).max(64, 'A promo code is at most 64 characters.'),
    discountType: z.enum(['percent', 'fixed'], { errorMap: () => ({ message: TYPE_TEXT }) }),
    discountValue: z.coerce.number({ invalid_type_error: 'discountValue must be a positive number.' })
        .positive('discountValue must be a positive number.'),
    // Stripe lower-cases this itself; the catalogue is open, so only the shape
    // is pinned.
    currency: worded('currency must be text, e.g. EUR.').trim().min(3, 'currency is a 3-letter code, e.g. EUR.').max(3, 'currency is a 3-letter code, e.g. EUR.').optional(),
    duration: z.enum(['once', 'repeating', 'forever'], { errorMap: () => ({ message: DURATION_TEXT }) }).optional(),
    durationMonths: count('durationMonths'),
    maxRedemptions: count('maxRedemptions'),
    expiresAt: worded('expiresAt must be a date.').trim().min(1, 'expiresAt must be a date.').optional(),
    firstTimeOnly: z.boolean({ invalid_type_error: 'firstTimeOnly is true or false.' }).optional(),
    minAmount: z.coerce.number({ invalid_type_error: 'minAmount must be a number.' })
        .int('minAmount is an amount in cents.')
        .min(0, 'minAmount cannot be negative.')
        .optional(),
    name: worded('name must be text.').trim().max(200, 'name is at most 200 characters.').optional(),
}).strict().superRefine((v, ctx) => {
    if (v.discountType === 'percent' && v.discountValue > 100) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['discountValue'], message: 'A percentage discount cannot exceed 100%.' });
    }
    if (v.duration === 'repeating' && v.durationMonths === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['durationMonths'], message: 'A repeating discount needs durationMonths.' });
    }
    if (v.expiresAt !== undefined && Number.isNaN(new Date(v.expiresAt).getTime())) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'expiresAt must be a date.' });
    }
});

// ═══════════════════════════════════════════
//  Promo Code Admin Routes
// ═══════════════════════════════════════════

const { hasPermission } = require('../../auth/permissions');

async function requireAdmin(req, res, next) {
    if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
    if (req.session.isAdmin || req.session.user?.role === 'admin') return next();
    // Check RBAC permissions
    const userId = req.session.user?.id;
    if (userId && await hasPermission(userId, 'all', req.session)) return next();
    return res.status(403).json({ error: 'Admin access required' });
}

// GET /api/stripe/promo-codes — List all promo codes
router.get('/promo-codes', requireCloud, stripeIpLimiter, requireAdmin, stripeUserLimiter, validate({ query: PromoCodeQuery }), async (req, res) => {
    const enabled = await stripeService.isEnabled();
    if (!enabled) return res.status(400).json({ error: 'Stripe is not enabled' });

    // Still CLAMPED rather than refused above the ceiling: asking for more
    // rows than a page shows is not a mistake worth a 400.
    const codes = await stripeService.listPromoCodes(Math.min(req.query.limit ?? 25, 100));
    res.json(codes);
});

// POST /api/stripe/promo-codes — Create a new promo code
router.post('/promo-codes', requireCloud, stripeIpLimiter, requireAdmin, stripeUserLimiter, validate({ body: PromoCodeBody }), async (req, res) => {
    try {
        const enabled = await stripeService.isEnabled();
        if (!enabled) return res.status(400).json({ error: 'Stripe is not enabled' });

        const { code, discountType, discountValue, currency, duration, durationMonths, maxRedemptions, expiresAt, firstTimeOnly, minAmount, name } = req.body;

        const result = await stripeService.createPromoCode({
            code,
            discountType,
            discountValue,
            currency,
            duration,
            durationMonths,
            maxRedemptions,
            expiresAt,
            firstTimeOnly,
            minAmount,
            name,
        });

        await userStore.logSubscriptionAudit('create_promo_code', 'promo', result.promoCodeId, req.session.user?.id, null, { code: result.code, discountType, discountValue });

        res.json(result);
    } catch (err) {
        log.error('[Stripe] Create promo code error:', err);
        // Stripe returns useful error messages for duplicate codes etc.
        const msg = err.raw?.message || err.message || 'Failed to create promo code';
        res.status(err.statusCode || 500).json({ error: msg });
    }
});

// PUT /api/stripe/promo-codes/:id/deactivate — Deactivate a promo code
router.put('/promo-codes/:id/deactivate', requireCloud, requireAdmin, async (req, res) => {
    const enabled = await stripeService.isEnabled();
    if (!enabled) return res.status(400).json({ error: 'Stripe is not enabled' });

    await stripeService.deactivatePromoCode(req.params.id);
    await userStore.logSubscriptionAudit('deactivate_promo_code', 'promo', req.params.id, req.session.user?.id, null, {});
    res.json({ success: true });
});

// PUT /api/stripe/promo-codes/:id/activate — Re-activate a promo code
router.put('/promo-codes/:id/activate', requireCloud, requireAdmin, async (req, res) => {
    const enabled = await stripeService.isEnabled();
    if (!enabled) return res.status(400).json({ error: 'Stripe is not enabled' });

    await stripeService.activatePromoCode(req.params.id);
    await userStore.logSubscriptionAudit('activate_promo_code', 'promo', req.params.id, req.session.user?.id, null, {});
    res.json({ success: true });
});

module.exports = router;
