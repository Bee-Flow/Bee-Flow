/**
 * Periodic NC user/group sync backstop.
 *
 * Real-time NC events (server/routes/webhooks/ncEvents.js) are the primary
 * sync path, but they can drop on NC restart, network blips, or if the
 * connector's events_listener subscription drifts. This cron does a full
 * diff every 6 hours per org so missed events self-heal without admin
 * intervention.
 *
 * Skips orgs that synced via webhook recently (last 30 min) — webhooks are
 * fresher and cheap to trust.
 *
 * Backs off for 24 hours after a failed sync. A broken connector (401/404 from
 * the NC proxy, or an unreachable instance) used to be retried and logged at
 * warn on every tick, on every replica and after every restart, because
 * runFullSync returns before it writes ncLastSyncAt. The backoff reads the
 * org-health row that runFullSync opens on failure (connector.nc_sync_failed,
 * last_seen_at = the last failed attempt), so it holds across replicas and
 * restarts without a column of its own, and an admin who resolves that
 * problem by hand lifts it. The failure is logged at warn once per window;
 * the skips in between log at debug. Manual syncs (routes/admin/ncSync.js)
 * call runFullSync directly and never pass through here, so the backoff
 * cannot block them.
 *
 * No-op for non-NC tenants: only iterates orgs with nc_instance_id.
 */

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const FRESH_WEBHOOK_WINDOW_MS = 30 * 60 * 1000;
const FAILURE_BACKOFF_MS = 24 * 60 * 60 * 1000;

const inFlight = new Set();
let _interval = null;

// Dependencies resolve lazily, so a test that injects stand-ins through
// _setDeps never loads a store (and never opens a pool).
let _deps = null;
function deps() {
    if (!_deps) {
        _deps = {
            userStore: require('../stores/userStore'),
            ncUserGroupSync: require('../services/ncUserGroupSync'),
            orgHealth: require('../services/orgHealth'),
            recordJobRun: require('../telemetry/metrics').recordJobRun,
            log: require('../telemetry/log'),
            now: () => Date.now(),
        };
    }
    return _deps;
}

/** Test hook: inject every dependency above; pass nothing to restore the real ones. */
function _setDeps(d) {
    _deps = d || null;
    inFlight.clear();
}

/**
 * One sweep. Resolves once every sync it started has settled (the timers
 * ignore the promise; tests await it).
 */
async function runOnce() {
    const { userStore, ncUserGroupSync, orgHealth, recordJobRun, log, now } = deps();
    const t0 = now();
    let orgs;
    try {
        orgs = await userStore.getAllOrganizations();
    } catch (err) {
        log.warn(`[ncSyncBackstop] Could not list orgs: ${err.message}`);
        recordJobRun({ job: 'nc_sync_backstop', status: 'error', durationMs: now() - t0 });
        return;
    }
    const ncOrgs = orgs.filter(o => o.nc_instance_id && (o.nc_sync_mode || 'mirror_all') !== 'manual');
    // Record the tick as alive regardless of whether any org needed a sweep.
    recordJobRun({ job: 'nc_sync_backstop', status: 'ok', durationMs: now() - t0 });
    if (ncOrgs.length === 0) return;

    // One read per tick. Never rejects; an empty map means no backoff, which
    // degrades to the old retry-every-tick behaviour rather than to silence.
    const lastFailureAt = await orgHealth.openProblemLastSeen(ncUserGroupSync.NC_SYNC_FAILED);

    const started = [];
    for (const org of ncOrgs) {
        if (inFlight.has(org.id)) continue;
        const tick = now();
        const lastSync = org.nc_last_sync_at ? new Date(org.nc_last_sync_at).getTime() : 0;
        if (tick - lastSync < FRESH_WEBHOOK_WINDOW_MS) continue;

        const failedAt = lastFailureAt.get(String(org.id));
        if (failedAt != null && tick - failedAt < FAILURE_BACKOFF_MS) {
            const retryAt = new Date(failedAt + FAILURE_BACKOFF_MS).toISOString();
            log.debug(`[ncSyncBackstop] org=${org.id} skipped: last sync failed ${new Date(failedAt).toISOString()}, next attempt after ${retryAt}`);
            continue;
        }

        inFlight.add(org.id);
        started.push(ncUserGroupSync.runFullSync(org)
            .then(result => {
                if (result?.error) {
                    log.warn(`[ncSyncBackstop] org=${org.id} error=${result.error}; backing off 24h (manual sync still allowed)`);
                } else if (result) {
                    const drift = (result.created || 0) + (result.deactivated || 0);
                    if (drift > 0) {
                        log.info(`[ncSyncBackstop] org=${org.id} drift-corrected created=${result.created} deactivated=${result.deactivated} groupsCreated=${result.groupsCreated}`);
                    }
                }
            })
            .catch(err => {
                log.warn(`[ncSyncBackstop] org=${org.id} threw: ${err.message}`);
            })
            .finally(() => inFlight.delete(org.id)));
    }
    await Promise.allSettled(started);
}

function start() {
    if (_interval) return;
    // Stagger first run by 5 min after boot so we don't compete with init load.
    setTimeout(() => { runOnce().catch(() => { }); }, 5 * 60 * 1000).unref?.();
    _interval = setInterval(() => { runOnce().catch(() => { }); }, SIX_HOURS_MS);
    if (typeof _interval.unref === 'function') _interval.unref();
    deps().log.info('[ncSyncBackstop] Scheduled (every 6h, 30min webhook freshness window, 24h backoff after a failure)');
}

function stop() {
    if (_interval) {
        clearInterval(_interval);
        _interval = null;
    }
}

module.exports = { start, stop, runOnce, FAILURE_BACKOFF_MS, _setDeps };
