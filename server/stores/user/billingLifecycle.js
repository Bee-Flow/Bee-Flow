// @typecheck
// Billing lifecycle — Stripe webhook idempotency, dunning counters and
// suspension sweeps, trial expiry, and the downgrade-to-Free floor.

const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./schema');
const { getOrgSubscription, setOrgSubscription, setConsumerSubscription, isManualOverrideActive } = require('./subscriptions');
const { logSubscriptionAudit } = require('./audit');
const log = require('../../telemetry/log');

// ── Notification idempotency ─────────────────────────────
// Returns true when we have NOT yet sent this kind to this target — caller
// should then send. Atomic via PK conflict so two cron ticks can't race.
async function claimNotificationSlot(targetId, notifKind) {
    if (!targetId || !notifKind) return false;
    await initDB();
    try {
        const result = await run(
            `INSERT INTO license_notifications_sent (target_id, notif_kind)
             VALUES ($1, $2)
             ON CONFLICT (target_id, notif_kind) DO NOTHING`,
            [String(targetId), String(notifKind)]
        );
        return (result.rowCount || 0) > 0;
    } catch (e) {
        log.error('[UserStore] claimNotificationSlot error:', e.message);
        return false;
    }
}

async function getDunningCounts() {
    await initDB();
    try {
        const o = await getOne(`SELECT
            COUNT(*) FILTER (WHERE status = 'past_due')::int AS past_due_count,
            COUNT(*) FILTER (WHERE status = 'suspended')::int AS suspended_count
            FROM organization_subscriptions`);
        const c = await getOne(`SELECT
            COUNT(*) FILTER (WHERE status = 'past_due')::int AS past_due_count,
            COUNT(*) FILTER (WHERE status = 'suspended')::int AS suspended_count
            FROM consumer_subscriptions`);
        return {
            past_due_count: (o?.past_due_count || 0) + (c?.past_due_count || 0),
            suspended_count: (o?.suspended_count || 0) + (c?.suspended_count || 0),
        };
    } catch (_e) {
        return { past_due_count: 0, suspended_count: 0 };
    }
}

// ── Stripe webhook idempotency ─────────────────────────────
// Records that an event has been processed. Returns true on first insert,
// false if the event_id was already present (i.e. a duplicate delivery).
/**
 * Claim a Stripe event id. True on the first sighting, false on a replay.
 *
 * THROWS when the ledger is unreachable — deliberately. Returning true there
 * (as this used to) means "treat an event we cannot deduplicate as new", which
 * double-applies subscription changes during a database hiccup. The webhook
 * route turns the throw into a 500 so Stripe redelivers once the store is back.
 */
async function recordStripeEventProcessed(eventId, eventType, payloadHash = null) {
    if (!eventId) return true;
    await initDB();
    const result = await run(
        `INSERT INTO stripe_processed_events (event_id, event_type, payload_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (event_id) DO NOTHING`,
        [eventId, eventType || 'unknown', payloadHash]
    );
    return (result.rowCount || 0) > 0;
}

/**
 * Release a claimed event id after its handler failed, so Stripe's redelivery is
 * processed rather than skipped as a duplicate. Without this the insert-first
 * gate turns any transient handler error into permanent event loss.
 */
async function releaseStripeEventProcessed(eventId) {
    if (!eventId) return false;
    await initDB();
    const result = await run('DELETE FROM stripe_processed_events WHERE event_id = $1', [eventId]);
    return (result.rowCount || 0) > 0;
}

// ── Dunning counters ─────────────────────────────
// Increment payment_attempt_count and stamp past_due_since on the first
// failure. Used by the Stripe invoice.payment_failed handler.
async function recordPaymentFailureForOrg(orgId) {
    await initDB();
    await run(
        `UPDATE organization_subscriptions
            SET payment_attempt_count = COALESCE(payment_attempt_count, 0) + 1,
                last_payment_failure_at = NOW(),
                past_due_since = COALESCE(past_due_since, NOW()),
                updated_at = $2
          WHERE organization_id = $1`,
        [orgId, new Date().toISOString()]
    );
    try { require('../usageStore').invalidatePaygCache(orgId, null); } catch (_) { /* circular-load safe */ }
    const row = await getOne(
        'SELECT payment_attempt_count, past_due_since FROM organization_subscriptions WHERE organization_id = $1',
        [orgId]
    );
    return row || null;
}

async function recordPaymentFailureForConsumer(userId) {
    await initDB();
    await run(
        `UPDATE consumer_subscriptions
            SET payment_attempt_count = COALESCE(payment_attempt_count, 0) + 1,
                last_payment_failure_at = NOW(),
                past_due_since = COALESCE(past_due_since, NOW()),
                updated_at = $2
          WHERE user_id = $1`,
        [userId, new Date().toISOString()]
    );
    try { require('../usageStore').invalidatePaygCache(null, userId); } catch (_) { /* circular-load safe */ }
    const row = await getOne(
        'SELECT payment_attempt_count, past_due_since FROM consumer_subscriptions WHERE user_id = $1',
        [userId]
    );
    return row || null;
}

async function resetPaymentFailureForOrg(orgId) {
    await initDB();
    await run(
        `UPDATE organization_subscriptions
            SET payment_attempt_count = 0,
                past_due_since = NULL,
                updated_at = $2
          WHERE organization_id = $1`,
        [orgId, new Date().toISOString()]
    );
    try { require('../usageStore').invalidatePaygCache(orgId, null); } catch (_) { /* circular-load safe */ }
}

async function resetPaymentFailureForConsumer(userId) {
    await initDB();
    await run(
        `UPDATE consumer_subscriptions
            SET payment_attempt_count = 0,
                past_due_since = NULL,
                updated_at = $2
          WHERE user_id = $1`,
        [userId, new Date().toISOString()]
    );
    try { require('../usageStore').invalidatePaygCache(null, userId); } catch (_) { /* circular-load safe */ }
}

// Run a sweep that suspends any org/consumer sub whose past_due_since is
// older than graceDays. Returns counts so the caller (scheduler) can log
// activity. Idempotent: re-running flips nothing once the sub is suspended.
async function suspendPastDueSubscriptions(graceDays = 7) {
    await initDB();
    const graceMs = Math.max(0, Number(graceDays)) * 86400 * 1000;
    const cutoffIso = new Date(Date.now() - graceMs).toISOString();

    const orgsToSuspend = await getAll(
        `SELECT organization_id, payment_attempt_count, past_due_since
           FROM organization_subscriptions
          WHERE past_due_since IS NOT NULL
            AND past_due_since < $1
            AND status NOT IN ('suspended', 'cancelled')`,
        [cutoffIso]
    );
    for (const row of orgsToSuspend) {
        try {
            await run(
                `UPDATE organization_subscriptions
                    SET status = 'suspended', payment_status = 'failed', updated_at = $2
                  WHERE organization_id = $1`,
                [row.organization_id, new Date().toISOString()]
            );
            try { require('../usageStore').invalidatePaygCache(row.organization_id, null); } catch (_) { /* circular-load safe */ }
            await logSubscriptionAudit(
                'dunning_suspend', 'organization', row.organization_id, 'system', null,
                { reason: 'past_due_grace_exceeded', attempt_count: row.payment_attempt_count, past_due_since: row.past_due_since, grace_days: graceDays }
            );
        } catch (e) {
            log.error('[UserStore] suspendPastDueSubscriptions org error:', row.organization_id, e.message);
        }
    }

    const consumersToSuspend = await getAll(
        `SELECT user_id, payment_attempt_count, past_due_since
           FROM consumer_subscriptions
          WHERE past_due_since IS NOT NULL
            AND past_due_since < $1
            AND status NOT IN ('suspended', 'cancelled')`,
        [cutoffIso]
    );
    for (const row of consumersToSuspend) {
        try {
            await run(
                `UPDATE consumer_subscriptions
                    SET status = 'suspended', payment_status = 'failed', updated_at = $2
                  WHERE user_id = $1`,
                [row.user_id, new Date().toISOString()]
            );
            try { require('../usageStore').invalidatePaygCache(null, row.user_id); } catch (_) { /* circular-load safe */ }
            await logSubscriptionAudit(
                'dunning_suspend', 'consumer', row.user_id, 'system', null,
                { reason: 'past_due_grace_exceeded', attempt_count: row.payment_attempt_count, past_due_since: row.past_due_since, grace_days: graceDays }
            );
        } catch (e) {
            log.error('[UserStore] suspendPastDueSubscriptions consumer error:', row.user_id, e.message);
        }
    }

    return { orgs: orgsToSuspend.length, consumers: consumersToSuspend.length };
}

// Persist trial-end transitions. Called by the trial-expiry scheduler.
// Subs whose trial_end_date has passed and that aren't paid get flipped to
// status='suspended', payment_status='trial_expired'. Idempotent.
async function expireOverdueTrials() {
    await initDB();
    const nowIso = new Date().toISOString();

    const orgsExpiring = await getAll(
        `SELECT organization_id, trial_end_date
           FROM organization_subscriptions
          WHERE status = 'trialing'
            AND trial_end_date IS NOT NULL
            AND trial_end_date < $1
            AND COALESCE(payment_status, '') NOT IN ('paid', 'trialing')`,
        [nowIso]
    );
    for (const row of orgsExpiring) {
        try {
            // BFSF-226: an expired no-card trial drops to the capped Free plan
            // (usable) rather than `suspended` (locked-out). downgradeOrgToFreePlan
            // invalidates the PAYG cache and audits the transition. The primary
            // path is the Stripe `subscription.deleted` webhook; this tick is the
            // backstop for trials stuck in an odd state.
            const downgraded = await downgradeOrgToFreePlan(row.organization_id, { changedBy: 'system', reason: 'trial_expired' });
            if (!downgraded) {
                // No Free plan to fall back to — preserve the prior suspend
                // behaviour so the org doesn't keep an unlimited trial.
                await run(
                    `UPDATE organization_subscriptions
                        SET status = 'suspended', payment_status = 'trial_expired', updated_at = $2
                      WHERE organization_id = $1`,
                    [row.organization_id, nowIso]
                );
                try { require('../usageStore').invalidatePaygCache(row.organization_id, null); } catch (_) { /* circular-load safe */ }
            }
            await logSubscriptionAudit(
                'trial_expired', 'organization', row.organization_id, 'system', null,
                { trial_end_date: row.trial_end_date, transitioned_to: downgraded ? 'free' : 'suspended' }
            );
        } catch (e) {
            log.error('[UserStore] expireOverdueTrials org error:', row.organization_id, e.message);
        }
    }

    const consumersExpiring = await getAll(
        `SELECT user_id, trial_end_date
           FROM consumer_subscriptions
          WHERE status = 'trialing'
            AND trial_end_date IS NOT NULL
            AND trial_end_date < $1
            AND COALESCE(payment_status, '') NOT IN ('paid', 'trialing')`,
        [nowIso]
    );
    for (const row of consumersExpiring) {
        try {
            await run(
                `UPDATE consumer_subscriptions
                    SET status = 'suspended', payment_status = 'trial_expired', updated_at = $2
                  WHERE user_id = $1`,
                [row.user_id, nowIso]
            );
            try { require('../usageStore').invalidatePaygCache(null, row.user_id); } catch (_) { /* circular-load safe */ }
            await logSubscriptionAudit(
                'trial_expired', 'consumer', row.user_id, 'system', null,
                { trial_end_date: row.trial_end_date, transitioned_to: 'suspended' }
            );
        } catch (e) {
            log.error('[UserStore] expireOverdueTrials consumer error:', row.user_id, e.message);
        }
    }

    return { orgs: orgsExpiring.length, consumers: consumersExpiring.length };
}

// ── Default org plan resolution + downgrade-to-Free ──────────────────────────
// The capped Free org plan is the floor every cloud org falls back to: at
// signup (createOrganization), when a no-card trial ends without payment, and
// when a never-paid Stripe subscription is deleted. Centralised here so the
// lookup + cheapest-plan fallback stay identical across all call sites
// (BFSF-226). Consumers don't need this — checkConsumerLimits always floors
// them at the `__consumer_default__` plan regardless of subscription state.
async function getDefaultOrgPlanId() {
    await initDB();
    // Preferred: the operator-designated default org plan.
    let row = await getOne(
        `SELECT id FROM subscription_plans
          WHERE is_default = TRUE AND (plan_type = 'organization' OR plan_type IS NULL)
          LIMIT 1`
    );
    if (row?.id) return row.id;
    // Fallback: the cheapest org plan, so a new/expired org stays capped even
    // if the single-default invariant was lost by inconsistent seeding.
    row = await getOne(
        `SELECT id FROM subscription_plans
          WHERE (plan_type = 'organization' OR plan_type IS NULL)
          ORDER BY price ASC NULLS LAST, created_at ASC
          LIMIT 1`
    );
    return row?.id || null;
}

/**
 * Downgrade an org to the capped Free plan (BFSF-226). Used when a no-card
 * trial expires or a never-paid Stripe subscription is deleted, so the org
 * lands on a usable, capped plan instead of being left unlimited (no row) or
 * locked-out (suspended/cancelled).
 *
 * Keeps stripe_customer_id so a later upgrade reuses the same customer; clears
 * the dead subscription/trial/schedule bookkeeping. setOrgSubscription's
 * plan-change path clears stale per-org limit overrides so the Free plan caps
 * govern (BFSF-245). Best-effort: returns the resolved subscription, or null
 * if no default plan exists (logged) so callers can fall back.
 */
async function downgradeOrgToFreePlan(orgId, { changedBy = 'system', reason = 'downgrade_to_free' } = {}) {
    await initDB();
    const freeId = await getDefaultOrgPlanId();
    if (!freeId) {
        log.warn(`[UserStore] downgradeOrgToFreePlan: no default org plan found for org ${orgId} — left unchanged`);
        return null;
    }
    const before = await getOrgSubscription(orgId);
    // Respect an admin manual-override hold, mirroring the Stripe webhook path's
    // setOrgSubscriptionRespectingOverride. Return the unchanged row (truthy) so
    // callers treat it as handled and skip their suspend/cancel fallback rather
    // than clobbering the admin's pin.
    if (isManualOverrideActive(before)) {
        log.info(`[UserStore] downgradeOrgToFreePlan: manual override active for org ${orgId} — skipped`);
        return before;
    }
    const ok = await setOrgSubscription(orgId, {
        plan_id: freeId,
        status: 'active',
        payment_status: null,
        stripe_subscription_id: null,
        trial_end_date: null,
        cancel_at_period_end: false,
        cancel_at: null,
        pending_plan_id: null,
        pending_plan_effective: null,
        stripe_schedule_id: null,
    });
    // setOrgSubscription swallows DB errors and returns false. Surface that as
    // null so callers fall back (suspend/cancel) instead of logging a phantom
    // downgrade and leaving stale state.
    if (!ok) {
        log.warn(`[UserStore] downgradeOrgToFreePlan: setOrgSubscription failed for org ${orgId}`);
        return null;
    }
    try { await require('../../services/planEntitlements').applyPlanToOrg(orgId, freeId, { mode: 'reset' }); }
    catch (e) { log.warn(`[UserStore] downgradeOrgToFreePlan applyPlanToOrg failed for ${orgId}:`, e.message); }
    try { require('../usageStore').invalidatePaygCache(orgId, null); } catch (_) { /* circular-load safe */ }
    await logSubscriptionAudit('downgrade_to_free', 'organization', orgId, changedBy, before, { plan_id: freeId, reason });
    return await getOrgSubscription(orgId);
}

// Stripe transitions a subscription from `incomplete` → `incomplete_expired`
// after ~14 days when no payment method is added. If that webhook is missed
// (Stripe outage, misconfig), the local row stays `incomplete` forever and
// admins see a stuck subscription. Sweep + flip to `cancelled` matches
// Stripe's own expiry semantics. Idempotent and safe to call from a tick.
async function cancelStaleIncompleteSubscriptions(thresholdDays = 14) {
    await initDB();
    const cutoffIso = new Date(Date.now() - Math.max(0, Number(thresholdDays)) * 86400 * 1000).toISOString();

    const orgs = await getAll(
        `SELECT organization_id FROM organization_subscriptions
          WHERE status = 'incomplete' AND created_at < $1`,
        [cutoffIso]
    );
    for (const r of orgs) {
        try {
            // setOrgSubscription validates status, audits via the column-update
            // path, and busts the PAYG cache; reuse it for consistency.
            await setOrgSubscription(r.organization_id, { status: 'cancelled', payment_status: 'failed' });
            await logSubscriptionAudit(
                'cancel_stale_incomplete', 'organization', r.organization_id, 'system', null,
                { threshold_days: thresholdDays }
            );
        } catch (e) {
            log.error('[UserStore] cancelStaleIncompleteSubscriptions org error:', r.organization_id, e.message);
        }
    }

    const consumers = await getAll(
        `SELECT user_id FROM consumer_subscriptions
          WHERE status = 'incomplete' AND created_at < $1`,
        [cutoffIso]
    );
    for (const r of consumers) {
        try {
            await setConsumerSubscription(r.user_id, { status: 'cancelled', payment_status: 'failed' });
            await logSubscriptionAudit(
                'cancel_stale_incomplete', 'consumer', r.user_id, 'system', null,
                { threshold_days: thresholdDays }
            );
        } catch (e) {
            log.error('[UserStore] cancelStaleIncompleteSubscriptions consumer error:', r.user_id, e.message);
        }
    }

    return { orgs: orgs.length, consumers: consumers.length };
}

module.exports = {
    claimNotificationSlot, getDunningCounts,
    recordStripeEventProcessed, releaseStripeEventProcessed,
    recordPaymentFailureForOrg, recordPaymentFailureForConsumer,
    resetPaymentFailureForOrg, resetPaymentFailureForConsumer,
    suspendPastDueSubscriptions, expireOverdueTrials, cancelStaleIncompleteSubscriptions,
    getDefaultOrgPlanId, downgradeOrgToFreePlan,
};
