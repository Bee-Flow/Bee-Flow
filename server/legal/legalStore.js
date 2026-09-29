/**
 * Legal Store — runtime overrides for the optional-consent catalog.
 *
 * The code defaults (documentRegistry.OPTIONAL_CONSENTS_DEFAULT) are the SEED.
 * This store lets a platform admin enable/disable or re-version an optional
 * consent (marketing, the Art. 9(2)(a) voiceprint consent) at runtime, without
 * a deploy.
 *
 * The override lives in configStore; an in-memory cache makes it available to
 * the SYNCHRONOUS consent functions (documentRegistry / consentGuards). The
 * cache is refreshed at server startup and after every admin write. Before the
 * first refresh, isLoaded() is false and the registry falls back to the code
 * defaults — always safe.
 *
 * Storage (configStore):
 *   legal_optional_consents   → [ { id, version, category, enabled, labelKey } ]
 */

const configStore = require('../stores/configStore');
const log = require('../telemetry/log');

const OPTIONAL_KEY = 'legal_optional_consents';

let _cache = { optional: null, loaded: false };

/**
 * Load the override from configStore into the in-memory cache.
 * Call at startup and after every admin write.
 */
async function refresh() {
    try {
        const optional = await configStore.getConfig(OPTIONAL_KEY);
        _cache = {
            optional: Array.isArray(optional) ? optional : null,
            loaded: true,
        };
    } catch (err) {
        log.warn('[LegalStore] refresh failed:', err.message);
        _cache.loaded = true; // fall back to defaults rather than blocking
    }
    return _cache;
}

function isLoaded() {
    return _cache.loaded;
}

/** The optional-consent catalog override, or null when unset. */
function getOptionalOverride() {
    return _cache.optional;
}

/** Replace the optional-consent catalog, then refresh the cache. */
async function setOptionalConsents(list) {
    await configStore.setConfig(OPTIONAL_KEY, Array.isArray(list) ? list : []);
    await refresh();
}

module.exports = {
    refresh,
    isLoaded,
    getOptionalOverride,
    setOptionalConsents,
};
