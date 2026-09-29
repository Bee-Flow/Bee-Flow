/**
 * Subscription plan CRUD — the admin Plans editor plus the manual Stripe sync.
 * Super-admin only; the gate sits on the parent router in routes/subscriptions.js.
 */

const express = require('express');
const userStore = require('../../stores/userStore');
const { getAdminId } = require('./shared');
const log = require('../../telemetry/log');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

const router = express.Router();

// ── What a caller may send ──────────────────────────────────────────
//
// Both bodies are `.strict()`, and the field list below is exactly the set
// stores/user/plans.js reads. That store writes through an explicit column
// map, so any OTHER key was dropped in silence and answered 201/200 with the
// plan echoed back — `markup_precent: 40` saved a plan at 20% and said
// "Plan created."
//
// `plan_type` is the one that had no check at all: `plan_type: 'consumr'` was
// stored verbatim, and a plan with a plan_type nobody matches on is invisible
// in BOTH pickers (the org list filters `=== 'organization'`, the consumer
// list `=== 'consumer'`) and can never be offered as a trial. It is an enum
// with an errorMap now, because `invalid_type_error` would not have caught a
// wrong VALUE.

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const text = (what) => worded(`${what} must be text.`);
const cap = (name) => z.coerce.number({ invalid_type_error: `${name} must be a number.` })
    .min(0, `${name} must be non-negative.`).nullish();
const whole = (name) => z.coerce.number({ invalid_type_error: `${name} must be a number.` })
    .int(`${name} must be a whole number.`).min(0, `${name} must be non-negative.`).nullish();
const flag = (name) => z.boolean({ invalid_type_error: `${name} is true or false.` }).optional();
/** An allow-list column: a list of ids, or null for "unrestricted". */
const allowList = (name) => z.array(text(`Each entry in ${name}`), { invalid_type_error: `${name} is a list of ids, or null.` }).nullish();

const INTERVAL_TEXT = 'billing_interval is "monthly" or "yearly".';
const MODEL_TEXT = 'billing_model is "fixed" or "metered".';
const TYPE_TEXT = 'plan_type is "organization" or "consumer".';
const TIER_TEXT = 'tier is "pro", "enterprise", or empty.';
const CURRENCY_TEXT = 'currency is a three-letter code, like EUR.';
const NAME_TEXT = 'A plan needs a name.';

// Everything the store reads. Shared by create and update; only `name`
// differs, so it is layered on per route.
const PLAN_SHAPE = {
    description: text('A description').nullish(),
    tagline: text('A tagline').nullish(),
    plan_type: z.enum(['organization', 'consumer'], { errorMap: () => ({ message: TYPE_TEXT }) }).optional(),
    tier: z.enum(['pro', 'enterprise', ''], { errorMap: () => ({ message: TIER_TEXT }) }).nullish(),

    max_messages_per_month: cap('max_messages_per_month'),
    max_tokens_per_month: cap('max_tokens_per_month'),
    max_cost_per_month: cap('max_cost_per_month'),
    max_users: cap('max_users'),
    max_agents: cap('max_agents'),
    max_knowledge_sources: cap('max_knowledge_sources'),
    max_messages_per_seat: cap('max_messages_per_seat'),
    // A per-agent-type cap map — its keys ARE the data, so it stays open.
    max_messages_by_type: z.record(z.coerce.number()).nullish(),

    allowed_features: allowList('allowed_features'),
    allowed_models: allowList('allowed_models'),
    allowed_integrations: allowList('allowed_integrations'),
    allowed_beta_features: allowList('allowed_beta_features'),

    price: cap('price'),
    currency: worded(CURRENCY_TEXT).regex(/^[a-z]{3}$/i, CURRENCY_TEXT).optional(),
    billing_interval: z.enum(['monthly', 'yearly'], { errorMap: () => ({ message: INTERVAL_TEXT }) }).optional(),
    billing_model: z.enum(['fixed', 'metered'], { errorMap: () => ({ message: MODEL_TEXT }) }).optional(),
    markup_percent: z.coerce.number({ invalid_type_error: 'markup_percent must be a number.' })
        .min(0, 'markup_percent is between 0 and 1000.').max(1000, 'markup_percent is between 0 and 1000.').optional(),
    trial_days: whole('trial_days'),
    sort_order: whole('sort_order'),
    per_seat: flag('per_seat'),

    is_default: flag('is_default'),
    is_public: flag('is_public'),
    nc_recommended: flag('nc_recommended'),
    nc_only: flag('nc_only'),

    stripe_price_id: text('stripe_price_id').nullish(),
    stripe_product_id: text('stripe_product_id').nullish(),
    stripe_meter_id: text('stripe_meter_id').nullish(),
    stripe_meter_event_name: text('stripe_meter_event_name').nullish(),
};

// Stripe needs a payment method up front for a metered price, so a PAYG plan
// cannot carry a trial. Read off the BODY only — same as before, so a PUT that
// touches neither field is unaffected.
const noTrialOnPayg = (v, ctx) => {
    if (v.billing_model === 'metered' && v.trial_days) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom, path: ['trial_days'],
            message: 'PAYG plans cannot have trial_days — Stripe requires a payment method up front.',
        });
    }
};

const CreatePlanBody = z.object({
    id: text('A plan id').optional(),
    name: worded(NAME_TEXT).trim().min(1, NAME_TEXT),
    ...PLAN_SHAPE,
}).strict().superRefine(noTrialOnPayg);

const UpdatePlanBody = z.object({
    name: worded(NAME_TEXT).trim().min(1, 'A plan name cannot be empty.').optional(),
    ...PLAN_SHAPE,
}).strict().superRefine(noTrialOnPayg);

// ═══════════════════════════════════════
//  Subscription Plans
// ═══════════════════════════════════════

// GET /api/subscriptions/plans
router.get('/plans', async (req, res) => {
    const plans = await userStore.getAllPlans();
    res.json(plans);
});

// POST /api/subscriptions/plans
router.post('/plans', validate({ body: CreatePlanBody }), async (req, res) => {
    try {
        const plan = await userStore.createPlan(req.body);
        if (!plan) return res.status(400).json({ error: 'Failed to create plan' });

        await userStore.logSubscriptionAudit('create_plan', 'plan', plan.id, getAdminId(req), null, { name: plan.name, price: plan.price, billing_interval: plan.billing_interval, billing_model: plan.billing_model });

        // Auto-sync to Stripe if enabled. PAYG plans always sync (price is
        // irrelevant for metered); fixed plans only sync when they carry a price.
        const isPayg = plan.billing_model === 'metered';
        if (isPayg || plan.price > 0) {
            try {
                const stripeService = require('../../services/stripeService');
                if (await stripeService.isEnabled()) {
                    const result = isPayg
                        ? await stripeService.syncPaygPlanToStripe(plan)
                        : await stripeService.syncPlanToStripe(plan);
                    const updates = { stripe_product_id: result.productId, stripe_price_id: result.priceId };
                    if (isPayg) {
                        updates.stripe_meter_id = result.meterId;
                        updates.stripe_meter_event_name = result.meterEventName;
                    }
                    await userStore.updatePlan(plan.id, updates);
                    Object.assign(plan, updates);
                    log.info(`[Subscriptions] Auto-synced plan ${plan.id} to Stripe: ${result.productId} (${isPayg ? 'metered' : 'fixed'})`);
                }
            } catch (err) {
                log.warn(`[Subscriptions] Stripe auto-sync failed for plan ${plan.id}:`, err.message);
                // Don't fail the plan creation — Stripe sync is optional
            }
        }

        res.status(201).json(plan);
    } catch (e) {
        log.error('[Subscriptions] createPlan error:', e);
        res.status(400).json({ error: e.message });
    }
});

// PUT /api/subscriptions/plans/:id
router.put('/plans/:id', validate({ body: UpdatePlanBody }), async (req, res) => {
    try {
        const oldPlan = await userStore.getPlan(req.params.id);
        const ok = await userStore.updatePlan(req.params.id, req.body);
        if (!ok) return res.status(404).json({ error: 'Plan not found' });

        const updated = await userStore.getPlan(req.params.id);
        await userStore.logSubscriptionAudit('update_plan', 'plan', req.params.id, getAdminId(req), oldPlan, req.body);

        // Bust stale entitlement snapshots for orgs on this plan. The resolver
        // memoises per-session for ~30s (keys `_ent:…:v{ver}` / `_lic:…:v{ver}`),
        // and plan edits never went through the org/group grant-write path that
        // calls bustSessionsForOrg — so a feature toggled here (e.g. Notebooks)
        // was served from a stale snapshot for up to 30s, making it look like the
        // change "sometimes works". Bumping the install-wide licence version
        // changes those cache keys so the next request re-resolves from the DB.
        // Only fires when an entitlement-bearing list actually changed — price /
        // name edits don't need it.
        const ENT_FIELDS = ['allowed_features', 'allowed_beta_features', 'allowed_integrations', 'allowed_models'];
        const entChanged = ENT_FIELDS.some(f =>
            req.body[f] !== undefined &&
            JSON.stringify(req.body[f] ?? null) !== JSON.stringify(oldPlan?.[f] ?? null)
        );
        if (entChanged) {
            try { require('../../license').bumpServerLicenseVersion(); } catch (_) { /* best-effort cache bust */ }
        }

        // Auto-sync to Stripe if enabled.
        // Fixed plans: trigger on price / name / interval change AND price > 0.
        // PAYG plans:  trigger on name / interval / currency change OR first sync.
        const isPayg = updated.billing_model === 'metered';
        const priceChanged = req.body.price !== undefined && req.body.price !== oldPlan?.price;
        const nameChanged = req.body.name !== undefined && req.body.name !== oldPlan?.name;
        const intervalChanged = req.body.billing_interval !== undefined && req.body.billing_interval !== oldPlan?.billing_interval;
        const currencyChanged = req.body.currency !== undefined && req.body.currency !== oldPlan?.currency;
        const billingModelChanged = req.body.billing_model !== undefined && req.body.billing_model !== oldPlan?.billing_model;
        const needsFixedSync = !isPayg && updated.price > 0 && (priceChanged || nameChanged || intervalChanged || billingModelChanged);
        const needsPaygSync = isPayg && (nameChanged || intervalChanged || currencyChanged || billingModelChanged || !updated.stripe_price_id);
        if (needsFixedSync || needsPaygSync) {
            try {
                const stripeService = require('../../services/stripeService');
                if (await stripeService.isEnabled()) {
                    const result = isPayg
                        ? await stripeService.syncPaygPlanToStripe(updated)
                        : await stripeService.syncPlanToStripe(updated);
                    const updates = { stripe_product_id: result.productId, stripe_price_id: result.priceId };
                    if (isPayg) {
                        updates.stripe_meter_id = result.meterId;
                        updates.stripe_meter_event_name = result.meterEventName;
                    }
                    await userStore.updatePlan(updated.id, updates);
                    Object.assign(updated, updates);
                    log.info(`[Subscriptions] Auto-synced plan ${updated.id} to Stripe: ${result.productId} (${isPayg ? 'metered' : 'fixed'})`);
                }
            } catch (err) {
                log.warn(`[Subscriptions] Stripe auto-sync failed for plan ${updated.id}:`, err.message);
            }
        }

        res.json(updated);
    } catch (e) {
        log.error('[Subscriptions] updatePlan error:', e);
        res.status(400).json({ error: e.message });
    }
});

// DELETE /api/subscriptions/plans/:id
router.delete('/plans/:id', async (req, res, next) => {
    try {
        const oldPlan = await userStore.getPlan(req.params.id);
        const ok = await userStore.deletePlan(req.params.id);
        if (!ok) return res.status(404).json({ error: 'Plan not found' });

        await userStore.logSubscriptionAudit('delete_plan', 'plan', req.params.id, getAdminId(req), oldPlan, null);
        res.json({ success: true });
    } catch (e) {
        if (e instanceof userStore.PlanInUseError) {
            return res.status(409).json({
                error: 'plan_in_use',
                message: `Plan is referenced by ${e.affectedOrgs.length} org subscription(s) and ${e.affectedConsumers.length} consumer subscription(s). Migrate them to a different plan first.`,
                affected_orgs: e.affectedOrgs,
                affected_consumers: e.affectedConsumers,
            });
        }
        log.error('[Subscriptions] deletePlan error:', e);
        next(e);
    }
});

// POST /api/subscriptions/plans/:id/sync-stripe — Manually sync a plan to Stripe
router.post('/plans/:id/sync-stripe', async (req, res) => {
    const stripeService = require('../../services/stripeService');
    if (!(await stripeService.isEnabled())) {
        return res.status(400).json({ error: 'Stripe is not enabled. Configure Stripe in the Stripe settings tab first.' });
    }

    const plan = await userStore.getPlan(req.params.id);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const isPayg = plan.billing_model === 'metered';
    if (!isPayg && (!plan.price || plan.price <= 0)) {
        return res.status(400).json({ error: 'Fixed-price plans must have a price greater than 0 to sync to Stripe' });
    }

    const result = isPayg
        ? await stripeService.syncPaygPlanToStripe(plan)
        : await stripeService.syncPlanToStripe(plan);
    const updates = { stripe_product_id: result.productId, stripe_price_id: result.priceId };
    if (isPayg) {
        updates.stripe_meter_id = result.meterId;
        updates.stripe_meter_event_name = result.meterEventName;
    }
    await userStore.updatePlan(plan.id, updates);

    await userStore.logSubscriptionAudit('update_plan', 'plan', plan.id, getAdminId(req), null, updates);

    res.json({ success: true, ...updates });
});

module.exports = router;
