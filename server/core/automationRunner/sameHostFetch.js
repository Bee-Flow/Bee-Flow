'use strict';

const MAX_AUTH_REDIRECTS = 5;

/**
 * fetch() for a request that carries an injected credential: redirects are
 * followed by hand and only while they stay on the original host. A hop to
 * another host throws instead of carrying the credential along.
 */
async function fetchFollowingSameHost(fetchImpl, url, init) {
    const host = new URL(url).hostname.toLowerCase();
    let current = url;
    let req = { ...init, redirect: 'manual' };
    for (let hop = 0; hop <= MAX_AUTH_REDIRECTS; hop += 1) {
        const r = await fetchImpl(current, req);
        const location = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
        if (!location) return r;
        const next = new URL(location, current);
        if (next.hostname.toLowerCase() !== host || (next.protocol !== 'http:' && next.protocol !== 'https:')) {
            throw new Error('http_request: the server redirected to another host; the stored credential is not sent there. Use the final URL in the step instead.');
        }
        current = next.href;
        if (r.status !== 307 && r.status !== 308 && req.method !== 'GET' && req.method !== 'HEAD') {
            req = { ...req, method: 'GET', body: undefined };
        }
    }
    throw new Error('http_request: too many redirects.');
}

module.exports = { fetchFollowingSameHost };
