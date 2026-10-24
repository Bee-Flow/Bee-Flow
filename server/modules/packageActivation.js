/**
 * Package loader: activate / deactivate a verified package in the live
 * process, the crash accounting that quarantines a misbehaving module, the
 * operator's reactivate lever, the host-owned worker tick and the request
 * handler (deadline + crash accounting) the dispatcher calls.
 */

'use strict';

const path = require('path');
const fsp = require('fs/promises');

const {
    deps, _dispatch, _remoteDescriptors, _moduleHealth, _healthOf, _logSystem,
    _ticks, REQUEST_TIMEOUT_MS, CRASH_WINDOW_MS, CRASH_THRESHOLD,
} = require('./packageState');
const { versionDir, moduleDataDir, _manifestSummary, _reverifyFromDisk } = require('./packageStaging');
const {
    _projectDescriptors, _pushDescriptors, _stopTick, _purgeRequireCache, _drainAndDispose,
} = require('./packageRuntime');
const log = require('../telemetry/log');

const { store, packageStore, registry, runtime, moduleAudit, hostApiFactory } = deps;

const DEFAULT_TICK_MS = 60_000;

/**
 * Crash accounting → quarantine trip. Sources: router throws, request
 * timeouts, worker-tick rejections, activation failures. CRASH_THRESHOLD
 * crashes inside CRASH_WINDOW_MS auto-disables the module DURABLY
 * (ledger status 'quarantined' — boot skips it) until an operator re-enables.
 */
function _recordCrash(moduleId, source, err) {
    const h = _healthOf(moduleId);
    const now = Date.now();
    h.crashes.push(now);
    while (h.crashes.length && h.crashes[0] < now - CRASH_WINDOW_MS) h.crashes.shift();
    _logSystem(moduleId, `crash(${source}): ${(err && err.message) || err}`);
    if (h.crashes.length >= CRASH_THRESHOLD && _dispatch.has(moduleId)) {
        const entry = _dispatch.get(moduleId);
        // Fire-and-forget — quarantine must never block the failing request path.
        _quarantine(moduleId, entry.version, `${h.crashes.length} crashes in ${Math.round(CRASH_WINDOW_MS / 1000)}s (last: ${(err && err.message) || err})`)
            .catch(e => log.error(`[Modules] quarantine failed for ${moduleId}:`, e.message));
    }
}

async function _quarantine(moduleId, version, reason) {
    log.error(`[Modules] QUARANTINE ${moduleId}@${version}: ${reason}`);
    _logSystem(moduleId, `quarantined: ${reason}`);
    await deactivate(moduleId, { persist: true });
    try { await packageStore().setQuarantined(moduleId, version, { error: reason }); } catch (_) { log.warn('could not mark the module version as quarantined', _); }
    await moduleAudit().emit('platform.module.quarantine', moduleId, null, { version, reason });
}

/**
 * Operator lever: re-verify + reactivate a quarantined module and reset its
 * crash counters.
 */
async function reactivateModule(moduleId, { actorId = null } = {}) {
    const rows = await packageStore().listForModule(moduleId);
    const q = (rows || []).find(r => r.status === 'quarantined');
    if (!q) { const e = new Error('not_quarantined'); e.code = 'not_quarantined'; throw e; }
    const { manifest, kid } = await _reverifyFromDisk(moduleId, q.version);
    _moduleHealth.delete(moduleId); // fresh counters
    await activate(moduleId, q.version, {
        actorId, manifest, kid, sha256: q.packageSha256, persist: true,
    });
    _logSystem(moduleId, `reactivated by ${actorId || 'operator'}`);
    await moduleAudit().emit('platform.module.reactivate', moduleId, actorId, { version: q.version });
    return { ok: true, version: q.version };
}

// ── Worker tick ───────────────────────────────────────────────────────────
function _startTick(moduleId, tickFn, intervalMs) {
    _stopTick(moduleId);
    let running = false;
    const timer = setInterval(async () => {
        if (running) return;                       // overlap suppression
        try {
            if (!(await runtime().isModuleActive(moduleId))) return; // self-gate
        } catch (_) { return; }
        running = true;
        try { await tickFn(); }
        catch (e) {
            log.error(`[module:${moduleId}] tick error:`, e.message);
            _recordCrash(moduleId, 'tick', e);
        }
        finally { running = false; }
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    _ticks.set(moduleId, timer);
}

// ── Activation ──────────────────────────────────────────────────────────────
/**
 * One wrapper owns BOTH request-instrumentation concerns (review F24): the
 * per-request deadline (503 module_timeout; counts as a crash AND as request
 * completion for draining) and router-throw crash accounting. Routes matching
 * a manifest server.streamingRoutes[] prefix opt out of the deadline (SSE etc.).
 */
function _composeHandler(entry) {
    const gate = entry.gateCapability ? hostApiFactory().requireCapability(entry.gateCapability) : null;
    const streaming = Array.isArray(entry.streamingRoutes) ? entry.streamingRoutes : [];
    return function moduleHandle(req, res, next) {
        const url = req.url || '/';
        // In-flight accounting drives the hot-swap drain: a request completes
        // on socket close — which a deadline 503 also produces (review F24).
        entry.inflight = (entry.inflight || 0) + 1;
        let counted = true;
        res.on('close', () => { if (counted) { counted = false; entry.inflight--; } });
        const exempt = streaming.some(p => p && url.startsWith(p));
        if (!exempt && REQUEST_TIMEOUT_MS > 0) {
            const timer = setTimeout(() => {
                _recordCrash(entry.moduleId, 'timeout', new Error(`request deadline ${REQUEST_TIMEOUT_MS}ms exceeded: ${url}`));
                if (!res.headersSent) {
                    try { res.status(503).json({ error: 'module_timeout' }); } catch (err) { log.debug('raced a write', err); }
                }
            }, REQUEST_TIMEOUT_MS);
            if (typeof timer.unref === 'function') timer.unref();
            res.on('close', () => clearTimeout(timer));
        }
        // Express catches sync handler throws internally and reports them via
        // next(err) — so crash accounting must hook the next callback, not
        // just the (rare) direct throw out of router().
        const crashAwareNext = (err) => {
            if (err) _recordCrash(entry.moduleId, 'router', err);
            return next(err);
        };
        const run = () => {
            try {
                return entry.router(req, res, crashAwareNext);
            } catch (e) {
                _recordCrash(entry.moduleId, 'router', e);
                throw e; // dispatchRouter's catch 404-conceals
            }
        };
        if (!gate) return run();
        // The gate calls next() on success and next(err) on an entitlement outage;
        // a bare `run` would ignore the error and serve the module anyway.
        return gate(req, res, (err) => (err ? next(err) : run()));
    };
}

async function _readManifest(dir) {
    const raw = await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8');
    return JSON.parse(raw);
}

/**
 * Activate a verified, staged package into the running process.
 * @param {string} moduleId
 * @param {string} version
 * @param {{ actorId?, manifest?, kid?, sha256?, entitlement?, persist?, onPhase? }} opts
 */
async function activate(moduleId, version, {
    actorId = null, manifest = null, kid = null, sha256 = null,
    entitlement = null, persist = true, onPhase = null,
    grantedPermissions = null, source = null,
} = {}) {
    const dir = versionDir(moduleId, version);
    if (!manifest) manifest = await _readManifest(dir);

    // Resolve + guard the entry path (must live inside the version dir).
    const entryRel = manifest.server && manifest.server.entry;
    if (!entryRel) throw new Error('manifest missing server.entry');
    const entryAbs = path.resolve(dir, entryRel);
    if (entryAbs !== dir && !entryAbs.startsWith(dir + path.sep)) {
        throw new Error(`entry escapes module dir: ${entryRel}`);
    }

    // ── mv2 permission invariant (M2) ───────────────────────────────────────
    // EVERY activation (boot and reconcile included) re-checks that the SIGNED
    // manifest's permission list is covered by the operator's persisted grant.
    // A package updated to demand more than was consented to fails closed.
    const isMv2 = Number(manifest.manifestVersion || 1) >= 2;
    const neededPermissions = (isMv2 && Array.isArray(manifest.permissions)) ? manifest.permissions : [];
    let modulePermissions = null; // null ⇒ legacy mv1 full surface
    if (isMv2) {
        if (neededPermissions.length) {
            let grantedList = (grantedPermissions && grantedPermissions.list) || null;
            if (!grantedList) {
                try {
                    const row = await store().getState(moduleId);
                    grantedList = (row && row.settings && row.settings.grantedPermissions
                        && row.settings.grantedPermissions.list) || [];
                } catch (_) { grantedList = []; }
            }
            const missing = neededPermissions.filter(p => !grantedList.includes(p));
            if (missing.length) {
                const e = new Error(`permissions_not_granted: ${missing.join(',')}`);
                e.code = 'permissions_not_granted';
                e.missingPermissions = missing;
                throw e;
            }
        }
        modulePermissions = neededPermissions;
    }

    // Descriptors first — so capability lookups resolve while createModule runs.
    // Capability-id CONFLICTS (an id another module or a built-in already owns):
    // hard-fail new installs; boot re-activation (persist:false) grandfathers
    // mv1's shadowing semantics — skip the conflicting descriptor, warn, and
    // surface it in health (review F16).
    const projected = _projectDescriptors(moduleId, manifest);
    const conflicts = [];
    for (const c of projected.capDescriptors) {
        let existing = null;
        try { existing = registry().getCapability(c.id); } catch (err) { log.debug('registry not ready', err); }
        if (existing && existing.moduleId !== moduleId) conflicts.push(c.id);
    }
    if (conflicts.length) {
        if (persist) throw new Error(`capability_conflict: ${conflicts.join(',')}`);
        log.warn(`[Modules] ${moduleId}: skipping conflicting capability ids at boot: ${conflicts.join(', ')}`);
        _logSystem(moduleId, `capability conflict (grandfathered, descriptors skipped): ${conflicts.join(', ')}`);
        projected.capDescriptors = projected.capDescriptors.filter(c => !conflicts.includes(c.id));
        projected.betaDescriptors = projected.betaDescriptors.filter(c => !conflicts.includes(c.id));
        _healthOf(moduleId).capabilityConflicts = conflicts;
    }
    _remoteDescriptors.set(moduleId, projected);
    _pushDescriptors();

    const dataDir = moduleDataDir(moduleId);
    await fsp.mkdir(dataDir, { recursive: true });
    const hostApi = hostApiFactory().build(moduleId, { dataDir, permissions: modulePermissions });

    let mod;
    try {
        _purgeRequireCache(moduleId);
        mod = require(entryAbs);
    } catch (e) {
        _remoteDescriptors.delete(moduleId); _pushDescriptors();
        throw new Error(`module require failed: ${e.message}`);
    }
    if (!mod || typeof mod.createModule !== 'function') {
        _remoteDescriptors.delete(moduleId); _pushDescriptors();
        throw new Error('module does not export createModule(hostApi)');
    }

    let instance;
    try {
        instance = await mod.createModule(hostApi);
    } catch (e) {
        _remoteDescriptors.delete(moduleId); _pushDescriptors();
        throw new Error(`createModule failed: ${e.message}`);
    }
    if (!instance || typeof instance.router !== 'function') {
        _remoteDescriptors.delete(moduleId); _pushDescriptors();
        throw new Error('createModule must return { router }');
    }

    // Schema migrations — abort activation on failure so we never expose routes
    // over a half-materialised schema, and mark the package failed.
    if (typeof instance.initDBs === 'function') {
        if (onPhase) onPhase('migrating', 75);
        try {
            await instance.initDBs();
        } catch (e) {
            _stopTick(moduleId);
            _dispatch.delete(moduleId);
            _remoteDescriptors.delete(moduleId); _pushDescriptors();
            throw new Error(`initDBs failed: ${e.message}`);
        }
    }
    if (onPhase) onPhase('activating', 90);

    // Gate capability: manifest override → studioApp gate (the SDK's actual
    // spelling — the old chain read a field the schema never had) → first own
    // capability. The gate MUST be module-own: an id this module doesn't
    // declare would let it hide behind (or expose itself via) someone else's
    // entitlement.
    const ownCapIds = new Set((Array.isArray(manifest.capabilities) ? manifest.capabilities : [])
        .map(c => c && c.id).filter(Boolean));
    let gateCapability = manifest.gateCapability
        || (manifest.frontend && manifest.frontend.studioApp && manifest.frontend.studioApp.gateCapability)
        || (manifest.frontend && manifest.frontend.gateCapability)
        || (Array.isArray(manifest.capabilities) && manifest.capabilities[0] && manifest.capabilities[0].id)
        || null;
    if (gateCapability && !ownCapIds.has(gateCapability)) {
        log.warn(`[Modules] ${moduleId}: gateCapability '${gateCapability}' is not module-own — falling back`);
        gateCapability = (Array.isArray(manifest.capabilities) && manifest.capabilities[0] && manifest.capabilities[0].id) || null;
    }
    const entry = {
        moduleId, version, router: instance.router, instance, gateCapability, dir,
        inflight: 0, draining: false,
        streamingRoutes: (manifest.server && Array.isArray(manifest.server.streamingRoutes))
            ? manifest.server.streamingRoutes : [],
    };
    entry.handle = _composeHandler(entry);
    // Hot-swap: the Map.set below atomically routes NEW requests to the new
    // instance; the replaced entry drains its in-flight requests and is then
    // disposed (fire-and-forget — the swap itself never waits).
    const oldEntry = _dispatch.get(moduleId);
    _dispatch.set(moduleId, entry);
    if (oldEntry && oldEntry !== entry) {
        _drainAndDispose(moduleId, oldEntry).catch(() => {});
    }
    _logSystem(moduleId, `activated v${version}`);

    if (typeof instance.tick === 'function') {
        const intervalMs = Number(instance.tickIntervalMs) > 0 ? Number(instance.tickIntervalMs) : DEFAULT_TICK_MS;
        _startTick(moduleId, instance.tick, intervalMs);
    }

    if (persist) {
        // Merge with any existing settings so entitlement survives a re-activate.
        let existing = null;
        let existingRead = true;
        try { existing = await store().getState(moduleId); } catch (err) {
            existingRead = false;
            log.warn('module state lookup failed, keeping the stored settings as they are', err);
        }
        const settings = {
            remote: true,
            manifest: _manifestSummary(manifest),
            entitlement: entitlement || (existing && existing.settings && existing.settings.entitlement) || null,
            package: { version, sha256, kid },
            latestVersion: version,
            grantedPermissions: grantedPermissions
                || (existing && existing.settings && existing.settings.grantedPermissions) || null,
        };
        // Without the stored row, an entitlement or grant not passed in would be written as null: skip that write.
        const wouldDropStored = !existingRead && (!entitlement || !grantedPermissions);
        if (!wouldDropStored) await store().setImported(moduleId, { actorId, version, settings });
        await packageStore().setActive(moduleId, version, { manifest: _manifestSummary(manifest), kid, packageSha256: sha256, actorId, source });
    }

    runtime().invalidateCache();
    await runtime().refreshModuleActivations();
    return { ok: true, moduleId, version };
}

async function deactivate(moduleId, { actorId = null, persist = true } = {}) {
    _stopTick(moduleId);
    const entry = _dispatch.get(moduleId);
    _dispatch.delete(moduleId);
    _remoteDescriptors.delete(moduleId);
    _pushDescriptors();
    // Give the instance its dispose hook (bounded; a hang flags the health row
    // as "restart advised" rather than blocking the deactivate).
    if (entry && entry.instance && typeof entry.instance.dispose === 'function') {
        try {
            await Promise.race([
                Promise.resolve(entry.instance.dispose()),
                new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('dispose_timeout')), 10_000); if (t.unref) t.unref(); }),
            ]);
        } catch (e) {
            if (e && e.message === 'dispose_timeout') _healthOf(moduleId).disposeTimeouts++;
            log.warn(`[Modules] dispose failed for ${moduleId}:`, e.message);
        }
    }
    _logSystem(moduleId, 'deactivated');
    _purgeRequireCache(moduleId);
    if (persist) {
        try { await store().setRemoved(moduleId, { actorId }); } catch (e) { log.warn(`[Modules] deactivate persist failed for ${moduleId}:`, e.message); }
    }
    runtime().invalidateCache();
    await runtime().refreshModuleActivations();
    return { ok: true };
}

module.exports = {
    _recordCrash,
    _composeHandler,
    reactivateModule,
    activate,
    deactivate,
};
