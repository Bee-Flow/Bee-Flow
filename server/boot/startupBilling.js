/**
 * Billing schedulers: dunning, trial expiry, plan-cap drift, seat sync, PAYG drain.
 *
 * One phase of boot/startupTasks.js runStartupTasks(), which calls the phases
 * in the order they always ran; see that file for the whole sequence.
 */

const log = require('../telemetry/log');

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
                if (stale.orgs || stale.consumers) {
                    log.info(`[IncompleteCleanup] cancelled orgs=${stale.orgs} consumers=${stale.consumers}`);
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
                    const r = await require('../services/planEntitlements').auditPlanCapDrift({ trim: PLAN_CAP_AUTO_TRIM });
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
                            } catch (err) { log.debug('audit best-effort', err); }
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
}

/** The Stripe per-seat quantity sync (cloud only). */
function startSeatSync() {
    // Stripe per-seat quantity drift sync. The customer.subscription.updated
    // webhook normally echoes seat counts, but if an org adds/removes users
    // without a Stripe event firing (NC group sync, admin DELETE),
    // stripe_seat_quantity can drift below the local active-user count and
    // the next invoice underbills. The sweep walks every per-seat org and
    // pushes the current count to Stripe; idempotent (no-op when Stripe
    // already matches local).
    if ((process.env.DEPLOYMENT_MODE || 'cloud') !== 'self-hosted') {
        try {
            const SEAT_SYNC_INTERVAL_MS = parseInt(process.env.STRIPE_SEAT_SYNC_INTERVAL_MS || String(15 * 60 * 1000), 10);
            const runSeatSync = async () => {
                try {
                    const us = require('../stores/userStore');
                    const { syncSeatQuantityForOrg } = require('../services/stripeService');
                    const subs = await us.getAllOrgSubscriptions();
                    let synced = 0;
                    for (const sub of (subs || [])) {
                        if (!sub.organization_id || sub.status !== 'active') continue;
                        if (!sub.stripe_subscription_id) continue;
                        try {
                            await syncSeatQuantityForOrg(sub.organization_id);
                            synced++;
                        } catch (e) {
                            log.warn(`[SeatSync] org=${sub.organization_id} failed: ${e.message}`);
                        }
                    }
                    if (synced > 0) log.info(`[SeatSync] checked ${synced} active per-seat orgs`);
                } catch (e) { log.error('[SeatSync] tick error:', e.message); }
            };
            setTimeout(runSeatSync, 90_000).unref();
            setInterval(runSeatSync, SEAT_SYNC_INTERVAL_MS).unref();
            log.info(`[Server] Stripe seat-sync scheduler started (interval=${SEAT_SYNC_INTERVAL_MS}ms)`);
        } catch (e) {
            log.warn('[Server] Failed to start seat-sync scheduler:', e.message);
        }
    }
}

/** The PAYG meter event drain (cloud only). */
function startPaygDrain() {
    // PAYG meter event drain — durable Stripe meter event delivery. The
    // hot path (usageStore.logUsage) enqueues into payg_meter_outbox; this
    // tick drains pending rows with backoff. Self-hosted installs have no
    // PAYG plan so the drain is a cheap empty scan there.
    if ((process.env.DEPLOYMENT_MODE || 'cloud') !== 'self-hosted') {
        try {
            const PAYG_DRAIN_INTERVAL_MS = parseInt(process.env.PAYG_DRAIN_TICK_INTERVAL_MS || '30000', 10);
            const runPaygDrain = async () => {
                const t0 = Date.now();
                let ok = true;
                try {
                    const r = await require('../workers/paygDrain').drainOnce();
                    if (r.delivered || r.failed || r.hardFailed) {
                        log.info(`[PaygDrain] delivered=${r.delivered} failed=${r.failed} hard_failed=${r.hardFailed}`);
                    }
                } catch (e) { ok = false; log.error('[PaygDrain] tick error:', e.message); }
                finally { try { require('../telemetry/metrics').recordJobRun({ job: 'payg_drain', status: ok ? 'ok' : 'error', durationMs: Date.now() - t0 }); } catch (err) { log.debug('best-effort', err); } }
            };
            setTimeout(runPaygDrain, 30_000).unref();
            setInterval(runPaygDrain, PAYG_DRAIN_INTERVAL_MS).unref();
            log.info(`[Server] PAYG meter drain scheduler started (interval=${PAYG_DRAIN_INTERVAL_MS}ms)`);
        } catch (e) {
            log.warn('[Server] Failed to start PAYG drain scheduler:', e.message);
        }
    }
}

module.exports = { startDunningAndTrialSchedulers, startPlanCapDriftAudit, startSeatSync, startPaygDrain };
