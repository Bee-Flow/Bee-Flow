// @typecheck strict
/**
 * Periodic prunes started at boot.
 *
 * One phase of boot/startupTasks.js runStartupTasks(), which calls the phases
 * in the order they always ran; see that file for the whole sequence.
 */

const log = require('../telemetry/log');
const { bestEffort } = require('../utils/bestEffort');

/** Org-health and integration-cache prunes, and the delayed orphan-chunk purge. */
function startPruneSchedulers() {
    // Org-health retention — daily prune of timeline events (90d), resolved
    // problems (30d) and unattributable domain/unknown buckets (30d).
    // Idempotent DELETEs — safe on multi-replica double runs.
    try {
        const orgHealthStore = require('../stores/orgHealthStore');
        const runOrgHealthPrune = async () => {
            try {
                const r = await orgHealthStore.pruneOld({
                    eventRetentionDays: parseInt(process.env.ORG_HEALTH_EVENT_RETENTION_DAYS ?? '', 10) || 90,
                    resolvedProblemRetentionDays: parseInt(process.env.ORG_HEALTH_RESOLVED_RETENTION_DAYS ?? '', 10) || 30,
                });
                if (r && (r.events || r.resolvedProblems || r.unattributed)) {
                    log.info(`[OrgHealth] pruned events=${r.events} resolvedProblems=${r.resolvedProblems} unattributed=${r.unattributed}`);
                }
            } catch (e) { log.error('[OrgHealth] prune error:', e.message); }
        };
        setTimeout(runOrgHealthPrune, 90_000).unref();
        setInterval(runOrgHealthPrune, 24 * 60 * 60 * 1000).unref();
    } catch (err) {
        log.warn('[Server] Org-health prune scheduler load failed:', err.message);
    }
    // Integration response cache — hourly sweep of expired rows.
    //
    // Hourly rather than daily because the entries hold third-party response
    // payloads and their TTL is capped at an hour: a daily prune would leave a
    // whole day of expired-but-still-stored answers sitting in the table, which
    // is a retention claim the product would not be keeping. The expiry is
    // enforced on READ regardless (the WHERE clause), so this is about not
    // storing what nothing may read, not about correctness.
    try {
        const integrationCacheStore = require('../stores/integrationCacheStore');
        const runIntegrationCachePrune = async () => {
            try {
                const n = await integrationCacheStore.pruneExpired();
                if (n) log.info(`[IntegrationCache] pruned ${n} expired entr${n === 1 ? 'y' : 'ies'}`);
            } catch (e) { log.error('[IntegrationCache] prune error:', e.message); }
        };
        setTimeout(runIntegrationCachePrune, 120_000).unref();
        setInterval(runIntegrationCachePrune, 60 * 60 * 1000).unref();
    } catch (err) {
        log.warn('[Server] Integration cache prune scheduler load failed:', err.message);
    }
    // Purge orphaned KB chunks (non-blocking, delayed to let DB pool warm up)
    setTimeout(() => {
        try {
            const { purgeOrphanedChunks } = require('../core/kb/localKBIngest');
            purgeOrphanedChunks()
                .then(n => { if (n > 0) log.info(`[Server] Startup: purged ${n} orphaned KB chunks`); })
                .catch(err => log.warn('[Server] Orphan purge error:', err.message));
        } catch (err) { bestEffort('boot/startupPrunes:orphanPurge', err); }
        // An embedding model switched while the server was down (or a
        // migration interrupted by a restart) is picked up here.
        require('../core/kb/embeddingMigration').ensureKbEmbeddingsCurrent({ reason: 'boot' });
    }, 5000);
}

module.exports = { startPruneSchedulers };
