/**
 * Framework policy — which frameworks are ACTIVE for an organisation.
 *
 * A framework is active when it is enabled AND its licence capability is
 * effective for the org. Two axes, resolved here and nowhere else:
 *
 *   enabled   core frameworks (GDPR, AI Act, ISO 27001) are always on; the
 *             others are opt-in, stored in compliance_settings.enabled_frameworks
 *             (JSONB list of framework ids).
 *   locked    from the entitlement resolver — null when the capability is
 *             effective, 'not_granted' when the plan/licence includes it but the
 *             org has not switched it on, 'ceiling' when it is outside the plan.
 *             A locked framework is shown locked, never hidden.
 *
 * Plus `relevance` ('relevant' | 'not_relevant' | 'unknown') for the frameworks
 * that only apply to some organisations (DORA, Machinery) — stored in
 * compliance_settings.framework_relevance, read by the checks themselves so a
 * 'not_relevant' framework yields not_applicable rows instead of noise.
 *
 * The runner asks `activeRegulations(orgId)` before every sweep: a disabled or
 * locked framework's checks are neither run nor persisted (PLAN.md §1.4). The
 * request path passes `req` so the licence answer is the caller's own (the
 * resolver memoises per session); the runner path has no req and gets the
 * org-level answer, memoised here for 30 s per org.
 *
 * Nothing here decides what a capability id means — that is the entitlement
 * resolver's job; this module only asks it and shapes the 403 body exactly as
 * requireCapability would, so a route can hand the error straight through.
 */

const complianceStore = require('../stores/complianceStore');
const frameworks = require('./frameworks');
const log = require('../telemetry/log');

const MEMO_TTL_MS = parseInt(process.env.COMPLIANCE_POLICY_MEMO_MS || '30000', 10);
const RELEVANCE_VALUES = Object.freeze(['relevant', 'not_relevant', 'unknown']);
const CUSTOM_CAPABILITY = 'compliance_hub_custom';

// Event names emitted through compliance/events.js (that module owns the bus;
// it does not need to know these names to relay them — handlers subscribe by
// string). Payload: { orgId, frameworkId, regulation, actorId, at } and, for
// the relevance event, { relevance, note }.
const POLICY_EVENTS = Object.freeze({
    FRAMEWORK_ENABLED: 'framework_enabled',
    FRAMEWORK_DISABLED: 'framework_disabled',
    FRAMEWORK_RELEVANCE_CHANGED: 'framework_relevance_changed',
});

// ── errors (routes map status/body straight through) ─────────────────────

class UnknownFrameworkError extends Error {
    constructor(id) {
        super(`Unknown framework: ${id}`);
        this.name = 'UnknownFrameworkError';
        this.code = 'unknown_framework';
        this.status = 400;
        this.body = { error: 'unknown_framework', framework: id };
    }
}

class FrameworkCoreError extends Error {
    constructor(id) {
        super(`Framework ${id} is a core framework and cannot be disabled`);
        this.name = 'FrameworkCoreError';
        this.code = 'framework_core';
        this.status = 400;
        this.body = { error: 'framework_core', framework: id };
    }
}

class FrameworkLockedError extends Error {
    /**
     * @param {'ceiling'|'not_granted'} reason
     * @param {{feature:string, required:string|null, upgrade_url:string, current?:string}} lock
     */
    constructor(id, reason, lock) {
        super(`Framework ${id} is locked (${reason})`);
        this.name = 'FrameworkLockedError';
        this.status = 403;
        this.reason = reason;
        this.lock = lock;
        this.framework = id;
        // Same shape requireCapability emits, so SPA call sites that already
        // read `error`/`feature`/`required`/`upgrade_url` keep working.
        this.code = reason === 'ceiling' ? 'feature_locked' : 'feature_disabled';
        this.body = reason === 'ceiling'
            ? { error: 'feature_locked', feature: lock.feature, required: lock.required || 'enterprise', current: lock.current || null, upgrade_url: lock.upgrade_url }
            : { error: 'feature_disabled', feature: lock.feature };
    }
}

class EntitlementsUnavailableError extends Error {
    constructor(orgId) {
        super(`Entitlements could not be resolved for org ${orgId}`);
        this.name = 'EntitlementsUnavailableError';
        this.code = 'entitlement_unavailable';
        this.status = 503;
        this.body = { error: 'entitlement_unavailable', retry_after: 1 };
    }
}

class InvalidRelevanceError extends Error {
    constructor(value) {
        super(`Invalid relevance "${value}" — expected ${RELEVANCE_VALUES.join(' | ')}`);
        this.name = 'InvalidRelevanceError';
        this.code = 'invalid_relevance';
        this.status = 400;
        this.body = { error: 'invalid_relevance', allowed: RELEVANCE_VALUES };
    }
}

// ── lazy deps (the resolver pulls in the licence + telemetry layers) ──────

let _entitlements = null;
function _ent() {
    if (!_entitlements) _entitlements = require('../core/entitlements/entitlements');
    return _entitlements;
}
function _upgradeUrl() {
    return process.env.LICENSE_UPGRADE_URL || 'https://beeflow.nl/pricing';
}
function _requiredTier(capId) {
    try {
        const cap = _ent().registry.getCapability(capId);
        const feature = cap?.licenseFeature || capId;
        const { findRequiredTierForFeature } = require('../license/middleware');
        return findRequiredTierForFeature(feature) || 'enterprise';
    } catch {
        return 'enterprise';
    }
}

// ── settings parsing ─────────────────────────────────────────────────────

function _asArray(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
    return [];
}
function _asObject(v) {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    if (typeof v === 'string') { try { const p = JSON.parse(v); return p && typeof p === 'object' && !Array.isArray(p) ? p : {}; } catch { return {}; } }
    return {};
}

async function _settings(orgId) {
    let s = null;
    try { s = await complianceStore.getSettings(orgId); } catch { s = null; }
    return {
        enabled: new Set(_asArray(s?.enabled_frameworks).filter(x => typeof x === 'string')),
        relevance: _asObject(s?.framework_relevance),
    };
}

// ── licence ──────────────────────────────────────────────────────────────

/**
 * One entitlement snapshot per call — every framework's lock reason is read
 * from it, so ten frameworks cost one resolution, not ten.
 */
async function _snapshot({ orgId, req }) {
    let snap = null;
    try {
        snap = await _ent().resolveEntitlements({
            orgId,
            userId: req?.session?.user?.id || null,
            session: req?.session || null,
            req: req || null,
        });
    } catch {
        snap = null;
    }
    if (!snap || snap.degraded) throw new EntitlementsUnavailableError(orgId);
    return snap;
}

function _inCeiling(snap, cap) {
    const set = snap._sets?.ceiling?.[cap.kind];
    if (set && typeof set.has === 'function') return set.has(cap.id);
    const arr = snap.ceiling?.[cap.kind];
    return Array.isArray(arr) && arr.includes(cap.id);
}

/**
 * null when the capability is effective; 'not_granted' when it is in the
 * plan/licence ceiling but not switched on for the org; 'ceiling' when the
 * plan does not include it — or when no tier declares the id at all, which
 * is the same thing from the org's point of view.
 */
function _lockReason(snap, capId) {
    const ent = _ent();
    const cap = ent.registry.getCapability(capId);
    if (!cap) return 'ceiling';
    if (ent.snapshotHas(snap, capId)) return null;
    if (cap.aliasOf && ent.snapshotHas(snap, cap.aliasOf)) return null;
    return _inCeiling(snap, cap) ? 'not_granted' : 'ceiling';
}

function _lock(snap, capId, reason) {
    if (!reason) return null;
    return {
        feature: capId,
        required: _requiredTier(capId),
        current: snap?.tier || null,
        upgrade_url: _upgradeUrl(),
    };
}

// ── memo (org-level state; the request path re-reads the licence) ────────

const _memo = new Map(); // orgId → { at, settings, snap }

async function _orgState(orgId) {
    const hit = _memo.get(orgId);
    if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit;
    const settings = await _settings(orgId);
    const snap = await _snapshot({ orgId, req: null }); // throws when unavailable — never memoised
    const entry = { at: Date.now(), settings, snap };
    _memo.set(orgId, entry);
    return entry;
}

function invalidate(orgId) {
    if (orgId === undefined) _memo.clear();
    else _memo.delete(orgId);
}

// ── public ───────────────────────────────────────────────────────────────

function _entry(fw, settings, snap) {
    const reason = _lockReason(snap, fw.capability);
    const relevance = fw.relevance_gate
        ? (RELEVANCE_VALUES.includes(settings.relevance[fw.id]) ? settings.relevance[fw.id] : 'unknown')
        : (settings.relevance[fw.id] === 'not_relevant' ? 'not_relevant' : 'relevant');
    return {
        id: fw.id,
        regulation: fw.regulation,
        enabled: fw.core ? true : settings.enabled.has(fw.id),
        core: fw.core,
        locked: reason,
        lock: _lock(snap, fw.capability, reason),
        relevance,
    };
}

/**
 * Per-framework state for one org. With `req` the licence is the caller's own
 * (super-admins see their full ceiling); without it, the org-level answer.
 * Throws EntitlementsUnavailableError when the licence cannot be resolved —
 * a runner must then skip the org, not run with an empty set.
 */
async function resolve(orgId, { req = null } = {}) {
    const org = orgId || 'default';
    const state = await _orgState(org);
    const snap = req ? await _snapshot({ orgId: org, req }) : state.snap;
    return frameworks.listBuiltin().map(fw => _entry(fw, state.settings, snap));
}

/** True iff the org holds the custom-frameworks capability (no per-framework toggle for those). */
async function customUnlocked(orgId, { req = null } = {}) {
    const org = orgId || 'default';
    const state = await _orgState(org);
    const snap = req ? await _snapshot({ orgId: org, req }) : state.snap;
    return _lockReason(snap, CUSTOM_CAPABILITY) === null;
}

/**
 * The Set of regulation codes whose checks run for this org: enabled AND
 * unlocked, plus 'CUSTOM' when the org may define its own frameworks.
 */
async function activeRegulations(orgId, opts = {}) {
    const entries = await resolve(orgId, opts);
    const active = new Set(entries.filter(e => e.enabled && e.locked === null).map(e => e.regulation));
    if (await customUnlocked(orgId, opts)) active.add(frameworks.CUSTOM_REGULATION);
    return active;
}

function _emit(name, payload) {
    try {
        const events = require('./events');
        if (typeof events.emit === 'function') events.emit(name, payload);
    } catch (e) {
        log.warn(`[FrameworkPolicy] emit ${name} failed:`, e.message);
    }
}

function _bestEffortCountsInvalidate(orgId) {
    // The counts body caches the framework set for 60 s per org; bust it so the
    // rail and the header pick up an enable/disable on the very next poll.
    try { require('./countsCache').invalidate(orgId); } catch { /* not shipped yet */ }
}

/**
 * Switch an opt-in framework on or off. Throws UnknownFrameworkError,
 * FrameworkCoreError (disable of a core framework) or FrameworkLockedError
 * (enable of a framework the licence does not cover). Enabling a core
 * framework is a no-op. Returns the framework's resolved entry.
 */
async function setEnabled(orgId, id, on, actorId = null, { req = null } = {}) {
    const org = orgId || 'default';
    const fw = frameworks.byId(id);
    if (!fw) throw new UnknownFrameworkError(id);
    if (fw.core) {
        if (!on) throw new FrameworkCoreError(id);
        return (await resolve(org, { req })).find(e => e.id === id);
    }
    const current = (await resolve(org, { req })).find(e => e.id === id);
    if (on && current.locked) throw new FrameworkLockedError(id, current.locked, current.lock);

    const { enabled } = await _settings(org); // fresh read — never write from a memo
    const next = new Set(enabled);
    if (on) next.add(id); else next.delete(id);
    const changed = on ? !enabled.has(id) : enabled.has(id);
    await complianceStore.saveSettings(org, { enabled_frameworks: [...next] });
    invalidate(org);
    _bestEffortCountsInvalidate(org);
    if (changed) {
        _emit(on ? POLICY_EVENTS.FRAMEWORK_ENABLED : POLICY_EVENTS.FRAMEWORK_DISABLED, {
            orgId: org, frameworkId: id, regulation: fw.regulation, actorId, at: new Date().toISOString(),
        });
    }
    return (await resolve(org, { req })).find(e => e.id === id);
}

/**
 * Record whether a relevance-gated framework applies to this org. Stored as
 * `framework_relevance[id] = relevance` (the checks read exactly that) with
 * who/when/why under `framework_relevance.meta[id]`.
 */
async function setRelevance(orgId, id, relevance, actorId = null, note = null, { req = null } = {}) {
    const org = orgId || 'default';
    const fw = frameworks.byId(id);
    if (!fw) throw new UnknownFrameworkError(id);
    if (!RELEVANCE_VALUES.includes(relevance)) throw new InvalidRelevanceError(relevance);

    const { relevance: existing } = await _settings(org);
    const at = new Date().toISOString();
    const meta = { ..._asObject(existing.meta), [id]: { set_by: actorId, set_at: at, note: note ? String(note).slice(0, 500) : null } };
    const nextRelevance = { ...existing, [id]: relevance, meta, set_by: actorId, set_at: at };
    await complianceStore.saveSettings(org, { framework_relevance: nextRelevance });
    invalidate(org);
    _bestEffortCountsInvalidate(org);
    if (existing[id] !== relevance) {
        _emit(POLICY_EVENTS.FRAMEWORK_RELEVANCE_CHANGED, {
            orgId: org, frameworkId: id, regulation: fw.regulation, relevance, note: note || null, actorId, at,
        });
    }
    return (await resolve(org, { req })).find(e => e.id === id);
}

module.exports = {
    resolve,
    activeRegulations,
    customUnlocked,
    setEnabled,
    setRelevance,
    invalidate,
    POLICY_EVENTS,
    RELEVANCE_VALUES,
    MEMO_TTL_MS,
    UnknownFrameworkError,
    FrameworkCoreError,
    FrameworkLockedError,
    EntitlementsUnavailableError,
    InvalidRelevanceError,
};
