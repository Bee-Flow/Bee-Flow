// @typecheck
/**
 * In-memory index of the model price catalogue (table `model_price_catalog`).
 *
 * Pure and dependency-free on purpose (only the logger): modelCosts sits on the
 * cost path of every LLM call and is required from tests that must not open a
 * database connection. The database side lives in stores/modelPriceCatalogStore.js,
 * which loads the rows and hands them to `setRows` at boot, after every change
 * and whenever the registered refresher says the snapshot is stale (a save on
 * another replica arrives that way, the same idea as modelCosts' override snapshot).
 *
 * A row is one price card for (provider, model_id, tier) that is valid for the
 * half-open interval [valid_from, valid_to). Rows are append-only: a changed rate
 * becomes a NEW row with a later valid_from, an old row is never edited, so a call
 * made last month is still rated with last month's card. Future-dated rows are
 * allowed (a price step-up announced for 2027-01-01, a promo that ends); they are
 * simply invisible to every lookup whose `at` lies before their valid_from.
 *
 * Units: rates are `currency` per 1,000,000 tokens (for the row's own currency;
 * Scaleway quotes EUR and is stored as EUR, never round-tripped through USD).
 *
 * Provider vocabulary (the adapter types): claude, openai, azure, google,
 * google-vertex, mistral, scaleway, ionos, eugpt, elevenlabs. 'local' never has rows:
 * a self-hosted model is priced at zero before any lookup.
 *
 * Trust: rows come from an import job that fetches third-party data, so the
 * index re-validates every row it is given and DROPS a bad one instead of
 * throwing (one poisoned row must not take the whole catalogue, or the cost path,
 * down). Only a whitelist of fields is copied, numbers must be finite and inside
 * a plausibility band, and every map is built without a prototype.
 */

'use strict';

const log = require('../../telemetry/log');

const { KNOWN_TIERS, normalizeProvider, normalizeTier, validateRow } = require('./priceCatalogRow');

// ─── The index ───────────────────────────────────────────────────────────────

/** `${provider}|${model}|${tier}` -> rows sorted by validFromMs ascending. */
let _byKey = new Map();
/** lower-cased model id -> Set of providers that have rows for it. */
let _providersByModel = new Map();
let _count = 0;
let _loadedAt = 0;
let _refresher = null;
let _refreshTtlMs = 5 * 60_000;
/** @type {Promise<boolean> | null} */
let _refreshing = null;

/**
 * @param {string} model
 * @param {string} tier
 */
const _key = (provider, model, tier) => `${provider}|${String(model).toLowerCase()}|${tier}`;

/**
 * Replace the whole snapshot. Invalid rows are dropped (and counted in the
 * warning), never thrown on.
 * @param {any[]} rows
 * @returns {{ loaded: number, dropped: number }}
 */
function setRows(rows) {
    const byKey = new Map();
    const providers = new Map();
    let loaded = 0;
    let dropped = 0;
    for (const raw of Array.isArray(rows) ? rows : []) {
        const v = validateRow(raw);
        if (!v.row) { dropped += 1; continue; }
        const row = Object.freeze(v.row);
        const k = _key(row.provider, row.model_id, row.tier);
        let list = byKey.get(k);
        if (!list) { list = []; byKey.set(k, list); }
        list.push(row);
        const lc = row.model_id.toLowerCase();
        let set = providers.get(lc);
        if (!set) { set = new Set(); providers.set(lc, set); }
        set.add(row.provider);
        loaded += 1;
    }
    for (const list of byKey.values()) {
        // Stable: later valid_from last; equal starts keep insertion (id) order.
        list.sort((a, b) => a.validFromMs - b.validFromMs);
    }
    _byKey = byKey;
    _providersByModel = providers;
    _count = loaded;
    _loadedAt = Date.now();
    if (dropped > 0) log.warn(`[PriceCatalog] dropped ${dropped} invalid catalogue row(s) while loading`);
    return { loaded, dropped };
}

function clear() {
    _byKey = new Map();
    _providersByModel = new Map();
    _count = 0;
    _loadedAt = 0;
}

/**
 * Register how to re-read the rows (the store does this at init). A lookup that
 * finds the snapshot older than `ttlMs` asks for a refresh in the background and
 * answers from what it has; a failed refresh keeps the last good snapshot.
 * @param {number} [ttlMs]
 */
function setRefresher(fn, ttlMs = 5 * 60_000) {
    _refresher = typeof fn === 'function' ? fn : null;
    _refreshTtlMs = ttlMs;
}

function refreshNow() {
    if (!_refresher) return Promise.resolve(false);
    if (_refreshing) return _refreshing;
    _refreshing = Promise.resolve()
        .then(() => _refresher())
        .then((rows) => { setRows(rows); return true; })
        .catch((e) => { log.warn(`[PriceCatalog] refresh failed, keeping the last snapshot: ${e && e.message}`); return false; })
        .finally(() => { _refreshing = null; });
    return _refreshing;
}

function _maybeRefresh() {
    if (_refresher && !_refreshing && Date.now() - _loadedAt > _refreshTtlMs) refreshNow();
}

/**
 * @param {string | number | Date | undefined} at
 */
function toMs(at) {
    if (at === null || at === undefined || at === '') return Date.now();
    const ms = at instanceof Date ? at.getTime() : (typeof at === 'number' ? at : Date.parse(String(at)));
    return Number.isFinite(ms) ? ms : Date.now();
}

/**
 * The row in force at `at` for exactly (provider, model, tier): the one with the
 * latest valid_from among those with valid_from <= at < valid_to.
 *
 * @param {{ provider: string, model: string, tier?: string, at?: Date|number|string }} q
 * @returns {any|null}
 */
function lookup({ provider, model, tier = 'standard', at } = /** @type {{ provider: string, model: string, tier?: string, at?: Date|number|string }} */ ({})) {
    if (!model) return null;
    _maybeRefresh();
    const p = normalizeProvider(provider);
    const t = normalizeTier(tier);
    if (!p || !t) return null;
    const list = _byKey.get(_key(p, model, t));
    if (!list) return null;
    const ms = toMs(at);
    for (let i = list.length - 1; i >= 0; i--) {
        const r = list[i];
        if (r.validFromMs <= ms && ms < r.validToMs) return r;
    }
    return null;
}

/**
 * Providers that have any row for this model id (any time, any tier).
 * @param {string} model
 */
function providersFor(model) {
    if (!model) return [];
    return [...(_providersByModel.get(String(model).toLowerCase()) || [])];
}

/**
 * Every standard-tier row in force at `at`, one per (provider, model): the donor
 * pool for modelCosts' estimate of a model nothing prices. Rows are frozen
 * and already validated, so the caller may read them freely.
 * @param {{ at?: Date|number|string }} [q]
 * @returns {any[]}
 */
function listActive({ at } = {}) {
    _maybeRefresh();
    const ms = toMs(at);
    const out = [];
    for (const [k, list] of _byKey) {
        if (!k.endsWith('|standard')) continue;
        for (let i = list.length - 1; i >= 0; i--) {
            const r = list[i];
            if (r.validFromMs <= ms && ms < r.validToMs) { out.push(r); break; }
        }
    }
    return out;
}

/** Snapshot size and age, for admin/diagnostics. */
function stats() {
    return { rows: _count, loadedAt: _loadedAt || null };
}

module.exports = {
    KNOWN_TIERS,
    normalizeProvider,
    normalizeTier,
    validateRow,
    setRows,
    clear,
    setRefresher,
    refreshNow,
    lookup,
    providersFor,
    listActive,
    stats,
    toMs,
};
