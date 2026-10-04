// @typecheck
/**
 * Admin cost overrides for model pricing (AI Config), split out of modelCosts.js.
 * modelCosts reads them synchronously on every call's cost path and listens for
 * changes, so its unknown-model estimate cache drops donors an override replaced.
 */

const configStore = require('../../stores/configStore');
const log = require('../../telemetry/log');

const _listeners = new Set();

/** Called after every successful read or write of the overrides. */
function onOverridesChanged(fn) {
    _listeners.add(fn);
}

function _notifyChanged() {
    for (const fn of _listeners) fn();
}

// ─── Custom Overrides (admin-edited via AI Config) ───────────────────────────
//
// The overrides live in configStore, which is async; the lookups below are
// synchronous and sit on every LLM call's cost path. So reads go through a
// process-local snapshot: loaded on first use, then refreshed from the store at
// most every OVERRIDES_TTL_MS, which is how a save on another replica arrives
// here. Writes go through configStore.mutateConfig — an atomic read-modify-write
// across replicas — one at a time, in the order they were made.
//
// This used to call configStore.getConfig synchronously. It JSON-parsed the
// Promise that came back, threw, and fell back to {} — so no override was ever
// applied, and every save started from {} and wrote only its own model, wiping
// the others.

const CONFIG_KEY = 'model_cost_overrides';
const OVERRIDES_TTL_MS = 60_000;

let _overrides = {};
let _overridesLoadedAt = 0;
let _overridesLoading = null;
let _writes = Promise.resolve();

/** Stored as an object; rows written by the old code hold the same JSON as text. */
function _asOverrides(raw) {
    let value = raw;
    if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { value = null; }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * Re-read the overrides from the store. A failed read keeps the last good
 * snapshot: falling back to {} would quietly bill at list price again.
 */
function refreshCustomOverrides() {
    if (_overridesLoading) return _overridesLoading;
    _overridesLoading = Promise.resolve()
        .then(() => configStore.getConfig(CONFIG_KEY))
        .then((raw) => {
            _overrides = _asOverrides(raw);
            _overridesLoadedAt = Date.now();
            _notifyChanged();
        })
        .catch((e) => { log.warn(`[ModelCosts] could not read the cost overrides: ${e.message}`); })
        .finally(() => { _overridesLoading = null; });
    return _overridesLoading;
}

function getCustomOverrides() {
    if (Date.now() - _overridesLoadedAt > OVERRIDES_TTL_MS) refreshCustomOverrides();
    return _overrides;
}

/** One write at a time: a caller that loops without awaiting loses nothing. */
function _mutateOverrides(change) {
    const run = _writes.then(async () => {
        const next = await configStore.mutateConfig(CONFIG_KEY, (current) => change({ ..._asOverrides(current) }));
        _overrides = _asOverrides(next);
        _overridesLoadedAt = Date.now();
        _notifyChanged();
    });
    _writes = run.catch((e) => { log.error(`[ModelCosts] could not save a cost override: ${e.message}`); });
    return run;
}

/**
 * Set a custom cost for a model (admin override).
 */
function setModelCost(modelId, input, output) {
    return _mutateOverrides((overrides) => {
        overrides[modelId] = { input: Number(input), output: Number(output) };
        return overrides;
    });
}

/**
 * Remove custom cost override for a model (revert to default pricing).
 */
function resetModelCost(modelId) {
    return _mutateOverrides((overrides) => {
        delete overrides[modelId];
        return overrides;
    });
}

module.exports = {
    getCustomOverrides,
    refreshCustomOverrides,
    setModelCost,
    resetModelCost,
    onOverridesChanged,
};
