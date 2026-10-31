// @typecheck strict
/**
 * Nextcloud Connector bootstrap: the X-Beeflow-NC-* request headers, read
 * once per request, and the gate on the one of them this server later
 * connects to (the connector callback URL).
 */

const { assertAllowedNextcloudHost } = require('../../utils/nextcloudTarget');

/** @param {import('express').Request} req */
function readBootstrapHeaders(req) {
    return {
        ncInstanceId: String(req.headers['x-beeflow-nc-instance-id'] || '').trim(),
        ncBaseUrl: String(req.headers['x-beeflow-nc-base-url'] || '').trim().replace(/\/+$/, ''),
        ncAdminUid: String(req.headers['x-beeflow-nc-admin-uid'] || '').trim(),
        ncAdminEmail: String(req.headers['x-beeflow-nc-admin-email'] || '').trim().toLowerCase(),
        ncAdminDisplayName: String(req.headers['x-beeflow-nc-admin-display-name'] || '').trim(),
        connectorCallbackUrl: String(req.headers['x-beeflow-connector-callback-url'] || '').trim().replace(/\/+$/, ''),
        pairingCode: String(req.headers['x-beeflow-pairing-code'] || '').trim().toUpperCase(),
    };
}

/**
 * The 400 body for a callback URL this server may not connect to, or null
 * when the URL passes (or is absent: older connectors send none). The URL is
 * where this server later sends signed requests (user/group sync, task
 * processing, menu sync) and is stored as given, so it passes the same host
 * gate as every other Nextcloud target before any branch can write it.
 * @param {string} connectorCallbackUrl
 */
function callbackUrlRefusal(connectorCallbackUrl) {
    if (!connectorCallbackUrl) return null;
    try {
        assertAllowedNextcloudHost(connectorCallbackUrl);
        return null;
    } catch (e) {
        return {
            error: `Connector callback URL rejected: ${/** @type {Error} */ (e).message}`,
            code: 'invalid_callback_url',
            remediation: 'The connector sends its own public address as X-Beeflow-Connector-Callback-Url. Set BEEFLOW_NC_PUBLIC_URL on the connector to the address Bee Flow can reach, or, for a Nextcloud on a private network, set NEXTCLOUD_ALLOW_PRIVATE_HOSTS=1 on the Bee Flow server.',
        };
    }
}

module.exports = { readBootstrapHeaders, callbackUrlRefusal };
