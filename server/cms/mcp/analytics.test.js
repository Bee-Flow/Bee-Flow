/**
 * CMS MCP analytics tools: the six cms_analytics_* tools against a fake Umami.
 *
 * The point of these tests is the privacy contract: whatever Umami sends, the
 * result holds only allow-listed aggregates. The fake answers carry session ids,
 * IPs, user agents, ?query=email, cities and event properties on purpose.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCmsMcp, ANALYTICS_MAX_PER_WINDOW } = require('./dispatch');
const { ANALYTICS_TOOLS } = require('./tools');
const { createAnalyticsQueries } = require('../../core/cms/analyticsQueries');
const { TOOL_SCHEMAS } = require('../../cmsBuilder/schemas');
const { isSuperAdminUser } = require('../../auth/permissions');
const { classifyRpc, parseToolCall, PROTOCOL_VERSION, INVALID_REQUEST } = require('../../routes/mcpServer');

const SITE = 'pj_aaaa1111';
const SITE_ID_RE = /^pj_[a-f0-9]{4,}$/;

const stubAccess = {
    scopeAllowsTool(scopes, server, name, { readOnly = false, publish = false } = {}) {
        const spec = scopes && scopes[server];
        if (!spec) return false;
        if (spec.level === 'read' && !readOnly) return false;
        if (publish && spec.publish !== true) return false;
        if (Array.isArray(spec.tools) && !spec.tools.includes(name)) return false;
        return true;
    },
    filterToolsByScope(scopes, server, tools, { isReadOnly, isPublish }) {
        return tools.filter((t) => stubAccess.scopeAllowsTool(scopes, server, t.name, { readOnly: isReadOnly(t), publish: isPublish(t) }));
    },
};

// What Umami might send, with everything that must never reach the model.
const LEAKY = {
    stats: {
        pageviews: { value: 1200, prev: 900 }, visitors: { value: 300, prev: 250 },
        visits: { value: 400, prev: 320 }, bounces: { value: 100, prev: 96 }, totaltime: { value: 48000, prev: 32000 },
        sessionId: 'sess_secret', ip: '203.0.113.9',
    },
    pageviews: {
        pageviews: [{ x: '2026-10-01', y: 10, sessionId: 'sess_secret' }, { x: '2026-10-02', y: 20 }],
        sessions: [{ x: '2026-10-01', y: 4 }, { x: '2026-10-02', y: 8 }],
        ip: '203.0.113.9',
    },
    paths: [
        { x: '/pricing?email=jane@example.nl&utm=x', y: 5, sessionId: 'sess_secret', ip: '203.0.113.9' },
        { x: '/pricing#section', y: 3, userAgent: 'Mozilla/5.0 (X11)' },
        { x: 'https://bee.example/unsubscribe/jane@example.nl?token=abc', y: 2, city: 'Utrecht' },
        { x: '/', y: 1 },
    ],
    referrers: [
        { x: 'https://www.google.com/search?q=secret+person', y: 6 },
        { x: 'https://news.example.org/a/b?c=d#e', y: 2 },
        { x: '', y: 4 },
    ],
    countries: [{ x: 'NL', y: 7, city: 'Utrecht', ip: '203.0.113.9' }],
    events: [{ x: 'cta_click', y: 9, eventData: { email: 'jane@example.nl' }, sessionId: 'sess_secret' }],
    realtime: {
        urls: { '/pricing?visitor=jane@example.nl': 3, '/': 1 },
        referrers: { 'google.com': 2 },
        countries: { NL: 4 },
        totals: { views: 12, visitors: 5, events: 2 },
        events: [{ sessionId: 'sess_secret', ip: '203.0.113.9', userAgent: 'Mozilla', city: 'Utrecht', urlPath: '/x?e=a@b.nl' }],
        series: { views: [], visitors: [] },
    },
    performance: {
        summary: { lcp: { p50: 1800, p75: 2400, p95: 4100 }, inp: { p50: 90, p75: 150, p95: 300 }, cls: { p50: 0.01, p75: 0.05, p95: 0.2 }, count: 33, sessionId: 'sess_secret' },
        pages: [{ name: '/pricing?q=jane@example.nl', p75: 3100, count: 12, ip: '203.0.113.9' }, { name: '/', p75: 1500, count: 21 }],
        devices: [{ name: 'mobile', p75: 2800 }],
        chart: [], sessions: [{ id: 'sess_secret' }],
    },
    breakdown: [
        { path: '/pricing?email=jane@example.nl', visits: 30, views: 40, sessionId: 'sess_secret' },
        { path: '/', visits: 50, views: 60 },
    ],
};

const SECRETS = ['sess_secret', '203.0.113.9', 'Mozilla', 'jane@example.nl', 'Utrecht', 'token=abc', 'secret+person', 'email=', '?', '#'];
function assertNoLeak(value) {
    const json = JSON.stringify(value);
    for (const needle of SECRETS) assert.ok(!json.includes(needle), `result must not contain ${needle}: ${json}`);
}

function makeUmami(over = {}) {
    const calls = [];
    const umami = {
        calls,
        isConfigured: async () => true,
        getStats: async (id, q) => { calls.push(['stats', id, q]); return LEAKY.stats; },
        getPageviews: async (id, q) => { calls.push(['pageviews', id, q]); return LEAKY.pageviews; },
        getMetrics: async (id, q) => {
            calls.push(['metrics', id, q]);
            if (q.type === 'path') return LEAKY.paths;
            if (q.type === 'referrer') return LEAKY.referrers;
            if (q.type === 'country') return LEAKY.countries;
            if (q.type === 'event') return LEAKY.events;
            return [];
        },
        getActive: async () => ({ visitors: 5 }),
        get: async (path) => { calls.push(['get', path]); return LEAKY.realtime; },
        post: async (path, body) => {
            calls.push(['post', path, body]);
            return path.endsWith('/performance') ? LEAKY.performance : LEAKY.breakdown;
        },
        ...over,
    };
    return umami;
}

function makeHarness({ umamiOver, config = {}, superAdmin = isSuperAdminUser, wire = true } = {}) {
    const store = new Map(Object.entries({
        cms_analytics_enabled: true,
        cms_analytics_consent_mode: 'cookieless',
        cms_analytics_site_map: { [SITE]: 'web_1' },
        ...config,
    }));
    const umami = makeUmami(umamiOver);
    const analytics = createAnalyticsQueries({
        configStore: { getConfig: async (k) => (store.has(k) ? store.get(k) : null) },
        umamiClient: umami,
        getLiveSiteId: async () => SITE,
        siteIdRe: SITE_ID_RE,
    });
    let nowMs = Date.parse('2026-10-11T12:00:00Z');
    const mcp = createCmsMcp({
        cmsStore: {}, cmsParts: {}, builder: { TOOL_SCHEMAS, MUTATING_TOOLS: new Set(), applyToolCall: async () => ({}) },
        validateDraft: () => ({ errors: [], warnings: [] }), defaults: {}, access: stubAccess,
        live: { getLiveSiteId: async () => SITE, SITE_ID_RE },
        tickets: {}, screenshots: {}, storage: {}, audit: async () => {},
        isAdmin: async (u) => u.role === 'admin' || u.role === 'cms_admin',
        isSuperAdmin: superAdmin,
        ...(wire ? { analytics: { analytics, umami } } : {}),
        rpc: { classifyRpc, parseToolCall, PROTOCOL_VERSION, INVALID_REQUEST },
        now: () => nowMs,
    });
    return { mcp, umami, store, tick: (ms) => { nowMs += ms; } };
}

const FULL = { cms: { level: 'write', publish: true } };
const READ = { cms: { level: 'read' } };
const ctxOf = (scopes, user = { id: 'u1', role: 'admin' }) => ({ user, userId: user.id, orgId: 'org1', token: { name: 't', scopes } });
const call = async (mcp, ctx, name, args = {}) => {
    const res = await mcp.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, ctx);
    return { isError: res.result.isError, text: res.result.content[0].text, json: () => JSON.parse(res.result.content[0].text) };
};
const listNames = async (mcp, ctx) =>
    (await mcp.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctx)).result.tools.map((t) => t.name);

// ── access ───────────────────────────────────────────────────────────

test('the six analytics tools are advertised to a super admin, also on a read-level token', async () => {
    const { mcp } = makeHarness();
    for (const scopes of [FULL, READ]) {
        const names = await listNames(mcp, ctxOf(scopes));
        for (const n of ANALYTICS_TOOLS) assert.ok(names.includes(n), `${n} listed`);
    }
    assert.equal(ANALYTICS_TOOLS.size, 6);
});

test('all analytics tools are classified read-only', async () => {
    const { mcp } = makeHarness();
    for (const n of ANALYTICS_TOOLS) assert.deepEqual(mcp.classify(n), { readOnly: true, publish: false });
    const tools = (await mcp.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctxOf(FULL))).result.tools;
    for (const t of tools.filter((x) => ANALYTICS_TOOLS.has(x.name))) assert.equal(t.annotations.readOnlyHint, true);
});

test('a CMS admin who is not a super admin neither sees nor can call the analytics tools', async () => {
    const { mcp, umami } = makeHarness();
    const ctx = ctxOf(FULL, { id: 'u2', role: 'cms_admin' });
    const names = await listNames(mcp, ctx);
    assert.ok(names.includes('cms_list_sites'), 'other CMS tools are still there');
    for (const n of ANALYTICS_TOOLS) {
        assert.ok(!names.includes(n), `${n} hidden`);
        const out = await call(mcp, ctx, n, { type: 'url' });
        assert.equal(out.isError, true);
        assert.match(out.text, /super administrator/);
    }
    assert.equal(umami.calls.length, 0, 'Umami was never asked');
});

test('the gate is the requireSuperAdmin predicate', () => {
    assert.equal(isSuperAdminUser({ role: 'admin' }), true);
    assert.equal(isSuperAdminUser({ role: 'org_admin' }), false);
    assert.equal(isSuperAdminUser(null), false);
});

test('a host that wires no isSuperAdmin hides the tools from everyone', async () => {
    const { mcp } = makeHarness({ superAdmin: null });
    const names = await listNames(mcp, ctxOf(FULL));
    for (const n of ANALYTICS_TOOLS) assert.ok(!names.includes(n));
});

test('a per-server tool allow-list narrows the analytics tools too', async () => {
    const { mcp } = makeHarness();
    const names = await listNames(mcp, ctxOf({ cms: { level: 'read', tools: ['cms_analytics_overview'] } }));
    assert.deepEqual(names, ['cms_analytics_overview']);
    const refused = await call(mcp, ctxOf({ cms: { level: 'read', tools: ['cms_analytics_overview'] } }), 'cms_analytics_realtime');
    assert.equal(refused.isError, true);
});

test('without the Umami side wired the tools are refused plainly', async () => {
    const { mcp } = makeHarness({ wire: false });
    const out = await call(mcp, ctxOf(FULL), 'cms_analytics_overview');
    assert.equal(out.isError, true);
    assert.match(out.text, /not available/);
});

test('budget: 60 calls per 10 minutes per user, then a polite sentence, then it refills', async () => {
    const { mcp, tick } = makeHarness();
    const ctx = ctxOf(FULL);
    for (let i = 0; i < ANALYTICS_MAX_PER_WINDOW; i++) {
        assert.equal((await call(mcp, ctx, 'cms_analytics_status')).isError, false);
    }
    const over = await call(mcp, ctx, 'cms_analytics_status');
    assert.equal(over.isError, false);
    assert.match(over.text, /budget spent/i);
    assert.equal((await call(mcp, ctxOf(FULL, { id: 'u9', role: 'admin' }), 'cms_analytics_status')).isError, false, 'another user is unaffected');
    tick(10 * 60 * 1000 + 1);
    assert.doesNotMatch((await call(mcp, ctx, 'cms_analytics_status')).text, /budget spent/i);
});

// ── not configured ───────────────────────────────────────────────────

test('analytics off, unconfigured or untracked: a plain sentence, not an error', async () => {
    const cases = [
        [{ config: { cms_analytics_enabled: false } }, 'disabled', /switched off/],
        [{ umamiOver: { isConfigured: async () => false } }, 'unconfigured', /no credentials/],
        [{ config: { cms_analytics_site_map: {} } }, 'unprovisioned', /No site is being tracked/],
    ];
    for (const [opts, state, re] of cases) {
        const { mcp, umami } = makeHarness(opts);
        for (const tool of ['cms_analytics_overview', 'cms_analytics_pageviews', 'cms_analytics_metrics', 'cms_analytics_realtime', 'cms_analytics_vitals']) {
            const out = await call(mcp, ctxOf(FULL), tool, { type: 'url' });
            assert.equal(out.isError, false, `${tool} ${state}`);
            assert.match(out.text, re);
        }
        const st = await call(mcp, ctxOf(FULL), 'cms_analytics_status');
        assert.equal(st.isError, false);
        assert.match(st.text, re);
        assert.equal(umami.calls.length, 0, 'no data call was made');
    }
});

test('status: ready names the tracked site and exposes no credentials or URLs', async () => {
    const { mcp } = makeHarness({ config: { cms_analytics_url: 'https://user:pw@umami.internal', cms_analytics_api_token: 'tok_secret' } });
    const out = await call(mcp, ctxOf(FULL), 'cms_analytics_status');
    const json = out.json();
    assert.deepEqual(Object.keys(json).sort(), ['configured', 'consentMode', 'enabled', 'message', 'siteId', 'state', 'tracked']);
    assert.equal(json.state, 'ready');
    assert.equal(json.siteId, SITE);
    assert.ok(!out.text.includes('umami.internal') && !out.text.includes('tok_secret') && !out.text.includes('pw@'));
});

// ── tools ────────────────────────────────────────────────────────────

test('overview: totals, derived rates and the previous period', async () => {
    const { mcp, umami } = makeHarness();
    const out = await call(mcp, ctxOf(FULL), 'cms_analytics_overview', { range: '30d' });
    const j = out.json();
    assert.equal(j.siteId, SITE);
    assert.equal(j.range, '30d');
    assert.deepEqual(j.visitors, { value: 300, previous: 250 });
    assert.deepEqual(j.pageviews, { value: 1200, previous: 900 });
    assert.deepEqual(j.visits, { value: 400, previous: 320 });
    assert.deepEqual(j.bounceRatePercent, { value: 25, previous: 30 });
    assert.deepEqual(j.avgVisitSeconds, { value: 120, previous: 100 });
    assertNoLeak(j);
    const q = umami.calls.find((c) => c[0] === 'stats');
    assert.equal(q[1], 'web_1');
    assert.equal(q[2].endAt - q[2].startAt, 30 * 86400000);
});

test('overview: the older `comparison` shape gives the same previous numbers', async () => {
    const { mcp } = makeHarness({ umamiOver: {
        getStats: async () => ({ pageviews: 10, visitors: 5, visits: 8, bounces: 4, totaltime: 800, comparison: { pageviews: 20, visitors: 6, visits: 10, bounces: 5, totaltime: 1500 } }),
    } });
    const j = (await call(mcp, ctxOf(FULL), 'cms_analytics_overview')).json();
    assert.deepEqual(j.visitors, { value: 5, previous: 6 });
    assert.deepEqual(j.bounceRatePercent, { value: 50, previous: 50 });
    assert.deepEqual(j.avgVisitSeconds, { value: 100, previous: 150 });
});

test('range handling: default 7d, today, custom ISO window, and bad input', async () => {
    const { mcp, umami } = makeHarness();
    const ctx = ctxOf(FULL);
    await call(mcp, ctx, 'cms_analytics_overview');
    const seven = umami.calls.at(-1)[2];
    assert.equal(seven.endAt - seven.startAt, 7 * 86400000);

    const today = (await call(mcp, ctx, 'cms_analytics_pageviews', { range: 'today' })).json();
    assert.equal(today.unit, 'hour');
    assert.equal(today.from, '2026-10-11T00:00:00.000Z');

    const custom = (await call(mcp, ctx, 'cms_analytics_pageviews', { startAt: '2026-09-01', endAt: '2026-09-20' })).json();
    assert.equal(custom.range, 'custom');
    assert.equal(custom.unit, 'day');

    for (const bad of [{ range: 'forever' }, { startAt: '2026-09-01' }, { startAt: 'x', endAt: 'y' }, { startAt: '2026-09-02', endAt: '2026-09-01' }, { startAt: '2024-01-01', endAt: '2026-01-01' }]) {
        const out = await call(mcp, ctx, 'cms_analytics_overview', bad);
        assert.equal(out.isError, true, JSON.stringify(bad));
    }
    assert.equal((await call(mcp, ctx, 'cms_analytics_overview', { siteId: 'nope' })).isError, true);
});

test('pageviews: a merged series of pageviews and sessions per bucket, nothing else', async () => {
    const { mcp } = makeHarness();
    const j = (await call(mcp, ctxOf(FULL), 'cms_analytics_pageviews')).json();
    assert.deepEqual(j.series, [
        { time: '2026-10-01', pageviews: 10, sessions: 4 },
        { time: '2026-10-02', pageviews: 20, sessions: 8 },
    ]);
    assertNoLeak(j);
});

test('metrics url: paths lose query and hash, merge, and no email survives', async () => {
    const { mcp } = makeHarness();
    const j = (await call(mcp, ctxOf(FULL), 'cms_analytics_metrics', { type: 'url' })).json();
    assert.deepEqual(j.rows, [
        { name: '/pricing', count: 8 },
        { name: '/unsubscribe/[removed]', count: 2 },
        { name: '/', count: 1 },
    ]);
    for (const r of j.rows) assert.deepEqual(Object.keys(r), ['name', 'count']);
    assertNoLeak(j);
});

test('metrics referrer: reduced to the domain, direct labelled', async () => {
    const { mcp } = makeHarness();
    const j = (await call(mcp, ctxOf(FULL), 'cms_analytics_metrics', { type: 'referrer' })).json();
    assert.deepEqual(j.rows, [{ name: 'google.com', count: 6 }, { name: '(direct)', count: 4 }, { name: 'news.example.org', count: 2 }]);
    assertNoLeak(j);
});

test('metrics country, event and limit', async () => {
    const { mcp, umami } = makeHarness();
    const ctx = ctxOf(FULL);
    const c = (await call(mcp, ctx, 'cms_analytics_metrics', { type: 'country' })).json();
    assert.deepEqual(c.rows, [{ name: 'NL', count: 7 }]);
    assertNoLeak(c);
    const e = (await call(mcp, ctx, 'cms_analytics_metrics', { type: 'event' })).json();
    assert.deepEqual(e.rows, [{ name: 'cta_click', count: 9 }]);
    assertNoLeak(e);
    const one = (await call(mcp, ctx, 'cms_analytics_metrics', { type: 'url', limit: 1 })).json();
    assert.equal(one.rows.length, 1);
    assert.ok(umami.calls.some((x) => x[0] === 'metrics' && x[2].type === 'country'));
});

test('metrics entry: landing pages by visits, from the breakdown report', async () => {
    const { mcp, umami } = makeHarness();
    const j = (await call(mcp, ctxOf(FULL), 'cms_analytics_metrics', { type: 'entry' })).json();
    assert.deepEqual(j.rows, [{ name: '/', count: 50 }, { name: '/pricing', count: 30 }]);
    assertNoLeak(j);
    const post = umami.calls.find((c) => c[0] === 'post');
    assert.equal(post[1], '/api/reports/breakdown');
    assert.deepEqual(post[2].parameters.fields, ['path']);
});

test('metrics channel: direct from the totals, referrers bucketed', async () => {
    const { mcp } = makeHarness();
    const j = (await call(mcp, ctxOf(FULL), 'cms_analytics_metrics', { type: 'channel' })).json();
    const by = Object.fromEntries(j.rows.map((r) => [r.name, r.count]));
    assert.equal(by.Search, 6);
    assert.equal(by.Referral, 2);
    assert.ok(by.Direct >= 4);
    assertNoLeak(j);
});

test('metrics: only allow-listed types and a sane limit', async () => {
    const { mcp, umami } = makeHarness();
    const ctx = ctxOf(FULL);
    for (const bad of [{ type: 'city' }, { type: 'distinctId' }, { type: 'session' }, { type: 'query' }, { type: 'hostname' }, {}, { type: 'url', limit: 51 }, { type: 'url', limit: 0 }, { type: 'url', limit: '5' }]) {
        const out = await call(mcp, ctx, 'cms_analytics_metrics', bad);
        assert.equal(out.isError, true, JSON.stringify(bad));
    }
    assert.equal(umami.calls.length, 0);
});

test('metrics: every advertised type is accepted', async () => {
    const { mcp } = makeHarness();
    const tool = (await mcp.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctxOf(FULL))).result.tools.find((t) => t.name === 'cms_analytics_metrics');
    for (const type of tool.inputSchema.properties.type.enum) {
        const out = await call(mcp, ctxOf(FULL), 'cms_analytics_metrics', { type });
        assert.equal(out.isError, false, type);
    }
    assert.ok(!tool.inputSchema.properties.type.enum.includes('city'));
});

test('realtime: counts and clean active pages, no events, sessions or locations', async () => {
    const { mcp } = makeHarness();
    const j = (await call(mcp, ctxOf(FULL), 'cms_analytics_realtime')).json();
    assert.deepEqual(j, {
        siteId: SITE,
        activeVisitors: 5,
        activePages: [{ name: '/pricing', count: 3 }, { name: '/', count: 1 }],
        last30Minutes: { pageviews: 12, visitors: 5, events: 2 },
    });
    assertNoLeak(j);
});

test('vitals: percentiles and slowest pages by clean path only', async () => {
    const { mcp, umami } = makeHarness();
    const j = (await call(mcp, ctxOf(FULL), 'cms_analytics_vitals')).json();
    assert.equal(j.samples, 33);
    assert.deepEqual(j.vitals.lcp, { p50: 1800, p75: 2400, p95: 4100 });
    assert.deepEqual(j.slowestPages, [
        { path: '/pricing', lcpP75Ms: 3100, samples: 12 },
        { path: '/', lcpP75Ms: 1500, samples: 21 },
    ]);
    assert.deepEqual(Object.keys(j.slowestPages[0]), ['path', 'lcpP75Ms', 'samples']);
    assertNoLeak(j);
    const post = umami.calls.find((c) => c[0] === 'post');
    assert.equal(post[1], '/api/reports/performance');
    assert.equal(post[2].websiteId, 'web_1');
});

test('vitals: nothing measured is a sentence, not zeros', async () => {
    const { mcp } = makeHarness({ umamiOver: { post: async () => ({ summary: { lcp: { p75: 0 }, count: 0 } }) } });
    const out = await call(mcp, ctxOf(FULL), 'cms_analytics_vitals');
    assert.equal(out.isError, false);
    assert.match(out.text, /No web-vitals samples/);
});

test('an Umami failure is a plain sentence that does not repeat the upstream text', async () => {
    const { mcp } = makeHarness({ umamiOver: { getStats: async () => { throw new Error('connect ECONNREFUSED http://admin:pw@umami:3000'); } } });
    const out = await call(mcp, ctxOf(FULL), 'cms_analytics_overview');
    assert.equal(out.isError, true);
    assert.match(out.text, /did not answer/);
    assert.ok(!out.text.includes('ECONNREFUSED') && !out.text.includes('pw@'));
});

test('a site that is not tracked falls back like the dashboard (live, then first)', async () => {
    const { mcp } = makeHarness({ config: { cms_analytics_site_map: { pj_bbbb2222: 'web_9' } } });
    const j = (await call(mcp, ctxOf(FULL), 'cms_analytics_overview', { siteId: 'pj_cccc3333' })).json();
    assert.equal(j.siteId, 'pj_bbbb2222');
});
