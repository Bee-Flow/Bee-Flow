/**
 * Platform-module runtime — catalog (./catalog.js) joined with persisted
 * import state (stores/platformModuleStore.js).
 *
 * A module that is NOT active behaves as if it doesn't exist on the instance:
 *   - its capability ids are pushed into the capability registry's inactive
 *     set (refreshModuleActivations → setInactiveModuleCapabilityIds), so
 *     listCapabilities() drops them and every downstream projection (ceiling,
 *     orgAvailable, effective, /my-entitlements, admin matrices) inherits;
 *   - its routes 404 via the requireModule() gate (concealment, mirrors
 *     customIntegrationsFeatureGate);
 *   - its workers no-op (schedulers wrap their tick in moduleGatedTick()).
 *
 * State reads are TTL-cached (15s) with synchronous invalidation on write.
 * On a DB read failure the last good cache is served; with no cache at all we
 * fall back to catalog defaults — grandfathered (defaultImported:true) modules
 * fail OPEN like projectFeatureGate, future defaultImported:false modules fail
 * closed.
 */

const fs = require('fs');
const path = require('path');
const { tagGate } = require('../auth/gateMeta');
const { listModules, getModule } = require('./catalog');
const log = require('../telemetry/log');

// Lazy requires — the registry lazy-requires this module back (cycle safety),
// and stores must not load before migrateDb/boot decides to.
let _store, _registry, _userStore, _sessionCache, _remoteCatalog, _packageLoader;
function store() { return _store || (_store = require('../stores/platformModuleStore')); }
function registry() { return _registry || (_registry = require('../core/entitlements/capabilityRegistry')); }
function userStore() { return _userStore || (_userStore = require('../stores/userStore')); }
function sessionCache() { return _sessionCache || (_sessionCache = require('../auth/sessionCache')); }
function remoteCatalog() { return _remoteCatalog || (_remoteCatalog = require('./remoteCatalog')); }
function packageLoader() { return _packageLoader || (_packageLoader = require('./packageLoader')); }

const STATE_TTL_MS = 15_000;
// Post-expiry grace for a remote module's entitlement: 24h so an operator whose
// hub blipped over a renewal boundary isn't hard-down instantly. Pin to 0 for
// v1's immediate-lapse strictness. (entitlementRefresh is the freshness owner;
// runtime honours the timestamp it persisted.)
const REMOTE_GRACE_MS = parseInt(process.env.MODULE_ENTITLEMENT_GRACE_MS || String(24 * 60 * 60 * 1000), 10);
// Grace for a grant that failed re-verification (status 'invalid') — bounded
// from entitlement.invalidSince, then fail closed.
const INVALID_GRACE_MS = parseInt(process.env.MODULE_INVALID_GRACE_MS || String(24 * 60 * 60 * 1000), 10);
const GRACE_OPTS = Object.freeze({ graceMs: REMOTE_GRACE_MS, graceInvalidMs: INVALID_GRACE_MS });
let _stateCache = null; // { at, rows: Map<moduleId, storeRow> }

async function loadStates() {
    if (_stateCache && (Date.now() - _stateCache.at) < STATE_TTL_MS) return _stateCache;
    try {
        const rows = await store().getAllStates();
        _stateCache = { at: Date.now(), rows: new Map(rows.map(r => [r.moduleId, r])) };
    } catch (e) {
        log.warn('[Modules] state read failed — using', _stateCache ? 'last cached state' : 'catalog defaults', ':', e.message);
        if (_stateCache) {
            _stateCache.at = Date.now(); // serve stale rather than flip-flop
        } else {
            _stateCache = { at: Date.now(), rows: new Map() }; // row-absent ⇒ catalog default
        }
    }
    return _stateCache;
}

function invalidateCache() {
    _stateCache = null;
}

// Resolve a module id to a catalog-shaped entry: a built-in catalog entry, or a
// remote entry reconstructed from its (signed) platform_modules row. Built-in
// always wins a slug collision.
function resolveEntry(id, states) {
    const builtin = getModule(id);
    if (builtin) return builtin;
    const row = states && states.rows.get(id);
    if (row && remoteCatalog().isRemoteRow(row)) return remoteCatalog().entryFromRow(row);
    return null;
}

// Remote catalog-shaped entries derived from every remote row in the state map
// (excluding any slug that a built-in claims).
function remoteEntriesFromStates(states) {
    const out = [];
    for (const row of states.rows.values()) {
        if (!remoteCatalog().isRemoteRow(row)) continue;
        if (getModule(row.moduleId)) continue; // built-in wins the slug
        const e = remoteCatalog().entryFromRow(row);
        if (e) out.push(e);
    }
    return out;
}

// Wire-contract status: 'unavailable' trumps everything; explicit row wins
// over the catalog default; row-absent = grandfathering default. Remote modules
// are timestamp-gated: an imported row whose entitlement has lapsed reports
// 'expired'.
function statusFor(entry, row) {
    if (entry.available === false) return 'unavailable';
    if (entry.remote) {
        if (!row || row.status === 'removed') return 'removed';
        const ent = remoteCatalog().entitlementState(row, { now: Date.now(), ...GRACE_OPTS });
        return ent.active ? row.status : 'expired';
    }
    if (row) return row.status;
    return entry.defaultImported ? 'imported' : 'removed';
}

function isActive(entry, row) {
    if (!entry || entry.available === false) return false;
    if (entry.remote) {
        // Remote: imported AND currently entitled (TIMESTAMP-ONLY — no network).
        if (!row || row.status !== 'imported') return false;
        return remoteCatalog().isEntitled(row, { now: Date.now(), ...GRACE_OPTS });
    }
    if (row) return row.status === 'imported';
    return entry.defaultImported === true;
}

async function isModuleActive(id) {
    const states = await loadStates();
    const entry = resolveEntry(id, states);
    if (!entry || entry.available === false) return false;
    return isActive(entry, states.rows.get(id));
}

function buildRequirements(entry) {
    const req = entry.requirements || {};
    const rows = [];
    if (req.docker) {
        const met = fs.existsSync('/var/run/docker.sock');
        rows.push({
            id: 'docker',
            label: 'Docker socket',
            met,
            detail: met ? '/var/run/docker.sock' : (req.notes || 'Docker socket not found at /var/run/docker.sock'),
        });
    }
    // Image/env requirements are informational (met:true) — they are only
    // pull-/read-at-use, so we can't probe them cheaply or reliably here.
    for (const image of req.images || []) {
        rows.push({ id: `image:${image}`, label: `Image: ${image}`, met: true, detail: req.notes || 'Required at run time.' });
    }
    for (const envPattern of req.env || []) {
        rows.push({ id: `env:${envPattern}`, label: `Environment: ${envPattern}`, met: true, detail: 'Optional tuning variables.' });
    }
    return rows;
}

/** Project one catalog entry + optional store row into the wire-contract row. */
function projectRow(entry, row) {
    const requirements = buildRequirements(entry);
    return {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        category: entry.category,
        icon: entry.icon,
        version: entry.version,
        available: entry.available !== false,
        remote: entry.remote === true,
        status: statusFor(entry, row),
        source: row ? 'explicit' : 'default',
        importedAt: row?.importedAt || null,
        importedBy: row?.importedBy || null,
        requirementsMet: requirements.every(r => r.met),
        requirements,
        capabilities: (entry.capabilityIds || []).map(capId => {
            const cap = registry().getCapability(capId); // unfiltered lookup by design
            return { id: capId, label: cap?.name || capId, kind: cap?.kind || null };
        }),
    };
}

async function listModulesWithStatus() {
    const states = await loadStates();
    const builtins = listModules().map(entry => projectRow(entry, states.rows.get(entry.id)));
    const remotes = remoteEntriesFromStates(states).map(entry => projectRow(entry, states.rows.get(entry.id)));
    return [...builtins, ...remotes];
}

/** Capability ids owned by INACTIVE modules — the registry projection filter.
 *  Includes lapsed/removed remote modules (their caps drop from the ceiling). */
async function listInactiveCapabilityIds() {
    const states = await loadStates();
    const inactive = new Set();
    for (const entry of [...listModules(), ...remoteEntriesFromStates(states)]) {
        if (isActive(entry, states.rows.get(entry.id))) continue;
        for (const capId of entry.capabilityIds || []) inactive.add(capId);
    }
    return inactive;
}

/**
 * Recompute the inactive capability set and push it into the registry —
 * mirrors the _mcpDynamic push pattern: async entry points refresh BEFORE
 * reading the (synchronous) registry.
 */
let _refreshGen = 0;
async function refreshModuleActivations() {
    // Generation guard: a concurrent refresh that read pre-write TTL state
    // must not clobber a newer push (import/remove invalidates the cache and
    // refreshes; without this an in-flight resolve could re-push stale state).
    const gen = ++_refreshGen;
    const inactive = await listInactiveCapabilityIds();
    if (gen !== _refreshGen) return inactive;
    registry().setInactiveModuleCapabilityIds(inactive);
    return inactive;
}

// Best-effort audit + actor session bust shared by import/remove. Session
// destruction is the codebase's authoritative entitlement bust (see
// entitlements.invalidateForUser) — the actor's next request re-resolves
// against the new module state instead of a stale session memo.
async function auditAndPropagate(action, moduleId, actorId, beforeStatus, afterStatus) {
    try {
        await userStore().logAccessAudit(action, 'platform_module', moduleId, actorId, { status: beforeStatus }, { status: afterStatus }, null);
    } catch (e) { log.warn('[Modules] audit failed:', e.message); }
    if (actorId) {
        try { await sessionCache().bustSessionsForUser(actorId); } catch (e) { log.warn('[Modules] session bust failed:', e.message); }
    }
}

// Current status for the audit before-image — direct store read (bypasses the
// TTL cache) so back-to-back toggles audit the true previous state.
async function currentStatus(entry) {
    let row = null;
    try { row = await store().getState(entry.id); } catch (_) { /* default below */ }
    return statusFor(entry, row);
}

async function importModule(id, { actorId = null } = {}) {
    const states0 = await loadStates();
    const entry = resolveEntry(id, states0);
    if (!entry) return { ok: false, error: 'not_found' };
    if (entry.available === false) return { ok: false, error: 'module_unavailable' };

    if (entry.remote) {
        // Re-enable a previously-removed remote module by re-activating its
        // already-verified, staged package. NO host store migrations run
        // (remote modules own their schema via the host API). Paid-module
        // entitlement is gated HERE on the persisted timestamp (offline): a
        // lapsed/absent grant blocks the re-enable with `not_entitled` (→ 402).
        const row = states0.rows.get(id);
        if (!remoteCatalog().isEntitled(row, { now: Date.now(), ...GRACE_OPTS })) {
            return { ok: false, error: 'not_entitled' };
        }
        const version = row?.version || entry.version;
        if (!version) return { ok: false, error: 'module_unavailable' };
        const before = await currentStatus(entry);
        await packageLoader().activate(id, version, { actorId });
        await auditAndPropagate('platform.module.import', id, actorId, before, 'imported');
        const states = await loadStates();
        return { ok: true, module: projectRow(resolveEntry(id, states) || entry, states.rows.get(id)) };
    }

    // Built-in store migrations FIRST — a failure aborts the import (retryable)
    // so we never activate routes over a half-materialized schema. Paths in the
    // catalog are relative to server/.
    for (const s of entry.storeModules || []) {
        const mod = require(path.join(__dirname, '..', s.file));
        if (typeof mod.initDB === 'function') await mod.initDB();
    }

    const before = await currentStatus(entry);
    await store().setImported(id, { actorId, version: entry.version });
    invalidateCache();
    await refreshModuleActivations();
    await auditAndPropagate('platform.module.import', id, actorId, before, 'imported');

    const states = await loadStates();
    return { ok: true, module: projectRow(entry, states.rows.get(id)) };
}

async function removeModule(id, { actorId = null } = {}) {
    const states0 = await loadStates();
    const entry = resolveEntry(id, states0);
    if (!entry) return { ok: false, error: 'not_found' };

    if (entry.remote) {
        // Non-destructive: deactivate the runtime (stop worker + routes) and
        // flip the row to 'removed'. The staged package + its data stay on disk,
        // so a re-import restores everything.
        const before = await currentStatus(entry);
        await packageLoader().deactivate(id, { actorId });
        await auditAndPropagate('platform.module.remove', id, actorId, before, 'removed');
        const states = await loadStates();
        return { ok: true, module: projectRow(resolveEntry(id, states) || entry, states.rows.get(id)) };
    }

    // Built-in: non-destructive by design — only the state row flips. The
    // module's own tables/data are never touched, so a re-import restores it.
    const before = await currentStatus(entry);
    await store().setRemoved(id, { actorId });
    invalidateCache();
    await refreshModuleActivations();
    await auditAndPropagate('platform.module.remove', id, actorId, before, 'removed');

    const states = await loadStates();
    return { ok: true, module: projectRow(entry, states.rows.get(id)) };
}

/**
 * Route gate — mount in FRONT of requireCapability. Inactive module ⇒
 * 404 {error:'not_found'} (concealment; mirrors customIntegrationsFeatureGate).
 * Throws at mount time for unknown catalog ids, like requireCapability does
 * for unknown capability ids.
 */
function requireModule(moduleId, { remote = false } = {}) {
    // Built-in unknown ids throw at mount (like requireCapability). Remote ids
    // aren't in the static catalog, so a caller wiring a remote gate passes
    // { remote:true } to relax the mount-time existence check.
    if (!remote && !getModule(moduleId)) throw new Error(`requireModule: unknown module '${moduleId}'`);
    // Tagged so auth/routeWalk.cli.js can attribute the mount to its module
    // instead of recording another anonymous chain slot — the same contract
    // every other gate axis follows (see auth/gateMeta.js).
    return tagGate(async function moduleGate(req, res, next) {
        try {
            if (await isModuleActive(moduleId)) return next();
        } catch (_) { /* fall through to concealment */ }
        return res.status(404).json({ error: 'not_found' });
    }, { axis: 'module', id: moduleId });
}

/**
 * Wrap a scheduler tick so it no-ops while its module is not active.
 *
 * The header's third bullet — "its workers no-op" — was the one part of the
 * contract with nothing implementing it. Routes 404 through requireModule()
 * and capabilities vanish from the registry projection the moment a module is
 * removed, but its background work carried on: an operator who removed
 * Automations still had automations executing on the 60s tick, invisibly,
 * because the boot-time gates in boot/startupTasks.js read the CATALOG flag
 * (isModuleAvailable — a deploy-time constant) and nothing re-checked the
 * runtime row afterwards.
 *
 * isModuleActive() is TTL-cached (15s) with synchronous invalidation on write,
 * so calling it per tick is a Map lookup in the common case, not a query.
 *
 * FAILS OPEN, deliberately: if the state read throws, the tick runs. A
 * database blip must not silently stop the automation engine — that is the
 * same fail-open stance loadStates() already takes for grandfathered modules.
 */
function moduleGatedTick(moduleId, fn, name = fn.name || 'tick') {
    let announced = false;
    return async function moduleGatedTickInner(...args) {
        let active = true;
        try {
            active = await isModuleActive(moduleId);
        } catch (_) { /* fail open — see above */ }
        if (!active) {
            if (!announced) {
                log.info(`[Modules] ${name} paused — module '${moduleId}' is not active on this instance`);
                announced = true;
            }
            return undefined;
        }
        announced = false;
        return fn(...args);
    };
}

module.exports = {
    isModuleActive,
    moduleGatedTick,
    listModulesWithStatus,
    listInactiveCapabilityIds,
    invalidateCache,
    refreshModuleActivations,
    importModule,
    removeModule,
    requireModule,
};
