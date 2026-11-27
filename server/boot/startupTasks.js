// @typecheck strict
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
 * Each phase of runStartupTasks() starts its core work and then the job rows
 * the first-party modules contribute to it (modules/firstParty/loader.js
 * runStartupPhase, rows in firstParty/<id>.jobs.js).
 *
 * The after-listen wiring of the modules (the webpage full-tier proxy) sits
 * BETWEEN the two, in boot/lifecycle.js: it needs the http.Server and the
 * terminal error handler.
 */

const fs = require('fs');
const log = require('../telemetry/log');
const { trackBootStep } = require('../utils/runtimeState.mts');
const { requireIfPresent } = require('./optionalRequire');
const { startBootProbes, startLicenseAndModuleRuntime, startLateWarmups } = require('./startupProbes');
const { runOneShotTasks } = require('./startupOneShots');
const { startDunningAndTrialSchedulers, startPlanCapDriftAudit, startSeatSync, startPaygDrain } = require('./startupBilling');
const {
    startRetentionAndComplianceJobs, startConfigInvalidationListener, startModuleSchedulers,
    startRunnersAndFeeds, startSupportAndSyncJobs,
} = require('./startupJobs');
const { seedSystemAgentsAtBoot } = require('./startupSystemAgents');
const { startPruneSchedulers } = require('./startupPrunes');

/**
 * The warning for a server that runs in Kubernetes on the default App Studio
 * engine, or null. That engine keeps each app's records in one SQLite file that
 * one process writes (stores/lib/sqliteBlobFlush.js): a second replica that
 * writes the same app has its flush refused, loses what it had not flushed and
 * refuses that app's writes from then on. A Deployment is where a second
 * replica is one `kubectl scale` away, and the server cannot see the replica
 * count, so the line says it may not apply.
 * @param {{ inCluster: boolean, engine: string }} where
 * @returns {string | null}
 */
function studioEngineReplicaWarning({ inCluster, engine }) {
    if (!inCluster || engine !== 'sqlite') return null;
    return '[Server] App Studio runs on its default engine (STUDIO_APP_ENGINE=sqlite), which supports ONE server replica. '
        + 'With one replica this line does not apply. Before running more: move the apps with scripts/migrateStudioAppsToPg.js '
        + 'and set STUDIO_APP_ENGINE=pg, or two replicas writing the same app lose data and refuse its writes.';
}

function runStartupChecks() {
    // First, because everything below this line reads or writes a store, and a
    // fresh install should have its tables before the first request rather
    // than during it. Not awaited and not a precondition — see
    // boot/storeSchemas.js: a store nobody started here creates its schema on
    // its first query. The readiness probe does wait for them (utils/runtimeState.mts).
    const schemas = require('./storeSchemas').startStoreSchemas();
    trackBootStep('store schemas', schemas.settled.then(({ rejected }) => {
        if (rejected.length > 0) throw new Error(`store schema init failed: ${rejected.join(', ')}`);
    }));

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

    const replicaWarning = studioEngineReplicaWarning({
        inCluster: !!process.env.KUBERNETES_SERVICE_HOST,
        engine: require('../utils/engineFlag').getDialect(),
    });
    if (replicaWarning) log.warn(replicaWarning);

    // Run first-boot setup from INIT_* env vars (set by the installer or deployment env)
    const { runBootInit } = require('../boot-init');
    runBootInit().catch(err => log.error('[boot-init] Fatal:', err));

    // Learning-certificate HMAC secret: bootstrap a configStore-persisted secret
    // for installs that never set LEARNING_CERT_SECRET, so certificate serials
    // and public verify links survive restarts instead of silently breaking.
    // A file of the learning module: an optional lookup, skipped when the module is absent.
    const certificateToken = requireIfPresent(() => require('../auth/certificateToken'));
    if (certificateToken) certificateToken.ensureDurableSecret().catch(err => log.error('[CertificateToken] bootstrap failed:', err.message));

    // Webpage preview-token HMAC secret: same pattern — without this, each
    // replica of a multi-pod deploy would mint preview tokens with its own
    // random secret, so a token issued by one pod gets 401'd by another.
    // A file of the webpages module: an optional lookup, skipped when the module is absent.
    const webpagePreviewToken = requireIfPresent(() => require('../auth/webpagePreviewToken'));
    if (webpagePreviewToken) webpagePreviewToken.ensureDurableSecret().catch(err => log.error('[WebpagePreviewToken] bootstrap failed:', err.message));

    // Public-share HMAC secret: the same pattern once more, and the one with the
    // widest blast radius — it signs magic links, unlock cookies, view/bridge
    // tokens, the CSRF on public forms and the anonymous Studio-app visitor
    // identity. Without it a form page rendered by one replica answered "This
    // form expired" when the submit round-robined to another (BFSF-420).
    const { ensureDurableSecret: ensurePublicShareSecret } = require('../auth/publicShareToken');
    ensurePublicShareSecret().catch(err => log.error('[PublicShareToken] bootstrap failed:', err.message));

    // Nextcloud link-ticket HMAC secret: a ticket issued by one replica is
    // redeemed on whichever one the browser reaches.
    const { ensureDurableSecret: ensureNcLinkTicketSecret } = require('../auth/connector/ncLinkTicket.mts');
    ensureNcLinkTicketSecret().catch(err => log.error('[NcLinkTicket] bootstrap failed:', err.message));
}

/**
 * The phases of runStartupTasks(), in the order they run. Each lives in a sibling
 * module (boot/startup*.js) and only schedules or fires work, never waits on it,
 * so this is the order the timers and requests start. A list, so that a test can
 * hold it: a phase that is missing here is background work that never starts.
 */
const STARTUP_PHASES = [
    // First: the other phases read config, and the listener's first connect drops
    // whatever this replica cached while it was not listening.
    startConfigInvalidationListener,
    startBootProbes,
    startLicenseAndModuleRuntime,
    runOneShotTasks,
    startDunningAndTrialSchedulers,
    startPlanCapDriftAudit,
    startSeatSync,
    startPaygDrain,
    startLateWarmups,
    startRetentionAndComplianceJobs,
    seedSystemAgentsAtBoot,
    startModuleSchedulers,
    startRunnersAndFeeds,
    startSupportAndSyncJobs,
    startPruneSchedulers,
];

function runStartupTasks() {
    for (const phase of STARTUP_PHASES) phase();
}

module.exports = { runStartupChecks, runStartupTasks, STARTUP_PHASES, studioEngineReplicaWarning };
