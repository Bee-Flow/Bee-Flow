// @typecheck strict
/**
 * One-shot boot checks, backfills and data migrations.
 *
 * One phase of boot/startupTasks.js runStartupTasks(), which calls the phases
 * in the order they always ran; see that file for the whole sequence.
 */

const log = require('../telemetry/log');
const { trackBootStep } = require('../utils/runtimeState.mts');
const loader = require('../modules/firstParty/loader');

/**
 * Start one of the migration ladders of bootMigrations.js after the current
 * tick (boot does not wait for it) and make it a boot step: the readiness
 * probe answers "starting" until the ladder has ended. A ladder that ends with
 * failed migrations is one error line with their names, not a line per
 * migration somewhere in the warnings; it does not stop boot, and a failed
 * migration runs again at the next start (only a success is recorded).
 *
 * @param {string} step what the log line and the boot state call it
 * @param {() => Promise<{ failed: { name: string }[] }>} run
 */
function startLadder(step, run) {
    // Tracked in this tick, so no request can see "ready" between listen and the ladder's start.
    trackBootStep(step, new Promise((resolve) => { setImmediate(resolve); }).then(run).then((out) => {
        if (out.failed.length === 0) return;
        const names = out.failed.map((f) => f.name).join(', ');
        log.error(`[Server] ${step}: ${out.failed.length} failed, the rest ran. They run again at the next start: ${names}`);
        throw new Error(`${step} failed: ${names}`);
    }, (e) => {
        // The ladder catches each migration's own error, so this is the ladder itself not running.
        log.error(`[Server] ${step} did not run:`, e.message);
        throw e;
    }));
}

/** One-shot checks, backfills and data migrations, each non-blocking. */
function runOneShotTasks() {
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
    // on a failure; here it logs the failed names and carries on, boot comes first).
    startLadder('data migrations', () => require('./bootMigrations').runLooseMigrations());

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
    startLadder('Dutch translation catalogues', () => require('./bootMigrations').runNlTranslations());

    // The module rows of this phase: the Stripe webhook-secret check
    // (firstParty/billing_stripe.jobs.js) and the CMS image-variant backfill
    // (firstParty/cms.jobs.js).
    loader.runStartupPhase('runOneShotTasks');
}

module.exports = { runOneShotTasks, startLadder };
