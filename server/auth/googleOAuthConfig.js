// @typecheck strict
/**
 * The Google OAuth client of this installation (Settings → SSO → Google), read
 * in one place for the Google Workspace connector routes and the Meet
 * connection block. "Configured" means both a client id and a client secret
 * are set; one without the other cannot complete an OAuth exchange.
 *
 * `isGoogleConfigured` answers a boolean only: callers that put it in a
 * response never need the id or the secret for that.
 *
 * The auth config loader is a parameter (default: auth/permissions.loadConfig,
 * required lazily) so a caller or a test can pass its own.
 */

/** @typedef {() => Promise<{ providers?: { google?: { clientId?: string, clientSecret?: string } } }>} AuthConfigLoader */

/** @type {AuthConfigLoader} */
const loadAuthConfig = () => require('./permissions').loadConfig();

/**
 * The stored client id and secret, empty strings when unset.
 * @param {AuthConfigLoader} [load]
 * @returns {Promise<{ clientId: string, clientSecret: string }>}
 */
async function getGoogleClientConfig(load = loadAuthConfig) {
    const config = await load();
    const providerConfig = config.providers?.google || {};
    return {
        clientId: providerConfig.clientId || '',
        clientSecret: providerConfig.clientSecret || '',
    };
}

/**
 * True when the installation has a Google OAuth client (id and secret).
 * Rejects when the auth config cannot be read; the caller picks the fallback.
 * @param {AuthConfigLoader} [load]
 * @returns {Promise<boolean>}
 */
async function isGoogleConfigured(load = loadAuthConfig) {
    const { clientId, clientSecret } = await getGoogleClientConfig(load);
    return !!(clientId && clientSecret);
}

module.exports = { getGoogleClientConfig, isGoogleConfigured };
