/**
 * Consumer (individual) accounts — the signed-in user's own limits, usage and
 * subscription status, plus starting their one-time trial.
 */

const express = require('express');
const userStore = require('../../stores/userStore');
const usageStore = require('../../stores/usageStore');
const { getAdminId } = require('./shared');
const log = require('../../telemetry/log');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

const router = express.Router();

// ── What a caller may send ──────────────────────────────────────────
//
// `plan_id` here, `planId` on the lifecycle routes — see the note in
// orgSubscriptions.js. Strict, so the other spelling is named rather than
// reported as a missing field.

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const PLAN_ID_TEXT = 'plan_id is required — the plan to start the trial on.';
const StartTrialBody = z.object({
    plan_id: worded(PLAN_ID_TEXT).trim().min(1, PLAN_ID_TEXT),
}).strict();

// ═══════════════════════════════════════
//  Consumer Account Usage & Subscription
// ═══════════════════════════════════════

// GET /api/subscriptions/consumer/usage — consumer account limits + usage + subscription status
router.get('/consumer/usage', async (req, res) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    // Check if user has a paid consumer subscription
    const consumerSub = await userStore.getConsumerSubscription(userId);
    let activePlan = null;

    if (consumerSub && consumerSub.plan_id && ['active', 'trialing'].includes(consumerSub.status)) {
        activePlan = await userStore.getPlan(consumerSub.plan_id);
    }

    // Fallback to the default consumer plan
    if (!activePlan) {
        const allPlans = await userStore.getAllPlans();
        activePlan = allPlans.find(p => p.plan_type === 'consumer' && p.is_default)
            || allPlans.find(p => p.name === '__consumer_default__');
    }

    // Build limits from active plan (or return nulls = unlimited)
    const limits = {
        max_messages_per_month: activePlan?.max_messages_per_month ?? null,
        max_tokens_per_month: activePlan?.max_tokens_per_month ?? null,
        max_cost_per_month: activePlan?.max_cost_per_month ?? null,
        max_agents: activePlan?.max_agents ?? null,
        max_knowledge_sources: activePlan?.max_knowledge_sources ?? null,
        max_messages_by_type: activePlan?.max_messages_by_type ?? null,
        allowed_features: activePlan?.allowed_features ?? [],
        allowed_models: activePlan?.allowed_models ?? [],
        plan_name: activePlan?.name === '__consumer_default__' ? 'Free' : (activePlan?.name || 'Free'),
    };

    // Get current period usage for this user
    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const endDate = now.toISOString();
    const summary = await usageStore.getUsageSummary({ startDate, endDate, userId });
    const byType = await usageStore.getUsageByAgentType({ startDate, endDate, userId });

    const markup = Number(activePlan?.markup_percent) || 0;
    const billedFactor = 1 + markup / 100;
    const billedCost = (Number(summary.total_estimated_cost) || 0) * billedFactor;
    const redactedByType = (byType || []).map(t => {
        const row = { ...t };
        row.billed_cost = (Number(row.estimated_cost) || 0) * billedFactor;
        delete row.estimated_cost;
        delete row.total_calls;
        delete row.calls;
        delete row.total_tokens;
        delete row.prompt_tokens;
        delete row.completion_tokens;
        return row;
    });

    res.json({
        limits,
        usage: {
            total_billed_cost: billedCost,
            by_type: redactedByType,
        },
        billing_period: {
            start: startDate,
            end: new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString(),
        },
        // Plan billing model is hoisted to the top level so the usage
        // panel can hide €/cost when on a flat-rate plan even when there
        // is no consumer_subscriptions row (free / default consumer plan).
        billing_model: activePlan?.billing_model || 'fixed',
        subscription: consumerSub ? {
            status: consumerSub.status,
            plan_id: consumerSub.plan_id,
            plan_name: consumerSub.plan_name,
            payment_status: consumerSub.payment_status,
            stripe_customer_id: !!consumerSub.stripe_customer_id,
            stripe_subscription_id: !!consumerSub.stripe_subscription_id,
            trial_end_date: consumerSub.trial_end_date,
            billing_model: consumerSub.billing_model || activePlan?.billing_model || 'fixed',
        } : null,
    });
});

// POST /api/subscriptions/consumer/:userId/start-trial — one-time consumer trial via Stripe
router.post('/consumer/:userId/start-trial', validate({ body: StartTrialBody }), async (req, res) => {
    try {
        const userId = req.params.userId;
        const { plan_id } = req.body;

        const trialService = require('../../services/trialService');
        const sub = await trialService.startConsumerTrial(userId, plan_id, { changedBy: getAdminId(req) });
        res.json(sub);
    } catch (e) {
        if (e.code === 'trial_already_used') {
            return res.status(409).json({ error: 'trial_already_used' });
        }
        log.error('[Subscriptions] startConsumerTrial error:', e);
        res.status(400).json({ error: e.message });
    }
});

module.exports = router;
