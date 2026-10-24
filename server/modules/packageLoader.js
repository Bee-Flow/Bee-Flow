// @typecheck
/**
 * Package loader — the lifecycle engine for DOWNLOADABLE remote modules.
 *
 * Owns the trust-then-run pipeline end to end:
 *   installFromHub → download (.bfmod) → verifyAndStage (signature + integrity,
 *   product-compat) → entitlement gate (verifyModuleGrant for paid) → activate.
 *
 * activate() wires a verified package into the live process WITHOUT a restart:
 *   1. register its capability/beta descriptors so the registry can see them,
 *   2. require the abs entry and call createModule(hostApi),
 *   3. run the module's initDBs (abort → failed; nothing half-materialised),
 *   4. register its router in the dispatcher Map (see dispatchRouter),
 *   5. start its host-owned worker tick (unref, self-gated on isModuleActive,
 *      overlap-suppressed),
 *   6. persist platform_modules('imported') + platform_module_packages('active')
 *      and invalidate/refresh the capability projection.
 *
 * loadInstalledAtBoot() re-verifies every active package FROM DISK (the retained
 * .bfmod) before re-activating — a tampered-with staging dir can never come back
 * up. One module's failure never blocks the others (setFailed + continue).
 *
 * The dispatcher (mounted once at /api/mod) 404-conceals unknown/inactive module
 * ids so a removed or lapsed module is indistinguishable from one that never
 * existed.
 *
 * Layout (this file is the barrel; importers keep requiring packageLoader):
 *   packageState       shared maps, health counters, knobs, key resolvers,
 *                      data root, and the injected dependencies
 *   packageStaging     paths, verifyAndStage, re-verify from disk, extract
 *   packageEntitlement hub grant gate, offline .bfgrant, sideload gate
 *   packageRuntime     descriptors, tick stop, require.cache purge, drain
 *   packageActivation  activate / deactivate, crash quarantine, tick start,
 *                      request handler, reactivateModule
 *   packageInstall     installFromHub, update, sideload, staged, rollback
 *   packageReconciler  boot load, self-heal, reconcile, GC, health
 * This file owns the lazy require()s (wired into packageState) and the
 * /api/mod dispatcher.
 */

'use strict';

const packageVerify = require('./packageVerify');
const moduleEntitlements = require('./entitlements');
const hostApiFactory = require('./hostApi');

// Lazy requires — cycle-safety (index.js ↔ registry ↔ this) + test overrides.
let _hubClient, _store, _pkgStore, _registry, _beta, _runtime, _verify, _installStore, _logBuffer, _audit;
function hubClient() { return _hubClient || (_hubClient = require('./hubClient')); }
function store() { return _store || (_store = require('../stores/platformModuleStore')); }
function packageStore() { return _pkgStore || (_pkgStore = require('../stores/platformModulePackageStore')); }
function registry() { return _registry || (_registry = require('../core/entitlements/capabilityRegistry')); }
function betaFeatures() { return _beta || (_beta = require('../core/entitlements/betaFeatures')); }
function runtime() { return _runtime || (_runtime = require('./index')); }
function licenseVerify() { return _verify || (_verify = require('../license/verify')); }
function installStore() { return _installStore || (_installStore = require('../stores/platformModuleInstallStore')); }
function logBuffer() { return _logBuffer || (_logBuffer = require('./moduleLogBuffer')); }
function moduleAudit() { return _audit || (_audit = require('./moduleAudit')); }

const state = require('./packageState');

state.wireDeps({
    hubClient, store, packageStore, registry, betaFeatures, runtime,
    licenseVerify, installStore, logBuffer, moduleAudit,
    packageVerify: () => packageVerify,
    moduleEntitlements: () => moduleEntitlements,
    hostApiFactory: () => hostApiFactory,
    subjects: () => require('./subjects'),
    configStore: () => require('../stores/configStore'),
    remoteCatalog: () => require('./remoteCatalog'),
});

const { _dispatch, __setKeyResolversForTest, __setDataRootForTest } = state;
const { versionDir, moduleRoot, verifyAndStage } = require('./packageStaging');
const { applyOfflineGrant } = require('./packageEntitlement');
const { activate, deactivate, reactivateModule } = require('./packageActivation');
const {
    getInstallProgress, isInstalling, installFromHub, updateModule,
    sideloadFromBuffer, activateStaged, listVersions, rollbackTo,
} = require('./packageInstall');
const {
    loadInstalledAtBoot, reconcileRuntime, startReconciler, stopReconciler, getRuntimeHealth,
} = require('./packageReconciler');

const HOST_API_VERSION = hostApiFactory.HOST_API_VERSION;

// ── Dispatcher (mounted once at /api/mod) ──────────────────────────────────
/**
 * Route /api/mod/<moduleId>/… to that module's router. Unknown or inactive
 * (removed / lapsed entitlement) ids 404-conceal. The module segment is
 * stripped so the module router sees paths relative to its own mount.
 */
async function dispatchRouter(req, res, next) {
    try {
        const rawPath = (req.url || '/').split('?')[0];
        const first = rawPath.split('/').filter(Boolean)[0];
        if (!first) return res.status(404).json({ error: 'not_found' });
        const entry = _dispatch.get(first);
        if (!entry) return res.status(404).json({ error: 'not_found' });

        let active = false;
        try { active = await runtime().isModuleActive(first); } catch (_) { active = false; }
        if (!active) return res.status(404).json({ error: 'not_found' });

        // Strip the /<moduleId> prefix so the module router matches relative paths.
        const prefix = `/${first}`;
        let rest = (req.url || '').slice(prefix.length);
        if (!rest.startsWith('/')) rest = `/${rest}`;
        const origUrl = req.url;
        req.url = rest;
        const restore = () => { req.url = origUrl; };
        return entry.handle(req, res, (err) => { restore(); return next(err); });
    } catch (e) {
        return res.status(404).json({ error: 'not_found' });
    }
}

module.exports = {
    dispatchRouter,
    installFromHub,
    updateModule,
    loadInstalledAtBoot,
    activate,
    deactivate,
    reactivateModule,
    verifyAndStage,
    getInstallProgress,
    isInstalling,
    // enterprise (M3)
    sideloadFromBuffer,
    applyOfflineGrant,
    activateStaged,
    listVersions,
    rollbackTo,
    // runtime operations (M1)
    reconcileRuntime,
    startReconciler,
    stopReconciler,
    getRuntimeHealth,
    // paths (shared with moduleAssets router)
    versionDir,
    moduleRoot,
    HOST_API_VERSION,
    // test hooks
    __setKeyResolversForTest,
    __setDataRootForTest,
    _dispatch,
};
