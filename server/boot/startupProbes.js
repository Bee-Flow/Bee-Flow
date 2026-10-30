// @typecheck strict
/**
 * Boot probes, warmups and the licence/module runtime.
 *
 * One phase of boot/startupTasks.js runStartupTasks(), which calls the phases
 * in the order they always ran; see that file for the whole sequence.
 */

const log = require('../telemetry/log');
const { bestEffort } = require('../utils/bestEffort');

/** Boot probes: the connector-bootstrap table check, the scheduling of the CPU model warmups and the two PII Guard notices. */
function startBootProbes() {
    // Connector bootstrap sanity probe — verifies the tables the
    // /auth/connector/bootstrap endpoint relies on actually exist after the
    // store modules' implicit migrations. Runs after a short delay so the
    // store init has time to finish CREATE TABLE statements. If a critical
    // table is missing we log fatal and exit non-zero so Kubernetes treats
    // the rollout as failed and we see it in `kubectl rollout status`
    // instead of catching cryptic 500s at the first customer install.
    setTimeout(() => {
        const userStore = require('../stores/userStore');
        userStore.getOrganizationByNcInstanceId('__sanity_probe__')
            .then(() => log.info('[Server] Connector bootstrap tables: OK'))
            .catch(err => {
                log.error(`[Server] FATAL: Connector bootstrap sanity probe failed: ${err.message}`);
                log.error('[Server] The /auth/connector/bootstrap endpoint will return 500s. Exiting so Kubernetes restarts.');
                process.exit(1);
            });
    }, 8000).unref();

    // The in-process CPU models (reranker, embedder, Whisper) are warmed later,
    // one at a time, and only when a request can reach them and has lately:
    // building their sessions blocks the main thread for seconds on a small
    // host, which at this point of boot starved the pool. See the module.
    require('./cpuPipelineWarmup').startCpuPipelineWarmups();

    // PII Guard model migration hint — non-blocking. If the configStore still
    // records the older `urchade/gliner_multi_pii-v1` model, nudge the admin
    // to reinstall the guard via the dashboard to pick up the newer Dutch +
    // healthcare/finance fine-tune (E3-JSI/gliner-multi-pii-domains-v1).
    setImmediate(async () => {
        try {
            const configStore = require('../stores/configStore');
            const installedModel = await configStore.getConfig('pii_guard_model');
            if (installedModel === 'urchade/gliner_multi_pii-v1') {
                log.warn('[PiiGuard] Old model in config (urchade/gliner_multi_pii-v1). Reinstall the guard service from Admin → Guardrails for improved Dutch + medical recall (E3-JSI/gliner-multi-pii-domains-v1).');
            }
        } catch (err) { bestEffort('boot/startupProbes:startBootProbes#3', err); /* fail-quiet */ }
    });

    // PII Guard reachability — one loud line at boot, non-blocking.
    //
    // Detection has two failure paths and only one of them is noisy. A guard
    // that is CONFIGURED but unreachable degrades and then applies the org's
    // piiFailureMode (fail_closed by default), so somebody notices within a
    // request. A guard that was never CONFIGURED returns null from detectPii()
    // and every caller falls open — the privacy feature is simply absent, and
    // the only trace is a per-call log line in a stream nobody reads at 3am.
    // A silent privacy measure is worse than a broken one, so say it once,
    // clearly, at the moment an operator is actually looking at the console.
    setImmediate(async () => {
        try {
            const { getGuardEndpoint } = require('../core/privacy/piiDetection/guardEndpoint');
            const { url } = await getGuardEndpoint();
            if (url) return;
            log.warn(
                '[PiiGuard] NOT CONFIGURED — PII detection is OFF and every caller falls open. '
                + 'Nothing is scanned, redacted or blocked. Set PII_SERVICE_URL (compose: bring up '
                + '--profile guard, which selfhost.sh wires for you) or install the guard from '
                + 'Admin → Guardrails.',
            );
        } catch (e) {
            // Resolution itself failed — that is not "off", it is unknown, and
            // unknown must not read as fine.
            log.warn('[PiiGuard] Could not determine whether PII detection is configured:', e.message);
        }
    });
}

/** The licence refresh scheduler and the downloadable-module runtime. */
function startLicenseAndModuleRuntime() {
    // License refresh scheduler — periodic ping to license.beeflow.nl for
    // monthly licenses. Yearly/lifetime licenses are validated by JWT exp
    // and skip this loop. Disable with LICENSE_REFRESH_DISABLED=true.
    try { require('../license/refresh').start(); } catch (e) {
        log.warn('[License Refresh] Failed to start scheduler:', e.message);
    }

    // Downloadable modules — re-verify + re-activate every installed package
    // from disk (a tampered staging dir can never come back up), then start the
    // Hub entitlement-refresh scheduler so lapsed subscriptions deactivate, and
    // the runtime reconciler (60s) converging the process onto the ledger
    // (activate-missing, self-heal, retention GC).
    try {
        require('../modules/packageLoader').loadInstalledAtBoot()
            .catch(err => log.error('[Modules] boot activation error:', err.message));
        require('../modules/entitlementRefresh').start();
        require('../modules/packageLoader').startReconciler();
    } catch (e) {
        log.warn('[Modules] Failed to start module runtime:', e.message);
    }
}

/** Optional browser warmup and the Privacy Shield self-check. */
function startLateWarmups() {
    // Optionally pre-warm the shared browser singleton so the first PDF export /
    // thumbnail / SPA ingest doesn't pay the container cold-start. Off by default
    // (idle deployments shouldn't hold a browser container open).
    if (process.env.BROWSER_WARMUP === 'true') {
        try {
            require('../services/pwtRunner')
                .ensureBrowserSingleton({ onLine: (l) => log.info(`[browser] ${l}`) })
                .then(
                    () => log.info('[Server] Shared browser singleton warmed'),
                    (e) => log.warn('[Server] Browser warmup failed:', e.message),
                );
        } catch (e) {
            log.warn('[Server] Browser warmup error:', e.message);
        }
    }

    // Security-scan drain moved out of core: Security Scan is now a downloadable
    // .bfmod (Hub marketplace). The module ships its own outbox drain + reaper,
    // scheduled by the module runtime at install time — not here.

    // Non-invasive self-check of every org Privacy Shield blob. Logs warnings
    // for legacy shapes, orphaned regex collections, and invalid custom terms
    // so operators can spot guardrail drift in the startup log.
    const { selfCheckOrgShields } = require('../core/privacy/orgShield');
    selfCheckOrgShields().catch(err => log.warn('[OrgShieldSelfCheck] Error:', err.message));

    // The previous in-process PII pre-warm has been removed — PII detection
    // now runs only through the optional PII Guard service container, which
    // owns its own model loading lifecycle. The Whisper pre-warm lives in
    // boot/cpuPipelineWarmup.js with the other CPU models.
}

module.exports = { startBootProbes, startLicenseAndModuleRuntime, startLateWarmups };
