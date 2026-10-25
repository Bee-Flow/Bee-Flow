// @typecheck strict
/**
 * Package loader: the shared state of the remote-module lifecycle.
 *
 * Everything the split loader modules (packageStaging, packageEntitlement,
 * packageRuntime, packageActivation, packageInstall, packageReconciler) share
 * lives here and ONLY here: the in-process runtime maps, the per-module health
 * counters, the runtime-operations knobs, the trust-root key resolvers and the
 * data root (both overridable in tests).
 *
 * Injected dependencies: the loader's collaborators (hub client, stores,
 * capability registry, beta features, the module runtime, the licence
 * verifier, audit, log buffer, and the package-verify / grant-verify / hostApi
 * libraries) are wired in by the packageLoader barrel, which owns the lazy
 * require() calls. The split modules reach them only through `deps`, so none
 * of them requires a member of the modules/ ↔ entitlements import cycle
 * itself and the cycle does not grow (scc-ratchet).
 */

'use strict';

const path = require('path');
const telemetryLog = require('../telemetry/log');

const _wired = Object.create(null);
/**
 * Called once by the packageLoader barrel with { name: () => module }.
 * @param {Record<string, () => unknown>} getters
 */
function wireDeps(getters) { Object.assign(_wired, getters); }
/**
 * @param {string} name
 */
function _dep(name) {
    return function wiredDep() {
        const get = _wired[name];
        if (!get) throw new Error(`packageLoader dependency not wired: ${name}`);
        return get();
    };
}
/**
 * @typedef {{
 *   hubClient: () => typeof import('./hubClient'),
 *   store: () => typeof import('../stores/platformModuleStore'),
 *   packageStore: () => typeof import('../stores/platformModulePackageStore'),
 *   registry: () => typeof import('../core/entitlements/capabilityRegistry'),
 *   betaFeatures: () => typeof import('../core/entitlements/betaFeatures'),
 *   runtime: () => typeof import('./index'),
 *   licenseVerify: () => typeof import('../license/verify'),
 *   installStore: () => typeof import('../stores/platformModuleInstallStore'),
 *   logBuffer: () => typeof import('./moduleLogBuffer'),
 *   moduleAudit: () => typeof import('./moduleAudit'),
 *   packageVerify: () => typeof import('./packageVerify'),
 *   moduleEntitlements: () => typeof import('./entitlements'),
 *   hostApiFactory: () => typeof import('./hostApi'),
 *   subjects: () => typeof import('./subjects'),
 *   configStore: () => typeof import('../stores/configStore'),
 *   remoteCatalog: () => typeof import('./remoteCatalog'),
 * }} PackageDeps
 */
/** @type {PackageDeps} */
const deps = /** @type {PackageDeps} */ ({});
for (const name of [
    'hubClient', 'store', 'packageStore', 'registry', 'betaFeatures', 'runtime',
    'licenseVerify', 'installStore', 'logBuffer', 'moduleAudit',
    'packageVerify', 'moduleEntitlements', 'hostApiFactory',
    'subjects', 'configStore', 'remoteCatalog',
]) /** @type {Record<string, () => unknown>} */ (deps)[name] = _dep(name);
const { logBuffer, licenseVerify } = deps;

// Runtime-operations knobs (M1): per-request deadline, crash quarantine window,
// version-retention GC depth, reconciler cadence.
const REQUEST_TIMEOUT_MS = parseInt(process.env.MODULE_REQUEST_TIMEOUT_MS || '30000', 10);
const CRASH_WINDOW_MS = parseInt(process.env.MODULE_CRASH_WINDOW_MS || '600000', 10);
const CRASH_THRESHOLD = parseInt(process.env.MODULE_CRASH_THRESHOLD || '5', 10);
const RETENTION_KEEP = parseInt(process.env.MODULE_PACKAGE_RETENTION || '3', 10);
const RECONCILE_INTERVAL_MS = parseInt(process.env.MODULE_RECONCILE_INTERVAL_MS || '60000', 10);

const REPLICA_ID = `${require('os').hostname()}:${process.pid}`;

const MODULES_DATA_ROOT = process.env.MODULES_DATA_DIR
    || path.resolve(__dirname, '..', 'data', 'modules');

// ── In-process runtime maps ───────────────────────────────────────────────
/**
 * @typedef {(req: import('express').Request, res: import('express').Response, next: (err?: Error) => void) => unknown} ModuleRouter
 * @typedef {{ router: ModuleRouter, dispose?: () => unknown, tick?: () => unknown,
 *   tickIntervalMs?: number, initDBs?: () => Promise<unknown> }} ModuleInstance
 * @typedef {{ moduleId: string, version: string, router: ModuleRouter, instance: ModuleInstance,
 *   gateCapability: string | null, dir: string, inflight: number, draining: boolean, streamingRoutes: string[],
 *   handle?: import('express').RequestHandler }} DispatchEntry
 * @typedef {{ crashes: number[], lastActivationError: string | null, disposeTimeouts: number,
 *   capabilityConflicts: string[], healTerminal: string | null }} ModuleHealth
 * @typedef {{ phase: string, pct: number | null, error: string | null, detail: { missingPermissions?: string[] } | null }} InstallProgress
 */
/** @type {Map<string, DispatchEntry>} */
const _dispatch = new Map();          // moduleId → { router, handle, instance, gateCapability, version, dir, streamingRoutes }
/** @type {Map<string, ReturnType<typeof setInterval>>} */
const _ticks = new Map();             // moduleId → interval timer
/** @type {Map<string, ReturnType<typeof import('./packageRuntime')._projectDescriptors>>} */
const _remoteDescriptors = new Map(); // moduleId → { capDescriptors, betaDescriptors }
/** @type {Map<string, InstallProgress>} */
const _progress = new Map();          // moduleId → { phase, pct, error, detail }
/** @type {Set<string>} */
const _installing = new Set();        // moduleId currently installing (409 guard)
/** @type {Map<string, ModuleHealth>} */
const _moduleHealth = new Map();      // moduleId → { crashes:[ts], lastActivationError, disposeTimeouts, capabilityConflicts, healTerminal }

/**
 * @param {string} moduleId
 */
function _healthOf(moduleId) {
    let h = _moduleHealth.get(moduleId);
    if (!h) {
        h = { crashes: [], lastActivationError: null, disposeTimeouts: 0, capabilityConflicts: [], healTerminal: null };
        _moduleHealth.set(moduleId, h);
    }
    return h;
}

/**
 * @param {string} moduleId
 * @param {string} msg
 */
function _logSystem(moduleId, msg) {
    try { logBuffer().append(moduleId, 'system', [msg]); } catch (_) { telemetryLog.debug('log buffer unavailable, the line is dropped', _); }
}

// ── Trust-root key resolvers (overridable in tests) ───────────────────────
/** @param {string} kid */
async function _defaultPackageKeyResolver(kid) {
    // Hub `.bfmod` packages are signed by the same license.beeflow.nl key
    // infrastructure as licences/grants, so we reuse its JWKS→bundled chain.
    return licenseVerify().resolvePublicKeyByKid(kid);
}
/** @param {string} kid */
async function _defaultGrantKeyResolver(kid) {
    return licenseVerify().resolvePublicKeyByKid(kid);
}
let _packageKeyResolver = _defaultPackageKeyResolver;
let _grantKeyResolver = _defaultGrantKeyResolver;
/** @param {{ packageResolver?: typeof _defaultPackageKeyResolver | null, grantResolver?: typeof _defaultGrantKeyResolver | null }} [opts] */
function __setKeyResolversForTest({ packageResolver = null, grantResolver = null } = {}) {
    if (packageResolver) _packageKeyResolver = packageResolver;
    if (grantResolver) _grantKeyResolver = grantResolver;
}
/** @param {string | null} root */
function __setDataRootForTest(root) { _dataRootOverride = root; }
/** @type {string | null} */
let _dataRootOverride = null;
function dataRoot() { return _dataRootOverride || MODULES_DATA_ROOT; }
function packageKeyResolver() { return _packageKeyResolver; }
function grantKeyResolver() { return _grantKeyResolver; }

module.exports = {
    deps,
    wireDeps,
    REQUEST_TIMEOUT_MS,
    CRASH_WINDOW_MS,
    CRASH_THRESHOLD,
    RETENTION_KEEP,
    RECONCILE_INTERVAL_MS,
    REPLICA_ID,
    _dispatch,
    _ticks,
    _remoteDescriptors,
    _progress,
    _installing,
    _moduleHealth,
    _healthOf,
    _logSystem,
    packageKeyResolver,
    grantKeyResolver,
    __setKeyResolversForTest,
    __setDataRootForTest,
    dataRoot,
};
