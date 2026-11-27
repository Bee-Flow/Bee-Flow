// @typecheck strict
/**
 * The startup jobs of the first-party module "billing_stripe" (part "jobs" of
 * firstParty/billing_stripe.js; contract in modules/firstParty/contract.js). Moved verbatim out
 * of boot/startupOneShots.js and boot/startupBilling.js, started by loader.runStartupPhase in the
 * same phase; each keeps its own try/catch and log text.
 */

'use strict';

const log = require('../modules/firstParty/partLog');

/**
 * Stripe configuration sanity check. If Stripe is enabled but the webhook
 * signing secret is missing, every incoming webhook will be rejected with
 * 400 — that's silent in production unless the admin actively watches
 * webhook delivery logs. Surface it loudly at boot.
 */
function checkWebhookSecret() {
    if ((process.env.DEPLOYMENT_MODE || 'cloud') !== 'self-hosted') {
        (async () => {
            try {
                const stripeService = require('../services/stripeService');
                const configStore = require('../stores/configStore');
                if (await stripeService.isEnabled()) {
                    const secret = await configStore.getSecret('stripe_webhook_secret');
                    if (!secret) {
                        log.error('[Stripe] WARNING: Stripe is enabled but stripe_webhook_secret is not configured — all incoming webhooks will be rejected with 400. Configure the signing secret in the Stripe admin UI.');
                    }
                }
            } catch (e) {
                log.warn('[Stripe] Startup config check failed:', /** @type {Error} */ (e).message);
            }
        })();
    }
}

/** One pass of the seat sync: push the active-user count of every per-seat org to Stripe. */
async function runSeatSync() {
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
                log.warn(`[SeatSync] org=${sub.organization_id} failed: ${/** @type {Error} */ (e).message}`);
            }
        }
        if (synced > 0) log.info(`[SeatSync] checked ${synced} active per-seat orgs`);
    } catch (e) { log.error('[SeatSync] tick error:', /** @type {Error} */ (e).message); }
}

/**
 * Stripe per-seat quantity drift sync. The customer.subscription.updated
 * webhook normally echoes seat counts, but if an org adds/removes users
 * without a Stripe event firing (NC group sync, admin DELETE),
 * stripe_seat_quantity can drift below the local active-user count and
 * the next invoice underbills. The sweep walks every per-seat org and
 * pushes the current count to Stripe; idempotent (no-op when Stripe
 * already matches local).
 */
function startSeatSync() {
    if ((process.env.DEPLOYMENT_MODE || 'cloud') !== 'self-hosted') {
        try {
            const SEAT_SYNC_INTERVAL_MS = parseInt(process.env.STRIPE_SEAT_SYNC_INTERVAL_MS || String(15 * 60 * 1000), 10);
            setTimeout(runSeatSync, 90_000).unref();
            setInterval(runSeatSync, SEAT_SYNC_INTERVAL_MS).unref();
            log.info(`[Server] Stripe seat-sync scheduler started (interval=${SEAT_SYNC_INTERVAL_MS}ms)`);
        } catch (e) {
            log.warn('[Server] Failed to start seat-sync scheduler:', /** @type {Error} */ (e).message);
        }
    }
}

/** One pass of the PAYG drain, with its job metric. */
async function runPaygDrain() {
    const t0 = Date.now();
    let ok = true;
    try {
        const r = await require('../workers/paygDrain').drainOnce();
        if (r.delivered || r.failed || r.hardFailed) {
            log.info(`[PaygDrain] delivered=${r.delivered} failed=${r.failed} hard_failed=${r.hardFailed}`);
        }
    } catch (e) { ok = false; log.error('[PaygDrain] tick error:', /** @type {Error} */ (e).message); }
    finally { try { require('../telemetry/metrics').recordJobRun({ job: 'payg_drain', status: ok ? 'ok' : 'error', durationMs: Date.now() - t0 }); } catch (err) { require('../utils/bestEffort').bestEffort('boot/startupBilling:runPaygDrain', err); /* best-effort */ } }
}

/**
 * PAYG meter event drain — durable Stripe meter event delivery. The
 * hot path (usageStore.logUsage) enqueues into payg_meter_outbox; this
 * tick drains pending rows with backoff. Self-hosted installs have no
 * PAYG plan so the drain is a cheap empty scan there.
 */
function startPaygDrain() {
    if ((process.env.DEPLOYMENT_MODE || 'cloud') !== 'self-hosted') {
        try {
            const PAYG_DRAIN_INTERVAL_MS = parseInt(process.env.PAYG_DRAIN_TICK_INTERVAL_MS || '30000', 10);
            setTimeout(runPaygDrain, 30_000).unref();
            setInterval(runPaygDrain, PAYG_DRAIN_INTERVAL_MS).unref();
            log.info(`[Server] PAYG meter drain scheduler started (interval=${PAYG_DRAIN_INTERVAL_MS}ms)`);
        } catch (e) {
            log.warn('[Server] Failed to start PAYG drain scheduler:', /** @type {Error} */ (e).message);
        }
    }
}

/** @type {import('../modules/firstParty/contract').JobRow[]} */
const jobs = [
    { key: 'billing_stripe:webhookSecretCheck', phase: 'runOneShotTasks', label: 'Stripe config check', start: checkWebhookSecret },
    { key: 'billing_stripe:seatSync', phase: 'startSeatSync', label: 'Stripe seat-sync scheduler', start: startSeatSync },
    { key: 'billing_stripe:paygDrain', phase: 'startPaygDrain', label: 'PAYG drain scheduler', start: startPaygDrain },
];

module.exports = { jobs };
