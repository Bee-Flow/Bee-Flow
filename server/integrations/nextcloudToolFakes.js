'use strict';
/**
 * Fake Nextcloud for tool tests that keep state across several calls.
 * installFakeNc() swaps ncClient.resolveAuth for a fake whose fetch records
 * every call and answers through `handler`; resetFakeNc() puts the real
 * functions back (call it from test.after).
 */
const ncClient = require('./nextcloudClient');

const originalResolveAuth = ncClient.resolveAuth;
const originalIsConnectorSession = ncClient.isConnectorSession;

const json = (status, body) => ({
    ok: status < 400,
    status,
    headers: { get: () => null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

/**
 * @param {(req: { url: string, method: string, body: any }) => any} handler
 * @param {object} [auth] extra fields on the auth context (mode, publicBaseUrl, ...)
 * @returns {{ url: string, method: string, body: any }[]} the recorded calls
 */
function installFakeNc(handler, auth = {}) {
    const calls = [];
    ncClient.resolveAuth = async () => ({
        baseUrl: 'https://nc.example.test',
        authError: 'auth',
        uid: 'u',
        ...auth,
        fetch: async (url, opts = {}) => {
            const req = { url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined };
            calls.push(req);
            return handler(req);
        },
    });
    return calls;
}

function resetFakeNc() {
    ncClient.resolveAuth = originalResolveAuth;
    ncClient.isConnectorSession = originalIsConnectorSession;
}

module.exports = { json, installFakeNc, resetFakeNc };
