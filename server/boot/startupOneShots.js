/**
 * One-shot boot checks, backfills and data migrations.
 *
 * One phase of boot/startupTasks.js runStartupTasks(), which calls the phases
 * in the order they always ran; see that file for the whole sequence.
 */

const log = require('../telemetry/log');

/** One-shot checks, backfills and data migrations, each non-blocking. */
function runOneShotTasks() {
    // Stripe configuration sanity check. If Stripe is enabled but the webhook
    // signing secret is missing, every incoming webhook will be rejected with
    // 400 — that's silent in production unless the admin actively watches
    // webhook delivery logs. Surface it loudly at boot.
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
                log.warn('[Stripe] Startup config check failed:', e.message);
            }
        })();
    }

    // Trial-history backfill — idempotent one-shot that copies existing
    // organizations.trial_used_at / users.trial_used_at into the durable
    // trial_history table. After this runs once, the unique index makes
    // subsequent boots a no-op. Non-blocking so a slow query never holds
    // up boot.
    setImmediate(() => {
        require('../stores/userStore').backfillTrialHistory().catch(e =>
            log.warn('[Server] trial_history backfill error:', e.message));
    });

    // Subscription-plan tier audit. A paid plan whose `tier` column is unset or
    // unrecognised issues NO licence to the customers who buy it — they pay and
    // silently stay on Community. Cheap read, logged loudly, never fatal: a
    // billing-catalogue typo must not stop the server from booting.
    setImmediate(async () => {
        try {
            const plans = await require('../stores/userStore').getAllPlans();
            require('../license/tierResolution').reportPlanTierProblems(plans);
        } catch (e) {
            log.warn('[Server] plan tier audit skipped:', e.message);
        }
    });

    // NC org-name backfill — idempotent one-shot that renames connector-
    // provisioned orgs still on the generic "Nextcloud" default to
    // "Nextcloud (<host>)" so they're distinguishable in the admin list.
    // After a row is renamed it no longer matches, so re-runs are no-ops.
    setImmediate(() => {
        require('../stores/userStore').backfillAutoProvisionedNcOrgNames().catch(e =>
            log.warn('[Server] nc org-name backfill error:', e.message));
    });

    // Loose data migrations: the list, and the reason for each entry, live in
    // bootMigrations.js, which `npm run db:migrate` runs too (there it exits 1
    // on a failure; here it warns and carries on, boot comes first).
    setImmediate(() => {
        require('./bootMigrations').runLooseMigrations().catch(e =>
            log.warn('[Server] losse-migratieladder faalde:', e.message));
    });


    // Warm the module-capability filter before the first entitlement resolve —
    // after a restart a still-valid session snapshot skips buildCeiling, so a
    // sync listCapabilities() reader would otherwise see the unfiltered
    // registry until some resolve warms the filter.
    setImmediate(() => {
        require('../modules').refreshModuleActivations().catch(e =>
            log.warn('[Server] module activation warm-up error:', e.message));
    });

    // ── Dutch translation catalogues: the list AND the reason for its order
    // live in bootMigrations.js (sequential: each is a read-modify-write of the
    // same row; run in parallel, the second writer erased the first's keys).
    setImmediate(() => {
        require('./bootMigrations').runNlTranslations().catch(e =>
            log.warn('[Server] NL-catalogusladder faalde:', e.message));
    });
}

module.exports = { runOneShotTasks };
