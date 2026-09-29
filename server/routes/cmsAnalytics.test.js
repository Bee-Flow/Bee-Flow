/**
 * cmsAnalytics route tests.
 *
 * These four handlers (settings/sites/overview + the new proxy) previously had
 * ZERO coverage, which is how the `type: 'url'` 400 on Umami 3.x survived: the
 * overview swallowed it per-dimension and rendered an empty card.
 *
 * Same harness style as cms.public.test.js — a MOCKS table injected through
 * Module._resolveFilename, then the REAL router mounted on a real HTTP server.
 * umamiClient is stubbed so we assert on the exact upstream calls the router
 * makes without touching a live Umami.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const Module = require('node:module');

// ── In-memory config store ──────────────────────────────────────────

const configValues = new Map();
const mockConfigStore = {
    getConfig: async (k) => (configValues.has(k) ? configValues.get(k) : null),
    setConfig: async (k, v) => { configValues.set(k, v); },
    getSecret: async (k) => configValues.get(`secret:${k}`) || '',
    setSecret: async (k, v) => { configValues.set(`secret:${k}`, v); },
};

// ── Umami stub ──────────────────────────────────────────────────────

let umamiCalls = [];
let umamiHandler = () => ({});

const mockUmami = {
    KEY_URL: 'cms_analytics_url',
    KEY_USERNAME: 'cms_analytics_username',
    KEY_PASSWORD: 'cms_analytics_password',
    KEY_API_TOKEN: 'cms_analytics_api_token',
    METRIC_TYPES: ['path', 'referrer', 'browser', 'os', 'device', 'country', 'event', 'city'],
    isConfigured: async () => true,
    invalidateEndpointCache: () => {},
    listWebsites: async () => [{ id: 'web_1' }],
    ensureWebsite: async () => 'web_1',
    // Umami's masking enum. The real list lives in core/umamiClient and is
    // pinned by core/umamiClient.test.js — this stub only has to agree with it.
    MASK_LEVELS: ['strict', 'moderate'],
    // Faithful to the real implementation, including the sampling/masking
    // passthrough — a stub that ignored them would hide the whole point of
    // making those operator-configurable — and the coercion of unrecognised
    // levels, without which this stub would happily "pass" a value that 400s
    // against a real Umami.
    buildReplayConfig: ({ enabled, sampleRate = 1, maskLevel = 'strict' }) => ({
        replayEnabled: !!enabled,
        heatmapEnabled: !!enabled,
        sampleRate: enabled ? sampleRate : 0,
        heatmapSampleRate: enabled ? sampleRate : 0,
        maskLevel: ['strict', 'moderate'].includes(maskLevel) ? maskLevel : 'strict',
    }),
    updateWebsite: async (websiteId, patch) => {
        umamiCalls.push({ kind: 'updateWebsite', websiteId, patch });
        // Mirrors Umami: recorderEnabled is DERIVED from replayConfig.
        return { id: websiteId, recorderEnabled: !!patch.replayConfig?.replayEnabled };
    },
    getStats: async (websiteId, q) => { umamiCalls.push({ kind: 'stats', websiteId, q }); return { pageviews: 1 }; },
    getPageviews: async (websiteId, q) => { umamiCalls.push({ kind: 'pageviews', websiteId, q }); return { pageviews: [], sessions: [] }; },
    getMetrics: async (websiteId, q) => {
        umamiCalls.push({ kind: 'metrics', websiteId, q });
        return umamiHandler({ kind: 'metrics', q }) ?? [];
    },
    getActive: async (websiteId) => { umamiCalls.push({ kind: 'active', websiteId }); return { visitors: 2 }; },
    get: async (path, query) => { umamiCalls.push({ kind: 'get', path, query }); return umamiHandler({ kind: 'get', path, query }) ?? { ok: true }; },
    post: async (path, body) => { umamiCalls.push({ kind: 'post', path, body }); return umamiHandler({ kind: 'post', path, body }) ?? { ok: true }; },
};

const SITE_ID = 'pj_aaaa1111';

const MOCKS = {
    '../stores/configStore': mockConfigStore,
    '../stores/cmsStore': {
        listProjects: async () => [{ id: SITE_ID, name: 'Test site' }],
        getProject: async (id) => (id === SITE_ID ? { id, name: 'Test site' } : null),
    },
    '../core/umamiClient': mockUmami,
    '../utils/perUserRateLimit': { perUserRateLimit: () => (req, res, next) => next() },
    './cmsShared': {
        SITE_ID_RE: /^pj_[a-f0-9]{4,}$/,
        getLiveSiteId: async () => SITE_ID,
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:analytics:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) return MOCK_IDS[request];
    return originalResolve.call(this, request, parent, ...rest);
};

const express = require('express');
const cmsAnalytics = require('./cmsAnalytics');

// ── HTTP harness ────────────────────────────────────────────────────

let server;
let baseUrl;
let sessionUser = { user: { id: 'u1', role: 'admin' }, isAdmin: true };

async function call(method, path, body) {
    const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, json };
}

test.before(async () => {
    const app = express();
    app.use(express.json());
    // Stand in for the real session middleware.
    app.use((req, res, next) => { req.session = sessionUser; next(); });
    app.use('/analytics', cmsAnalytics.router);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
    server?.close();
    Module._resolveFilename = originalResolve;
});

test.beforeEach(() => {
    umamiCalls = [];
    umamiHandler = () => ({});
    sessionUser = { user: { id: 'u1', role: 'admin' }, isAdmin: true };
    configValues.clear();
    configValues.set('cms_analytics_enabled', true);
    configValues.set('cms_analytics_url', 'https://stats.example.com');
    configValues.set('cms_analytics_site_map', { [SITE_ID]: 'web_1' });
    cmsAnalytics._test.invalidateCache();
});

// ── Gating ──────────────────────────────────────────────────────────

test('unauthenticated requests are rejected', async () => {
    sessionUser = null;
    const res = await call('GET', '/analytics/overview');
    assert.equal(res.status, 401);
});

test('a non-operator admin is rejected even with the `all` permission', async () => {
    // requireAdmin (the CMS gate) would admit this user; the analytics gate
    // deliberately does not, because visitor stats span every site on the box.
    sessionUser = { user: { id: 'u2', role: 'user', permissions: ['all'] }, isAdmin: false };
    const res = await call('GET', '/analytics/overview');
    assert.equal(res.status, 403);
});

// ── Proxy allow-list (security boundary) ────────────────────────────

test('unknown resources are refused', async () => {
    for (const resource of ['reset', 'transfer', 'shares', 'nope']) {
        const res = await call('GET', `/analytics/query/${resource}`);
        assert.equal(res.status, 400, `${resource} must not be proxied`);
        assert.equal(umamiCalls.length, 0, `${resource} must not reach Umami`);
    }
});

test('unknown report types are refused', async () => {
    const res = await call('POST', '/analytics/report/evil', {});
    assert.equal(res.status, 400);
    assert.equal(umamiCalls.length, 0);
});

test('a client-supplied websiteId is ignored — the server resolves it', async () => {
    const res = await call('GET', '/analytics/query/stats?websiteId=web_SOMEONE_ELSE');
    assert.equal(res.status, 200);
    const statsCall = umamiCalls.find(c => c.kind === 'get' || c.kind === 'stats');
    assert.ok(statsCall.path.includes('/api/websites/web_1/'),
        `resolved website must win, got ${statsCall.path}`);
    assert.ok(!JSON.stringify(umamiCalls).includes('SOMEONE_ELSE'));
});

test('unknown dimensions are refused before reaching Umami', async () => {
    const res = await call('GET', '/analytics/query/metrics?type=; DROP TABLE');
    assert.equal(res.status, 400);
    assert.equal(umamiCalls.length, 0);
});

test('unlisted query params are not forwarded upstream', async () => {
    const res = await call('GET', '/analytics/query/stats?limit=5&evil=1&type=path');
    assert.equal(res.status, 200);
    const c = umamiCalls.find(x => x.kind === 'get');
    assert.deepEqual(Object.keys(c.query).sort(), ['endAt', 'startAt', 'timezone', 'unit'],
        'stats declares no extra params, so none may pass');
});

test('report bodies only carry allow-listed keys', async () => {
    const res = await call('POST', '/analytics/report/funnel', {
        steps: [{ type: 'path', value: '/a' }, { type: 'path', value: '/b' }],
        window: 60,
        websiteId: 'web_OTHER',
        evil: 'x',
    });
    assert.equal(res.status, 200);
    const c = umamiCalls.find(x => x.kind === 'post');
    assert.equal(c.path, '/api/reports/funnel');
    assert.equal(c.body.websiteId, 'web_1', 'websiteId is server-resolved');
    // Report options live under `parameters` in Umami 3.x, not at the top level.
    assert.equal(c.body.parameters.window, 60);
    assert.ok(Array.isArray(c.body.parameters.steps));
    assert.equal(c.body.parameters.evil, undefined);
    assert.equal(c.body.evil, undefined);
    assert.ok(c.body.dateRange?.startDate && c.body.dateRange?.endDate);
});

// Verified against a live Umami 3.2: omitting `type` or `filters`, or leaving
// the options at the top level instead of under `parameters`, is a hard 400.
test('report envelope matches the Umami 3.x contract', async () => {
    await call('POST', '/analytics/report/performance', { metric: 'lcp' });
    const c = umamiCalls.find(x => x.kind === 'post');
    assert.equal(c.body.type, 'performance', 'discriminator must equal the endpoint');
    assert.deepEqual(c.body.filters, {}, 'filters is required even when empty');
    // parameters repeats the window — dateRange alone is not accepted.
    assert.ok(c.body.parameters.startDate && c.body.parameters.endDate);
    assert.equal(c.body.parameters.metric, 'lcp');
});

test('filters are restricted to known dimensions', async () => {
    // GET filters ride as top-level params (Umami's own shape) — Express 5's
    // default query parser would not decode ?filters[country]=NL.
    await call('GET', '/analytics/query/stats?country=NL&evil=1');
    const c = umamiCalls.find(x => x.kind === 'get');
    assert.equal(c.query.country, 'NL');
    assert.equal(c.query.evil, undefined);
});

test('report filters ride nested in the JSON body', async () => {
    await call('POST', '/analytics/report/utm', { filters: { country: 'NL', evil: '1' } });
    const c = umamiCalls.find(x => x.kind === 'post');
    assert.deepEqual(c.body.filters, { country: 'NL' });
});

test('cache keys distinguish different filters', async () => {
    await call('GET', '/analytics/query/stats?country=NL');
    const afterNl = umamiCalls.length;
    await call('GET', '/analytics/query/stats?country=BE');
    assert.ok(umamiCalls.length > afterNl, 'a different filter must not reuse the cached answer');
});

// ── Degenerate states ───────────────────────────────────────────────

test('reports disabled/unconfigured/unprovisioned without calling Umami', async () => {
    configValues.set('cms_analytics_enabled', false);
    let res = await call('GET', '/analytics/overview');
    assert.deepEqual(res.json, { enabled: false });

    configValues.set('cms_analytics_enabled', true);
    configValues.set('cms_analytics_site_map', {});
    res = await call('GET', '/analytics/overview');
    assert.deepEqual(res.json, { enabled: true, configured: true, provisioned: false });
    assert.equal(umamiCalls.length, 0);
});

// ── Overview ────────────────────────────────────────────────────────

test('overview requests the v3 `path` dimension for top pages', async () => {
    await call('GET', '/analytics/overview');
    const types = umamiCalls.filter(c => c.kind === 'metrics').map(c => c.q.type);
    assert.ok(types.includes('path'), `expected a 'path' breakdown, got ${types.join(',')}`);
    assert.ok(!types.includes('url'), "'url' is the Umami 2.x name and 400s on 3.x");
});

test('a failing dimension is reported in partialErrors, not silently emptied', async () => {
    umamiHandler = ({ kind, q }) => {
        if (kind === 'metrics' && q.type === 'path') throw new Error('Umami GET /metrics → 400');
        return [];
    };
    const res = await call('GET', '/analytics/overview');
    assert.equal(res.status, 200, 'one bad dimension must not blank the page');
    assert.deepEqual(res.json.pages, []);
    const err = res.json.partialErrors.find(e => e.key === 'pages');
    assert.ok(err, 'the failure must surface so the UI can say so');
    assert.match(err.message, /400/);
});

test('a healthy overview reports no partial errors', async () => {
    const res = await call('GET', '/analytics/overview');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.partialErrors, []);
    assert.equal(res.json.active, 2);
});

// ── Caching ─────────────────────────────────────────────────────────

test('repeat queries are served from cache; fresh=1 bypasses', async () => {
    await call('GET', '/analytics/query/stats');
    const afterFirst = umamiCalls.length;

    const cached = await call('GET', '/analytics/query/stats');
    assert.equal(cached.json.cached, true);
    assert.equal(umamiCalls.length, afterFirst, 'cache hit must not call Umami');

    const fresh = await call('GET', '/analytics/query/stats?fresh=1');
    assert.notEqual(fresh.json.cached, true);
    assert.ok(umamiCalls.length > afterFirst);
});

// ── Drill-down filters actually reaching Umami ──────────────────────
//
// The filters were assembled, folded into the cache key, and then dropped on
// the floor for /metrics — so a filtered breakdown returned SITE-WIDE rows and
// stored them under a filter-specific key. Every drill-down chip on the
// dashboard was decorative.

test('a drill-down filter reaches the metrics call, not just the cache key', async () => {
    const res = await call('GET', '/analytics/query/metrics?type=path&country=NL');
    assert.equal(res.status, 200);
    const call1 = umamiCalls.find(c => c.kind === 'metrics');
    assert.equal(call1.q.filters?.country, 'NL',
        'the country filter must be handed to getMetrics, not silently discarded');
});

test('filters reach the overview fan-out too', async () => {
    const res = await call('GET', `/analytics/overview?siteId=${SITE_ID}&country=NL`);
    assert.equal(res.status, 200);
    assert.equal(umamiCalls.find(c => c.kind === 'stats').q.country, 'NL');
    assert.equal(umamiCalls.find(c => c.kind === 'pageviews').q.country, 'NL');
    assert.equal(umamiCalls.find(c => c.kind === 'metrics').q.filters?.country, 'NL');
});

test('window-less resources ignore filters and do not key the cache on the range', async () => {
    // realtime/active/daterange answer "right now" — forwarding a range or a
    // filter would only fragment the cache for a byte-identical payload.
    await call('GET', '/analytics/query/realtime?range=7d&country=NL');
    const first = umamiCalls.find(c => c.kind === 'get');
    assert.equal(first.query.country, undefined);
    assert.equal(first.query.startAt, undefined);

    umamiCalls = [];
    const second = await call('GET', '/analytics/query/realtime?range=30d&country=DE');
    assert.equal(second.json.cached, true, 'a different range must still hit the same cache entry');
    assert.equal(umamiCalls.length, 0);
});

// ── Report parameter names ──────────────────────────────────────────

test('heatmap forwards `mode`, and click/scroll do not share a cache entry', async () => {
    const clicks = await call('POST', '/analytics/report/heatmap', { siteId: SITE_ID, mode: 'click', urlPath: '/faq' });
    assert.equal(clicks.status, 200);
    const body = umamiCalls.find(c => c.kind === 'post').body;
    assert.equal(body.parameters.mode, 'click', 'Umami reads `mode`; `type` is ignored');

    umamiCalls = [];
    const scroll = await call('POST', '/analytics/report/heatmap', { siteId: SITE_ID, mode: 'scroll', urlPath: '/faq' });
    assert.notEqual(scroll.json.cached, true, 'scroll must not be served the click cache entry');
    assert.equal(umamiCalls.find(c => c.kind === 'post').body.parameters.mode, 'scroll');
});

test('a caller-supplied unit cannot clobber the derived window', async () => {
    await call('POST', '/analytics/report/performance', { siteId: SITE_ID, range: '7d', unit: 'minute' });
    const body = umamiCalls.find(c => c.kind === 'post').body;
    assert.equal(body.parameters.unit, 'day');
    assert.equal(body.dateRange.unit, 'day');
});

// ── Per-resource param vocabularies ─────────────────────────────────

test('event-data can be paged', async () => {
    // Without page/pageSize the proxy can only ever return Umami's first page,
    // so per-block event aggregation silently under-counts.
    await call('GET', '/analytics/query/event-data?event=cta_click&page=2&pageSize=100');
    const q = umamiCalls.find(c => c.kind === 'get').query;
    assert.equal(q.page, '2');
    assert.equal(q.pageSize, '100');
});

test('paging params are clamped', async () => {
    await call('GET', '/analytics/query/sessions?page=-3&pageSize=99999');
    const q = umamiCalls.find(c => c.kind === 'get').query;
    assert.equal(q.page, '1');
    assert.equal(q.pageSize, '500');
});

test('the dimension check applies to metrics/values only', async () => {
    // `segments` and `revenue-metrics` have their own `type` vocabulary;
    // validating theirs against METRIC_TYPES made them permanently unreachable.
    assert.equal((await call('GET', '/analytics/query/metrics?type=bogus')).status, 400);
    assert.equal((await call('GET', '/analytics/query/values?type=bogus')).status, 400);
    assert.equal((await call('GET', '/analytics/query/segments?type=segment')).status, 200);
});

// ── Recorder opt-in ─────────────────────────────────────────────────

test('recorder toggle stores the opt-in and mirrors it to Umami', async () => {
    const res = await call('PUT', '/analytics/recorder', { siteId: SITE_ID, enabled: true });
    assert.equal(res.status, 200);
    assert.equal(res.json.recording, true);
    assert.deepEqual(configValues.get('cms_analytics_recorder_map'), { [SITE_ID]: true });
    const up = umamiCalls.find(c => c.kind === 'updateWebsite');
    assert.equal(up.patch.replayConfig.replayEnabled, true, 'must send replayConfig, not recorderEnabled');
    assert.equal(up.patch.recorderEnabled, undefined);
    assert.equal(res.json.upstreamWarning, null, 'read-back confirmed it stuck');

    const off = await call('PUT', '/analytics/recorder', { siteId: SITE_ID, enabled: false });
    assert.equal(off.json.recording, false);
    assert.deepEqual(configValues.get('cms_analytics_recorder_map'), {});
});

test('recorder toggle refuses an untracked or malformed site', async () => {
    assert.equal((await call('PUT', '/analytics/recorder', { siteId: 'nope', enabled: true })).status, 400);
    assert.equal((await call('PUT', '/analytics/recorder', { siteId: 'pj_bbbb2222', enabled: true })).status, 409);
});

test('a rejected recorder change is NOT persisted', async () => {
    // The dangerous order is config-then-upstream: the public site would load
    // recorder.js, Umami would discard every /api/record, and this dashboard
    // would report "Recording on" while capturing nothing.
    const original = mockUmami.updateWebsite;
    mockUmami.updateWebsite = async (websiteId, patch) => {
        umamiCalls.push({ kind: 'updateWebsite', websiteId, patch });
        return { id: websiteId, recorderEnabled: false };   // Umami ignored it
    };
    try {
        const res = await call('PUT', '/analytics/recorder', { siteId: SITE_ID, enabled: true });
        assert.equal(res.status, 502);
        assert.equal(res.json.success, false);
        assert.equal(res.json.recording, false);
        assert.ok(/did not apply|rejected/i.test(res.json.error));
        assert.equal(configValues.get('cms_analytics_recorder_map'), null,
            'a rejected opt-in must not be written to config');
    } finally {
        mockUmami.updateWebsite = original;
    }
});

// ── Tracker + recorder options ──────────────────────────────────────

test('tracker options round-trip and default to sane values', async () => {
    const initial = await call('GET', '/analytics/settings');
    // excludeHash defaults ON: otherwise /pricing#plans and /pricing count as
    // two different pages and every per-page number is diluted.
    assert.deepEqual(initial.json.tracker, {
        tag: '', excludeSearch: false, excludeHash: true, doNotTrack: false, domains: '',
    });
    assert.deepEqual(initial.json.recorder, { sampleRate: 1, maskLevel: 'strict' });

    const saved = await call('PUT', '/analytics/settings', {
        tracker: { tag: 'staging', excludeSearch: true, domains: 'example.com' },
        recorder: { sampleRate: 0.5, maskLevel: 'moderate' },
    });
    assert.equal(saved.json.tracker.tag, 'staging');
    assert.equal(saved.json.tracker.excludeSearch, true);
    assert.equal(saved.json.tracker.excludeHash, true, 'untouched keys keep their value');
    assert.equal(saved.json.recorder.sampleRate, 0.5);
    assert.equal(saved.json.recorder.maskLevel, 'moderate');
});

// Regression: the mask vocabulary used to be our own invention
// ('strict' | 'balanced' | 'off'). Only 'strict' overlapped with Umami's enum,
// so picking either other option 400'd upstream with the failure buried in a
// nested `properties.replayConfig.properties.maskLevel` error. The offered list
// must be exactly what the client will accept.
test('offered mask levels are exactly the ones Umami accepts', async () => {
    const res = await call('GET', '/analytics/settings');
    assert.deepEqual(res.json.maskLevels, ['strict', 'moderate']);
    // Every level we advertise must survive the client untouched — if one gets
    // coerced, we are offering the operator a choice that silently does nothing.
    for (const level of res.json.maskLevels) {
        assert.equal(mockUmami.buildReplayConfig({ enabled: true, maskLevel: level }).maskLevel, level);
    }
});

test('invalid recorder options fall back instead of reaching Umami', async () => {
    await call('PUT', '/analytics/settings', { recorder: { sampleRate: 99, maskLevel: 'nonsense' } });
    const res = await call('GET', '/analytics/settings');
    assert.equal(res.json.recorder.sampleRate, 1);
    assert.equal(res.json.recorder.maskLevel, 'strict');
});

test('settings never echo a stored secret, only whether one exists', async () => {
    await call('PUT', '/analytics/settings', { apiToken: 'super-secret-token' });
    const res = await call('GET', '/analytics/settings');
    assert.deepEqual(res.json.storedCredentials, { username: false, password: false, apiToken: true });
    assert.ok(!JSON.stringify(res.json).includes('super-secret-token'));
});

test('the recorder toggle uses the operator\'s sampling and masking', async () => {
    await call('PUT', '/analytics/settings', { recorder: { sampleRate: 0.25, maskLevel: 'moderate' } });
    await call('PUT', '/analytics/recorder', { siteId: SITE_ID, enabled: true });
    const up = umamiCalls.find(c => c.kind === 'updateWebsite');
    assert.equal(up.patch.replayConfig.sampleRate, 0.25);
    assert.equal(up.patch.replayConfig.maskLevel, 'moderate');
});

// A level persisted by an older build ('balanced'/'off' from the vocabulary we
// used to invent) must never reach Umami and 400 the toggle. getRecorderOptions
// drops it on read; buildReplayConfig is the second line of defence, pinned
// against the real client in core/umamiClient.test.js.
test('a stale stored mask level never reaches Umami', async () => {
    configValues.set('cms_analytics_recorder_opts', { sampleRate: 0.5, maskLevel: 'balanced' });
    await call('PUT', '/analytics/recorder', { siteId: SITE_ID, enabled: true });
    const up = umamiCalls.find(c => c.kind === 'updateWebsite');
    assert.equal(up.patch.replayConfig.maskLevel, 'strict');
});

// ── Diagnose ────────────────────────────────────────────────────────

test('diagnose walks the chain and names what is broken', async () => {
    const res = await call('GET', '/analytics/diagnose');
    assert.equal(res.status, 200);
    const byId = Object.fromEntries(res.json.checks.map(c => [c.id, c]));
    assert.equal(byId.enabled.status, 'pass');
    assert.equal(byId.configured.status, 'pass');
    assert.equal(byId.provisioned.status, 'pass');
    // Cookie mode is a warning, not a failure: it works, it just means nothing
    // is counted until a visitor accepts — the single most common "why is my
    // dashboard empty" cause.
    assert.equal(byId.consent.status, 'pass', 'cookieless is the default');

    configValues.set('cms_analytics_consent_mode', 'cookies');
    const warned = await call('GET', '/analytics/diagnose');
    const consent = warned.json.checks.find(c => c.id === 'consent');
    assert.equal(consent.status, 'warn');
    assert.match(consent.detail, /Accept/);
});

test('diagnose skips dependent checks once something upstream fails', async () => {
    configValues.set('cms_analytics_enabled', false);
    configValues.delete('cms_analytics_url');
    const prevConfigured = mockUmami.isConfigured;
    mockUmami.isConfigured = async () => false;
    try {
        const res = await call('GET', '/analytics/diagnose');
        const byId = Object.fromEntries(res.json.checks.map(c => [c.id, c]));
        assert.equal(byId.enabled.status, 'fail');
        assert.equal(byId.configured.status, 'fail');
        assert.equal(byId.reachable.status, 'skip', 'do not report a connection failure caused by missing config');
        assert.equal(byId.script.status, 'skip');
    } finally {
        mockUmami.isConfigured = prevConfigured;
    }
});

// ── Sites + status ──────────────────────────────────────────────────

test('sites lists tracking + recording state', async () => {
    configValues.set('cms_analytics_recorder_map', { [SITE_ID]: true });
    const res = await call('GET', '/analytics/sites');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.sites, [{
        id: SITE_ID, name: 'Test site', live: true,
        tracked: true, websiteId: 'web_1', recording: true,
    }]);
});

test('status surfaces the internal vs public URL split', async () => {
    const prev = process.env.UMAMI_URL;
    process.env.UMAMI_URL = 'http://umami:3000';
    try {
        const res = await call('GET', '/analytics/status');
        assert.equal(res.json.publicUrl, 'https://stats.example.com');
        assert.equal(res.json.internalUrl, 'http://umami:3000');
        assert.equal(res.json.usingInternalOverride, true);
        assert.equal(res.json.reachable, true);
        assert.equal(res.json.websiteCount, 1);
    } finally {
        if (prev === undefined) delete process.env.UMAMI_URL; else process.env.UMAMI_URL = prev;
    }
});
