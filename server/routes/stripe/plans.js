/**
 * Stripe configuration status + the public plan catalogue.
 *
 *   GET /status  — is Stripe configured and enabled (and in test mode)
 *   GET /plans   — public plans with pricing, ?type=organization|consumer
 *
 * GET /status takes no input, so it carries no schema.
 */

const express = require('express');
const stripeService = require('../../services/stripeService');
const userStore = require('../../stores/userStore');
const { isNcOrg, filterNcOnlyPlans } = require('../../auth/ncAudience');
const { requireCloud, requireAuth, resolveOrgIdForUser } = require('./shared');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const log = require('../../telemetry/log');

const router = express.Router();

// ── What a caller may send ──────────────────────────────────────────
//
// `type` is matched against `plan.plan_type` with `===`, so a value this
// catalogue does not know matched nothing and the route answered 200 with an
// empty array: `?type=consumr` rendered "no plans available" on the pricing
// page of an installation whose consumer plans were all present and public.
// An unknown KEY did the same thing more quietly — `?typ=consumer` fell back
// to 'organization' and showed the wrong catalogue altogether.
const TYPE_TEXT = 'type is organization or consumer.';
const PlansQuery = z.object({
    type: z.enum(['organization', 'consumer'], { errorMap: () => ({ message: TYPE_TEXT }) }).optional(),
}).strict();

// ── GET /status — Check if Stripe is configured and enabled ──────────────────

router.get('/status', requireCloud, requireAuth, async (req, res) => {
    try {
        const enabled = await stripeService.isEnabled();
        const testMode = enabled ? await stripeService.isTestMode() : false;
        res.json({ enabled, testMode });
    } catch (err) {
        res.json({ enabled: false, testMode: false });
    }
});

// ── GET /plans — List public plans with pricing info ─────────────────────────
// Accepts ?type=organization|consumer (default: organization)

router.get('/plans', requireCloud, requireAuth, validate({ query: PlansQuery }), async (req, res) => {
    try {
        const enabled = await stripeService.isEnabled();
        if (!enabled) return res.json([]);

        const requestedType = req.query.type || 'organization';
        const allPlans = await userStore.getAllPlans();
        // Plans flagged nc_only are offered only to organisations that came in
        // through the Nextcloud connector. A consumer request resolves to no
        // org, so it never sees them.
        const isNc = await isNcOrg(await resolveOrgIdForUser(req));
        const publicPlans = filterNcOnlyPlans(allPlans, isNc)
            .filter(p => p.is_public && p.price > 0 && p.plan_type === requestedType)
            .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
            .map(p => ({
                id: p.id,
                name: p.name,
                description: p.description,
                price: p.price,
                currency: p.currency || 'eur',
                billing_interval: p.billing_interval || 'monthly',
                trial_days: p.trial_days || 0,
                plan_type: p.plan_type,
                max_messages_per_month: p.max_messages_per_month,
                max_tokens_per_month: p.max_tokens_per_month,
                max_cost_per_month: p.max_cost_per_month,
                max_users: p.max_users,
                max_agents: p.max_agents,
                max_knowledge_sources: p.max_knowledge_sources,
                allowed_features: p.allowed_features,
                has_stripe_price: !!p.stripe_price_id,
            }));

        res.json(publicPlans);
    } catch (err) {
        log.error('[Stripe] Failed to list plans:', err);
        res.status(500).json({ error: 'Failed to load plans' });
    }
});

module.exports = router;
