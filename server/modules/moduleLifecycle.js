/**
 * Platform-module lifecycle: import (activate) and remove (deactivate).
 *
 * Sits above both ./index (state/catalog runtime) and ./packageLoader (remote
 * package activation) so neither has to require the other for orchestration.
 */

const path = require('path');
const log = require('../telemetry/log');
const runtime = require('./index');
const packageLoader = require('./packageLoader');
const remoteCatalog = require('./remoteCatalog');

const { loadStates, resolveEntry, projectRow, statusFor, GRACE_OPTS, invalidateCache, refreshModuleActivations } = runtime;

let _store, _userStore, _sessionCache;
function store() { return _store || (_store = require('../stores/platformModuleStore')); }
function userStore() { return _userStore || (_userStore = require('../stores/userStore')); }
function sessionCache() { return _sessionCache || (_sessionCache = require('../auth/sessionCache')); }

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
    try { row = await store().getState(entry.id); } catch (err) { log.debug('default below', err); }
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
        if (!remoteCatalog.isEntitled(row, { now: Date.now(), ...GRACE_OPTS })) {
            return { ok: false, error: 'not_entitled' };
        }
        const version = row?.version || entry.version;
        if (!version) return { ok: false, error: 'module_unavailable' };
        const before = await currentStatus(entry);
        await packageLoader.activate(id, version, { actorId });
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
        await packageLoader.deactivate(id, { actorId });
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

module.exports = { importModule, removeModule };
