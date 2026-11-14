// @typecheck
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
const { versionDir, moduleDataDir, _reverifyFromDisk } = require('./packageStaging');
const {
    _projectDescriptors, _pushDescriptors, _stopTick, _purgeRequireCache, _drainAndDispose,
} = require('./packageRuntime');
const { resolveEntryPath, modulePermissionsFor, registerDescriptors, gateCapabilityOf, persistActivation } = require('./packageActivationSteps');
const log = require('../telemetry/log');
const { bestEffort } = require('../utils/bestEffort');

const { store, packageStore, runtime, moduleAudit, hostApiFactory } = deps;

const DEFAULT_TICK_MS = 60_000;

/**
 * Crash accounting → quarantine trip. Sources: router throws, request
 * timeouts, worker-tick rejections, activation failures. CRASH_THRESHOLD
 * crashes inside CRASH_WINDOW_MS auto-disables the module DURABLY
 * (ledger status 'quarantined' — boot skips it) until an operator re-enables.
 * @param {string} moduleId
 * @param {string} source
 * @param {Error} err
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

/**
 * @param {string} moduleId
 * @param {string} version
 * @param {string} reason
 */
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
 * @param {string} moduleId
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
/**
 * @param {string} moduleId
 * @param {number} intervalMs
 */
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
            log.error(`[module:${moduleId}] tick error:`, /** @type {Error} */ (e).message);
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
 * Every route needs a session (the host's requireAuth, read per request so a
 * test may swap it) unless a manifest server.publicRoutes[] prefix covers it:
 * nothing else stands between /api/mod and a module router. The capability
 * gate, when there is one, runs after the session check.
 */
function _composeHandler(entry) {
    const gate = entry.gateCapability ? hostApiFactory().requireCapability(entry.gateCapability) : null;
    const streaming = Array.isArray(entry.streamingRoutes) ? entry.streamingRoutes : [];
    const publicRoutes = Array.isArray(entry.publicRoutes) ? entry.publicRoutes : [];
    return function moduleHandle(/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res, /** @type {import('express').NextFunction} */ next) {
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
                    try { res.status(503).json({ error: 'module_timeout' }); } catch (err) { bestEffort('modules/packageActivation:_composeHandler', err); /* raced a write */ }
                }
            }, REQUEST_TIMEOUT_MS);
            if (typeof timer.unref === 'function') timer.unref();
            res.on('close', () => clearTimeout(timer));
        }
        // Express catches sync handler throws internally and reports them via
        // next(err) — so crash accounting must hook the next callback, not
        // just the (rare) direct throw out of router().
        /**
         * @param {Error} err
         */
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
        // The gate calls next() on success and next(err) on an entitlement outage;
        // a bare `run` would ignore the error and serve the module anyway.
        const gated = () => (gate ? gate(req, res, (err) => (err ? next(err) : run())) : run());
        if (require('./publicRoutes.mts').isPublicRoute(publicRoutes, url)) return gated(); // segment boundary
        const { requireAuth } = require('../auth/permissions');
        return requireAuth(req, res, (err) => (err ? next(err) : gated()));
    };
}

/**
 * @param {string} dir
 */
async function _readManifest(dir) {
    const raw = await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8');
    return JSON.parse(raw);
}

/** @param {string} moduleId */
function _dropDescriptors(moduleId) {
    _remoteDescriptors.delete(moduleId); _pushDescriptors();
}

/**
 * Load the module code and create its instance, then run its schema
 * migrations: on any failure the descriptors registered for it come down
 * again and activation fails, so no route is ever exposed over a
 * half-materialised module or schema.
 * @param {string} moduleId
 * @param {string} entryAbs
 * @param {unknown} hostApi
 * @param {((phase: string, pct: number) => void) | null} onPhase
 */
async function _loadInstance(moduleId, entryAbs, hostApi, onPhase) {
    let mod;
    try {
        _purgeRequireCache(moduleId);
        mod = require(entryAbs);
    } catch (e) {
        _dropDescriptors(moduleId);
        throw new Error(`module require failed: ${/** @type {Error} */ (e).message}`);
    }
    if (!mod || typeof mod.createModule !== 'function') {
        _dropDescriptors(moduleId);
        throw new Error('module does not export createModule(hostApi)');
    }
    let instance;
    try {
        instance = await mod.createModule(hostApi);
    } catch (e) {
        _dropDescriptors(moduleId);
        throw new Error(`createModule failed: ${/** @type {Error} */ (e).message}`);
    }
    if (!instance || typeof instance.router !== 'function') {
        _dropDescriptors(moduleId);
        throw new Error('createModule must return { router }');
    }
    if (typeof instance.initDBs === 'function') {
        if (onPhase) onPhase('migrating', 75);
        try {
            await instance.initDBs();
        } catch (e) {
            _stopTick(moduleId);
            _dispatch.delete(moduleId);
            _dropDescriptors(moduleId);
            throw new Error(`initDBs failed: ${/** @type {Error} */ (e).message}`);
        }
    }
    return instance;
}

/**
 * Route new requests to the new instance and start its tick. Hot-swap: the
 * Map.set atomically routes NEW requests to the new instance; the replaced
 * entry drains its in-flight requests and is then disposed (fire-and-forget,
 * the swap itself never waits).
 * @param {string} moduleId
 * @param {string} version
 * @param {{ instance: any, manifest: any, dir: string }} loaded
 */
function _installEntry(moduleId, version, { instance, manifest, dir }) {
    const gateCapability = gateCapabilityOf(moduleId, manifest);
    const entry = {
        moduleId, version, router: instance.router, instance, gateCapability, dir,
        inflight: 0, draining: false,
        streamingRoutes: (manifest.server && Array.isArray(manifest.server.streamingRoutes))
            ? manifest.server.streamingRoutes : [],
        publicRoutes: Array.isArray(manifest.server?.publicRoutes) ? manifest.server.publicRoutes : [],
    };
    entry.handle = _composeHandler(entry);
    const oldEntry = _dispatch.get(moduleId);
    _dispatch.set(moduleId, entry);
    if (oldEntry && oldEntry !== entry) {
        _drainAndDispose(moduleId, oldEntry).catch((e) => bestEffort('modules/packageActivation:activate#2', e));
    }
    _logSystem(moduleId, `activated v${version}`);

    if (typeof instance.tick === 'function') {
        const intervalMs = Number(instance.tickIntervalMs) > 0 ? Number(instance.tickIntervalMs) : DEFAULT_TICK_MS;
        _startTick(moduleId, instance.tick, intervalMs);
    } else {
        // The replaced instance is disposed: its tick must not keep calling it.
        _stopTick(moduleId);
    }
}

/**
 * Activate a verified, staged package into the running process. The steps
 * (packageActivationSteps.js) run in this order; any of them failing fails
 * the activation with its error.
 * @param {string} moduleId
 * @param {string} version
 * @param {{ actorId?, manifest?, kid?, sha256?, entitlement?, persist?, onPhase?, grantedPermissions?, source? }} [opts]
 */
async function activate(moduleId, version, {
    actorId = null, manifest = null, kid = null, sha256 = null,
    entitlement = null, persist = true, onPhase = null,
    grantedPermissions = null, source = null,
} = {}) {
    const dir = versionDir(moduleId, version);
    if (!manifest) manifest = await _readManifest(dir);
    const entryAbs = resolveEntryPath(dir, manifest);
    const modulePermissions = await modulePermissionsFor(moduleId, manifest, grantedPermissions);
    registerDescriptors(moduleId, manifest, persist);

    const dataDir = moduleDataDir(moduleId);
    await fsp.mkdir(dataDir, { recursive: true });
    const hostApi = hostApiFactory().build(moduleId, { dataDir, permissions: modulePermissions });
    const instance = await _loadInstance(moduleId, entryAbs, hostApi, onPhase);
    if (onPhase) onPhase('activating', 90);
    _installEntry(moduleId, version, { instance, manifest, dir });

    if (persist) await persistActivation(moduleId, version, manifest, { actorId, kid, sha256, entitlement, grantedPermissions, source });
    runtime().invalidateCache();
    await runtime().refreshModuleActivations();
    return { ok: true, moduleId, version };
}

/**
 * @param {string} moduleId
 */
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
            if (e && /** @type {Error} */ (e).message === 'dispose_timeout') _healthOf(moduleId).disposeTimeouts++;
            log.warn(`[Modules] dispose failed for ${moduleId}:`, /** @type {Error} */ (e).message);
        }
    }
    _logSystem(moduleId, 'deactivated');
    _purgeRequireCache(moduleId);
    if (persist) {
        try { await store().setRemoved(moduleId, { actorId }); } catch (e) { log.warn(`[Modules] deactivate persist failed for ${moduleId}:`, /** @type {Error} */ (e).message); }
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
