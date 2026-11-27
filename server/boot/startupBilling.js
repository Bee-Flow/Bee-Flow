// @typecheck strict
/**
 * Billing schedulers: dunning, trial expiry, plan-cap drift, seat sync, PAYG drain.
 *
 * One phase of boot/startupTasks.js runStartupTasks(), which calls the phases
 * in the order they always ran; see that file for the whole sequence.
 */

const log = require('../telemetry/log');
const { bestEffort } = require('../utils/bestEffort');
const loader = require('../modules/firstParty/loader');

/** Dunning and trial-expiry ticks. */
function startDunningAndTrialSchedulers() {
    // Dunning + trial-expiry schedulers. The dunning tick scans for orgs
    // that have been past_due longer than STRIPE_DUNNING_GRACE_DAYS and
    // flips them to suspended. The trial tick suspends trials whose
    // trial_end_date is in the past and that don't have payment_status='paid'.
    // Both are idempotent and re-run safely.
    try {
        const userStore = require('../stores/userStore');
        const DUNNING_INTERVAL_MS = parseInt(process.env.STRIPE_DUNNING_TICK_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10);
        const DUNNING_GRACE_DAYS = parseInt(process.env.STRIPE_DUNNING_GRACE_DAYS || '7', 10);
        const TRIAL_TICK_INTERVAL_MS = parseInt(process.env.TRIAL_EXPIRY_TICK_INTERVAL_MS || String(30 * 60 * 1000), 10);
        const runDunningTick = async () => {
            try {
                const r = await userStore.suspendPastDueSubscriptions(DUNNING_GRACE_DAYS);
                if (r.orgs || r.consumers) {
                    log.info(`[Dunning] suspended orgs=${r.orgs} consumers=${r.consumers} grace_days=${DUNNING_GRACE_DAYS}`);
                }
            } catch (e) { log.error('[Dunning] tick error:', e.message); }
        };
        const runTrialExpiryTick = async () => {
            try {
                const r = await userStore.expireOverdueTrials();
                if (r.orgs || r.consumers) {
                    log.info(`[TrialExpiry] suspended orgs=${r.orgs} consumers=${r.consumers}`);
                }
                // Also sweep `incomplete` subscriptions older than 14 days so
                // a missed Stripe `incomplete_expired` webhook doesn't leave
                // them stuck. Stripe's own grace window is 14 days.
                const stale = await userStore.cancelStaleIncompleteSubscriptions(14);
                if (stale.orgs || stale.consumers || stale.failed) {
                    log.info(`[IncompleteCleanup] cancelled orgs=${stale.orgs} consumers=${stale.consumers} failed=${stale.failed}`);
                }
            } catch (e) { log.error('[TrialExpiry] tick error:', e.message); }
        };
        setTimeout(runDunningTick, 60_000).unref();
        setInterval(runDunningTick, DUNNING_INTERVAL_MS).unref();
        setTimeout(runTrialExpiryTick, 45_000).unref();
        setInterval(runTrialExpiryTick, TRIAL_TICK_INTERVAL_MS).unref();
        log.info(`[Server] Dunning+TrialExpiry schedulers started (dunning=${DUNNING_INTERVAL_MS}ms grace=${DUNNING_GRACE_DAYS}d, trial=${TRIAL_TICK_INTERVAL_MS}ms)`);
    } catch (e) {
        log.warn('[Server] Failed to start dunning/trial schedulers:', e.message);
    }
    loader.runStartupPhase('startDunningAndTrialSchedulers');
}

/** The plan-cap drift audit (cloud only). */
function startPlanCapDriftAudit() {
    // Plan-cap drift audit. When a plan's `allowed_*` is narrowed *after*
    // orgs have opted in, the runtime keeps serving the feature because
    // `applyCap` only runs at toggle time. This daily sweep emits an
    // audit row for every drifting (org, feature) pair so compliance has
    // a record. Read-only by default; flip PLAN_CAP_AUTO_TRIM=true to
    // also re-intersect and persist the trimmed list.
    if ((process.env.DEPLOYMENT_MODE || 'cloud') !== 'self-hosted') {
        try {
            const PLAN_CAP_DRIFT_INTERVAL_MS = parseInt(process.env.PLAN_CAP_DRIFT_INTERVAL_MS || String(24 * 60 * 60 * 1000), 10);
            const PLAN_CAP_AUTO_TRIM = process.env.PLAN_CAP_AUTO_TRIM === 'true';
            const runPlanCapDrift = async ({ isBoot = false } = {}) => {
                try {
                    const r = await require('../core/entitlements/planEntitlements').auditPlanCapDrift({ trim: PLAN_CAP_AUTO_TRIM });
                    if (r.drifted > 0) {
                        log.info(`[PlanCapDrift] scanned=${r.scanned} drifted=${r.drifted} trimmed=${r.trimmed} auto_trim=${PLAN_CAP_AUTO_TRIM}${isBoot ? ' boot=1' : ''}`);
                        if (isBoot) {
                            // Surface a single audit marker so post-deploy drift
                            // is visible in compliance reports without grepping
                            // logs.
                            try {
                                const userStore = require('../stores/userStore');
                                await userStore.logAccessAudit(
                                    'plan_cap_drift_detected_at_boot',
                                    'system',
                                    'plan_cap_drift',
                                    'system',
                                    null,
                                    { scanned: r.scanned, drifted: r.drifted, trimmed: r.trimmed },
                                    null,
                                );
                            } catch (err) { bestEffort('boot/startupBilling:runPlanCapDrift', err); /* audit best-effort */ }
                        }
                    }
                } catch (e) { log.error('[PlanCapDrift] tick error:', e.message); }
            };
            // Run once synchronously at boot so a deploy with a freshly
            // narrowed plan surfaces drift immediately rather than waiting
            // for the first scheduled tick. Awaited inside an IIFE so we
            // don't block module init.
            (async () => { try { await runPlanCapDrift({ isBoot: true }); } catch (_) { log.warn('boot-time plan cap drift check failed', _); } })();
            setInterval(() => runPlanCapDrift({ isBoot: false }), PLAN_CAP_DRIFT_INTERVAL_MS).unref();
            log.info(`[Server] Plan-cap drift audit scheduled (interval=${PLAN_CAP_DRIFT_INTERVAL_MS}ms auto_trim=${PLAN_CAP_AUTO_TRIM})`);
        } catch (e) {
            log.warn('[Server] Failed to start plan-cap drift audit:', e.message);
        }
    }
    loader.runStartupPhase('startPlanCapDriftAudit');
}

/** The Stripe per-seat quantity sync (cloud only): a row of billing_stripe (firstParty/billing_stripe.jobs.js). */
function startSeatSync() {
    loader.runStartupPhase('startSeatSync');
}

/** The PAYG meter event drain (cloud only): a row of billing_stripe (firstParty/billing_stripe.jobs.js). */
function startPaygDrain() {
    loader.runStartupPhase('startPaygDrain');
}

module.exports = { startDunningAndTrialSchedulers, startPlanCapDriftAudit, startSeatSync, startPaygDrain };
