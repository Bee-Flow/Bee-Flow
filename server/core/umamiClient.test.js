/**
 * umamiClient unit tests.
 *
 * configStore is pre-mocked via the require cache to return nothing, so the
 * client resolves its endpoint from env vars (no DB needed). global.fetch is
 * stubbed per-test to assert request shape + exercise the find-or-create and
 * auth paths.
 */

const test = require('node:test');
const assert = require('node:assert');

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// No DB in tests — config reads return empty so env vars drive the client.
mock('../stores/configStore', {
    getConfig: async () => null,
    getSecret: async () => '',
});

const umami = require('./umamiClient');

const origFetch = global.fetch;

// Install a fetch stub that records calls and replies from `handler`.
function stubFetch(handler) {
    const calls = [];
    global.fetch = async (url, opts = {}) => {
        calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers || {} });
        const r = handler({ url: String(url), opts }) || {};
        const status = r.status ?? 200;
        const payload = r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? '');
        return { ok: status >= 200 && status < 300, status, text: async () => payload };
    };
    return calls;
}

function resetEnv({ token } = {}) {
    process.env.UMAMI_URL = 'http://umami.test';
    process.env.UMAMI_USERNAME = 'admin';
    process.env.UMAMI_PASSWORD = 'secret';
    if (token) process.env.UMAMI_API_TOKEN = token;
    else delete process.env.UMAMI_API_TOKEN;
    umami.invalidateEndpointCache();
}

test.afterEach(() => { global.fetch = origFetch; });

test('isConfigured() true when url + api token present', async () => {
    resetEnv({ token: 'tok123' });
    stubFetch(() => ({ json: {} }));
    assert.equal(await umami.isConfigured(), true);
});

test('isConfigured() false when url missing', async () => {
    process.env.UMAMI_URL = '';
    process.env.UMAMI_API_TOKEN = 'tok';
    umami.invalidateEndpointCache();
    assert.equal(await umami.isConfigured(), false);
});

test('api token is sent as Bearer (no login round-trip)', async () => {
    resetEnv({ token: 'tok123' });
    const calls = stubFetch(({ url }) => {
        if (url.includes('/stats')) return { json: { pageviews: { value: 5 }, visitors: { value: 3 } } };
        return { json: {} };
    });
    const stats = await umami.getStats('w1', { startAt: 1000, endAt: 2000 });
    assert.equal(stats.pageviews.value, 5);
    // No login call when an api token is configured.
    assert.equal(calls.some(c => c.url.includes('/api/auth/login')), false);
    const statsCall = calls.find(c => c.url.includes('/stats'));
    assert.ok(statsCall.url.includes('/api/websites/w1/stats'));
    assert.ok(statsCall.url.includes('startAt=1000') && statsCall.url.includes('endAt=2000'));
    assert.equal(statsCall.headers.Authorization, 'Bearer tok123');
});

test('ensureWebsite reuses an existing website matched by domain', async () => {
    resetEnv({ token: 'tok123' });
    const calls = stubFetch(({ url, opts }) => {
        if (url.includes('/api/websites') && (opts.method || 'GET') === 'GET') {
            return { json: { data: [{ id: 'w-existing', domain: 'acme.com' }] } };
        }
        return { json: { id: 'should-not-be-created' } };
    });
    const id = await umami.ensureWebsite({ name: 'Acme', domain: 'https://Acme.com/' });
    assert.equal(id, 'w-existing');
    // Must NOT have POSTed a new website.
    assert.equal(calls.some(c => c.method === 'POST'), false);
});

test('ensureWebsite creates a website when none matches', async () => {
    resetEnv({ token: 'tok123' });
    const calls = stubFetch(({ url, opts }) => {
        if (url.includes('/api/websites') && (opts.method || 'GET') === 'GET') return { json: { data: [] } };
        if (url.includes('/api/websites') && opts.method === 'POST') return { json: { id: 'w-new', domain: 'new.com' } };
        return { json: {} };
    });
    const id = await umami.ensureWebsite({ name: 'New site', domain: 'new.com' });
    assert.equal(id, 'w-new');
    const post = calls.find(c => c.method === 'POST');
    assert.ok(post, 'expected a POST to create the website');
    assert.equal(post.body.domain, 'new.com');
});

test('username/password path logs in and caches the token', async () => {
    resetEnv(); // no api token → login flow
    let loginCount = 0;
    const calls = stubFetch(({ url }) => {
        if (url.includes('/api/auth/login')) { loginCount++; return { json: { token: 'jwt-abc' } }; }
        if (url.includes('/active')) return { json: [{ x: 7 }] };
        return { json: {} };
    });
    await umami.getActive('w1');
    await umami.getActive('w1'); // second call reuses the cached token
    assert.equal(loginCount, 1, 'should log in once and reuse the token');
    const activeCall = calls.find(c => c.url.includes('/active'));
    assert.equal(activeCall.headers.Authorization, 'Bearer jwt-abc');
});

test('metrics builds the typed breakdown URL', async () => {
    resetEnv({ token: 'tok123' });
    const calls = stubFetch(() => ({ json: [{ x: '/', y: 12 }] }));
    const rows = await umami.getMetrics('w9', { type: 'url', startAt: 1, endAt: 2, limit: 5 });
    assert.deepEqual(rows, [{ x: '/', y: 12 }]);
    const c = calls[0];
    assert.ok(c.url.includes('/api/websites/w9/metrics'));
    assert.ok(c.url.includes('type=url') && c.url.includes('limit=5'));
});

// ── Dimension naming (Umami 2.x `url` vs 3.x `path`) ────────────────
//
// Requesting `url` against a 3.x server is a hard 400 that used to be swallowed
// by the overview's per-dimension .catch, so "Top pages" was permanently empty.

test('metrics sends the v3 dimension name as-is when the server accepts it', async () => {
    resetEnv({ token: 'tok123' });
    const calls = stubFetch(() => ({ json: [{ x: '/solutions', y: 3 }] }));
    const rows = await umami.getMetrics('w9', { type: 'path', startAt: 1, endAt: 2 });
    assert.deepEqual(rows, [{ x: '/solutions', y: 3 }]);
    assert.equal(calls.length, 1, 'no fallback request when the first call succeeds');
    assert.ok(calls[0].url.includes('type=path'));
});

test('metrics falls back to the v2 name once when the server rejects `path`', async () => {
    resetEnv({ token: 'tok123' });
    const calls = stubFetch(({ url }) => (
        url.includes('type=path')
            ? { status: 400, text: '{"error":"Bad request"}' }
            : { json: [{ x: '/', y: 7 }] }
    ));
    const rows = await umami.getMetrics('w9', { type: 'path', startAt: 1, endAt: 2 });
    assert.deepEqual(rows, [{ x: '/', y: 7 }], 'caller still gets rows from the 2.x server');
    assert.equal(calls.length, 2);
    assert.ok(calls[0].url.includes('type=path'));
    assert.ok(calls[1].url.includes('type=url'));

    // The flavour is remembered, so the next call skips the doomed attempt.
    const more = stubFetch(() => ({ json: [{ x: '/b', y: 1 }] }));
    await umami.getMetrics('w9', { type: 'path', startAt: 1, endAt: 2 });
    assert.equal(more.length, 1);
    assert.ok(more[0].url.includes('type=url'));
});

test('metrics forwards drill-down filters — on the v3 call AND the v2 retry', async () => {
    resetEnv({ token: 'tok123' });
    // Dropping filters on either path returns site-wide rows that the proxy
    // then caches under a filter-specific key: the wrong answer, remembered.
    const calls = stubFetch(({ url }) => (
        url.includes('type=path')
            ? { status: 400, text: '{"error":"Bad request"}' }
            : { json: [{ x: '/', y: 7 }] }
    ));
    await umami.getMetrics('w9', { type: 'path', startAt: 1, endAt: 2, filters: { country: 'NL' } });
    assert.equal(calls.length, 2);
    assert.ok(calls[0].url.includes('country=NL'), 'v3 attempt must carry the filter');
    assert.ok(calls[1].url.includes('country=NL'), 'v2 fallback must carry it too');
});

test('stats and pageviews forward filters', async () => {
    resetEnv({ token: 'tok123' });
    const calls = stubFetch(() => ({ json: {} }));
    await umami.getStats('w9', { startAt: 1, endAt: 2, country: 'NL' });
    await umami.getPageviews('w9', { startAt: 1, endAt: 2, browser: 'chrome' });
    assert.ok(calls[0].url.includes('country=NL'));
    assert.ok(calls[1].url.includes('browser=chrome'));
});

test('metrics does NOT fall back on non-400 failures', async () => {
    resetEnv({ token: 'tok123' });
    // 500 means the server is unwell, not that the dimension name is wrong —
    // retrying with a legacy name would mask a real outage.
    const calls = stubFetch(() => ({ status: 500, text: 'boom' }));
    await assert.rejects(
        () => umami.getMetrics('w9', { type: 'path', startAt: 1, endAt: 2 }),
        /500/,
    );
    assert.equal(calls.length, 1);
});

test('api errors carry the upstream status code', async () => {
    resetEnv({ token: 'tok123' });
    stubFetch(() => ({ status: 404, text: 'nope' }));
    const err = await umami.getStats('w9', { startAt: 1, endAt: 2 }).catch(e => e);
    assert.equal(err.status, 404);
});

// ── updateWebsite (the only write) ──────────────────────────────────

test('updateWebsite sends only writable keys and reads the result back', async () => {
    resetEnv({ token: 'tok123' });
    const calls = stubFetch(() => ({ json: { id: 'w9', recorderEnabled: true } }));
    const out = await umami.updateWebsite('w9', {
        replayConfig: { replayEnabled: true },
        // Umami derives recorderEnabled from replayConfig and ignores it when
        // sent directly (still returning 200), so it must not be writable.
        recorderEnabled: true,
        name: 'hacked', domain: 'evil.example', id: 'other',
    });
    assert.equal(calls.length, 2, 'write then read-back');
    assert.equal(calls[0].method, 'POST');
    assert.ok(calls[0].url.endsWith('/api/websites/w9'));
    assert.deepEqual(calls[0].body, { replayConfig: { replayEnabled: true } },
        'recorderEnabled/name/domain/id must never reach Umami');
    assert.equal(calls[1].method, 'GET', 'a 200 proves nothing — verify the stored state');
    assert.equal(out.recorderEnabled, true);
});

test('updateWebsite refuses a patch with no writable fields', async () => {
    resetEnv({ token: 'tok123' });
    stubFetch(() => ({ json: {} }));
    await assert.rejects(() => umami.updateWebsite('w9', { name: 'nope' }), /no writable fields/);
});

test('buildReplayConfig records everything and masks by default', async () => {
    // Upstream defaults to a 15% sample, which for a marketing site means most
    // real visits are never recorded and the heatmap looks broken.
    const on = umami.buildReplayConfig({ enabled: true });
    assert.equal(on.replayEnabled, true);
    assert.equal(on.heatmapEnabled, true);
    assert.equal(on.sampleRate, 1);
    assert.equal(on.heatmapSampleRate, 1);
    assert.equal(on.maskLevel, 'strict');

    const off = umami.buildReplayConfig({ enabled: false });
    assert.equal(off.replayEnabled, false);
    assert.equal(off.heatmapEnabled, false);
    assert.equal(off.sampleRate, 0);
});

// Regression. We used to offer our own masking vocabulary
// ('strict' | 'balanced' | 'off'). Umami's schema is a hard enum of exactly
// ['strict', 'moderate'], so only the overlapping value ever worked: selecting
// either of the other two 400'd POST /api/websites/:id, with the cause buried in
// `properties.replayConfig.properties.maskLevel`. This list is now the single
// source of truth — routes/cmsAnalytics.js re-exports it to the admin UI, so if
// this assertion is ever "fixed" by widening it, check the real Umami schema first.
test('MASK_LEVELS is exactly Umami\'s enum', async () => {
    assert.deepEqual([...umami.MASK_LEVELS], ['strict', 'moderate']);
    for (const level of umami.MASK_LEVELS) {
        assert.equal(umami.buildReplayConfig({ enabled: true, maskLevel: level }).maskLevel, level,
            `${level} must survive untouched — a coerced level is an option that silently does nothing`);
    }
});

test('an unrecognised mask level degrades to strict instead of 400ing upstream', async () => {
    for (const stale of ['balanced', 'off', '', null, undefined, 'STRICT']) {
        assert.equal(umami.buildReplayConfig({ enabled: true, maskLevel: stale }).maskLevel, 'strict');
    }
});
