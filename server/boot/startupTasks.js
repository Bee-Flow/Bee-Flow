// @typecheck
/**
 * What the server does once the HTTP listener is up, in two halves that index.js
 * calls in order from its listen callback:
 *
 *   runStartupChecks()  — the store schemas (boot/storeSchemas.js), then the
 *                         refuse-to-boot / NODE_ENV posture checks, the INIT_*
 *                         first-boot wizard and the durable HMAC secrets.
 *   runStartupTasks()   — the background work: sanity probes, warmups, one-shot
 *                         backfills and migrations, schedulers, runners and jobs.
 *
 * The webpage full-tier proxy mount sits BETWEEN the two and stays in index.js:
 * it needs the http.Server and the terminal error handler, both of which live
 * there.
 */

const fs = require('fs');
const log = require('../telemetry/log');
const { startBootProbes, startLicenseAndModuleRuntime, startLateWarmups } = require('./startupProbes');
const { runOneShotTasks } = require('./startupOneShots');
const { startDunningAndTrialSchedulers, startPlanCapDriftAudit, startSeatSync, startPaygDrain } = require('./startupBilling');
const { startRetentionAndComplianceJobs, startRunnersAndFeeds, startSupportAndSyncJobs } = require('./startupJobs');
const { seedSystemAgentsAtBoot } = require('./startupSystemAgents');
const { startPruneSchedulers } = require('./startupPrunes');

function runStartupChecks() {
    // First, because everything below this line reads or writes a store, and a
    // fresh install should have its tables before the first request rather
    // than during it. Not awaited and not a precondition — see
    // boot/storeSchemas.js: a store nobody started here creates its schema on
    // its first query.
    require('./storeSchemas').startStoreSchemas();

    if (process.env.INSECURE_CONNECTOR_TRUST === '1') {
        log.error('[SECURITY] INSECURE_CONNECTOR_TRUST=1 was set in the environment but the insecure connector bypass has been retired (Phase 2). Remove the variable. Refusing to boot.');
        process.exit(1);
    }

    // NODE_ENV sanity. Every branch in this file that keys off 'production'
    // silently takes its permissive path otherwise: session cookies are issued
    // without the Secure attribute, the built SPA and its cache headers are
    // never served, and dependencies switch to their debug behaviour — which is
    // exactly how a Node stack trace reached an anonymous caller before the
    // terminal handler above existed.
    //
    // Two different situations, deliberately not treated the same. In-cluster,
    // the ConfigMap pins NODE_ENV=production, so ANY other value is a real
    // misconfiguration of a real deployment. Outside a cluster only an EMPTY
    // value is suspicious: docker-compose.hub.local.yml sets `development` on
    // purpose (the module hub speaks plain http) and a developer running
    // `node index.js` is legitimate. Warned, never fatal — refusing to boot over
    // an env var would be the bigger outage.
    const nodeEnv = process.env.NODE_ENV || '';
    if (nodeEnv !== 'production') {
        const inCluster = !!process.env.KUBERNETES_SERVICE_HOST;
        const consequences = 'session cookies lose the Secure flag, the built frontend is not served, and dependencies take their debug paths';
        if (inCluster) {
            log.error(`[SECURITY] NODE_ENV="${nodeEnv}" in a Kubernetes deployment, expected "production": ${consequences}. Fix NODE_ENV in the beeflow-config ConfigMap.`);
        } else if (!nodeEnv) {
            const line = `NODE_ENV is not set, so this process is NOT in production mode: ${consequences}. Set NODE_ENV=production for any deployment.`;
            if (fs.existsSync('/.dockerenv')) log.error(`[SECURITY] ${line}`);
            else log.warn(`[Server] ${line}`);
        }
    }

    // Run first-boot setup from INIT_* env vars (set by the installer or deployment env)
    const { runBootInit } = require('../boot-init');
    runBootInit().catch(err => log.error('[boot-init] Fatal:', err));

    // Learning-certificate HMAC secret: bootstrap a configStore-persisted secret
    // for installs that never set LEARNING_CERT_SECRET, so certificate serials
    // and public verify links survive restarts instead of silently breaking.
    const { ensureDurableSecret } = require('../auth/certificateToken');
    ensureDurableSecret().catch(err => log.error('[CertificateToken] bootstrap failed:', err.message));

    // Webpage preview-token HMAC secret: same pattern — without this, each
    // replica of a multi-pod deploy would mint preview tokens with its own
    // random secret, so a token issued by one pod gets 401'd by another.
    const { ensureDurableSecret: ensureWebpagePreviewSecret } = require('../auth/webpagePreviewToken');
    ensureWebpagePreviewSecret().catch(err => log.error('[WebpagePreviewToken] bootstrap failed:', err.message));

    // Public-share HMAC secret: the same pattern once more, and the one with the
    // widest blast radius — it signs magic links, unlock cookies, view/bridge
    // tokens, the CSRF on public forms and the anonymous Studio-app visitor
    // identity. Without it a form page rendered by one replica answered "This
    // form expired" when the submit round-robined to another (BFSF-420).
    const { ensureDurableSecret: ensurePublicShareSecret } = require('../auth/publicShareToken');
    ensurePublicShareSecret().catch(err => log.error('[PublicShareToken] bootstrap failed:', err.message));
}

function runStartupTasks() {
    // Each phase lives in a sibling module (boot/startup*.js); this is the
    // order they run in. Every phase only schedules or fires work and never
    // waits on it, so the order is the order the timers and requests start.
    startBootProbes();
    startLicenseAndModuleRuntime();
    runOneShotTasks();
    startDunningAndTrialSchedulers();
    startPlanCapDriftAudit();
    startSeatSync();
    startPaygDrain();
    startLateWarmups();
    startRetentionAndComplianceJobs();
    seedSystemAgentsAtBoot();
    startRunnersAndFeeds();
    startSupportAndSyncJobs();
    startPruneSchedulers();
}

module.exports = { runStartupChecks, runStartupTasks };
