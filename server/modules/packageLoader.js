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
 */

'use strict';

const path = require('path');
const fsp = require('fs/promises');

const packageVerify = require('./packageVerify');
const moduleEntitlements = require('./entitlements');
const hostApiFactory = require('./hostApi');
const log = require('../telemetry/log');

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

const HOST_API_VERSION = hostApiFactory.HOST_API_VERSION;
const DEFAULT_TICK_MS = 60_000;

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
    try { await packageStore().setQuarantined(moduleId, version, { error: reason }); } catch (_) {}
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

// ── Path helpers (defense-in-depth segment sanitising) ────────────────────
function _safeSeg(seg) {
    const s = String(seg || '');
    if (!s || s.includes('/') || s.includes('\\') || s.includes('..')) {
        throw new Error(`unsafe path segment: ${seg}`);
    }
    return s;
}
function moduleRoot(id) { return path.join(dataRoot(), _safeSeg(id)); }
function versionDir(id, version) { return path.join(moduleRoot(id), 'versions', _safeSeg(version)); }
function moduleDataDir(id) { return path.join(moduleRoot(id), 'data'); }
function packagePath(id, version) { return path.join(moduleRoot(id), 'pkg', `${_safeSeg(version)}.bfmod`); }

// ── Progress (dual-write: memory for the fast poll path, DB for other
//    replicas + restarts) ────────────────────────────────────────────────────
function _setProgress(id, phase, pct = null, error = null, detail = null) {
    _progress.set(id, { phase, pct, error, detail });
    installStore().setPhase(id, phase, pct, { error, detail }).catch(() => { /* poller falls back to memory */ });
}
async function getInstallProgress(id) {
    const mem = _progress.get(id);
    if (mem) return mem;
    try {
        const row = await installStore().get(id);
        return row ? { phase: row.phase, pct: row.pct, error: row.error, detail: row.detail, replica: row.replica } : null;
    } catch (_) { return null; }
}
function isInstalling(id) {
    return _installing.has(id);
}

// ── Descriptor projection + registry push ─────────────────────────────────
function _projectDescriptors(moduleId, manifest) {
    const caps = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
    const capDescriptors = [];
    const betaDescriptors = [];
    for (const c of caps) {
        if (!c || !c.id) continue;
        // 'core' is host-reserved: mv2 packages are rejected at verify time;
        // mv1 packages are grandfathered by coercing to 'integration'.
        let kind = c.kind || 'integration';
        if (kind === 'core') {
            log.warn(`[Modules] ${moduleId}: capability ${c.id} declared kind 'core' — coerced to 'integration'`);
            kind = 'integration';
        }
        capDescriptors.push({
            id: c.id,
            kind,
            name: c.name || c.id,
            description: c.description || '',
            category: c.category || manifest.name || 'Modules',
            licenseFeature: c.licenseFeature || null,
            lifecycle: c.lifecycle || 'stable',
            defaultState: c.defaultState || (kind === 'integration' ? 'off' : 'on'),
            userFacing: c.userFacing !== false,
            groupTogglable: c.groupTogglable !== false,
            moduleId,
            _remoteModule: true,
        });
        if (kind === 'beta') {
            betaDescriptors.push({
                id: c.id,
                name: c.name || c.id,
                description: c.description || '',
                lifecycle: c.lifecycle || 'beta',
                licenseFeature: c.licenseFeature || null,
            });
        }
    }
    return { capDescriptors, betaDescriptors };
}

function _pushDescriptors() {
    const allCaps = [];
    const allBetas = [];
    for (const d of _remoteDescriptors.values()) {
        allCaps.push(...d.capDescriptors);
        allBetas.push(...d.betaDescriptors);
    }
    try { registry().setRemoteModuleCapabilityDescriptors(allCaps); } catch (_) { /* registry not ready */ }
    try { betaFeatures().setRemoteBetaFeatures(allBetas); } catch (_) { /* beta not ready */ }
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
function _stopTick(moduleId) {
    const t = _ticks.get(moduleId);
    if (t) { clearInterval(t); _ticks.delete(moduleId); }
}

// ── require.cache purge (so a re-install reloads fresh code) ───────────────
function _purgeRequireCache(moduleId) {
    const root = moduleRoot(moduleId) + path.sep;
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(root)) delete require.cache[key];
    }
}

// ── Compatibility gate ─────────────────────────────────────────────────────
function _incompatible(reason) {
    const e = new Error(reason);
    e.compat = true;
    return e;
}
/**
 * Compatibility gate — SIGNED payload values first (what the signer pinned),
 * manifest spellings (snake_case AND the SDK's authored camelCase) only as
 * fallback for packages signed before the payload carried them.
 */
function _compatCheck(manifest, signedPayload = null) {
    const semver = require('../utils/semver');
    const sp = signedPayload || {};
    const need = Number(
        sp.host_api_version
        ?? (manifest.server && manifest.server.host_api_version)
        ?? manifest.hostApiVersion
        ?? 1
    );
    if (Number.isFinite(need) && need > HOST_API_VERSION) {
        throw _incompatible(`host_api_version ${need} > ${HOST_API_VERSION}`);
    }
    const appVer = process.env.APP_VERSION || (safeRequireVersion());
    const minApp = sp.min_app_version
        || manifest.min_app_version
        || manifest.minAppVersion
        || manifest.minProductVersion
        || (manifest.server && manifest.server.min_app_version)
        || null;
    if (minApp && appVer && !semver.satisfiesMin(appVer, minApp)) {
        throw _incompatible(`requires product >= ${minApp} (have ${appVer})`);
    }
    // Advisory upper bound — manifest-only (the pinned JWS payload is not
    // widened with max claims in 3.1).
    const maxApp = manifest.max_app_version || manifest.maxAppVersion || null;
    if (maxApp && appVer && !semver.satisfiesMax(appVer, maxApp)) {
        throw _incompatible(`requires product <= ${maxApp} (have ${appVer})`);
    }
}
function safeRequireVersion() {
    try { return require('../../package.json').version || null; } catch (_) { return null; }
}

// ── Atomic extraction ──────────────────────────────────────────────────────
async function _extractAtomic(destDir, files) {
    const parent = path.dirname(destDir);
    await fsp.mkdir(parent, { recursive: true });
    const tmp = `${destDir}.tmp-${process.pid}-${Date.now()}`;
    await fsp.rm(tmp, { recursive: true, force: true });
    for (const [rel, buf] of files) {
        const abs = path.join(tmp, rel);
        if (abs !== tmp && !abs.startsWith(tmp + path.sep)) throw new Error(`bad extract path: ${rel}`);
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, buf);
    }
    await fsp.rm(destDir, { recursive: true, force: true });
    await fsp.rename(tmp, destDir);
}

function _kidFromSignature(files) {
    try {
        const jws = files.get('signature.jws');
        if (!jws) return null;
        const { header } = licenseVerify().decodeJwtUnverified(jws.toString('utf8'));
        return (header && header.kid) || null;
    } catch (_) { return null; }
}

function _manifestSummary(m) {
    return {
        id: m.id,
        name: m.name || m.id,
        version: m.version,
        manifestVersion: Number(m.manifestVersion || 1),
        permissions: Array.isArray(m.permissions) ? m.permissions : [],
        schemaVersion: Number(m.server && m.server.schemaVersion) || null,
        description: m.description || '',
        category: m.category || 'Modules',
        icon: m.icon || 'box',
        capabilities: Array.isArray(m.capabilities)
            ? m.capabilities.map(c => ({
                id: c.id, kind: c.kind || 'integration', name: c.name || c.id,
                description: c.description || '', category: c.category || null,
                licenseFeature: c.licenseFeature || null, lifecycle: c.lifecycle || 'stable',
            }))
            : [],
        frontend: m.frontend || null,
        requirements: (m.requirements && typeof m.requirements === 'object') ? m.requirements : {},
    };
}

/**
 * Verify a `.bfmod` and extract it to versionDir atomically.
 * @param {string} moduleId
 * @param {string} version
 * @param {{ buffer?:Buffer, download?:boolean }} opts
 * @returns {Promise<{ manifest, dir, sha256, kid }>}
 */
async function verifyAndStage(moduleId, version, { buffer = null, download = false, expectedSha256 = null, redownloadSha = null } = {}) {
    let sha256 = null;
    let pkgPath = packagePath(moduleId, version);

    if (download) {
        const dl = await hubClient().downloadPackage({ moduleId, version, destPath: pkgPath, expectedSha256, redownloadSha });
        sha256 = dl.sha256;
        buffer = await fsp.readFile(pkgPath);
    } else if (buffer) {
        await fsp.mkdir(path.dirname(pkgPath), { recursive: true });
        await fsp.writeFile(pkgPath, buffer); // retain for boot re-verify
        sha256 = require('crypto').createHash('sha256').update(buffer).digest('hex');
    } else {
        buffer = await fsp.readFile(pkgPath);
        sha256 = require('crypto').createHash('sha256').update(buffer).digest('hex');
    }

    const result = await packageVerify.verifyPackage(buffer, { publicKeyResolver: _packageKeyResolver });
    if (!result.ok) {
        const e = new Error(`package_verify_failed:${result.error}`);
        throw e;
    }
    const manifest = result.manifest;
    if (manifest.id !== moduleId || manifest.version !== version) {
        throw new Error(`package_identity_mismatch: ${manifest.id}@${manifest.version} != ${moduleId}@${version}`);
    }
    _compatCheck(manifest, result.signature && result.signature.payload);

    // Honest requiresRestart (M3): native addons can't be re-require()d into a
    // live process, and restart:'always' is the author saying "don't hot-swap
    // me". Updates of a RUNNING module with this flag are STAGED for the next
    // restart instead of activated.
    const requiresRestart = [...result.files.keys()].some(n => n.endsWith('.node'))
        || !!(manifest.server && (manifest.server.native === true || manifest.server.restart === 'always'));

    await _extractAtomic(versionDir(moduleId, version), result.files);
    return {
        manifest,
        dir: versionDir(moduleId, version),
        sha256,
        kid: (result.signature && result.signature.kid) || _kidFromSignature(result.files),
        signedPayload: (result.signature && result.signature.payload) || null,
        requiresRestart,
    };
}

// ── Entitlement gate (paid modules) ────────────────────────────────────────
function _subjectIds() {
    return require('./subjects').subjectIds();
}

/**
 * Require a currently-valid, signature-verified grant for `moduleId`. Returns
 * the entitlement + verified payload so the caller can persist the timestamp
 * gate. Throws HubError('not_entitled') when no valid grant exists.
 */
async function _entitlementGate(moduleId, manifest, { now = Math.floor(Date.now() / 1000) } = {}) {
    const { HubError } = hubClient();
    let list;
    try { ({ entitlements: list } = await hubClient().fetchEntitlements()); }
    catch (e) { if (e && e.code) throw e; throw new HubError('hub_unavailable', e.message); }
    const ent = (list || []).find(e => e && e.module_id === moduleId);
    if (!ent || !ent.grant_token) throw new HubError('not_entitled', `no entitlement grant for ${moduleId}`);
    const subjectIds = await _subjectIds();
    const res = await moduleEntitlements.verifyModuleGrant(ent.grant_token, {
        moduleId,
        subjectIds: subjectIds.length ? subjectIds : undefined,
        now,
        publicKeyResolver: _grantKeyResolver,
    });
    if (!res.valid) throw new HubError('not_entitled', `grant invalid: ${res.error}`);
    return {
        entitlement: {
            kind: res.payload.kind || ent.kind || 'unknown',
            status: 'active',
            exp: res.payload.exp,
            entitlement_id: res.payload.entitlement_id || ent.entitlement_id || null,
            current_period_end: ent.current_period_end || null,
        },
        payload: res.payload,
    };
}

// ── Activation ──────────────────────────────────────────────────────────────
/**
 * One wrapper owns BOTH request-instrumentation concerns (review F24): the
 * per-request deadline (503 module_timeout; counts as a crash AND as request
 * completion for draining) and router-throw crash accounting. Routes matching
 * a manifest server.streamingRoutes[] prefix opt out of the deadline (SSE etc.).
 */
function _composeHandler(entry) {
    const gate = entry.gateCapability ? hostApiFactory.requireCapability(entry.gateCapability) : null;
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
                    try { res.status(503).json({ error: 'module_timeout' }); } catch (_) { /* raced a write */ }
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
        return gate(req, res, run); // gate calls next===run on success, else 404
    };
}

async function _readManifest(dir) {
    const raw = await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8');
    return JSON.parse(raw);
}

const DRAIN_TIMEOUT_MS = parseInt(process.env.MODULE_DRAIN_TIMEOUT_MS || '10000', 10);
const DISPOSE_TIMEOUT_MS = 10_000;

/** Wait (bounded) for a replaced entry's in-flight requests, then dispose it. */
async function _drainAndDispose(moduleId, oldEntry) {
    oldEntry.draining = true;
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while ((oldEntry.inflight || 0) > 0 && Date.now() < deadline) {
        await new Promise((r) => { const t = setTimeout(r, 200); if (t.unref) t.unref(); });
    }
    if (oldEntry.instance && typeof oldEntry.instance.dispose === 'function') {
        try {
            await Promise.race([
                Promise.resolve(oldEntry.instance.dispose()),
                new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('dispose_timeout')), DISPOSE_TIMEOUT_MS); if (t.unref) t.unref(); }),
            ]);
        } catch (e) {
            if (e && e.message === 'dispose_timeout') _healthOf(moduleId).disposeTimeouts++;
            log.warn(`[Modules] hot-swap dispose failed for ${moduleId}:`, e.message);
        }
    }
    _logSystem(moduleId, `old v${oldEntry.version} drained (${oldEntry.inflight || 0} in-flight at timeout) + disposed`);
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
        try { existing = registry().getCapability(c.id); } catch (_) { /* registry not ready */ }
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
    const hostApi = hostApiFactory.build(moduleId, { dataDir, permissions: modulePermissions });

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
        try { existing = await store().getState(moduleId); } catch (_) {}
        const settings = {
            remote: true,
            manifest: _manifestSummary(manifest),
            entitlement: entitlement || (existing && existing.settings && existing.settings.entitlement) || null,
            package: { version, sha256, kid },
            latestVersion: version,
            grantedPermissions: grantedPermissions
                || (existing && existing.settings && existing.settings.grantedPermissions) || null,
        };
        await store().setImported(moduleId, { actorId, version, settings });
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

// ── Install from Hub (download → verify → gate → activate) ─────────────────
async function installFromHub(moduleId, { version = null, actorId = null, acceptedPermissions = null } = {}) {
    const { HubError } = hubClient();
    // A built-in module always wins its slug — a hub package must never
    // shadow one.
    try {
        if (require('./catalog').getModule(moduleId)) {
            const e = new Error('module_id_conflict'); e.code = 'module_id_conflict'; throw e;
        }
    } catch (e) { if (e.code === 'module_id_conflict') throw e; /* catalog unavailable in some tests */ }
    if (_installing.has(moduleId)) {
        const e = new HubError('already_connected', 'install_in_progress'); e.inProgress = true; throw e;
    }
    // Cross-replica lease: exactly one live install per module. A DB hiccup
    // degrades to the in-memory guard rather than blocking installs.
    let leased = false;
    try {
        const lease = await installStore().acquire(moduleId, { version, actor: actorId, replica: REPLICA_ID });
        if (!lease) {
            const e = new HubError('already_connected', 'install_in_progress'); e.inProgress = true; throw e;
        }
        leased = true;
    } catch (e) {
        if (e && e.inProgress) throw e;
        log.warn(`[Modules] install lease unavailable for ${moduleId} (continuing single-replica):`, e.message);
    }
    void leased;
    _installing.add(moduleId);
    _setProgress(moduleId, 'downloading', 0);
    let resolvedVersion = version;
    try {
        if (!resolvedVersion) {
            const cat = await hubClient().fetchCatalogEntry(moduleId);
            resolvedVersion = cat && cat.module && cat.module.latest_version;
            if (!resolvedVersion) throw new HubError('hub_unavailable', 'no downloadable version for module');
        }
        _setProgress(moduleId, 'downloading', 20);
        const staged = await verifyAndStage(moduleId, resolvedVersion, { download: true });
        _setProgress(moduleId, 'verifying', 60);

        // ── Consent gate (M2) — enforced against the SIGNED manifest ────────
        // Catalog-advertised permission lists are display-only; a package
        // demanding more than the operator accepted fails closed here.
        const manifest = staged.manifest;
        const isMv2 = Number(manifest.manifestVersion || 1) >= 2;
        const needed = (isMv2 && Array.isArray(manifest.permissions)) ? manifest.permissions : [];
        let grantedPermissions = null;
        if (isMv2) {
            let existingList = [];
            try {
                const row = await store().getState(moduleId);
                existingList = (row && row.settings && row.settings.grantedPermissions
                    && row.settings.grantedPermissions.list) || [];
            } catch (_) {}
            const granted = new Set([...existingList, ...(Array.isArray(acceptedPermissions) ? acceptedPermissions : [])]);
            const missing = needed.filter(p => !granted.has(p));
            if (missing.length) {
                const e = new Error('consent_required');
                e.code = 'consent_required';
                e.missingPermissions = missing;
                throw e;
            }
            grantedPermissions = { list: needed, acceptedBy: actorId, acceptedAt: new Date().toISOString() };
        }

        const gate = await _entitlementGate(moduleId, manifest);

        // Updates of a RUNNING module that can't hot-swap are staged: verified,
        // entitled and consented, but activated by the NEXT restart (boot
        // processes staged rows first). Fresh installs always activate — no old
        // code is loaded yet.
        if (staged.requiresRestart && _dispatch.has(moduleId)) {
            await packageStore().setStaged(moduleId, resolvedVersion, {
                manifest: _manifestSummary(manifest), kid: staged.kid,
                packageSha256: staged.sha256, actorId,
            });
            if (grantedPermissions) {
                try { await store().mergeSettings(moduleId, { grantedPermissions }); } catch (_) {}
            }
            _setProgress(moduleId, 'staged', 100);
            _logSystem(moduleId, `update to v${resolvedVersion} staged — restart required`);
            await moduleAudit().emit('platform.module.update', moduleId, actorId, { version: resolvedVersion, staged: true });
            return { ok: true, version: resolvedVersion, requiresRestart: true };
        }

        await activate(moduleId, resolvedVersion, {
            actorId,
            manifest,
            kid: staged.kid,
            sha256: staged.sha256,
            entitlement: gate.entitlement,
            grantedPermissions,
            onPhase: (phase, pct) => _setProgress(moduleId, phase, pct),
        });
        _setProgress(moduleId, 'done', 100);
        await moduleAudit().emit('platform.module.install', moduleId, actorId, { version: resolvedVersion, permissions: needed });
        if (grantedPermissions) {
            await moduleAudit().emit('platform.module.consent', moduleId, actorId, { permissions: needed });
        }
        return { ok: true, version: resolvedVersion, requiresRestart: false };
    } catch (e) {
        _healthOf(moduleId).lastActivationError = e.message;
        _setProgress(moduleId, 'error', null, e.code || e.message,
            e.missingPermissions ? { missingPermissions: e.missingPermissions } : null);
        if (resolvedVersion) {
            try {
                await packageStore().setFailed(moduleId, resolvedVersion, {
                    error: e.message,
                    status: e.compat ? 'incompatible' : 'failed',
                });
            } catch (_) { /* best effort */ }
        }
        throw e;
    } finally {
        _installing.delete(moduleId);
    }
}

async function updateModule(moduleId, { actorId = null, acceptedPermissions = null } = {}) {
    const cat = await hubClient().fetchCatalogEntry(moduleId);
    const hm = (cat && cat.module) || {};
    if (cat && Array.isArray(cat.versions) && !hm.versions) hm.versions = cat.versions;

    // Policy-aware resolution: highest non-yanked candidate on the install's
    // channel satisfying its pin (v1-hub fallback: flat latest_version).
    let row = null;
    try { row = await store().getState(moduleId); } catch (_) {}
    const installedVersion = (row && (row.version || (row.settings && row.settings.package && row.settings.package.version))) || null;
    const updatePolicy = (row && row.settings && row.settings.updatePolicy) || null;
    const latest = installedVersion
        ? require('./remoteCatalog').resolveUpdateTarget(hm, installedVersion, updatePolicy)
        : (hm.latest_version || null);
    if (!latest) { const e = new (hubClient().HubError)('hub_unavailable', 'no update available'); throw e; }
    const r = await installFromHub(moduleId, { version: latest, actorId, acceptedPermissions });
    if (!r.requiresRestart) {
        await moduleAudit().emit('platform.module.update', moduleId, actorId, { version: latest });
    }
    // Hot activation for pure-JS modules; native/restart:'always' packages are
    // staged and report requiresRestart honestly.
    return { ok: true, version: latest, requiresRestart: !!r.requiresRestart };
}

// ── Sideload + offline grants (M3.1 — air-gapped installs) ─────────────────
const OFFLINE_GRANT_CONFIG_PREFIX = 'beeflow_hub_offline_grant_';

function _offlineGrantKey(moduleId) { return `${OFFLINE_GRANT_CONFIG_PREFIX}${_safeSeg(moduleId)}`; }

/** Validate a parsed `.bfgrant` file's envelope (signature verified separately). */
function _validateGrantFile(g) {
    if (!g || typeof g !== 'object') return 'bad_grant_file';
    if (g.format !== 'beeflow-offline-grant') return 'bad_grant_format';
    if (Number(g.format_version) !== 1) return 'bad_grant_version';
    if (typeof g.module_id !== 'string' || !g.module_id) return 'bad_grant_module';
    if (typeof g.grant_token !== 'string' || !g.grant_token) return 'bad_grant_token';
    return null;
}

/**
 * Verify + stash an offline `.bfgrant` for a module. Works pre-install (the
 * grant waits in configStore) and post-402 (activate-staged picks it up).
 */
async function applyOfflineGrant(moduleId, grantFile) {
    const bad = _validateGrantFile(grantFile);
    if (bad) { const e = new Error(bad); e.code = bad; throw e; }
    if (grantFile.module_id !== moduleId) { const e = new Error('grant_module_mismatch'); e.code = 'grant_module_mismatch'; throw e; }
    const subjectIds = await _subjectIds();
    const res = await moduleEntitlements.verifyModuleGrant(grantFile.grant_token, {
        moduleId,
        subjectIds: subjectIds.length ? subjectIds : undefined,
        publicKeyResolver: _grantKeyResolver,
    });
    if (!res.valid) { const e = new Error(`grant_invalid: ${res.error}`); e.code = 'grant_invalid'; e.detail = res.error; throw e; }
    await require('../stores/configStore').setConfig(_offlineGrantKey(moduleId), {
        format: grantFile.format, format_version: 1, module_id: moduleId,
        subject: grantFile.subject || null, kind: grantFile.kind || res.payload.kind || 'admin_granted',
        grant_token: grantFile.grant_token, kid: grantFile.kid || null,
        expires_at: grantFile.expires_at || null, note: grantFile.note || null,
    });
    return {
        ok: true,
        entitlement: {
            kind: res.payload.kind || grantFile.kind || 'admin_granted',
            status: 'active',
            exp: res.payload.exp,
            entitlement_id: res.payload.entitlement_id || null,
            source: 'offline',
            grantToken: grantFile.grant_token,
        },
    };
}

/**
 * Entitlement gate for a sideloaded package, in order: (1) a stashed offline
 * .bfgrant, (2) `license_class:'free'` pinned in the package's SIGNED payload
 * (absent ⇒ paid), (3) the hub when connected. No match ⇒
 * offline_grant_required (→ 402); the package stays staged for a later
 * activate-staged once a grant arrives.
 */
async function _sideloadEntitlementGate(moduleId, manifest, signedPayload) {
    let stash = null;
    try { stash = await require('../stores/configStore').getConfig(_offlineGrantKey(moduleId)); } catch (_) {}
    if (stash && stash.grant_token) {
        const subjectIds = await _subjectIds();
        const res = await moduleEntitlements.verifyModuleGrant(stash.grant_token, {
            moduleId, subjectIds: subjectIds.length ? subjectIds : undefined,
            publicKeyResolver: _grantKeyResolver,
        });
        if (res.valid) {
            return {
                entitlement: {
                    kind: res.payload.kind || stash.kind || 'admin_granted', status: 'active',
                    exp: res.payload.exp, entitlement_id: res.payload.entitlement_id || null,
                    source: 'offline', grantToken: stash.grant_token,
                },
            };
        }
    }
    if (signedPayload && signedPayload.license_class === 'free') {
        return { entitlement: { kind: 'free', status: 'active', exp: null, entitlement_id: null, source: 'offline' } };
    }
    try {
        if (await hubClient().isConnected()) return await _entitlementGate(moduleId, manifest);
    } catch (_) { /* fall through to 402 */ }
    const e = new Error('offline_grant_required');
    e.code = 'offline_grant_required';
    throw e;
}

/**
 * Install a `.bfmod` from a raw upload — the air-gapped path. Same trust root
 * and verify pipeline as a hub download; the only difference is where the
 * entitlement comes from. An unentitled upload is RETAINED and ledgered
 * 'staged' so a later grant + activate-staged completes it without re-upload.
 */
async function sideloadFromBuffer(buffer, { actorId = null, acceptedPermissions = null } = {}) {
    const result = await packageVerify.verifyPackage(buffer, { publicKeyResolver: _packageKeyResolver });
    if (!result.ok) { const e = new Error(`package_verify_failed:${result.error}`); e.code = 'package_verify_failed'; e.detail = result.error; throw e; }
    const manifest = result.manifest;
    const moduleId = manifest.id;
    const version = manifest.version;
    if (require('./catalog').getModule(moduleId)) { const e = new Error('module_id_conflict'); e.code = 'module_id_conflict'; throw e; }
    _compatCheck(manifest, result.signature && result.signature.payload);

    if (_installing.has(moduleId)) { const e = new Error('install_in_progress'); e.code = 'install_in_progress'; throw e; }
    _installing.add(moduleId);
    _setProgress(moduleId, 'verifying', 30);
    try {
        // Retain the package + extract (same layout as a hub install).
        const pkgPath = packagePath(moduleId, version);
        await fsp.mkdir(path.dirname(pkgPath), { recursive: true });
        await fsp.writeFile(pkgPath, buffer);
        const sha256 = require('crypto').createHash('sha256').update(buffer).digest('hex');
        await _extractAtomic(versionDir(moduleId, version), result.files);
        const kid = (result.signature && result.signature.kid) || null;

        // Consent gate — identical to the hub path, against the signed manifest.
        const isMv2 = Number(manifest.manifestVersion || 1) >= 2;
        const needed = (isMv2 && Array.isArray(manifest.permissions)) ? manifest.permissions : [];
        let grantedPermissions = null;
        if (isMv2) {
            let existingList = [];
            try {
                const row = await store().getState(moduleId);
                existingList = (row && row.settings && row.settings.grantedPermissions
                    && row.settings.grantedPermissions.list) || [];
            } catch (_) {}
            const granted = new Set([...existingList, ...(Array.isArray(acceptedPermissions) ? acceptedPermissions : [])]);
            const missing = needed.filter(p => !granted.has(p));
            if (missing.length) {
                const e = new Error('consent_required'); e.code = 'consent_required'; e.missingPermissions = missing; throw e;
            }
            grantedPermissions = { list: needed, acceptedBy: actorId, acceptedAt: new Date().toISOString() };
        }

        let gate;
        try {
            gate = await _sideloadEntitlementGate(moduleId, manifest, result.signature && result.signature.payload);
        } catch (e) {
            // Keep the verified package for a later grant.
            await packageStore().setStaged(moduleId, version, {
                manifest: _manifestSummary(manifest), kid, packageSha256: sha256, actorId, source: 'sideload',
            });
            _setProgress(moduleId, 'error', null, e.code || e.message);
            throw e;
        }

        const requiresRestart = ([...result.files.keys()].some(n => n.endsWith('.node'))
            || !!(manifest.server && (manifest.server.native === true || manifest.server.restart === 'always')))
            && _dispatch.has(moduleId);
        if (requiresRestart) {
            await packageStore().setStaged(moduleId, version, {
                manifest: _manifestSummary(manifest), kid, packageSha256: sha256, actorId, source: 'sideload',
            });
            if (grantedPermissions) { try { await store().mergeSettings(moduleId, { grantedPermissions }); } catch (_) {} }
            _setProgress(moduleId, 'staged', 100);
            return { ok: true, version, requiresRestart: true };
        }

        await activate(moduleId, version, {
            actorId, manifest, kid, sha256,
            entitlement: gate.entitlement, grantedPermissions, source: 'sideload',
            onPhase: (phase, pct) => _setProgress(moduleId, phase, pct),
        });
        _setProgress(moduleId, 'done', 100);
        await moduleAudit().emit('platform.module.install', moduleId, actorId, { version, source: 'sideload', permissions: needed });
        return { ok: true, version, requiresRestart: false };
    } catch (e) {
        if (!_progress.get(moduleId) || _progress.get(moduleId).phase !== 'error') {
            _setProgress(moduleId, 'error', null, e.code || e.message,
                e.missingPermissions ? { missingPermissions: e.missingPermissions } : null);
        }
        throw e;
    } finally {
        _installing.delete(moduleId);
    }
}

/**
 * Activate a previously staged version (sideload waiting on a grant, or an
 * operator choosing to apply a staged update NOW instead of at restart —
 * only valid when a hot swap is actually safe).
 */
async function activateStaged(moduleId, { version = null, actorId = null } = {}) {
    const rows = await packageStore().listForModule(moduleId);
    const staged = (rows || []).filter(r => r.status === 'staged');
    const target = version ? staged.find(r => r.version === version) : staged[0];
    if (!target) { const e = new Error('no_staged_version'); e.code = 'no_staged_version'; throw e; }

    const { manifest, kid } = await _reverifyFromDisk(moduleId, target.version);
    let gate = null;
    if (target.source === 'sideload') {
        gate = await _sideloadEntitlementGate(moduleId, manifest, null);
    } else {
        gate = await _entitlementGate(moduleId, manifest);
    }
    await activate(moduleId, target.version, {
        actorId, manifest, kid, sha256: target.packageSha256,
        entitlement: gate.entitlement, source: target.source,
    });
    await moduleAudit().emit('platform.module.install', moduleId, actorId, { version: target.version, source: target.source, fromStaged: true });
    return { ok: true, version: target.version };
}

// ── Version retention + rollback (M3.2) ─────────────────────────────────────

/** Ledger versions joined with an fs probe (does the .bfmod still exist?). */
async function listVersions(moduleId) {
    const rows = await packageStore().listForModule(moduleId);
    const out = [];
    for (const r of (rows || [])) {
        let hasPackageFile = false;
        try { await fsp.access(packagePath(r.moduleId, r.version)); hasPackageFile = true; } catch (_) {}
        out.push({ ...r, hasPackageFile });
    }
    return out;
}

/**
 * Roll back to a retained retired version. Guards: lease, package file present,
 * full re-verify, schema-downgrade check (the target's server.schemaVersion
 * must not be lower than the active one's unless forced), offline entitlement.
 */
async function rollbackTo(moduleId, { version = null, force = false, actorId = null } = {}) {
    const candidates = await packageStore().listRollbackCandidates(moduleId);
    const target = version
        ? (candidates || []).find(r => r.version === version)
        : (candidates || [])[0];
    if (!target) { const e = new Error('no_rollback_candidate'); e.code = 'no_rollback_candidate'; throw e; }

    if (_installing.has(moduleId)) { const e = new Error('install_in_progress'); e.code = 'install_in_progress'; throw e; }
    _installing.add(moduleId);
    try {
        try { await installStore().acquire(moduleId, { version: target.version, actor: actorId, replica: REPLICA_ID }); } catch (_) {}
        _setProgress(moduleId, 'verifying', 30);
        const { manifest, kid } = await _reverifyFromDisk(moduleId, target.version);

        // Schema-downgrade guard: module data written by a NEWER schema may be
        // unreadable to older code — refuse unless the operator forces it.
        const activeRow = await packageStore().getActive(moduleId);
        const activeSchema = Number(activeRow && activeRow.manifest && activeRow.manifest.schemaVersion
            || (activeRow && activeRow.manifest && activeRow.manifest.server && activeRow.manifest.server.schemaVersion) || 0);
        const targetSchema = Number((manifest.server && manifest.server.schemaVersion) || 0);
        if (!force && activeSchema && targetSchema && targetSchema < activeSchema) {
            const e = new Error('schema_downgrade'); e.code = 'schema_downgrade';
            e.detail = `target schemaVersion ${targetSchema} < active ${activeSchema}`;
            throw e;
        }

        // Offline entitlement: the persisted timestamp gate must still hold.
        let row = null;
        try { row = await store().getState(moduleId); } catch (_) {}
        const remoteCatalog = require('./remoteCatalog');
        if (!remoteCatalog.isEntitled(row)) { const e = new Error('not_entitled'); e.code = 'not_entitled'; throw e; }

        await activate(moduleId, target.version, {
            actorId, manifest, kid, sha256: target.packageSha256, source: target.source,
        });
        _setProgress(moduleId, 'done', 100);
        _logSystem(moduleId, `rolled back to v${target.version} by ${actorId || 'operator'}`);
        await moduleAudit().emit('platform.module.update', moduleId, actorId, { version: target.version, rollback: true, forced: !!force });
        return { ok: true, version: target.version };
    } catch (e) {
        _setProgress(moduleId, 'error', null, e.code || e.message);
        throw e;
    } finally {
        _installing.delete(moduleId);
    }
}

// ── Boot re-verify + activate ──────────────────────────────────────────────
async function _reverifyFromDisk(moduleId, version) {
    let buffer;
    try { buffer = await fsp.readFile(packagePath(moduleId, version)); }
    catch (_) { throw new Error('package_file_missing'); }
    const result = await packageVerify.verifyPackage(buffer, { publicKeyResolver: _packageKeyResolver });
    if (!result.ok) throw new Error(`verify_failed:${result.error}`);
    if (result.manifest.id !== moduleId || result.manifest.version !== version) throw new Error('manifest_mismatch');
    _compatCheck(result.manifest, result.signature && result.signature.payload);
    await _extractAtomic(versionDir(moduleId, version), result.files);
    return { manifest: result.manifest, kid: (result.signature && result.signature.kid) || _kidFromSignature(result.files) };
}

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
    const staged = await verifyAndStage(pkg.moduleId, pkg.version, {
        download: true, expectedSha256: pkg.packageSha256, redownloadSha: pkg.packageSha256,
    });
    await activate(pkg.moduleId, pkg.version, {
        actorId: pkg.installedBy, manifest: staged.manifest, kid: staged.kid,
        sha256: staged.sha256, persist: false,
    });
    try {
        await require('./moduleAudit').emit('platform.module.selfheal', pkg.moduleId, null, {
            version: pkg.version, sha256: pkg.packageSha256,
        });
    } catch (_) { /* audit is best-effort */ }
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
                try { await packageStore().setFailed(pkg.moduleId, pkg.version, { error: e.message, status: e.compat ? 'incompatible' : 'failed' }); } catch (_) {}
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
            } catch (_) {}
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
    lastRunAt: null, lastDurationMs: null, lastError: null,
    activated: 0, deactivated: 0, healed: 0, errors: 0, gcPruned: 0, boot: null,
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
                } catch (_) { /* next run */ }
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
                } catch (_) { /* raced */ }
            }
        } catch (_) { /* per-module best effort */ }
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
