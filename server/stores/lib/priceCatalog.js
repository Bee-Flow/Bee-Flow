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
 * google-vertex, mistral, scaleway, eugpt, elevenlabs. 'local' never has rows:
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

/** Upper plausibility bound for a per-1M-token rate (no model costs a million per million). */
const MAX_RATE_PER_MTOK = 1_000_000;
/** Multipliers outside (0, MAX_MULTIPLIER] are rejected. */
const MAX_MULTIPLIER = 100;
/** A long-context threshold is a token count. */
const MAX_THRESHOLD_TOKENS = 100_000_000;

const KNOWN_TIERS = Object.freeze(['standard', 'batch', 'flex', 'priority']);
const TIER_MULTIPLIER_KEYS = Object.freeze(['batch', 'flex', 'priority']);
const LONG_CTX_RATE_KEYS = Object.freeze(['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h']);
const IDENT = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const MODEL_ID = /^[^\s\u0000-\u001f]{1,200}$/;
const CURRENCY = /^[A-Z]{3}$/;
const OPEN_ENDED = Number.POSITIVE_INFINITY;
/** The epoch: "valid since forever" for a row without a start date. */
const EPOCH_MS = 0;

const PROVIDER_ALIASES = Object.freeze({
    anthropic: 'claude',
    claude: 'claude',
    openai: 'openai',
    azure: 'azure',
    'azure-openai': 'azure',
    azure_openai: 'azure',
    google: 'google',
    gemini: 'google',
    'google-vertex': 'google-vertex',
    vertex: 'google-vertex',
    vertex_ai: 'google-vertex',
    mistral: 'mistral',
    scaleway: 'scaleway',
    eugpt: 'eugpt',
    elevenlabs: 'elevenlabs',
});

/** Adapter type for any spelling a caller or a source uses; null when it is not a provider we price. */
function normalizeProvider(raw) {
    if (typeof raw !== 'string') return null;
    const key = raw.trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(PROVIDER_ALIASES, key) ? PROVIDER_ALIASES[key] : null;
}

function normalizeTier(raw) {
    const t = typeof raw === 'string' ? raw.trim().toLowerCase() : 'standard';
    return KNOWN_TIERS.includes(t) ? t : null;
}

function _rate(v, { allowNull = true } = {}) {
    if (v === null || v === undefined || v === '') return allowNull ? null : NaN;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > MAX_RATE_PER_MTOK) return NaN;
    return n;
}

function _multiplier(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n <= MAX_MULTIPLIER ? n : NaN;
}

const BROKEN_JSON = Symbol('broken json');

/** A JSON column: already parsed (jsonb through node-postgres) or still text. */
function _json(v) {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return BROKEN_JSON; }
}

function _ms(v, fallback) {
    if (v === null || v === undefined || v === '') return fallback;
    const ms = v instanceof Date ? v.getTime() : Date.parse(String(v));
    return Number.isFinite(ms) ? ms : NaN;
}

/**
 * Validate one raw row (a database row, or what an importer wants to insert) and
 * return the cleaned card, or `{ error }` naming the first problem.
 *
 * @param {any} raw
 * @returns {{ row?: any, error?: string }}
 */
function validateRow(raw) {
    if (!raw || typeof raw !== 'object') return { error: 'row is not an object' };
    const provider = normalizeProvider(raw.provider);
    if (!provider) return { error: 'unknown provider' };
    const modelId = typeof raw.model_id === 'string' ? raw.model_id.trim() : '';
    if (!MODEL_ID.test(modelId)) return { error: 'invalid model_id' };
    const tier = normalizeTier(raw.tier == null ? 'standard' : raw.tier);
    if (!tier) return { error: 'unknown tier' };
    const currency = String(raw.currency == null ? 'USD' : raw.currency).toUpperCase();
    if (!CURRENCY.test(currency)) return { error: 'invalid currency' };

    const input = _rate(raw.input, { allowNull: false });
    const output = _rate(raw.output, { allowNull: false });
    if (Number.isNaN(input) || Number.isNaN(output)) return { error: 'input/output must be finite non-negative rates' };
    const cacheRead = _rate(raw.cache_read);
    const cacheWrite5m = _rate(raw.cache_write_5m);
    const cacheWrite1h = _rate(raw.cache_write_1h);
    if ([cacheRead, cacheWrite5m, cacheWrite1h].some(Number.isNaN)) return { error: 'invalid cache rate' };

    const validFromMs = _ms(raw.valid_from, EPOCH_MS);
    const validToMs = _ms(raw.valid_to, OPEN_ENDED);
    if (Number.isNaN(validFromMs) || Number.isNaN(validToMs)) return { error: 'invalid validity date' };
    if (validToMs <= validFromMs) return { error: 'valid_to must be after valid_from' };

    // Long context: a threshold and the rates above it, together or not at all.
    let longCtxThreshold = null;
    let longCtxRates = null;
    if (raw.long_ctx_threshold !== null && raw.long_ctx_threshold !== undefined && raw.long_ctx_threshold !== '') {
        const th = Number(raw.long_ctx_threshold);
        if (!Number.isFinite(th) || th <= 0 || th > MAX_THRESHOLD_TOKENS) return { error: 'invalid long_ctx_threshold' };
        longCtxThreshold = Math.floor(th);
        const lr = _json(raw.long_ctx_rates);
        if (lr === BROKEN_JSON || !lr || typeof lr !== 'object' || Array.isArray(lr)) return { error: 'long_ctx_threshold needs long_ctx_rates' };
        longCtxRates = Object.create(null);
        for (const k of LONG_CTX_RATE_KEYS) {
            if (!Object.prototype.hasOwnProperty.call(lr, k) || lr[k] == null) continue;
            const v = _rate(lr[k]);
            if (Number.isNaN(v)) return { error: `invalid long_ctx_rates.${k}` };
            longCtxRates[k] = v;
        }
        if (longCtxRates.input === undefined && longCtxRates.output === undefined) return { error: 'long_ctx_rates needs input or output' };
    }

    // Multipliers: whitelisted keys only, geo is a map of identifier -> factor.
    let multipliers = null;
    const mRaw = _json(raw.multipliers);
    if (mRaw !== null && mRaw !== undefined) {
        if (mRaw === BROKEN_JSON || typeof mRaw !== 'object' || Array.isArray(mRaw)) return { error: 'multipliers must be an object' };
        multipliers = Object.create(null);
        for (const k of TIER_MULTIPLIER_KEYS) {
            if (!Object.prototype.hasOwnProperty.call(mRaw, k) || mRaw[k] == null) continue;
            const v = _multiplier(mRaw[k]);
            if (Number.isNaN(v)) return { error: `invalid multipliers.${k}` };
            multipliers[k] = v;
        }
        if (Object.prototype.hasOwnProperty.call(mRaw, 'regional') && mRaw.regional != null) {
            const v = _multiplier(mRaw.regional);
            if (Number.isNaN(v)) return { error: 'invalid multipliers.regional' };
            multipliers.regional = v;
        }
        if (Object.prototype.hasOwnProperty.call(mRaw, 'geo') && mRaw.geo != null) {
            const geo = mRaw.geo;
            if (typeof geo !== 'object' || Array.isArray(geo)) return { error: 'multipliers.geo must be an object' };
            const out = Object.create(null);
            const keys = Object.keys(geo);
            if (keys.length > 16) return { error: 'multipliers.geo has too many keys' };
            for (const g of keys) {
                if (!IDENT.test(g)) return { error: 'invalid multipliers.geo key' };
                const v = _multiplier(geo[g]);
                if (Number.isNaN(v)) return { error: `invalid multipliers.geo.${g}` };
                out[g] = v;
            }
            multipliers.geo = out;
        }
    }

    const source = typeof raw.source === 'string' ? raw.source.trim().slice(0, 64) : '';
    if (!source || !/^[\x20-\x7e]+$/.test(source)) return { error: 'invalid source' };
    const catalogVersion = typeof raw.catalog_version === 'string' ? raw.catalog_version.trim().slice(0, 64) : '';
    if (!catalogVersion || !/^[\x20-\x7e]+$/.test(catalogVersion)) return { error: 'invalid catalog_version' };

    return {
        row: {
            id: raw.id == null ? null : raw.id,
            provider,
            model_id: modelId,
            tier,
            currency,
            input,
            output,
            cache_read: cacheRead,
            cache_write_5m: cacheWrite5m,
            cache_write_1h: cacheWrite1h,
            long_ctx_threshold: longCtxThreshold,
            long_ctx_rates: longCtxRates,
            multipliers,
            source,
            catalog_version: catalogVersion,
            valid_from: new Date(validFromMs).toISOString(),
            valid_to: validToMs === OPEN_ENDED ? null : new Date(validToMs).toISOString(),
            validFromMs,
            validToMs,
        },
    };
}

// ─── The index ───────────────────────────────────────────────────────────────

/** `${provider}|${model}|${tier}` -> rows sorted by validFromMs ascending. */
let _byKey = new Map();
/** lower-cased model id -> Set of providers that have rows for it. */
let _providersByModel = new Map();
let _count = 0;
let _loadedAt = 0;
let _refresher = null;
let _refreshTtlMs = 5 * 60_000;
let _refreshing = null;

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
 * @returns {object|null}
 */
function lookup({ provider, model, tier = 'standard', at } = /** @type {any} */ ({})) {
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

/** Providers that have any row for this model id (any time, any tier). */
function providersFor(model) {
    if (!model) return [];
    return [...(_providersByModel.get(String(model).toLowerCase()) || [])];
}

/**
 * Every standard-tier row in force at `at`, one per (provider, model): the donor
 * pool for modelCosts' estimate of a model nothing prices. Rows are frozen
 * and already validated, so the caller may read them freely.
 * @param {{ at?: Date|number|string }} [q]
 * @returns {object[]}
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
