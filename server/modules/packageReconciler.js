// @typecheck
/**
 * Package loader: boot, reconcile, retention GC and the health snapshot.
 *
 * loadInstalledAtBoot() re-verifies every staged and active package FROM DISK
 * before re-activating it (one failure never blocks the others), with a
 * sha-pinned self-heal from the hub; reconcileRuntime() converges the live
 * process onto the ledger and prunes retired packages; getRuntimeHealth() is
 * the admin snapshot.
 */

'use strict';

const path = require('path');
const fsp = require('fs/promises');

const {
    deps, _dispatch, _moduleHealth, _healthOf, _logSystem, REPLICA_ID,
    REQUEST_TIMEOUT_MS, CRASH_WINDOW_MS, CRASH_THRESHOLD, RETENTION_KEEP, RECONCILE_INTERVAL_MS,
} = require('./packageState');
const { packagePath, versionDir, moduleRoot, verifyAndStage, _reverifyFromDisk } = require('./packageStaging');
const { activate, deactivate } = require('./packageActivation');
const log = require('../telemetry/log');
const { bestEffort } = require('../utils/bestEffort');

const { hubClient, packageStore, runtime, moduleAudit } = deps;

// Boot failures a hub re-download can repair: the retained .bfmod vanished, or
// no longer verifies (disk corruption, or a signing-key rotation the JWKS/key
// cache can't bridge). Anything else (compat, entry errors) re-downloads to the
// same failure.
function _selfHealable(err) {
    const msg = (err && err.message) || '';
    return msg === 'package_file_missing' || msg.startsWith('verify_failed:');
}

/**
 * Sha-pinned self-heal: re-download the EXACT ledgered bytes from the hub and
 * try again. Pinning to the ledger's packageSha256 means a compromised or
 * confused hub can never swap in different content during a heal.
 */
async function _selfHealFromHub(pkg) {
    if (!pkg.packageSha256) throw new Error('selfheal_unpinned');
    if ((pkg.source || 'hub') === 'sideload') throw new Error('selfheal_sideloaded');
    if (!(await hubClient().isConnected())) throw new Error('selfheal_not_connected');
    const staged = await verifyAndStage(pkg.moduleId, pkg.version, /** @type {any} */ ({
        download: true, expectedSha256: pkg.packageSha256, redownloadSha: pkg.packageSha256,
    }));
    await activate(pkg.moduleId, pkg.version, {
        actorId: pkg.installedBy, manifest: staged.manifest, kid: staged.kid,
        sha256: staged.sha256, persist: false,
    });
    try {
        await moduleAudit().emit('platform.module.selfheal', pkg.moduleId, null, {
            version: pkg.version, sha256: pkg.packageSha256,
        });
    } catch (err) { bestEffort('modules/packageReconciler:_selfHealFromHub', err); /* audit is best-effort */ }
}

async function loadInstalledAtBoot() {
    // Staged rows FIRST — a restart-pending update (native addon /
    // restart:'always') completes on this boot before the active set wires up,
    // so the old version never comes back to life after an update.
    try {
        const staged = await packageStore().listStaged();
        for (const pkg of (staged || [])) {
            try {
                const { manifest, kid } = await _reverifyFromDisk(pkg.moduleId, pkg.version);
                await activate(pkg.moduleId, pkg.version, {
                    actorId: pkg.installedBy, manifest, kid, sha256: pkg.packageSha256, persist: true,
                });
                _logSystem(pkg.moduleId, `staged update completed at boot: v${pkg.version}`);
                await moduleAudit().emit('platform.module.update', pkg.moduleId, pkg.installedBy, { version: pkg.version, staged: true });
            } catch (e) {
                try { await packageStore().setFailed(pkg.moduleId, pkg.version, { error: e.message, status: e.compat ? 'incompatible' : 'failed' }); } catch (_) { log.warn('could not record the failed activation', _); }
                log.error(`[Modules] staged boot activation failed for ${pkg.moduleId}@${pkg.version}: ${e.message}`);
            }
        }
    } catch (e) { log.warn('[Modules] boot: staged ledger read failed:', e.message); }

    let active;
    try { active = await packageStore().listActive(); }
    catch (e) { log.warn('[Modules] boot: package ledger read failed:', e.message); return { activated: 0, failed: 0 }; }

    let activated = 0, failed = 0;
    for (const pkg of (active || [])) {
        try {
            const { manifest, kid } = await _reverifyFromDisk(pkg.moduleId, pkg.version);
            // Wire the runtime WITHOUT rewriting install timestamps or the
            // entitlement (those persist across restarts; entitlementRefresh
            // owns freshness).
            await activate(pkg.moduleId, pkg.version, {
                actorId: pkg.installedBy, manifest, kid, sha256: pkg.packageSha256, persist: false,
            });
            activated++;
        } catch (e) {
            if (_selfHealable(e)) {
                try {
                    await _selfHealFromHub(pkg);
                    activated++;
                    log.info(`[Modules] boot self-heal succeeded for ${pkg.moduleId}@${pkg.version} (${e.message})`);
                    continue;
                } catch (healErr) {
                    log.error(`[Modules] boot self-heal failed for ${pkg.moduleId}@${pkg.version}: ${healErr.message}`);
                }
            }
            failed++;
            try {
                await packageStore().setFailed(pkg.moduleId, pkg.version, {
                    error: e.message, status: e.compat ? 'incompatible' : 'failed',
                });
            } catch (_) { log.warn('could not record the failed activation', _); }
            log.error(`[Modules] boot activation failed for ${pkg.moduleId}@${pkg.version}: ${e.message}`);
        }
    }
    if (activated || failed) log.info(`[Modules] boot activation: ${activated} active, ${failed} failed`);
    _reconcileStats.boot = { activated, failed, at: new Date().toISOString() };
    return { activated, failed };
}

// ── Runtime reconciler (M1.3) — the single retry/GC host ───────────────────
let _reconcileTimer = null;
const _reconcileStats = {
    lastRunAt: /** @type {string | null} */ (null), lastDurationMs: /** @type {number | null} */ (null), lastError: null,
    activated: 0, deactivated: 0, healed: 0, errors: 0, gcPruned: 0, boot: /** @type {{ activated: number; failed: number; at: string; } | null} */ (null),
};

/**
 * Converge the live process onto the ledger every RECONCILE_INTERVAL_MS:
 *  - ledger-active + runtime-entitled but NOT dispatched (or version drift)
 *    ⇒ activate from disk, self-healing a missing/corrupt package (sha-pinned);
 *  - dispatched but no longer supposed to run (removed / lapsed) ⇒ deactivate
 *    the runtime only (persistence already reflects the truth);
 *  - retention GC: prune retired package files beyond the newest
 *    RETENTION_KEEP, stamp pruned_at; sweep stale versions/*.tmp-* dirs.
 */
async function reconcileRuntime() {
    const startedAt = Date.now();
    _reconcileStats.lastRunAt = new Date(startedAt).toISOString();
    _reconcileStats.lastError = null;
    try {
        let active = [];
        try { active = await packageStore().listActive(); } catch (e) { _reconcileStats.lastError = e.message; return; }

        for (const pkg of (active || [])) {
            let shouldRun = false;
            try { shouldRun = await runtime().isModuleActive(pkg.moduleId); } catch (_) { shouldRun = false; }
            const entry = _dispatch.get(pkg.moduleId);

            if (shouldRun && (!entry || entry.version !== pkg.version)) {
                try {
                    const { manifest, kid } = await _reverifyFromDisk(pkg.moduleId, pkg.version);
                    await activate(pkg.moduleId, pkg.version, {
                        actorId: pkg.installedBy, manifest, kid, sha256: pkg.packageSha256, persist: false,
                    });
                    _reconcileStats.activated++;
                } catch (e) {
                    const h = _healthOf(pkg.moduleId);
                    h.lastActivationError = e.message;
                    if (_selfHealable(e) && !h.healTerminal) {
                        try {
                            await _selfHealFromHub(pkg);
                            _reconcileStats.healed++;
                        } catch (healErr) {
                            // A 410 (yanked and not re-downloadable) is terminal —
                            // stop hammering the hub; surface in health instead.
                            if (healErr && healErr.status === 410) h.healTerminal = healErr.detail || 'gone';
                            _reconcileStats.errors++;
                        }
                    } else {
                        _reconcileStats.errors++;
                    }
                }
            } else if (!shouldRun && entry) {
                try {
                    await deactivate(pkg.moduleId, { persist: false });
                    _reconcileStats.deactivated++;
                } catch (e) { _reconcileStats.errors++; }
            }
        }

        await _gcRetired(active || []);
    } catch (e) {
        _reconcileStats.lastError = e.message;
    } finally {
        _reconcileStats.lastDurationMs = Date.now() - startedAt;
    }
}

/** Retention GC + stale tmp-dir sweep. Never throws. */
async function _gcRetired(activeRows) {
    for (const pkg of activeRows) {
        try {
            const candidates = await packageStore().listRollbackCandidates(pkg.moduleId);
            for (const old of candidates.slice(RETENTION_KEEP)) {
                try {
                    await fsp.rm(packagePath(old.moduleId, old.version), { force: true });
                    await fsp.rm(versionDir(old.moduleId, old.version), { recursive: true, force: true });
                    await packageStore().markPruned(old.moduleId, old.version);
                    _reconcileStats.gcPruned++;
                } catch (err) { bestEffort('modules/packageReconciler:_gcRetired', err); /* next run */ }
            }
            // Stale atomic-extract leftovers (a crash mid-extract): versions/*.tmp-*
            // older than a day.
            const versionsRoot = path.join(moduleRoot(pkg.moduleId), 'versions');
            let entries = [];
            try { entries = await fsp.readdir(versionsRoot, { withFileTypes: true }); } catch (_) { continue; }
            for (const ent of entries) {
                if (!ent.isDirectory() || !ent.name.includes('.tmp-')) continue;
                const abs = path.join(versionsRoot, ent.name);
                try {
                    const st = await fsp.stat(abs);
                    if (Date.now() - st.mtimeMs > 24 * 3600 * 1000) {
                        await fsp.rm(abs, { recursive: true, force: true });
                    }
                } catch (err) { bestEffort('modules/packageReconciler:_gcRetired#2', err); /* raced */ }
            }
        } catch (err) { bestEffort('modules/packageReconciler:_gcRetired#3', err); /* per-module best effort */ }
    }
}

function startReconciler() {
    if (_reconcileTimer) return;
    _reconcileTimer = setInterval(() => {
        reconcileRuntime().catch(e => log.error('[Modules] reconcile unhandled:', e.message));
    }, RECONCILE_INTERVAL_MS);
    if (typeof _reconcileTimer.unref === 'function') _reconcileTimer.unref();
    log.info(`[Modules] runtime reconciler started — every ${Math.round(RECONCILE_INTERVAL_MS / 1000)}s`);
}
function stopReconciler() {
    if (_reconcileTimer) { clearInterval(_reconcileTimer); _reconcileTimer = null; }
}

// ── Health snapshot (M1.5) ──────────────────────────────────────────────────
/** Per-module + loader-level health for the admin surface. */
function getRuntimeHealth() {
    const modules = {};
    for (const [id, entry] of _dispatch) {
        modules[id] = { running: true, version: entry.version };
    }
    for (const [id, h] of _moduleHealth) {
        modules[id] = {
            ...(modules[id] || { running: false, version: null }),
            crashesInWindow: h.crashes.filter(t => t > Date.now() - CRASH_WINDOW_MS).length,
            lastActivationError: h.lastActivationError,
            disposeTimeouts: h.disposeTimeouts,
            restartAdvised: h.disposeTimeouts > 0,
            capabilityConflicts: h.capabilityConflicts,
            healTerminal: h.healTerminal,
        };
    }
    return {
        replica: REPLICA_ID,
        dispatchedCount: _dispatch.size,
        reconciler: { ..._reconcileStats, running: !!_reconcileTimer },
        limits: {
            requestTimeoutMs: REQUEST_TIMEOUT_MS,
            crashWindowMs: CRASH_WINDOW_MS,
            crashThreshold: CRASH_THRESHOLD,
            retentionKeep: RETENTION_KEEP,
        },
        modules,
    };
}

module.exports = {
    loadInstalledAtBoot,
    reconcileRuntime,
    startReconciler,
    stopReconciler,
    getRuntimeHealth,
};
