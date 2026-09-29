/**
 * The registry half of GET /api/check-updates: the digest of a repo's
 * `latest` manifest, read from the registry's manifest API.
 *
 * Public: registryTransportOptions(env), createRemoteDigest(options) ->
 * getRemoteDigest(repo) -> Promise<{ digest, status, error }>.
 *
 * Invariant: the registry credentials travel as HTTP Basic auth, which is
 * reversible, so they are only ever sent inside TLS whose certificate was
 * verified, unless the operator opted out of verification. Two opt-ins exist
 * for registries that cannot offer verified TLS, both off by default:
 *   REGISTRY_INSECURE_TLS=1  accept any certificate (a self-signed registry)
 *   REGISTRY_ALLOW_HTTP=1    retry over plain HTTP when HTTPS yields no digest;
 *                            that retry NEVER carries the credentials, so it
 *                            only succeeds against an anonymously readable registry
 */

const https = require('https');
const http = require('http');

const MANIFEST_ACCEPT = 'application/vnd.docker.distribution.manifest.v2+json';

/** The transport opt-ins from the environment; only the exact value '1' enables one. */
function registryTransportOptions(env = process.env) {
    return {
        insecureTls: env.REGISTRY_INSECURE_TLS === '1',
        allowHttp: env.REGISTRY_ALLOW_HTTP === '1',
    };
}

const defaultRequest = (protocol, options, onResponse) =>
    (protocol === 'https' ? https : http).request(options, onResponse);

/**
 * @param {object} o
 * @param {string} o.registryUrl  host[:port], optionally with an http(s):// prefix
 * @param {string} o.user
 * @param {string} o.token
 * @param {boolean} [o.insecureTls]
 * @param {boolean} [o.allowHttp]
 * @param {Function} [o.request]  (protocol, options, onResponse) -> ClientRequest; injectable for tests
 * @param {number} [o.timeoutMs]
 */
function createRemoteDigest({ registryUrl, user, token, insecureTls = false, allowHttp = false, request = defaultRequest, timeoutMs = 8000 }) {
    const registryHost = String(registryUrl || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const [hostname, portPart] = registryHost.split(':');
    const explicitPort = portPart ? parseInt(portPart, 10) : null;
    const basicAuth = `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;

    const tryRequest = (protocol, repo) => new Promise((resolve) => {
        const headers = { 'Accept': MANIFEST_ACCEPT };
        // The credentials go inside TLS only; a plain-HTTP request never carries them.
        if (protocol === 'https') headers['Authorization'] = basicAuth;
        const options = {
            hostname,
            port: explicitPort || (protocol === 'https' ? 443 : 80),
            path: `/v2/${repo}/manifests/latest`,
            method: 'GET',
            headers,
            timeout: timeoutMs,
        };
        if (protocol === 'https' && insecureTls) options.rejectUnauthorized = false;

        const req = request(protocol, options, (resp) => {
            // Drain body so connection closes
            resp.on('data', () => {});
            resp.on('end', () => resolve({
                digest: resp.headers['docker-content-digest'] || null,
                status: resp.statusCode,
                error: resp.statusCode >= 400 ? `HTTP ${resp.statusCode}` : null,
            }));
        });
        req.on('error', (e) => resolve({ digest: null, status: 0, error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ digest: null, status: 0, error: 'timeout' }); });
        req.end();
    });

    return function getRemoteDigest(repo) {
        return tryRequest('https', repo).then((r) => (r.digest || !allowHttp ? r : tryRequest('http', repo)));
    };
}

module.exports = { registryTransportOptions, createRemoteDigest, MANIFEST_ACCEPT };
