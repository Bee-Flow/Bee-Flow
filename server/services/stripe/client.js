// @typecheck
/**
 * Stripe client: lazy SDK construction from the encrypted config (cached per
 * secret key), the enabled / test-mode probes, and the Search query escaper.
 * Holds the only module-level state of the Stripe service.
 */

const deps = require('./deps');

let _client = null;
/** @type {string | null} */
let _lastKeyHash = null;

/**
 * Escape a value interpolated into a Stripe Search query.
 *
 * Search queries are their own small query language. An unescaped quote inside
 * an id breaks out of the string literal and changes which records match, so an
 * org id containing `'` could make a customer lookup return another tenant's
 * customer. Rejects control characters outright and escapes backslash + quote.
 * @param {string} value
 */
function escapeSearchValue(value) {
    const s = String(value == null ? '' : value);
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x20 || c === 0x7f) throw new Error('invalid_search_value');
    }
    return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Get or create a Stripe client instance.
 * Re-creates if the secret key has changed since last call.
 */
async function getClient() {
    const key = await deps.configStore.getSecret('stripe_secret_key');
    if (!key) throw new Error('Stripe secret key not configured');

    // Simple hash to detect key changes without storing the key in memory
    const keyHash = Buffer.from(key).toString('base64').slice(0, 16);
    if (_client && _lastKeyHash === keyHash) return _client;

    const Stripe = require('stripe');
    // Override via STRIPE_API_VERSION when validating a new Stripe API
    // version against staging before rolling it out everywhere.
    const apiVersion = process.env.STRIPE_API_VERSION || '2024-12-18.acacia';
    _client = new Stripe(key, {
        // env-configurable, so a plain string rather than the SDK's pinned literal
        apiVersion: /** @type {any} */ (apiVersion),
        appInfo: { name: 'BeeFlow', version: '1.0.0' },
    });
    _lastKeyHash = keyHash;
    return _client;
}

/**
 * Check if Stripe is enabled in the admin config.
 */
async function isEnabled() {
    try {
        const enabled = await deps.configStore.getConfig('stripe_enabled');
        if (!enabled) return false;
        const key = await deps.configStore.getSecret('stripe_secret_key');
        return !!key;
    } catch {
        return false;
    }
}

/**
 * Detect whether the configured key is a test mode key.
 */
async function isTestMode() {
    try {
        const key = await deps.configStore.getSecret('stripe_secret_key');
        return key?.startsWith('sk_test_') || false;
    } catch {
        return false;
    }
}

module.exports = {
    getClient,
    isEnabled,
    isTestMode,
    escapeSearchValue,
};
