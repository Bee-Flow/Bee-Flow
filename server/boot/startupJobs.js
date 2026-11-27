// @typecheck strict
/**
 * Background runners and jobs started at boot.
 *
 * One phase of boot/startupTasks.js runStartupTasks(), which calls the phases
 * in the order they always ran; see that file for the whole sequence.
 */

const log = require('../telemetry/log');
const { isModuleAvailable } = require('../modules/catalog');
const loader = require('../modules/firstParty/loader');
const { optionalFeatureModule } = require('../core/featureModules');

/**
 * Retention jobs, the ports and the Azure group sync; then the module rows of this phase
 * (the App Studio run log, the compliance scheduler).
 */
function startRetentionAndComplianceJobs() {
    // The Art-5(1)(e) memory retention enforcer. (The AI Act + GDPR compliance
    // checks and the statutory-deadline notifier that were started next to it
    // are rows of the compliance module: firstParty/compliance.jobs.js.)
    require('../jobs/memoryRetentionEnforcer').start();
    // Memory search indexes: fills the tsvector and pgvector columns of rows
    // that predate them and re-embeds rows left on another embedding
    // dimension. Resumable and idempotent; first pass 90 s after boot.
    try {
        require('../jobs/memoryEmbeddingBackfill').start();
    } catch (err) {
        log.warn('[Server] Memory embedding backfill load failed:', err.message);
    }
    // Memory consolidation: merges near-duplicates and archives stale,
    // low-importance rows. Same fail-soft load as the backfill.
    try {
        require('../jobs/memoryConsolidation').start();
    } catch (err) {
        log.warn('[Server] Memory consolidation load failed:', err.message);
    }
    // Monitoring-ledger retention and the PII scan-ledger prune. NOT gated on
    // a module: chat and DLP fill those tables on every install, including
    // one without Automations, whose runner these passes do not ride.
    try {
        // A run on hold the retention pass ends withdraws the approval request it asked.
        // App Studio may be absent (an optional lookup): then there is no request to withdraw.
        require('../jobs/platformRetention').start({ releaseStudioWait: (appId, kind, ref, reason) => {
            const waits = optionalFeatureModule('appStudio/approvalWaits');
            return waits ? waits.releaseWait(appId, kind, ref, reason) : Promise.resolve(undefined);
        } });
    } catch (err) {
        log.warn('[Server] Platform retention job load failed:', err.message);
    }
    // Co-editing upkeep: materialise co-edited notebooks and pages into their
    // own columns, write one version per editing session and compact the
    // update log. Not gated on a module: a log that is never compacted only
    // grows, and a document edited before the module was removed must still
    // reach its notebook. Advisory-locked, one pod per pass.
    try {
        require('../jobs/collabDocCompaction').start();
    } catch (err) {
        log.warn('[Server] Co-editing upkeep job load failed:', err.message);
    }
    // Project live-feed retention: project_events rows older than a week only
    // served a reconnect that now refetches instead. Not gated on a module:
    // every workspace writes events. Advisory-locked, one pod per pass.
    try {
        require('../jobs/projectEventsPrune').start();
    } catch (err) {
        log.warn('[Server] Project event prune job load failed:', err.message);
    }
    // KB query log retention: expired log rows of knowledge bases that log, hourly in
    // batches. Not gated on a module or the licence (deleting must keep working);
    // kill switch KB_QUERY_LOG_RETENTION_DISABLED=1. Advisory-locked, one pod per pass.
    try {
        require('../jobs/kbQueryLogRetention.mts').start();
    } catch (err) {
        log.warn('[Server] KB query log retention job load failed:', err.message);
    }
    // Document version retention: thin out long version histories (hourly,
    // daily, weekly with age), never a named, restore or pinned revision.
    // Daily, advisory-locked, not gated on a module.
    try {
        require('../jobs/documentVersionRetention').start();
    } catch (err) {
        log.warn('[Server] Document version retention job load failed:', err.message);
    }
    // The compliance half of the ports is wired only when the compliance module loaded
    // (not by the catalog flag: core mode hides a module the catalog calls available).
    require('./ports').wirePorts({ compliance: moduleLoaded('compliance') });

    // Azure AD group sync: periodic syncs per org (explicit lifecycle call; it
    // used to be a require() side effect of integrations/azureGroupSync.js).
    try {
        require('../integrations/azureGroupSync').start();
    } catch (err) {
        log.warn('[Server] Azure group sync start failed:', err.message);
    }
    // The compliance scheduler, the deadline notifier and the ISO evidence collector
    // (firstParty/compliance.jobs.js), the App Studio run log (firstParty/apps.jobs.js).
    loader.runStartupPhase('startRetentionAndComplianceJobs');
}

/**
 * Whether a first-party module loaded (modules/firstParty/loader.js).
 * @param {string} id
 */
function moduleLoaded(id) {
    return loader.load().some((m) => m.id === id && m.state === 'loaded');
}

/**
 * The config cache's cross-replica invalidation listener: a Postgres connection
 * of its own that LISTENs. Started here and not when stores/configStore is
 * required, so a script or a generator that loads the store opens no connection.
 * @param {{ configStore?: { startInvalidationListener: () => unknown }, loader?: PhaseRunner }} [deps] test seam
 */
function startConfigInvalidationListener(deps = {}) {
    try {
        (deps.configStore || require('../stores/configStore')).startInvalidationListener();
    } catch (err) {
        log.warn('[Server] Config invalidation listener start failed:', err.message);
    }
    (deps.loader || loader).runStartupPhase('startConfigInvalidationListener');
}

/**
 * The schedulers that live inside a store or a runner module: the reminder
 * checker here, then the module rows of this phase (the cowork tick, the one
 * scheduler of cowork runs, with its retention sweep, and the coverage prune of
 * aiTaskRunner, its execution engine: firstParty/cowork.jobs.js). Each is
 * armed here and not when its module is required: a script, a generator or a test
 * that loads the app runs no job against the database it happens to point at.
 * A scheduler that is not started here does not run at all.
 * @param {{ reminderStore?: Startable, loader?: PhaseRunner }} [deps] test seam
 */
function startModuleSchedulers(deps = {}) {
    try {
        (deps.reminderStore || require('../stores/reminderStore')).start();
    } catch (err) {
        log.warn('[Server] Reminder checker start failed:', /** @type {Error} */ (err).message);
    }
    (deps.loader || loader).runStartupPhase('startModuleSchedulers');
}

/**
 * MCP, the project run feed and the OpenObserve pushes; then the module rows of this
 * phase (the automation runner, the Nextcloud mirror sync, the AI participation job).
 */
function startRunnersAndFeeds() {
    // Initialize MCP server connections (non-blocking)
    try {
        const mcpManager = require('../core/mcpManager');
        mcpManager.initialize().catch(err =>
            log.warn('[Server] MCP manager init error:', err.message)
        );
    } catch (err) {
        log.warn('[Server] MCP manager load failed:', err.message);
    }
    // Automation runs → project feed. runEventBus is in-process only; re-emitting
    // through the project feed is what gives a run cross-replica delivery and
    // reconnect-by-cursor, which projectEventBus already solved. No-ops for every
    // automation that is not in a project, which is most of them.
    if (isModuleAvailable('projects')) try {
        require('../core/projectContent/projectFeed.runs').start();
    } catch (err) {
        log.warn('[Server] Project run feed bridge load failed:', err.message);
    }
    // OpenObserve usage-push job — periodically pushes per-org/per-user token +
    // cost rollups to OpenObserve. Self-gated (no-op unless USAGE_PUSH_ENABLED),
    // advisory-locked so only one pod pushes.
    try {
        require('../jobs/usageOpenObservePush').start();
    } catch (err) {
        log.warn('[Server] Usage push job load failed:', err.message);
    }
    // OpenObserve ops-metrics push job — periodically snapshots operational /
    // product / security / billing gauges to OpenObserve. Self-gated (no-op
    // unless OPS_PUSH_ENABLED), advisory-locked so only one pod pushes.
    try {
        require('../jobs/opsMetricsPush').start();
    } catch (err) {
        log.warn('[Server] Ops metrics push job load failed:', err.message);
    }
    loader.runStartupPhase('startRunnersAndFeeds');
}

/**
 * The Nextcloud, telemetry and KB jobs; then the module rows of this phase (Support
 * Studio, projects, sanctions, cowork, learning, meeting audio, App Studio).
 */
function startSupportAndSyncJobs() {
    // NC user/group sync backstop — covers gaps when real-time webhooks miss
    try {
        require('../services/ncSyncBackstop').start();
    } catch (err) {
        log.warn('[Server] NC sync backstop load failed:', err.message);
    }
    // NC onboarding-incomplete reminder — daily nudge to org admins of orgs
    // provisioned >3d ago that never finished the wizard (1 reminder/org/7d,
    // deduped via configStore marker).
    try {
        require('../jobs/ncOnboardingReminder').start();
    } catch (err) {
        log.warn('[Server] NC onboarding reminder load failed:', err.message);
    }
    // Periodic process-memory log line (MEMORY_TELEMETRY_INTERVAL_MS, 0 = off).
    try { require('../jobs/memoryTelemetry').start(); } catch (err) { log.warn('[Server] Memory telemetry load failed:', err.message); }
    // Knowledge-base source refresh. Keeps a KB's sources up to date on their
    // own schedule, so what an agent quotes is what the source says today
    // rather than what it said the day someone added it. Advisory-locked
    // (0xBEEF10F) AND claimed per source, so two replicas cannot refresh the
    // same one twice; the tick also reaps claims a dead worker left behind,
    // without which one crash takes a source offline permanently.
    //
    // NOT gated on a module: a knowledge base is core, and a source that
    // silently stops refreshing is indistinguishable from one nobody edited.
    try {
        require('../jobs/kbSourceRefresh').start();
    } catch (err) {
        log.warn('[Server] KB source refresh load failed:', err.message);
    }
    loader.runStartupPhase('startSupportAndSyncJobs');
}

module.exports = {
    startRetentionAndComplianceJobs, startConfigInvalidationListener, startModuleSchedulers,
    startRunnersAndFeeds, startSupportAndSyncJobs,
};

/** A module whose background work boot starts by name. @typedef {{ start: () => unknown }} Startable */
/** The part of the first-party loader a phase calls. @typedef {{ runStartupPhase: (phase: import('../modules/firstParty/contract').StartupPhase) => void }} PhaseRunner */
