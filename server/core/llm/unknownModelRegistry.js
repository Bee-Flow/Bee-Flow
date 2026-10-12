// @typecheck
/**
 * Registry of models that were called but that no price source knows.
 *
 * Until now the only signal was one `log.warn` per process per model name, and the
 * call itself was billed at the most expensive rate of every model there is.
 * modelCosts now rates such a call as `cost_basis: 'unknown'` (see
 * unknownModelRate.js for the estimate) and records it here: how often it was
 * seen, when it first and last appeared, which provider it came from and what the
 * row was rated at. An admin route reads `listUnknownModels()` later; nothing here
 * writes to a database, so it is per process (a replica keeps its own list) and
 * starts empty after a restart. The authoritative per-call record is the row in
 * `ai_usage_log` (`cost_basis = 'unknown'`).
 *
 * The model name is attacker-influenced (it arrives from a request, a provider
 * listing or an admin form), so everything stored or logged is sanitised, the map
 * is bounded, and the warning is rate limited: a client that cycles through
 * random names can neither grow memory nor flood the log.
 */

const log = require('../../telemetry/log');

/** At most this many distinct (provider, model) pairs are tracked; the rest only bump `overflow`. */
const MAX_ENTRIES = 500;
const MAX_MODEL_LENGTH = 128;
/** The same model warns at most once per this interval ... */
const WARN_PER_MODEL_MS = 10 * 60_000;
/** ... and the whole registry at most this often per minute, however many names there are. */
const WARN_PER_MINUTE = 20;

const REASONS = Object.freeze(['unknown_model', 'unmapped_deployment']);
const PROVIDER = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** @type {Map<string, any>} */
const _entries = new Map();
let _overflow = 0;
let _suppressed = 0;
let _windowStart = 0;
let _windowCount = 0;

/**
 * A model id made safe to store, return from an API and write to a log line:
 * printable characters only, bounded. Empty becomes the visible marker '(none)'.
 */
function cleanModel(model) {
    const s = String(model ?? '')
        .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_MODEL_LENGTH);
    return s || '(none)';
}

function cleanProvider(provider) {
    const p = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
    return PROVIDER.test(p) ? p : null;
}

function cleanEstimate(estimate) {
    if (!estimate || typeof estimate !== 'object') return null;
    const source = typeof estimate.source === 'string' ? estimate.source.replace(/[^A-Za-z0-9._:/@+-]/g, '_').slice(0, 120) : null;
    const num = (v) => (Number.isFinite(v) ? v : null);
    return {
        source,
        input: num(estimate.input),
        output: num(estimate.output),
        currency: typeof estimate.currency === 'string' && /^[A-Z]{3}$/.test(estimate.currency) ? estimate.currency : null,
    };
}

function _mayWarn(entry, now) {
    if (entry.warnedAt && now - entry.warnedAt < WARN_PER_MODEL_MS) return false;
    if (now - _windowStart >= 60_000) { _windowStart = now; _windowCount = 0; }
    if (_windowCount >= WARN_PER_MINUTE) { _suppressed += 1; return false; }
    _windowCount += 1;
    entry.warnedAt = now;
    return true;
}

/**
 * Note one call of a model nothing could price.
 *
 * @param {{ model: string, provider?: string|null, reason?: 'unknown_model'|'unmapped_deployment',
 *           deployment?: string|null,
 *           estimate?: { source?: string, input?: number, output?: number, currency?: string }|null }} seen
 *   `estimate` is what the call was rated at (null: it could not be rated and cost 0)
 * @param {number} [now]  epoch ms (tests)
 * @returns {boolean} whether the pair is tracked (false: the registry is full)
 */
function recordUnknownModel(seen, now = Date.now()) {
    const model = cleanModel(seen && seen.model);
    const provider = cleanProvider(seen && seen.provider);
    const reason = REASONS.includes(seen && seen.reason) ? seen.reason : 'unknown_model';
    const estimate = cleanEstimate(seen && seen.estimate);
    const key = `${provider || ''}|${model}`;

    let entry = _entries.get(key);
    if (!entry) {
        if (_entries.size >= MAX_ENTRIES) { _overflow += 1; return false; }
        entry = {
            model, provider, reason, deployment: null, calls: 0, first_seen: now, last_seen: now,
            estimate: null, warnedAt: 0,
        };
        _entries.set(key, entry);
    }
    entry.calls += 1;
    entry.last_seen = now;
    entry.reason = reason;
    entry.estimate = estimate;
    if (seen && seen.deployment) entry.deployment = cleanModel(seen.deployment);

    if (_mayWarn(entry, now)) {
        const how = estimate && estimate.source
            ? `rated as an estimate (${estimate.source}, ${estimate.input}/${estimate.output} ${estimate.currency || ''} per 1M)`
            : 'no estimate possible, rated at 0';
        const extra = _suppressed > 0 ? ` (${_suppressed} further unknown-model warning(s) suppressed)` : '';
        _suppressed = 0;
        const what = reason === 'unmapped_deployment'
            ? `Azure deployment ${JSON.stringify(model)} is not mapped to a model (set it as name=model in the Azure model list)`
            : `Unknown model ${JSON.stringify(model)}${provider ? ` (provider ${provider})` : ''}`;
        log.warn(`[ModelCosts] ${what}; ${how}; add it to the pricing data or as a custom override${extra}`);
    }
    return true;
}

/**
 * The unknown models seen by this process, most recently seen first. A copy:
 * callers cannot mutate the registry. Shape is stable for the admin route.
 * @returns {Array<{ model: string, provider: string|null, reason: string, deployment: string|null,
 *                   calls: number, first_seen: string, last_seen: string,
 *                   estimate: { source: string|null, input: number|null, output: number|null, currency: string|null }|null }>}
 */
function listUnknownModels() {
    return [..._entries.values()]
        .sort((a, b) => b.last_seen - a.last_seen || b.calls - a.calls)
        .map((e) => ({
            model: e.model,
            provider: e.provider,
            reason: e.reason,
            deployment: e.deployment,
            calls: e.calls,
            first_seen: new Date(e.first_seen).toISOString(),
            last_seen: new Date(e.last_seen).toISOString(),
            estimate: e.estimate ? { ...e.estimate } : null,
        }));
}

/** How many pairs did not fit (the registry is capped). */
function unknownModelStats() {
    return { tracked: _entries.size, max: MAX_ENTRIES, overflow: _overflow };
}

/** Forget everything (an admin acknowledging the list, and tests). */
function resetUnknownModels() {
    _entries.clear();
    _overflow = 0;
    _suppressed = 0;
    _windowStart = 0;
    _windowCount = 0;
}

module.exports = {
    MAX_ENTRIES,
    WARN_PER_MODEL_MS,
    WARN_PER_MINUTE,
    cleanModel,
    recordUnknownModel,
    listUnknownModels,
    unknownModelStats,
    resetUnknownModels,
};
