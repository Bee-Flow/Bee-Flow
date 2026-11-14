// @typecheck strict
/**
 * One row of the model price catalogue, validated (priceCatalog.js explains
 * the catalogue). Rows come from an import job that fetches third-party data,
 * so every field is checked here: only a whitelist of fields is copied,
 * numbers must be finite and inside a plausibility band, and every map is
 * built without a prototype. A bad row is `{ error }`, never a throw.
 */

'use strict';

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
    ionos: 'ionos',
    eugpt: 'eugpt',
    elevenlabs: 'elevenlabs',
});

/**
 * Adapter type for any spelling a caller or a source uses; null when it is not a provider we price.
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeProvider(raw) {
    if (typeof raw !== 'string') return null;
    const key = raw.trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(PROVIDER_ALIASES, key) ? /** @type {Record<string, string>} */ (PROVIDER_ALIASES)[key] : null;
}

/**
 * @param {unknown} raw
 */
function normalizeTier(raw) {
    const t = typeof raw === 'string' ? raw.trim().toLowerCase() : 'standard';
    return KNOWN_TIERS.includes(t) ? t : null;
}

/**
 * A per-1M-token rate inside the plausibility band; NaN refuses, null is "not set" where allowed.
 * @param {unknown} v
 * @param {{ allowNull?: boolean }} [opts]
 * @returns {number | null}
 */
function _rate(v, { allowNull = true } = {}) {
    if (v === null || v === undefined || v === '') return allowNull ? null : NaN;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > MAX_RATE_PER_MTOK) return NaN;
    return n;
}

/**
 * A factor in (0, MAX_MULTIPLIER]; NaN refuses.
 * @param {unknown} v
 */
function _multiplier(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n <= MAX_MULTIPLIER ? n : NaN;
}

const BROKEN_JSON = Symbol('broken json');

/**
 * A JSON column: already parsed (jsonb through node-postgres) or still text.
 * @param {unknown} v
 * @returns {unknown}
 */
function _json(v) {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return BROKEN_JSON; }
}

/**
 * @param {unknown} v
 * @param {number} fallback
 */
function _ms(v, fallback) {
    if (v === null || v === undefined || v === '') return fallback;
    const ms = v instanceof Date ? v.getTime() : Date.parse(String(v));
    return Number.isFinite(ms) ? ms : NaN;
}

/**
 * @typedef {{ error: string }} RowError
 * A row as the store or an importer hands it over: any field may be missing or of the wrong type.
 * @typedef {Record<string, unknown>} RawRow
 * @typedef {Record<string, number | null>} RateMap
 * @typedef {{ batch?: number, flex?: number, priority?: number, regional?: number, geo?: Record<string, number>, [k: string]: unknown }} Multipliers
 * @typedef {{ id: unknown, provider: string, model_id: string, tier: string, currency: string,
 *   input: number, output: number, cache_read: number | null, cache_write_5m: number | null, cache_write_1h: number | null,
 *   long_ctx_threshold: number | null, long_ctx_rates: RateMap | null, multipliers: Multipliers | null,
 *   source: string, catalog_version: string, valid_from: string, valid_to: string | null, validFromMs: number, validToMs: number }} PriceCard
 */

/**
 * The card's identity: provider, model id, tier and currency.
 * @param {RawRow} raw
 * @returns {RowError | { provider: string, model_id: string, tier: string, currency: string }}
 */
function _identity(raw) {
    const provider = normalizeProvider(raw.provider);
    if (!provider) return { error: 'unknown provider' };
    const modelId = typeof raw.model_id === 'string' ? raw.model_id.trim() : '';
    if (!MODEL_ID.test(modelId)) return { error: 'invalid model_id' };
    const tier = normalizeTier(raw.tier == null ? 'standard' : raw.tier);
    if (!tier) return { error: 'unknown tier' };
    const currency = String(raw.currency == null ? 'USD' : raw.currency).toUpperCase();
    if (!CURRENCY.test(currency)) return { error: 'invalid currency' };
    return { provider, model_id: modelId, tier, currency };
}

/**
 * The rates: input and output required, the cache rates optional.
 * @param {RawRow} raw
 * @returns {RowError | { input: number, output: number, cache_read: number | null, cache_write_5m: number | null, cache_write_1h: number | null }}
 */
function _rates(raw) {
    const input = _rate(raw.input, { allowNull: false });
    const output = _rate(raw.output, { allowNull: false });
    if (Number.isNaN(input) || Number.isNaN(output)) return { error: 'input/output must be finite non-negative rates' };
    const rates = { input: /** @type {number} */ (input), output: /** @type {number} */ (output), cache_read: _rate(raw.cache_read), cache_write_5m: _rate(raw.cache_write_5m), cache_write_1h: _rate(raw.cache_write_1h) };
    if ([rates.cache_read, rates.cache_write_5m, rates.cache_write_1h].some(Number.isNaN)) return { error: 'invalid cache rate' };
    return rates;
}

/**
 * The half-open validity window [valid_from, valid_to), in ms.
 * @param {RawRow} raw
 * @returns {RowError | { validFromMs: number, validToMs: number }}
 */
function _validity(raw) {
    const validFromMs = _ms(raw.valid_from, EPOCH_MS);
    const validToMs = _ms(raw.valid_to, OPEN_ENDED);
    if (Number.isNaN(validFromMs) || Number.isNaN(validToMs)) return { error: 'invalid validity date' };
    if (validToMs <= validFromMs) return { error: 'valid_to must be after valid_from' };
    return { validFromMs, validToMs };
}

/**
 * The whitelisted keys of `source` that are set, each through `check`
 * (NaN refuses), into a map without a prototype.
 * @param {Record<string, unknown>} source
 * @param {readonly string[]} keys
 * @param {(v: unknown) => number | null} check
 * @param {string} label   names the first refused key in the error
 * @returns {RowError | { map: RateMap }}
 */
function _whitelisted(source, keys, check, label) {
    const out = Object.create(null);
    for (const k of keys) {
        if (!Object.prototype.hasOwnProperty.call(source, k) || source[k] == null) continue;
        const v = check(source[k]);
        if (Number.isNaN(v)) return { error: `invalid ${label}.${k}` };
        out[k] = v;
    }
    return { map: out };
}

/**
 * Long context: a threshold and the rates above it, together or not at all.
 * @param {RawRow} raw
 * @returns {RowError | { threshold: number | null, rates: RateMap | null }}
 */
function _longContext(raw) {
    if (raw.long_ctx_threshold === null || raw.long_ctx_threshold === undefined || raw.long_ctx_threshold === '') return { threshold: null, rates: null };
    const th = Number(raw.long_ctx_threshold);
    if (!Number.isFinite(th) || th <= 0 || th > MAX_THRESHOLD_TOKENS) return { error: 'invalid long_ctx_threshold' };
    const lr = _json(raw.long_ctx_rates);
    if (lr === BROKEN_JSON || !lr || typeof lr !== 'object' || Array.isArray(lr)) return { error: 'long_ctx_threshold needs long_ctx_rates' };
    const rates = _whitelisted(/** @type {Record<string, unknown>} */ (lr), LONG_CTX_RATE_KEYS, (v) => _rate(v), 'long_ctx_rates');
    if ('error' in rates) return rates;
    if (rates.map.input === undefined && rates.map.output === undefined) return { error: 'long_ctx_rates needs input or output' };
    return { threshold: Math.floor(th), rates: rates.map };
}

/**
 * The geo multipliers: a map of at most 16 identifier → factor.
 * @param {unknown} geo
 * @returns {RowError | { geo: Record<string, number> }}
 */
function _geoMultipliers(geo) {
    if (typeof geo !== 'object' || Array.isArray(geo)) return { error: 'multipliers.geo must be an object' };
    const out = Object.create(null);
    const keys = Object.keys(/** @type {Record<string, unknown>} */ (geo));
    if (keys.length > 16) return { error: 'multipliers.geo has too many keys' };
    for (const g of keys) {
        if (!IDENT.test(g)) return { error: 'invalid multipliers.geo key' };
        const v = _multiplier(/** @type {Record<string, unknown>} */ (geo)[g]);
        if (Number.isNaN(v)) return { error: `invalid multipliers.geo.${g}` };
        out[g] = v;
    }
    return { geo: out };
}

/**
 * Multipliers: whitelisted keys only, geo is a map of identifier -> factor.
 * @param {RawRow} raw
 * @returns {RowError | { multipliers: Multipliers | null }}
 */
function _multipliers(raw) {
    const mRaw = _json(raw.multipliers);
    if (mRaw === null || mRaw === undefined) return { multipliers: null };
    if (mRaw === BROKEN_JSON || typeof mRaw !== 'object' || Array.isArray(mRaw)) return { error: 'multipliers must be an object' };
    const m = /** @type {Record<string, unknown>} */ (mRaw);
    const tiers = _whitelisted(m, TIER_MULTIPLIER_KEYS, _multiplier, 'multipliers');
    if ('error' in tiers) return tiers;
    const multipliers = /** @type {Multipliers} */ (tiers.map);
    if (Object.prototype.hasOwnProperty.call(m, 'regional') && m.regional != null) {
        const v = _multiplier(m.regional);
        if (Number.isNaN(v)) return { error: 'invalid multipliers.regional' };
        multipliers.regional = v;
    }
    if (Object.prototype.hasOwnProperty.call(m, 'geo') && m.geo != null) {
        const geo = _geoMultipliers(m.geo);
        if ('error' in geo) return geo;
        multipliers.geo = geo.geo;
    }
    return { multipliers };
}

/**
 * Where the card came from: a printable source and catalogue version.
 * @param {RawRow} raw
 * @returns {RowError | { source: string, catalog_version: string }}
 */
function _provenance(raw) {
    const source = typeof raw.source === 'string' ? raw.source.trim().slice(0, 64) : '';
    if (!source || !/^[\x20-\x7e]+$/.test(source)) return { error: 'invalid source' };
    const catalogVersion = typeof raw.catalog_version === 'string' ? raw.catalog_version.trim().slice(0, 64) : '';
    if (!catalogVersion || !/^[\x20-\x7e]+$/.test(catalogVersion)) return { error: 'invalid catalog_version' };
    return { source, catalog_version: catalogVersion };
}

/**
 * Validate one raw row (a database row, or what an importer wants to insert) and
 * return the cleaned card, or `{ error }` naming the first problem (the checks
 * run in the order of the card's fields).
 *
 * @param {unknown} input
 * @returns {{ row?: PriceCard, error?: string }}
 */
function validateRow(input) {
    if (!input || typeof input !== 'object') return { error: 'row is not an object' };
    const raw = /** @type {RawRow} */ (input);
    const identity = _identity(raw);
    if ('error' in identity) return identity;
    const rates = _rates(raw);
    if ('error' in rates) return rates;
    const validity = _validity(raw);
    if ('error' in validity) return validity;
    const longCtx = _longContext(raw);
    if ('error' in longCtx) return longCtx;
    const mult = _multipliers(raw);
    if ('error' in mult) return mult;
    const provenance = _provenance(raw);
    if ('error' in provenance) return provenance;
    const { validFromMs, validToMs } = validity;
    return {
        row: {
            id: raw.id == null ? null : raw.id,
            ...identity,
            ...rates,
            long_ctx_threshold: longCtx.threshold,
            long_ctx_rates: longCtx.rates,
            multipliers: mult.multipliers,
            ...provenance,
            valid_from: new Date(validFromMs).toISOString(),
            valid_to: validToMs === OPEN_ENDED ? null : new Date(validToMs).toISOString(),
            validFromMs,
            validToMs,
        },
    };
}

module.exports = { KNOWN_TIERS, normalizeProvider, normalizeTier, validateRow };
