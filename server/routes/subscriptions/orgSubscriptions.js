/**
 * Org subscriptions — listing every org's subscription, one org's subscription
 * with its billing/usage view and plan pickers, the admin assign/update write,
 * and starting the one-time trial.
 */

const express = require('express');
const userStore = require('../../stores/userStore');
const usageStore = require('../../stores/usageStore');
const { isNcOrg, filterNcOnlyPlans } = require('../../auth/ncAudience');
const { getAdminId } = require('./shared');
const log = require('../../telemetry/log');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

const router = express.Router();

// ── What a caller may send ──────────────────────────────────────────
//
// The assign/update body is `.strict()` over exactly the columns
// stores/user/subscriptions.js writes. That store keys off `!== undefined` per
// column, so a misspelled one never reached the UPDATE and the route answered
// 200 with the subscription re-read from the database — "Subscription saved."
// over a cap that had not moved. `override_hours` is the one key that is NOT a
// column: it is translated here into manual_override_until/-_by.
//
// The trial body names `plan_id`. The sibling lifecycle routes name the same
// thing `planId`; both spellings live in this API, which is exactly why a
// strict schema — rather than a truthiness check — has to say which one this
// route takes.

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const text = (what) => worded(`${what} must be text.`);
const cap = (name) => z.coerce.number({ invalid_type_error: `${name} must be a number.` })
    .min(0, `${name} must be non-negative.`).nullish();

const STATUS_TEXT = 'Invalid status. Must be: active, suspended, cancelled, trialing, past_due';
const PLAN_ID_TEXT = 'plan_id is required — the plan to start the trial on.';

const OrgSubscriptionBody = z.object({
    // '' is how the editor spells "no plan"; it is stored as-is today.
    plan_id: text('plan_id').nullish(),
    status: z.enum(['active', 'suspended', 'cancelled', 'trialing', 'past_due'], {
        errorMap: () => ({ message: STATUS_TEXT }),
    }).optional(),

    max_messages_per_month: cap('max_messages_per_month'),
    max_tokens_per_month: cap('max_tokens_per_month'),
    max_cost_per_month: cap('max_cost_per_month'),
    max_users: cap('max_users'),
    max_agents: cap('max_agents'),
    max_knowledge_sources: cap('max_knowledge_sources'),
    // A per-agent-type cap map — its keys ARE the data, so it stays open.
    max_messages_by_type: z.record(z.coerce.number()).nullish(),

    allowed_features: z.array(text('Each allowed feature')).nullish(),
    allowed_models: z.array(text('Each allowed model')).nullish(),

    billing_cycle_start: text('billing_cycle_start').nullish(),
    notes: text('Notes').nullish(),
    trial_end_date: text('trial_end_date').nullish(),

    stripe_customer_id: text('stripe_customer_id').nullish(),
    stripe_subscription_id: text('stripe_subscription_id').nullish(),
    stripe_schedule_id: text('stripe_schedule_id').nullish(),
    stripe_seat_quantity: cap('stripe_seat_quantity'),
    payment_status: text('payment_status').nullish(),
    payment_attempt_count: cap('payment_attempt_count'),
    last_payment_failure_at: text('last_payment_failure_at').nullish(),
    past_due_since: text('past_due_since').nullish(),

    cancel_at_period_end: z.boolean({ invalid_type_error: 'cancel_at_period_end is true or false.' }).nullish(),
    cancel_at: text('cancel_at').nullish(),
    current_period_end: text('current_period_end').nullish(),
    pending_plan_id: text('pending_plan_id').nullish(),
    pending_plan_effective: text('pending_plan_effective').nullish(),

    manual_override_until: text('manual_override_until').nullish(),
    manual_override_by: text('manual_override_by').nullish(),
    // Not a column: 0 clears an override, 1-168 sets one.
    override_hours: z.coerce.number({ invalid_type_error: 'override_hours must be between 0 and 168' })
        .min(0, 'override_hours must be between 0 and 168')
        .max(168, 'override_hours must be between 0 and 168')
        .optional(),
}).strict();

const StartTrialBody = z.object({
    plan_id: worded(PLAN_ID_TEXT).trim().min(1, PLAN_ID_TEXT),
}).strict();

// ═══════════════════════════════════════
//  Organization Subscriptions
// ═══════════════════════════════════════

// GET /api/subscriptions/orgs — list all org subscriptions with current usage
router.get('/orgs', async (req, res) => {
    const subs = await userStore.getAllOrgSubscriptions();
    const orgs = await userStore.getAllOrganizations();

    // Enrich each subscription with org info and current usage
    const result = [];
    for (const sub of subs) {
        const org = orgs.find(o => o.id === sub.organization_id);
        const effective = await userStore.getEffectiveLimits(sub.organization_id);
        // Use billing period for usage calculation
        const period = userStore.getBillingPeriod(sub);
        let usage = {};
        try {
            usage = await usageStore.getUsageSummary({ startDate: period.startDate, endDate: new Date().toISOString(), organizationId: sub.organization_id });
        } catch (_) { }

        const plan = sub.plan_id ? await userStore.getPlan(sub.plan_id) : null;
        const markup = Number(plan?.markup_percent) || 0;
        const billedCost = (Number(usage.total_estimated_cost) || 0) * (1 + markup / 100);

        result.push({
            ...sub,
            org_name: org?.name || 'Unknown',
            org_trial_used_at: org?.trial_used_at || null,
            effective_limits: effective,
            billing_period: period,
            current_usage: {
                messages: usage.total_calls || 0,
                tokens: usage.total_tokens || 0,
                cost: billedCost,
            }
        });
    }

    res.json(result);
});

// GET /api/subscriptions/orgs/:orgId
router.get('/orgs/:orgId', async (req, res) => {
    const sub = await userStore.getOrgSubscription(req.params.orgId);
    if (!sub) return res.status(404).json({ error: 'No subscription for this org' });

    const effective = await userStore.getEffectiveLimits(req.params.orgId);
    const period = userStore.getBillingPeriod(sub);
    let usage = {};
    try {
        usage = await usageStore.getUsageSummary({ startDate: period.startDate, endDate: new Date().toISOString(), organizationId: req.params.orgId });
    } catch (_) { }

    const plan = sub.plan_id ? await userStore.getPlan(sub.plan_id) : null;
    const markup = Number(plan?.markup_percent) || 0;
    const rawCost = Number(usage.total_estimated_cost) || 0;
    const billedCost = rawCost * (1 + markup / 100);

    // Effective cost cap: explicit subscription override > plan-price ×
    // seats (or flat plan price) > unlimited. Customers see this as
    // their AI-usage ceiling; markup stays internal so the cap aligns
    // with what they actually pay each cycle.
    // Prefer the live active-user count so seat changes show up
    // immediately on the customer's License page; Stripe still catches
    // up via the existing 15-min sync timer.
    let seatQty;
    try {
        seatQty = Math.max(1, await userStore.getActiveSeatCount(req.params.orgId));
    } catch (_) {
        seatQty = Number(sub.stripe_seat_quantity) || Number(effective?.seat_count) || 1;
    }
    const planPrice = Number(plan?.price) || 0;
    const isPerSeat = !!plan?.per_seat;
    const derivedCap = planPrice > 0
        ? (isPerSeat ? planPrice * seatQty : planPrice)
        : null;
    // Read the genuine subscription override from the raw row — `effective`
    // now already carries the seat-scaled cap from getEffectiveLimits, so
    // checking it here would just echo that. Using `sub` lets the displayed
    // cap track the LIVE seat count (derivedCap) for immediacy, while a real
    // admin override still wins. Display and enforcement share the price ×
    // seats formula and converge as soon as the seat sync lands.
    const explicitCap = Number(sub?.max_cost_per_month);
    const effectiveCostCap = (Number.isFinite(explicitCap) && explicitCap > 0)
        ? explicitCap
        : derivedCap;
    if (effectiveCostCap != null) {
        effective.max_cost_per_month = effectiveCostCap;
    }

    // Pooled / per-user toggle lives on the organization row. '1' is
    // the pre-migration default (pooled). When per-user, the client
    // renders an additional slice (`per_user_cap`) per active seat so
    // the dashboard can show personal budgets.
    let usagePooled = true;
    try {
        const orgRow = await userStore.getOrganization(req.params.orgId);
        usagePooled = (orgRow?.usage_pooled ?? '1') !== '0' && orgRow?.usagePooled !== false;
    } catch (_) { /* keep default = true */ }

    const billing = plan ? {
        plan_price: planPrice || null,
        plan_currency: plan.currency || 'EUR',
        billing_interval: plan.billing_interval || 'monthly',
        per_seat: isPerSeat,
        seat_quantity: isPerSeat ? seatQty : null,
        subscription_total: planPrice > 0
            ? (isPerSeat ? planPrice * seatQty : planPrice)
            : 0,
        usage_pooled: usagePooled,
        per_user_cap: !usagePooled
            && Number.isFinite(Number(effective?.max_cost_per_month))
            && Number(effective.max_cost_per_month) > 0
            ? Number(effective.max_cost_per_month) / Math.max(1, seatQty)
            : null,
    } : null;

    // Privacy gate (not the operational permission used elsewhere): raw
    // tokens / messages are only returned to the hardcoded platform
    // operator account. Everyone else — including admin_subscriptions
    // RBAC holders and org admins — gets the marked-up cost only.
    const isPlatformOperator = req.session?.user?.id === 'admin';
    const currentUsage = isPlatformOperator
        ? { messages: usage.total_calls || 0, tokens: usage.total_tokens || 0, cost: billedCost }
        : { cost: billedCost };

    // Plans restricted to Nextcloud organisations are dropped from both
    // pickers below unless this org actually is one. A lookup failure
    // leaves the flag false, so the restricted plans stay hidden.
    let isNcOrgCaller = false;
    try { isNcOrgCaller = await isNcOrg(req.params.orgId); }
    catch (e) { log.warn('[Subscriptions] NC-audience lookup failed, hiding nc_only plans:', e.message); }

    // Upgradeable plans: same scope + interval, strictly higher price.
    // The frontend uses this list directly to render the Upgrade picker —
    // doing the filter server-side prevents the UI from ever offering a
    // downgrade just because the client logic drifts.
    let upgradeable_plans = [];
    try {
        const allPlans = await userStore.getAllPlans();
        upgradeable_plans = filterNcOnlyPlans(allPlans || [], isNcOrgCaller)
            .filter(p => p.is_active !== false
                && p.stripe_price_id
                && (p.plan_type || 'organization') === (plan?.plan_type || 'organization')
                && p.billing_interval === plan?.billing_interval
                && Number(p.price) > planPrice)
            .sort((a, b) => Number(a.price) - Number(b.price))
            .map(p => ({
                id: p.id,
                name: p.name,
                description: p.description,
                price: p.price,
                currency: p.currency || 'eur',
                billing_interval: p.billing_interval,
                max_users: p.max_users,
                max_agents: p.max_agents,
                max_knowledge_sources: p.max_knowledge_sources,
                per_seat: !!p.per_seat,
                has_stripe_price: !!p.stripe_price_id,
            }));
    } catch (e) {
        log.warn('[Subscriptions] upgradeable_plans compute failed:', e.message);
    }

    // Changeable plans: both directions (upgrade + downgrade), same scope +
    // interval, with a Stripe price and a non-zero price (downgrade-to-free
    // is "cancel", not a plan change). Each is tagged with its direction so
    // the in-app Change-plan picker can label and confirm appropriately.
    let changeable_plans = [];
    try {
        const allPlans = await userStore.getAllPlans();
        changeable_plans = filterNcOnlyPlans(allPlans || [], isNcOrgCaller)
            .filter(p => p.is_active !== false
                && p.stripe_price_id
                && Number(p.price) > 0
                && p.id !== plan?.id
                && (p.plan_type || 'organization') === (plan?.plan_type || 'organization')
                && p.billing_interval === plan?.billing_interval
                && Number(p.price) !== planPrice)
            .sort((a, b) => Number(a.price) - Number(b.price))
            .map(p => ({
                id: p.id,
                name: p.name,
                description: p.description,
                price: p.price,
                currency: p.currency || 'eur',
                billing_interval: p.billing_interval,
                max_users: p.max_users,
                max_agents: p.max_agents,
                max_knowledge_sources: p.max_knowledge_sources,
                per_seat: !!p.per_seat,
                has_stripe_price: !!p.stripe_price_id,
                direction: Number(p.price) > planPrice ? 'upgrade' : 'downgrade',
            }));
    } catch (e) {
        log.warn('[Subscriptions] changeable_plans compute failed:', e.message);
    }

    // Resolve the friendly name of a pending (scheduled) downgrade target.
    let pending_plan_name = null;
    if (sub.pending_plan_id) {
        try { pending_plan_name = (await userStore.getPlan(sub.pending_plan_id))?.name || null; } catch (_) { /* ignore */ }
    }

    res.json({
        ...sub,
        cancel_at_period_end: !!sub.cancel_at_period_end,
        cancel_at: sub.cancel_at || null,
        current_period_end: sub.current_period_end || null,
        pending_plan_id: sub.pending_plan_id || null,
        pending_plan_effective: sub.pending_plan_effective || null,
        pending_plan_name,
        effective_limits: effective,
        billing_period: period,
        billing,
        current_usage: currentUsage,
        upgradeable_plans,
        changeable_plans,
    });
});

// PUT /api/subscriptions/orgs/:orgId — assign or update subscription
router.put('/orgs/:orgId', validate({ body: OrgSubscriptionBody }), async (req, res) => {
    try {
        // Manual-override window: an admin can lock the subscription against
        // Stripe webhook clobbering for up to a week (default 24h). Pass
        // override_hours: 0 to clear an existing override.
        const payload = { ...req.body };
        const adminId = getAdminId(req);
        if (Object.prototype.hasOwnProperty.call(req.body, 'override_hours')) {
            const h = req.body.override_hours;
            payload.manual_override_until = h > 0 ? new Date(Date.now() + h * 3600 * 1000).toISOString() : null;
            payload.manual_override_by = h > 0 ? (adminId || 'admin') : null;
            delete payload.override_hours;
        }

        // Atomic read-modify-write: serialises two admins racing on the same
        // org and reports when this write displaced another admin's active
        // override. Both attempts are then visible in the audit log.
        const lockResult = await userStore.setOrgSubscriptionWithLock(req.params.orgId, payload);
        if (!lockResult.ok) return res.status(400).json({ error: 'Failed to set subscription' });
        const oldSub = lockResult.snapshot;

        // Propagate plan entitlements (integrations + beta features) when the
        // plan changes. Use 'intersect' on downgrade-style updates so admins
        // can opt into widening explicitly elsewhere if needed.
        if (payload.plan_id && payload.plan_id !== oldSub?.plan_id) {
            try {
                await require('../../services/planEntitlements').applyPlanToOrg(req.params.orgId, payload.plan_id, { mode: 'reset' });
            } catch (e) {
                log.warn('[Subscriptions] applyPlanToOrg failed:', e.message);
            }
        }

        const action = oldSub ? 'update_subscription' : 'assign_subscription';
        await userStore.logSubscriptionAudit(action, 'org_subscription', req.params.orgId, adminId, oldSub, payload);
        if (payload.manual_override_until !== undefined) {
            await userStore.logSubscriptionAudit('manual_override_set', 'org_subscription', req.params.orgId, adminId, null, { manual_override_until: payload.manual_override_until });
        }
        if (lockResult.displaced) {
            // Surface the loser-of-race in audit so the previous admin's
            // override timestamp + identity isn't silently lost.
            await userStore.logSubscriptionAudit(
                'manual_override_displaced',
                'org_subscription',
                req.params.orgId,
                adminId,
                {
                    previous_override_by: oldSub.manual_override_by,
                    previous_override_until: oldSub.manual_override_until,
                },
                { manual_override_until: payload.manual_override_until, manual_override_by: payload.manual_override_by },
            );
        }

        const sub = await userStore.getOrgSubscription(req.params.orgId);
        res.json(sub);
    } catch (e) {
        log.error('[Subscriptions] setOrgSub error:', e);
        res.status(400).json({ error: e.message });
    }
});

// POST /api/subscriptions/orgs/:orgId/start-trial — one-time trial via Stripe
router.post('/orgs/:orgId/start-trial', validate({ body: StartTrialBody }), async (req, res) => {
    try {
        const orgId = req.params.orgId;
        const { plan_id } = req.body;

        const trialService = require('../../services/trialService');
        const sub = await trialService.startOrgTrial(orgId, plan_id, { changedBy: getAdminId(req) });
        res.json(sub);
    } catch (e) {
        if (e.code === 'trial_already_used') {
            return res.status(409).json({ error: 'trial_already_used' });
        }
        log.error('[Subscriptions] startOrgTrial error:', e);
        res.status(400).json({ error: e.message });
    }
});

module.exports = router;
