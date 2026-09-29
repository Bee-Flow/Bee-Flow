// @typecheck
'use strict';
/**
 * Process-wide registry: custom type id → the type an org saved.
 *
 * A custom type travels as a category id in the lists every scan already
 * passes to detectPii, so a scan knows only the id. This is where the id is
 * turned back into a matcher, a placeholder key and a display name.
 *
 * Who fills it: resolveOrgShield (every runtime read of an org shield) and the
 * Privacy Shield save route. Nobody else writes; everybody may read.
 *
 *   - An id removed from an org stays resolvable for TOMBSTONE_MS, so a scan
 *     that started with the old list, or a token minted a minute ago, still
 *     finds its type.
 *   - An id nobody registered triggers refreshAll (all org shields, at most
 *     once per REFRESH_MIN_MS). Still unknown after that, a scan reports it
 *     degraded (`custom_type_unknown`); it is never silently skipped.
 *   - An id is owned by ONE org. When two orgs both list the same id (a
 *     copied id; the save route refuses one it can see is taken) the id
 *     resolves to NOTHING for as long as both claim it: a scan reports it
 *     degraded rather than run one org's matcher for the other. The id alone
 *     must never select another org's data.
 */

const { sha256, isCustomTypeId } = require('./ids');
const { specDigest, typesDigest, normKey } = require('./spec');
const log = require('../../../telemetry/log');

const TOMBSTONE_MS = 10 * 60_000;
const REFRESH_MIN_MS = 30_000;
/** Placeholder key for an id nobody can resolve any more (reserved: no type can take it). */
const FALLBACK_TOKEN_KEY = 'custom';
const FALLBACK_NAME = 'Custom data';

/** @type {Map<string, { orgId: string, type: any, digest: string, order: number, tombstoneUntil: number }>} */
const _entries = new Map();
/** @type {Map<string, { digest: string, ids: Set<string>, claimed: Set<string> }>} */
const _orgs = new Map();
/** id → the orgs whose last sync listed it */
const _claims = new Map();
/** normalised tokenKey → number of live entries using it */
const _tokenKeys = new Map();
let _lastRefresh = 0;
/** @type {Promise<boolean>|null} */
let _refreshing = null;

function _countKey(type, delta) {
    const k = normKey(type?.tokenKey);
    if (!k) return;
    const n = (_tokenKeys.get(k) || 0) + delta;
    if (n > 0) _tokenKeys.set(k, n); else _tokenKeys.delete(k);
}

function _drop(id) {
    const e = _entries.get(id);
    if (!e) return;
    _countKey(e.type, -1);
    _entries.delete(id);
}

/**
 * The entry for an id, or null. Expired tombstones are dropped here.
 * @param {string} id
 */
function lookup(id) {
    const e = _entries.get(id);
    if (!e) return null;
    if (e.tombstoneUntil && Date.now() > e.tombstoneUntil) { _drop(id); return null; }
    const claims = _claims.get(id);
    if (claims && claims.size > 1) return null;
    // A tombstone of an org that no longer lists the id, while another org
    // now does: that org takes over on its next sync, until then nobody has it.
    if (e.tombstoneUntil && claims && claims.size && !claims.has(e.orgId)) return null;
    return e;
}

/** Is everything an org listed registered to it (or waiting on a conflict)? */
function _settled(orgId, cur) {
    for (const id of cur.claimed) {
        const claims = _claims.get(id);
        if (claims && claims.size > 1) continue;
        const e = _entries.get(id);
        if (!e || e.orgId !== orgId || e.tombstoneUntil) return false;
    }
    return true;
}

/**
 * Replace what an org has registered. Cheap when nothing changed (one digest
 * compare), which matters: resolveOrgShield calls this on every request.
 *
 * @param {string} orgId
 * @param {any[]} types  the ENFORCED types, in definition order
 * @returns {boolean} whether anything changed
 */
function syncOrg(orgId, types) {
    if (!orgId) return false;
    const list = (Array.isArray(types) ? types : []).filter(t => t && isCustomTypeId(t.id));
    const digest = typesDigest(list);
    const cur = _orgs.get(orgId);
    if (cur && cur.digest === digest && _settled(orgId, cur)) return false;

    const listed = new Set(list.map(t => t.id));
    // Claims first, so a conflict is visible whichever org synced first.
    if (cur) {
        for (const id of cur.claimed) {
            if (listed.has(id)) continue;
            const c = _claims.get(id);
            if (c) { c.delete(orgId); if (!c.size) _claims.delete(id); }
        }
    }
    for (const id of listed) {
        if (!_claims.has(id)) _claims.set(id, new Set());
        /** @type {Set<string>} */ (_claims.get(id)).add(orgId);
    }

    const ids = new Set();
    list.forEach((type, order) => {
        const existing = _entries.get(type.id);
        // A live entry of another org is never overwritten (its tombstone,
        // which only serves that org's in-flight scans, may be).
        if (existing && existing.orgId !== orgId && !existing.tombstoneUntil) {
            log.warn(`[CustomTypes] type ${type.id} is listed by two organisations (org=${orgId} and another); it resolves to nothing until one removes it`);
            return;
        }
        if (existing) _countKey(existing.type, -1);
        _entries.set(type.id, { orgId, type, digest: specDigest(type), order, tombstoneUntil: 0 });
        _countKey(type, 1);
        ids.add(type.id);
    });
    if (cur) {
        const until = Date.now() + TOMBSTONE_MS;
        for (const id of cur.ids) {
            if (ids.has(id)) continue;
            const e = _entries.get(id);
            if (e && e.orgId === orgId && !e.tombstoneUntil) e.tombstoneUntil = until;
        }
    }
    _orgs.set(orgId, { digest, ids, claimed: listed });
    if (list.some(t => t.method === 'pattern' && t.pattern?.engine === 'v8-legacy')) {
        require('./legacyRunner').prewarm();
    }
    return true;
}

/** @param {string} id */
function tokenKeyFor(id) {
    return lookup(id)?.type?.tokenKey || FALLBACK_TOKEN_KEY;
}

/** @param {string} id */
function displayNameFor(id) {
    return lookup(id)?.type?.name || FALLBACK_NAME;
}

/** @param {string} id */
function methodFor(id) {
    return lookup(id)?.type?.method || null;
}

/**
 * Which org owns an id, as far as this process knows (tombstones included:
 * an id an org removed a minute ago is still its own).
 * @param {string} id
 */
function ownerOf(id) {
    const e = _entries.get(id);
    if (e && !(e.tombstoneUntil && Date.now() > e.tombstoneUntil)) return e.orgId;
    const claims = _claims.get(id);
    return claims && claims.size ? [...claims][0] : null;
}

/** Do two orgs list this id (so it resolves to nothing on purpose)? */
function isConflicted(id) {
    const claims = _claims.get(id);
    return !!claims && claims.size > 1;
}

/** Is this (normalised) placeholder key used by any registered type? */
function isCustomTokenKey(key) {
    const k = normKey(key);
    return !!k && (_tokenKeys.has(k) || k === normKey(FALLBACK_TOKEN_KEY));
}

/**
 * Digest of the specs behind a list of ids: the part of a scan's cache key
 * that changes when an admin edits a type (a word added, a pattern fixed).
 * @param {string[]} categories  may also hold built-in ids; they are ignored
 */
function digestFor(categories) {
    const ids = [...new Set((Array.isArray(categories) ? categories : []).filter(isCustomTypeId))].sort();
    if (!ids.length) return '';
    // Same material as plan.js planScan's digest, so both name one spec alike.
    return sha256(ids.map((id) => {
        const e = lookup(id);
        return e ? `${id}:${e.digest}:${e.order}` : `${id}:unknown`;
    }).join(',')).slice(0, 16);
}

/**
 * Re-read every org shield (which re-syncs each org through
 * resolveOrgShield). At most once per REFRESH_MIN_MS; concurrent callers
 * share one run.
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<boolean>} whether a refresh ran
 */
async function refreshAll({ force = false } = {}) {
    if (_refreshing) return _refreshing;
    if (!force && Date.now() - _lastRefresh < REFRESH_MIN_MS) return false;
    _lastRefresh = Date.now();
    _refreshing = (async () => {
        try {
            const configStore = require('../../../stores/configStore');
            const { resolveOrgShield } = require('../orgShield');
            const prefix = 'org_privacy_shield_';
            const keys = typeof configStore.listKeysWithPrefix === 'function'
                ? await configStore.listKeysWithPrefix(prefix)
                : Object.keys(await configStore.getAllConfig() || {}).filter(k => k.startsWith(prefix));
            for (const key of keys) {
                try { await resolveOrgShield(key.slice(prefix.length)); } catch (_) { /* one bad row must not stop the rest */ }
            }
            return true;
        } catch (err) {
            log.warn('[CustomTypes] registry refresh failed:', err.message);
            return false;
        } finally {
            _refreshing = null;
        }
    })();
    return _refreshing;
}

/** Test seam: forget everything. */
function _resetRegistry() {
    _entries.clear();
    _orgs.clear();
    _claims.clear();
    _tokenKeys.clear();
    _lastRefresh = 0;
    _refreshing = null;
}

module.exports = {
    syncOrg,
    lookup,
    tokenKeyFor,
    displayNameFor,
    methodFor,
    ownerOf,
    isConflicted,
    isCustomTokenKey,
    digestFor,
    refreshAll,
    _resetRegistry,
    TOMBSTONE_MS,
    REFRESH_MIN_MS,
    FALLBACK_TOKEN_KEY,
    FALLBACK_NAME,
};
