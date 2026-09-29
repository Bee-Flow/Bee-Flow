/**
 * Route tests for GET /api/studio-apps/usage-counts (routes/studioAppUsage.js).
 *
 * The stores and the audience helper are mocked via the Module._resolveFilename
 * harness (same pattern as studioApps.test.js) so no DB is opened; auth runs
 * for REAL (auth/permissions.requireAuth over a mocked userStore), because
 * "who may ask" is half of what this route is.
 *
 * Run: node --test routes/studioAppUsage.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('module');

// ── Fixtures ────────────────────────────────────────────────────────

const USERS = {
    // Sees two apps: one that ran, one that never did.
    alice: { id: 'alice', displayName: 'Alice', organizationId: 'orgA', groups: ['grp-a'] },
    // Another org entirely — must not learn anything about orgA's apps.
    bob: { id: 'bob', displayName: 'Bob', organizationId: 'orgB', groups: ['grp-b'] },
};

// What each caller may SEE — the directory's own visibility predicate stands in
// for getAccessibleStudioApps here; its correctness is studioAppStore's job.
const VISIBLE = {
    alice: [{ id: 'app-ran' }, { id: 'app-quiet' }],
    bob: [{ id: 'app-bob' }],
};

// Rows that exist in ai_usage_log, keyed by app. `app-quiet` is deliberately
// absent: an app nobody pressed.
const RUNS = { 'app-ran': 12, 'app-bob': 1 };

const calls = { visibility: [], usage: [] };

const mockStudioAppStore = {
    async getAccessibleStudioApps(userId, userGroups, orgIds) {
        calls.visibility.push({ userId, userGroups, orgIds });
        return (VISIBLE[userId] || []).map(a => ({ ...a }));
    },
};

const mockUsageStore = {
    RUN_COUNT_WINDOWS: { month: "date_trunc('month', NOW())" },
    async getStudioAppRunCounts(appIds, opts) {
        calls.usage.push({ appIds, opts });
        return new Map((appIds || []).map(id => [id, RUNS[id] || 0]));
    },
};

const mockUserStore = {
    async getUser(id) { return USERS[id] || null; },
};

const mockAudience = {
    async resolveAudienceContext(req) {
        const u = USERS[req.session?.user?.id];
        return {
            userId: u ? u.id : null,
            orgIds: u ? new Set([u.organizationId]) : new Set(),
            userGroups: u ? u.groups : [],
        };
    },
};

// ── Require-cache injection (before the router loads) ───────────────

const MOCKS = {
    '../stores/studioAppStore': mockStudioAppStore,
    '../stores/usageStore': mockUsageStore,
    '../stores/userStore': mockUserStore,
    '../auth/audience': mockAudience,
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) return MOCK_IDS[request];
    return originalResolve.call(this, request, parent, ...rest);
};

const express = require('express');
const router = require('./studioAppUsage');

// ── HTTP harness ────────────────────────────────────────────────────

let server;
let baseUrl;

test.before(async () => {
    const app = express();
    // Session stand-in: x-test-user selects one of the USERS fixtures.
    app.use((req, res, next) => {
        const uid = req.headers['x-test-user'];
        if (uid && USERS[uid]) req.session = { isAuthenticated: true, user: { id: uid } };
        next();
    });
    app.use('/api/studio-apps', router);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/api/studio-apps`;
});

test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
});

async function api(pathStr, { user } = {}) {
    const headers = {};
    if (user) headers['x-test-user'] = user;
    const res = await fetch(`${baseUrl}${pathStr}`, { headers });
    let body = null;
    try { body = await res.json(); } catch (_) { /* empty body */ }
    return { status: res.status, body };
}

test.beforeEach(() => { calls.visibility = []; calls.usage = []; });

test('an anonymous caller gets nothing', async () => {
    const res = await api('/usage-counts');
    assert.strictEqual(res.status, 401);
    assert.strictEqual(calls.usage.length, 0, 'no aggregate is computed for a caller we do not know');
});

test('the caller gets a count for every app they may see — zero included', async () => {
    const res = await api('/usage-counts', { user: 'alice' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.counts, { 'app-ran': 12, 'app-quiet': 0 },
        'an app nobody pressed is 0, not missing — the tile may say "0 actions", never nothing');
});

test('the number is asked per APP, never per viewer', async () => {
    // De valkuil uit APPS-08: de verbruiksrijen staan op de EIGENAAR van de
    // app. Zodra de kijker het filter wordt, telt elke app op nul voor iedereen
    // behalve de bouwer — en nul is een geldig getal, dus dat ziet niemand.
    await api('/usage-counts', { user: 'alice' });
    assert.strictEqual(calls.usage.length, 1);
    const { appIds, opts } = calls.usage[0];
    assert.deepStrictEqual(appIds, ['app-ran', 'app-quiet']);
    const passed = JSON.stringify(opts || {});
    assert.ok(!passed.includes('alice'), `the viewer must not narrow the aggregate (got ${passed})`);
});

test('an app the caller may not see is absent, not zero', async () => {
    const res = await api('/usage-counts', { user: 'bob' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(Object.keys(res.body.counts), ['app-bob']);
    assert.ok(!('app-ran' in res.body.counts),
        'answering 0 for someone else\'s app would confirm that the id exists');
    // The visibility question is asked with the CALLER's own audience.
    assert.deepStrictEqual(calls.visibility[0], { userId: 'bob', userGroups: ['grp-b'], orgIds: ['orgB'] });
});

test('the payload says WHAT it counted', async () => {
    const res = await api('/usage-counts', { user: 'alice' });
    assert.strictEqual(res.body.unit, 'action_runs',
        'this is a count of action runs, not of openings — a caller that renders it as "214x" promises a measurement nobody took');
    assert.strictEqual(res.body.window, 'month');
});

test('an unsupported window is refused, not silently answered as a month', async () => {
    const res = await api('/usage-counts?window=week', { user: 'alice' });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'invalid_window');
    assert.deepStrictEqual(res.body.supported, ['month']);
    assert.strictEqual(calls.usage.length, 0, 'a refused window asks the database nothing');
});

// ── The mount ───────────────────────────────────────────────────────

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

test('the router is mounted BEFORE the CRUD router, or GET /:id swallows /usage-counts', () => {
    const usageAt = INDEX.indexOf("require('./routes/studioAppUsage')");
    const crudAt = INDEX.indexOf("require('./routes/studioApps')");
    assert.ok(usageAt > -1, 'routes/studioAppUsage is not mounted in index.js');
    assert.ok(crudAt > -1);
    assert.ok(usageAt < crudAt,
        'studioApps.js has GET /:id — mounted after it, /usage-counts answers 404 for an app that does not exist');
});

test('the mount carries the same module and capability gates as the rest of App Studio', () => {
    const line = INDEX.split('\n').find(l => l.includes("require('./routes/studioAppUsage')"));
    assert.match(line, /app\.use\('\/api\/studio-apps'/);
    assert.match(line, /requireModule\('apps'\)/);
    assert.match(line, /requireCapability\('app_studio'\)/);
});
