import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { adoptsRedirect, probeServer, type FetchLike, type ProbeRequestInit, type ProbeResponse } from './probe.ts';

/**
 * A pretend network: `routes` maps a full URL to what it answers. A route can
 * return a response, throw a network error, or redirect (by answering from a
 * different URL). Anything not listed is refused, the way a closed port is.
 */
type Route = (init: ProbeRequestInit | undefined) => ProbeResponse | Promise<ProbeResponse>;

function network(routes: Record<string, Route>): FetchLike & { calls: Array<{ url: string; init?: ProbeRequestInit }> } {
    const calls: Array<{ url: string; init?: ProbeRequestInit }> = [];
    const fetch = (async (url: string, init?: ProbeRequestInit) => {
        calls.push({ url, ...(init ? { init } : {}) });
        const route = routes[url];
        if (!route) throw new Error('net::ERR_CONNECTION_REFUSED');
        return route(init);
    }) as FetchLike & { calls: typeof calls };
    fetch.calls = calls;
    return fetch;
}

function respond(url: string, status: number, body: unknown, contentType = 'application/json'): ProbeResponse {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { status, url, headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) }, text: async () => text };
}

const HEALTH = { status: 'ok', timestamp: '2026-09-23T00:00:00.000Z', appVersion: 'abc1234' };

/** Everything a healthy Bee Flow at `base` answers. */
function beeFlow(base: string, extra: Partial<{ setupStatus: unknown; originGate: string[] }> = {}): Record<string, Route> {
    const gate = (init: ProbeRequestInit | undefined, answer: () => ProbeResponse, url: string) => {
        const origin = init?.headers?.Origin;
        if (origin && extra.originGate && !extra.originGate.includes(origin)) return respond(url, 403, { error: 'Origin not allowed' });
        return answer();
    };
    return {
        [`${base}/api/health`]: (init) => gate(init, () => respond(`${base}/api/health`, 200, HEALTH), `${base}/api/health`),
        [`${base}/`]: (init) => gate(init, () => respond(`${base}/`, 200, '<div id="root"></div>', 'text/html'), `${base}/`),
        [`${base}/ai/`]: (init) => gate(init, () => respond(`${base}/ai/`, 404, 'Cannot GET /ai/', 'text/html'), `${base}/ai/`),
        [`${base}/auth/setup-status`]: (init) => gate(init, () => respond(`${base}/auth/setup-status`, 200, extra.setupStatus ?? { needsSetup: false }), `${base}/auth/setup-status`),
    };
}

describe('probeServer — the happy path', () => {
    it('accepts a Bee Flow server and reports the build', async () => {
        const fetch = network(beeFlow('https://bee.example.com'));
        const result = await probeServer('bee.example.com', { fetch });
        assert.equal(result.ok, true);
        assert.equal(result.url, 'https://bee.example.com');
        assert.equal(result.appVersion, 'abc1234');
        assert.equal(result.insecure, false);
        assert.equal(result.warnings, undefined);
    });

    it('probes the subpath the user gave, not the bare origin', async () => {
        const fetch = network(beeFlow('https://cloud.example.com/beeflow'));
        const result = await probeServer('https://cloud.example.com/beeflow', { fetch });
        assert.equal(result.ok, true);
        assert.equal(fetch.calls[0]?.url, 'https://cloud.example.com/beeflow/api/health');
    });

    it('announces itself as the desktop client', async () => {
        const fetch = network(beeFlow('https://bee.example.com'));
        await probeServer('bee.example.com', { fetch });
        assert.equal(fetch.calls[0]?.init?.headers?.['X-Beeflow-Client'], 'desktop');
    });
});

describe('probeServer — an address typed without http://', () => {
    function httpOnly(base: string): Record<string, Route> {
        const https = base.replace('http://', 'https://');
        return {
            ...beeFlow(base),
            // What an http port does to a TLS handshake, as Chromium reports it.
            [`${https}/api/health`]: () => {
                throw new Error('net::ERR_SSL_PROTOCOL_ERROR');
            },
        };
    }

    it('falls back to http for a private IP address, and says it is not encrypted', async () => {
        const fetch = network(httpOnly('http://192.168.1.40:5176'));
        const result = await probeServer('192.168.1.40:5176', { fetch });
        assert.equal(result.ok, true);
        assert.equal(result.url, 'http://192.168.1.40:5176');
        assert.equal(result.insecure, true);
    });

    it('falls back to http for this computer, which is not a network hop', async () => {
        const fetch = network(httpOnly('http://localhost:5176'));
        const result = await probeServer('localhost:5176', { fetch });
        assert.equal(result.ok, true);
        assert.equal(result.url, 'http://localhost:5176');
        assert.equal(result.insecure, false);
    });

    it('does not fall back silently for a name the local network answers', async () => {
        // On someone else's Wi-Fi, `nas.local` can be anyone.
        const fetch = network(httpOnly('http://nas.local:5176'));
        const result = await probeServer('nas.local:5176', { fetch });
        assert.equal(result.ok, false);
        assert.equal(result.code, 'plain-http');
        assert.match(String(result.error), /type http:\/\/nas\.local:5176/);
    });

    it('does not fall back for a public host either', async () => {
        const fetch = network(httpOnly('http://bee.example.com'));
        const result = await probeServer('bee.example.com', { fetch });
        assert.equal(result.code, 'plain-http');
    });

    it('connects when http:// was typed, and flags it', async () => {
        const fetch = network(beeFlow('http://nas.local:5176'));
        const result = await probeServer('http://nas.local:5176', { fetch });
        assert.equal(result.ok, true);
        assert.equal(result.insecure, true);
    });

    it('never falls back when https fails on a certificate', async () => {
        const fetch = network({
            ...beeFlow('http://192.168.1.40:5176'),
            'https://192.168.1.40:5176/api/health': () => {
                throw new Error('net::ERR_CERT_AUTHORITY_INVALID');
            },
        });
        const result = await probeServer('192.168.1.40:5176', { fetch });
        assert.equal(result.ok, false);
        assert.equal(result.code, 'tls');
        assert.equal(fetch.calls.some((call) => call.url.startsWith('http://')), false);
    });

    it('never falls back when https was typed', async () => {
        const fetch = network(httpOnly('http://192.168.1.40:5176'));
        const result = await probeServer('https://192.168.1.40:5176', { fetch });
        assert.equal(result.ok, false);
        assert.equal(result.code, 'tls');
    });

    it('tries port 80 when 443 is closed and no port was typed', async () => {
        const fetch = network(beeFlow('http://10.0.0.7'));
        const result = await probeServer('10.0.0.7', { fetch });
        assert.equal(result.ok, true);
        assert.equal(result.url, 'http://10.0.0.7');
    });
});

describe('probeServer — the address it ends up at', () => {
    it('saves the address a redirect leads to', async () => {
        const target = beeFlow('https://www.bee.example.com');
        const fetch = network({
            ...target,
            'https://bee.example.com/api/health': () => respond('https://www.bee.example.com/api/health', 200, HEALTH),
            'https://bee.example.com/': () => respond('https://www.bee.example.com/', 200, '<div id="root"></div>', 'text/html'),
        });
        const result = await probeServer('bee.example.com', { fetch });
        assert.equal(result.ok, true);
        assert.equal(result.url, 'https://www.bee.example.com');
    });

    it('keeps a subpath through an http → https redirect', async () => {
        const fetch = network({
            ...beeFlow('https://cloud.example.com/beeflow'),
            'http://cloud.example.com/beeflow/api/health': () => respond('https://cloud.example.com/beeflow/api/health', 200, HEALTH),
            'http://cloud.example.com/beeflow/': () => respond('https://cloud.example.com/beeflow/login', 200, '<div id="root"></div>', 'text/html'),
        });
        const result = await probeServer('http://cloud.example.com/beeflow', { fetch });
        assert.equal(result.url, 'https://cloud.example.com/beeflow');
        assert.equal(result.insecure, false);
    });

    it('does not follow https down to http', async () => {
        const fetch = network({
            ...beeFlow('http://bee.example.com'),
            'https://bee.example.com/api/health': () => respond('https://bee.example.com/api/health', 200, HEALTH),
            'https://bee.example.com/': () => respond('http://bee.example.com/', 200, '<div id="root"></div>', 'text/html'),
        });
        const result = await probeServer('https://bee.example.com', { fetch });
        assert.equal(result.ok, false);
        assert.equal(result.code, 'redirected');
        assert.equal(result.redirectTarget, 'http://bee.example.com');
        assert.match(String(result.error), /will not switch from https to http/);
    });

    it('does not follow a plain-http answer onto another host', async () => {
        // Typed as a private IP, so the probe fell back to http; whoever
        // answered in plain text must not be able to repoint the app — least
        // of all at a name the fallback itself would have refused.
        const fetch = network({
            ...beeFlow('http://nas.local:5176'),
            'https://192.168.1.40:5176/api/health': () => {
                throw new Error('net::ERR_SSL_PROTOCOL_ERROR');
            },
            'http://192.168.1.40:5176/api/health': () => respond('http://192.168.1.40:5176/api/health', 200, HEALTH),
            'http://192.168.1.40:5176/': () => respond('http://nas.local:5176/', 200, '<div id="root"></div>', 'text/html'),
        });
        const result = await probeServer('192.168.1.40:5176', { fetch });
        assert.equal(result.ok, false);
        assert.equal(result.code, 'redirected');
        assert.equal(result.redirectTarget, 'http://nas.local:5176');
    });

    it('checks the API is really there after a redirect', async () => {
        const fetch = network({
            'https://bee.example.com/api/health': () => respond('https://bee.example.com/api/health', 200, HEALTH),
            'https://bee.example.com/': () => respond('https://parked.example.net/', 200, 'For sale', 'text/html'),
            'https://parked.example.net/api/health': () => respond('https://parked.example.net/api/health', 200, 'For sale', 'text/html'),
        });
        const result = await probeServer('bee.example.com', { fetch });
        assert.equal(result.ok, false);
        assert.match(String(result.error), /redirects to https:\/\/parked\.example\.net/);
    });
});

describe('probeServer — reachable, but not somewhere the window can use', () => {
    it('recognises the API port and says which port to use', async () => {
        const fetch = network({
            ...beeFlow('http://192.168.1.40:3001'),
            'http://192.168.1.40:3001/': () => respond('http://192.168.1.40:3001/', 404, '<pre>Cannot GET /</pre>', 'text/html'),
        });
        const result = await probeServer('http://192.168.1.40:3001', { fetch });
        assert.equal(result.ok, false);
        assert.equal(result.code, 'api-port');
        assert.match(String(result.error), /port 5176/);
    });

    it('says which setting to change when the server refuses this address', async () => {
        const fetch = network(beeFlow('http://192.168.1.40:5176', { originGate: ['http://localhost:5176'] }));
        const result = await probeServer('http://192.168.1.40:5176', { fetch });
        assert.equal(result.ok, false);
        assert.equal(result.code, 'origin-refused');
        assert.match(String(result.error), /add http:\/\/192\.168\.1\.40:5176 to CLIENT_PUBLIC_HOST/);
    });

    it('sends the Origin the window will send', async () => {
        const fetch = network(beeFlow('https://bee.example.com'));
        await probeServer('bee.example.com', { fetch });
        const origins = fetch.calls.map((call) => call.init?.headers?.Origin).filter(Boolean);
        assert.deepEqual([...new Set(origins)], ['https://bee.example.com']);
    });

    it('does not fail on an origin check that could not run', async () => {
        const routes = beeFlow('https://bee.example.com');
        delete routes['https://bee.example.com/ai/'];
        const result = await probeServer('bee.example.com', { fetch: network(routes) });
        assert.equal(result.ok, true);
        assert.equal(result.warnings?.length, 1);
    });
});

describe('probeServer — the single sign-on origin', () => {
    it('reports a second origin the web app sends sign-in to', async () => {
        const fetch = network(beeFlow('https://beeflow.example.com', { setupStatus: { serverUrl: 'https://api.beeflow.example.com' } }));
        const result = await probeServer('beeflow.example.com', { fetch });
        assert.equal(result.apiOrigin, 'https://api.beeflow.example.com');
    });

    it('ignores the stock localhost:3001 on a server that is not on this computer', async () => {
        const fetch = network(beeFlow('http://192.168.1.40:5176', { setupStatus: { serverUrl: 'http://localhost:3001' } }));
        const result = await probeServer('http://192.168.1.40:5176', { fetch });
        assert.equal(result.ok, true);
        assert.equal(result.apiOrigin, undefined);
    });

    it('accepts localhost:3001 when the server is on this computer', async () => {
        const fetch = network(beeFlow('http://localhost:5176', { setupStatus: { serverUrl: 'http://localhost:3001' } }));
        const result = await probeServer('http://localhost:5176', { fetch });
        assert.equal(result.apiOrigin, 'http://localhost:3001');
    });

    it('never lets an https server point sign-in at plain http', async () => {
        const fetch = network(beeFlow('https://bee.example.com', { setupStatus: { serverUrl: 'http://api.bee.example.com' } }));
        const result = await probeServer('bee.example.com', { fetch });
        assert.equal(result.apiOrigin, undefined);
    });

    it('ignores the same origin, and anything that is not a web address', async () => {
        for (const serverUrl of ['https://bee.example.com', 'javascript:alert(1)', 'not a url', 42]) {
            const fetch = network(beeFlow('https://bee.example.com', { setupStatus: { serverUrl } }));
            const result = await probeServer('bee.example.com', { fetch });
            assert.equal(result.apiOrigin, undefined, String(serverUrl));
        }
    });
});

describe('probeServer — something answered, but not Bee Flow', () => {
    it('rejects a 200 that is not JSON', async () => {
        const fetch = network({ 'https://bee.example.com/api/health': () => respond('https://bee.example.com/api/health', 200, '<html>Router login</html>', 'text/html') });
        const result = await probeServer('bee.example.com', { fetch });
        assert.equal(result.code, 'not-bee-flow');
        assert.match(String(result.error), /not a Bee Flow server/);
    });

    it('rejects JSON that is not a health check', async () => {
        const fetch = network({ 'https://bee.example.com/api/health': () => respond('https://bee.example.com/api/health', 200, { hello: 'world' }) });
        assert.equal((await probeServer('bee.example.com', { fetch })).code, 'not-bee-flow');
    });

    it('points at the subpath when the API 404s', async () => {
        const fetch = network({ 'https://cloud.example.com/api/health': () => respond('https://cloud.example.com/api/health', 404, { error: 'nope' }) });
        const result = await probeServer('https://cloud.example.com', { fetch });
        assert.equal(result.code, 'http-error');
        assert.match(String(result.error), /include it/);
    });

    it('reads a 503 as "still starting", not "broken"', async () => {
        const fetch = network({ 'https://bee.example.com/api/health': () => respond('https://bee.example.com/api/health', 503, {}) });
        assert.match(String((await probeServer('bee.example.com', { fetch })).error), /starting up/);
    });

    it('recognises a login page in front of the server', async () => {
        const fetch = network({ 'https://bee.example.com/api/health': () => respond('https://bee.example.com/api/health', 401, {}) });
        assert.match(String((await probeServer('bee.example.com', { fetch })).error), /asking for a login/);
    });
});

describe('probeServer — failures and input', () => {
    it('passes a network failure through the classifier', async () => {
        const fetch = network({
            'https://bee.example.com/api/health': () => {
                throw new Error('net::ERR_NAME_NOT_RESOLVED');
            },
        });
        const result = await probeServer('https://bee.example.com', { fetch });
        assert.equal(result.code, 'dns');
    });

    it('reports a timeout when the request is aborted', async () => {
        const result = await probeServer('https://bee.example.com', {
            timeoutMs: 20,
            fetch: (_url, init) =>
                new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => {
                        const error = new Error('This operation was aborted');
                        error.name = 'AbortError';
                        reject(error);
                    });
                }),
        });
        assert.equal(result.code, 'timeout');
    });

    it('does not reach the network for an address it already knows is wrong', async () => {
        const fetch = network({});
        const result = await probeServer('ftp://bee.example.com', { fetch });
        assert.equal(fetch.calls.length, 0);
        assert.equal(result.code, 'invalid-url');
    });
});

describe('adoptsRedirect', () => {
    it('follows moves that cannot lower the bar', () => {
        assert.equal(adoptsRedirect('https://bee.example.com', 'https://bee.example.com/app'), true, 'same origin');
        assert.equal(adoptsRedirect('http://bee.example.com', 'https://bee.example.com'), true, 'upgrade');
        assert.equal(adoptsRedirect('http://192.168.1.40:5176', 'https://192.168.1.40'), true, 'upgrade, other port');
        assert.equal(adoptsRedirect('http://127.0.0.1:5176', 'http://127.0.0.1:8080'), true, 'same machine, other port');
        assert.equal(adoptsRedirect('https://bee.example.com', 'https://www.bee.example.com'), true, 'the certificate vouches');
    });

    it('does not follow the others', () => {
        assert.equal(adoptsRedirect('https://bee.example.com', 'http://bee.example.com'), false, 'downgrade');
        assert.equal(adoptsRedirect('http://192.168.1.40:5176', 'http://nas.local:5176'), false);
        assert.equal(adoptsRedirect('http://192.168.1.40:5176', 'https://evil.example.net'), false, 'plain http may not pick the new host');
        assert.equal(adoptsRedirect('not a url', 'https://x.example'), false);
    });
});
