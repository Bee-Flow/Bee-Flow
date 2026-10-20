/**
 * Background runners and jobs started at boot.
 *
 * One phase of boot/startupTasks.js runStartupTasks(), which calls the phases
 * in the order they always ran; see that file for the whole sequence.
 */

const { isModuleAvailable } = require('../modules/catalog');
const log = require('../telemetry/log');

/** Retention jobs, the compliance scheduler and the Azure group sync. */
function startRetentionAndComplianceJobs() {
    // Register and schedule AI Act + GDPR compliance checks (6-hour interval,
    // multi-tenant). Also start the Art-5(1)(e) memory retention enforcer and
    // the daily statutory-deadline notifier (72h incidents / 30d DSRs / DPIA
    // expiries).
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
    // one without Automations, whose runner these passes used to ride.
    try {
        require('../jobs/platformRetention').start();
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
    // Document version retention: thin out long version histories (hourly,
    // daily, weekly with age), never a named, restore or pinned revision.
    // Daily, advisory-locked, not gated on a module.
    try {
        require('../jobs/documentVersionRetention').start();
    } catch (err) {
        log.warn('[Server] Document version retention job load failed:', err.message);
    }
    require('./ports').wirePorts({ compliance: isModuleAvailable('compliance') });
    if (isModuleAvailable('compliance')) {
        require('../compliance/checks');
        require('../compliance/scheduler').start();
        require('../jobs/complianceDeadlineNotifier').start();
        // ISO evidence connectors — periodic external-system sweeps (advisory-locked).
        require('../jobs/isoEvidenceCollector').start();
    }

    // Azure AD group sync: periodic syncs per org (explicit lifecycle call; it
    // used to be a require() side effect of integrations/azureGroupSync.js).
    try {
        require('../integrations/azureGroupSync').start();
    } catch (err) {
        log.warn('[Server] Azure group sync start failed:', err.message);
    }
}

/** MCP, the cowork and automation runners, the project feeds and the OpenObserve pushes. */
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
    // Cowork runner — the one scheduler tick; aiTaskRunner is its execution
    // engine (and arms the coverage prune when it loads).
    try {
        require('../core/cowork/coworkRunner');
    } catch (err) {
        log.warn('[Server] Cowork runner load failed:', err.message);
    }
    // Initialize Automation Runner — gated per-org by the 'automations' beta feature
    if (isModuleAvailable('automation')) try {
        const automationRunner = require('../core/automationRunner');
        automationRunner.start().catch(err =>
            log.warn('[Server] Automation runner start error:', err.message)
        );
    } catch (err) {
        log.warn('[Server] Automation runner load failed:', err.message);
    }
    // Datatables that mirror a Nextcloud table: the scheduled refresh. The
    // other triggers (push events, opening the rows, "Refresh now") run the
    // same engine on demand; this is the safety net under them. Advisory-
    // locked; each mirror is additionally claimed per row.
    if (isModuleAvailable('automation')) try {
        require('../jobs/datatableNcSync').start();
    } catch (err) {
        log.warn('[Server] Nextcloud mirror sync load failed:', err.message);
    }
    // Automation runs → project feed. runEventBus is in-process only; re-emitting
    // through the project feed is what gives a run cross-replica delivery and
    // reconnect-by-cursor, which projectEventBus already solved. No-ops for every
    // automation that is not in a project, which is most of them.
    if (isModuleAvailable('projects')) try {
        require('../core/projectFeed.runs').start();
    } catch (err) {
        log.warn('[Server] Project run feed bridge load failed:', err.message);
    }
    // The AI that joins team chats and comment threads by itself: every 5 s
    // it claims the debounced watches that came due (FOR UPDATE SKIP LOCKED,
    // so replicas share the work without an advisory lock), asks the fast
    // relevance gate and answers or stays silent. A few at a time per replica,
    // paused by its own circuit breaker when the gate keeps failing.
    if (isModuleAvailable('projects')) try {
        require('../jobs/aiParticipation').start();
    } catch (err) {
        log.warn('[Server] AI participation job load failed:', err.message);
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
}

/** Support Studio, Nextcloud, project, learning, meeting-audio, App Studio and KB jobs. */
function startSupportAndSyncJobs() {
    // Support Studio inbox sync — polls connected tenant mailboxes and turns
    // inbound email into support tickets. Set SUPPORT_INBOX_SYNC_IN_API=false
    // when a dedicated worker owns it. Support-owned, so it follows the module
    // switch like the SLA enforcer below; the tick itself also re-checks the
    // runtime module row.
    if (isModuleAvailable('support')) try {
        if (process.env.SUPPORT_INBOX_SYNC_IN_API !== 'false') {
            require('../services/supportInboxSyncEngine').startSupportInboxSync();
        }
    } catch (err) {
        log.warn('[Server] Support inbox sync engine load failed:', err.message);
    }
    // Support Studio historical-scan drain — runs on-demand "how fast did we
    // answer in the past?" scans queued from the Insights view. Aggregate-only,
    // off the sync tick. Set SUPPORT_SCAN_IN_API=false when a worker owns it.
    if (isModuleAvailable('support')) try {
        if (process.env.SUPPORT_SCAN_IN_API !== 'false') {
            require('../services/supportInboxScanEngine').startSupportInboxScan();
        }
    } catch (err) {
        log.warn('[Server] Support inbox scan engine load failed:', err.message);
    }
    // Customer Support SLA enforcer — policy-driven first-response/resolution
    // breach detection on a 60s tick (replaces the old 15-min at-risk warner).
    if (isModuleAvailable('support')) try {
        require('../services/supportSlaEnforcer').start();
        require('../services/supportIssueSync').start();
    } catch (err) {
        log.warn('[Server] Support SLA enforcer load failed:', err.message);
    }
    // NC user/group sync backstop — covers gaps when real-time webhooks miss
    try {
        require('../jobs/ncSyncBackstop').start();
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
    // Project task reminders: a daily tick for open tasks due tomorrow, today or late.
    try { require('../jobs/projectTaskDueNotifier').start(); } catch (err) { log.warn('[Server] Project task due notifier load failed:', err.message); }
    if (isModuleAvailable('projects')) try { require('../jobs/solutionDeployRunner').start(); } catch (err) { log.warn('[Server] Solution deploy runner load failed:', err.message); }
    // Periodic process-memory log line (MEMORY_TELEMETRY_INTERVAL_MS, 0 = off).
    try { require('../jobs/memoryTelemetry').start(); } catch (err) { log.warn('[Server] Memory telemetry load failed:', err.message); }
    // Learning Center review nudge — daily tick that reminds lapsed learners
    // (started, unfinished, quiet 7-60d) to do a short review. Max one nudge
    // per user per 14d via configStore marker; advisory-locked across pods.
    // Learning-owned, so it follows the module switch like its siblings.
    if (isModuleAvailable('learning')) try {
        require('../jobs/learningNudge').start();
    } catch (err) {
        log.warn('[Server] Learning nudge load failed:', err.message);
    }
    // Safety net for meeting audio: give any recording still on this pod's disk
    // a durable object-storage copy. The request paths repair opportunistically;
    // this catches notes nobody happens to open.
    if (isModuleAvailable('meetingNotes')) try {
        require('../jobs/savedAudioBackfill').start();
    } catch (err) {
        log.warn('[Server] Saved-audio backfill load failed:', err.message);
    }
    // App Studio connector → table sync. Refreshes the tables that studio apps
    // fill from an external app on the owner's schedule, so viewers read local
    // rows instead of hitting the upstream API on every screen paint.
    // Advisory-locked; each sync is additionally claimed per (app, connector).
    if (isModuleAvailable('apps')) try {
        require('../jobs/studioAppConnectorSync').start();
        require('../jobs/datasetIngest').start();
    } catch (err) {
        log.warn('[Server] Studio app connector sync load failed:', err.message);
    }
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

    // Learning Center videos: install the pack this release pins into
    // LEARN_MEDIA_DIR, ~15 s after boot and never blocking it. Off in tests and
    // with LEARN_MEDIA_AUTO=off; a build without a pin skips quietly.
    try {
        require('../learning/learnMediaSync').startLearnMediaSync();
    } catch (err) {
        log.warn('[Server] Learn media sync load failed:', err.message);
    }
}

module.exports = { startRetentionAndComplianceJobs, startRunnersAndFeeds, startSupportAndSyncJobs };
