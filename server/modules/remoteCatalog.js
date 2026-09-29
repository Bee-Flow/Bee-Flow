/**
 * Remote-module projection — the join between the Hub catalog (hubClient) and
 * this install's persisted state (platform_modules rows written by
 * packageLoader), plus the TIMESTAMP-ONLY entitlement gate.
 *
 * A remote module lives in the SAME platform_modules table as built-in modules,
 * distinguished by `settings.remote === true`. Its catalog-entry shape (name,
 * capabilities, requirements, frontend) is reconstructed from the SIGNED
 * manifest we stored at install time — so the runtime (modules/index.js) can
 * treat a remote module exactly like a built-in one, minus the host-owned store
 * migration loop.
 *
 * Entitlement is enforced ON TIMESTAMPS ONLY here (settings.entitlement.exp /
 * .status), never by re-hitting the Hub — the signature was already verified by
 * entitlementRefresh/packageLoader when the grant was persisted. This keeps the
 * request path offline-safe: a lapsed entitlement deactivates the module without
 * any network dependency.
 */

'use strict';

const semver = require('../utils/semver');

// Lazy requires (cycle-safety + test require.cache overrides).
let _catalog, _hubClient, _store;
function catalog() { return _catalog || (_catalog = require('./catalog')); }
function hubClient() { return _hubClient || (_hubClient = require('./hubClient')); }
function store() { return _store || (_store = require('../stores/platformModuleStore')); }

/** True when a platform_modules row represents a Hub-downloaded (remote) module. */
function isRemoteRow(row) {
    return !!(row && row.settings && row.settings.remote === true);
}

/** Coerce a stored exp (unix seconds, ms, or ISO string) to epoch ms, or null. */
function _expMs(exp) {
    if (exp == null) return null;
    if (typeof exp === 'number' && Number.isFinite(exp)) {
        return exp < 1e12 ? exp * 1000 : exp; // seconds vs ms heuristic
    }
    const t = Date.parse(String(exp));
    return Number.isFinite(t) ? t : null;
}

// Bounded grace for a grant that FAILED re-verification ('invalid'): a licence
// replacement or hub key rotation legitimately invalidates old grants for a
// while — 24h to recover, then fail closed. Overridable per install.
const DEFAULT_INVALID_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Timestamp-only entitlement state for a remote row. FAIL-CLOSED on any stored
 * status other than 'active': a status the runtime doesn't recognise must never
 * keep a module running just because its exp is in the future.
 * @returns {{ state:string, active:boolean, exp:(number|null) }}
 */
function entitlementState(row, { now = Date.now(), graceMs = 0, graceInvalidMs = DEFAULT_INVALID_GRACE_MS } = {}) {
    const ent = row && row.settings && row.settings.entitlement;
    if (!ent) return { state: 'none', active: false, exp: null };
    if (ent.status === 'revoked') return { state: 'revoked', active: false, exp: null };
    if (ent.status && ent.status !== 'active') {
        if (ent.status === 'invalid') {
            const since = _expMs(ent.invalidSince);
            if (since != null && now <= since + graceInvalidMs) {
                return { state: 'grace', active: true, exp: _expMs(ent.exp) };
            }
        }
        // exp kept for diagnostics/UI — it plays no part in the decision.
        return { state: String(ent.status), active: false, exp: _expMs(ent.exp) };
    }

    const expMs = _expMs(ent.exp);
    if (expMs == null) return { state: 'active', active: true, exp: null }; // free / one_time
    if (now <= expMs) return { state: 'active', active: true, exp: expMs };
    if (now <= expMs + graceMs) return { state: 'grace', active: true, exp: expMs };
    return { state: 'expired', active: false, exp: expMs };
}

/** Convenience boolean for the runtime activation check. */
function isEntitled(row, opts = {}) {
    return entitlementState(row, opts).active;
}

/**
 * Reconstruct a catalog-entry-shaped object from a remote platform_modules row,
 * so modules/index.js can project it like a built-in entry. Returns null for a
 * non-remote row.
 */
function entryFromRow(row) {
    if (!isRemoteRow(row)) return null;
    const s = row.settings || {};
    const m = s.manifest || {};
    const version = row.version || m.version || (s.package && s.package.version) || null;
    const capabilityIds = Array.isArray(m.capabilities)
        ? m.capabilities.map(c => (c && c.id) || null).filter(Boolean)
        : [];
    return {
        id: row.moduleId,
        name: m.name || row.moduleId,
        description: m.description || '',
        category: m.category || 'Modules',
        icon: m.icon || 'box',
        version,
        available: true,
        defaultImported: false,   // remote modules are NEVER grandfathered-on
        remote: true,
        capabilityIds,
        // Remote modules own their schema via the host API (hostApi.db) at
        // activate time — they never use the host storeModules migration loop.
        storeModules: [],
        requirements: (m.requirements && typeof m.requirements === 'object') ? m.requirements : {},
        frontend: m.frontend || null,
        manifest: m,
        entitlement: s.entitlement || null,
        latestVersion: s.latestVersion || null,
    };
}

/** True when the Hub advertises a newer version than the installed one. */
function updateAvailable(row, latestVersion = null) {
    const installed = row && (row.version || (row.settings && row.settings.package && row.settings.package.version));
    const latest = latestVersion || (row && row.settings && row.settings.latestVersion);
    if (!installed || !latest) return false;
    return semver.compare(latest, installed) > 0;
}

/**
 * Server-side pricing derivation (review F13): the SPA renders this typed
 * object verbatim instead of hand-building pricing from prices[]. Headline =
 * the first ACTIVE, NON-TRIAL price; a module with only trial prices derives
 * no headline (trials are reserved for 3.2).
 */
function derivePricing(prices) {
    const list = Array.isArray(prices) ? prices : [];
    const p = list.find(x => x && x.kind !== 'trial' && (x.active === undefined || x.active === true));
    if (!p) return null;
    const amount = Number(p.unit_amount ?? p.amount ?? 0) || 0;
    if (p.kind === 'subscription' || p.billing_interval) {
        return { type: 'subscription', amount, currency: p.currency || 'eur', interval: p.billing_interval || 'month' };
    }
    if (amount === 0 || p.kind === 'free') return { type: 'free', amount: 0, currency: p.currency || 'eur', interval: null };
    return { type: 'one_time', amount, currency: p.currency || 'eur', interval: null };
}

/**
 * Policy-aware update resolution: the highest non-yanked candidate on the
 * install's chosen channel that satisfies its version pin. Falls back to the
 * hub's flat latest_version against a v1 hub (no per-version channel data).
 * @returns {string|null} the target version, or null when up to date.
 */
function resolveUpdateTarget(hm, installedVersion, updatePolicy) {
    if (!installedVersion) return null;
    const policy = updatePolicy || {};
    const channel = policy.channel === 'beta' ? 'beta' : 'stable';
    const pin = policy.pin === 'major' || policy.pin === 'minor' ? policy.pin : 'none';

    let candidates = [];
    if (Array.isArray(hm.versions) && hm.versions.length) {
        candidates = hm.versions
            .filter(v => v && v.version && !v.yanked)
            .filter(v => (v.channel || 'stable') === channel || (v.channel || 'stable') === 'stable')
            .map(v => v.version);
    } else if (hm.channels && (hm.channels[channel] || hm.channels.stable)) {
        candidates = [hm.channels[channel], hm.channels.stable].filter(Boolean);
    } else if (hm.latest_version) {
        candidates = [hm.latest_version]; // v1 hub fallback
    }
    const best = candidates
        .filter(v => semver.compare(v, installedVersion) > 0)
        .filter(v => pin === 'none'
            || (pin === 'major' && semver.sameMajor(v, installedVersion))
            || (pin === 'minor' && semver.sameMinor(v, installedVersion)))
        .sort((a, b) => semver.compare(b, a))[0];
    return best || null;
}

/** Project one Hub catalog entry + optional local row into a marketplace row. */
function marketplaceRow(hm, row, { now = Date.now(), graceMs = 0, graceInvalidMs = DEFAULT_INVALID_GRACE_MS } = {}) {
    const ent = entitlementState(row, { now, graceMs, graceInvalidMs });
    const installedVersion = row ? (row.version || (row.settings && row.settings.package && row.settings.package.version) || null) : null;
    const rowStatus = row ? row.status : null; // 'imported' | 'removed' | null
    const updatePolicy = (row && row.settings && row.settings.updatePolicy) || { channel: 'stable', pin: 'none' };
    const updateTarget = resolveUpdateTarget(hm, installedVersion, updatePolicy);
    return {
        id: hm.module_id,
        name: hm.name || hm.module_id,
        description: hm.description || '',
        category: hm.category || 'Modules',
        icon: hm.icon || 'box',
        vendor: hm.vendor || null,
        latestVersion: hm.latest_version || null,
        minProductVersion: hm.min_product_version || null,
        prices: Array.isArray(hm.prices) ? hm.prices : [],
        pricing: derivePricing(hm.prices),
        channels: hm.channels || null,
        installCount: hm.install_count == null ? null : Number(hm.install_count),
        installed: !!row && rowStatus === 'imported',
        installedVersion,
        source: (row && row.settings && row.settings.source) || 'hub',
        status: rowStatus || 'available',
        entitled: ent.active,
        entitlement: ent,
        updatePolicy,
        updateAvailable: !!updateTarget,
        updateTarget,
    };
}

/**
 * Join the Hub catalog (cached) with local install state. Hub entries whose id
 * collides with a BUILT-IN catalog id are dropped — a built-in module always
 * wins its slug. Returns `stale:true` when served from the last-good cache.
 */
async function listMarketplace({ q = '', category = '', cursor = '', limit = 0, now = Date.now(), graceMs = 0, graceInvalidMs = DEFAULT_INVALID_GRACE_MS } = {}) {
    const builtInIds = new Set(catalog().listModules().map(m => m.id));
    const { modules: hubModules, nextCursor, stale } = await hubClient().fetchCatalogCached({ q, category, cursor, limit });

    let rows = [];
    try { rows = await store().getAllStates(); } catch (_) { rows = []; }
    const rowById = new Map(rows.map(r => [r.moduleId, r]));

    const out = [];
    for (const hm of (hubModules || [])) {
        if (!hm || !hm.module_id) continue;
        if (builtInIds.has(hm.module_id)) continue;
        out.push(marketplaceRow(hm, rowById.get(hm.module_id) || null, { now, graceMs, graceInvalidMs }));
    }
    return { modules: out, nextCursor: nextCursor || null, stale: !!stale };
}

module.exports = {
    isRemoteRow,
    entryFromRow,
    entitlementState,
    isEntitled,
    updateAvailable,
    derivePricing,
    resolveUpdateTarget,
    marketplaceRow,
    listMarketplace,
    DEFAULT_INVALID_GRACE_MS,
};
