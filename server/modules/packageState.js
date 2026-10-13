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

const _wired = Object.create(null);
/** Called once by the packageLoader barrel with { name: () => module }. */
function wireDeps(getters) { Object.assign(_wired, getters); }
function _dep(name) {
    return function wiredDep() {
        const get = _wired[name];
        if (!get) throw new Error(`packageLoader dependency not wired: ${name}`);
        return get();
    };
}
const deps = {};
for (const name of [
    'hubClient', 'store', 'packageStore', 'registry', 'betaFeatures', 'runtime',
    'licenseVerify', 'installStore', 'logBuffer', 'moduleAudit',
    'packageVerify', 'moduleEntitlements', 'hostApiFactory',
    'subjects', 'configStore', 'remoteCatalog',
]) deps[name] = _dep(name);
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
const _dispatch = new Map();          // moduleId → { router, handle, instance, gateCapability, version, dir, streamingRoutes }
const _ticks = new Map();             // moduleId → interval timer
const _remoteDescriptors = new Map(); // moduleId → { capDescriptors, betaDescriptors }
const _progress = new Map();          // moduleId → { phase, pct, error, detail }
const _installing = new Set();        // moduleId currently installing (409 guard)
const _moduleHealth = new Map();      // moduleId → { crashes:[ts], lastActivationError, disposeTimeouts, capabilityConflicts, healTerminal }

function _healthOf(moduleId) {
    let h = _moduleHealth.get(moduleId);
    if (!h) {
        h = { crashes: [], lastActivationError: null, disposeTimeouts: 0, capabilityConflicts: [], healTerminal: null };
        _moduleHealth.set(moduleId, h);
    }
    return h;
}

function _logSystem(moduleId, msg) {
    try { logBuffer().append(moduleId, 'system', [msg]); } catch (_) {}
}

// ── Trust-root key resolvers (overridable in tests) ───────────────────────
async function _defaultPackageKeyResolver(kid) {
    // Hub `.bfmod` packages are signed by the same license.beeflow.nl key
    // infrastructure as licences/grants, so we reuse its JWKS→bundled chain.
    return licenseVerify().resolvePublicKeyByKid(kid);
}
async function _defaultGrantKeyResolver(kid) {
    return licenseVerify().resolvePublicKeyByKid(kid);
}
let _packageKeyResolver = _defaultPackageKeyResolver;
let _grantKeyResolver = _defaultGrantKeyResolver;
function __setKeyResolversForTest({ packageResolver = null, grantResolver = null } = {}) {
    if (packageResolver) _packageKeyResolver = packageResolver;
    if (grantResolver) _grantKeyResolver = grantResolver;
}
function __setDataRootForTest(root) { _dataRootOverride = root; }
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
