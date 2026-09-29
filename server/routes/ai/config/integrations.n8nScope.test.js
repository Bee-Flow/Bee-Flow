/**
 * Which org an n8n connection is stored under (routes/ai/config/integrations.js).
 *
 * The org id here is a STORAGE KEY — `n8n_url_org_<id>` and the secret beside
 * it — so the three things this pins are the three ways it can go wrong:
 *
 *   - a member who reaches an org only through a group still gets that org,
 *     which is why the private copy of this lookup existed in the first place;
 *   - the org-admin gate answers on the HOME org, never on the group's, so a
 *     stale org_admin role cannot travel into an org that never granted it;
 *   - a FAILED identity read is not "no org". Without that, one flaky
 *     userStore read would drop a tenant's credentials into the shared
 *     '__system__' scope, where every other super-admin can read them.
 *
 * Run: cd server && node --test --test-force-exit routes/ai/config/integrations.n8nScope.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const Module = require('module');

// ── Fixtures ────────────────────────────────────────────────────────

const fx = {
    users: {},
    groups: [],
    userThrows: false,
};
const written = [];   // every configStore write the routes performed

const userStoreStub = {
    getUser: async (id) => {
        if (fx.userThrows) throw new Error('user store unreachable');
        return fx.users[id] || null;
    },
    getAllGroups: async () => fx.groups,
};

const MOCKS = {
    '../../../stores/userStore': userStoreStub,
    '../stores/userStore': userStoreStub,
    '../../../stores/configStore': {
        getConfig: async () => null,
        getSecret: async () => null,
        setConfig: async (k, v) => { written.push([k, v]); },
        setSecret: async (k, v) => { written.push([k, v]); },
    },
    '../../../integrations/n8nTools': {
        listActiveWebhookWorkflows: async () => [],
        fetchWorkflowById: async () => ({}),
    },
    '../../../core/mcpManager': {},
    '../../../integrations/mcpRegistryClient': {},
    '../../../license/middleware': { requireFeature: () => (_req, _res, next) => next() },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:n8n-scope:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    // '../stores/userStore' is how auth/orgScope.js writes it — the real
    // lookup runs here, only its store is a double.
    if (Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) return MOCK_IDS[request];
    return originalResolve.call(this, request, parent, ...rest);
};
test.after(() => { Module._resolveFilename = originalResolve; });

const express = require('express');
const router = require('./integrations');

// ── HTTP harness ────────────────────────────────────────────────────

let server;
let baseUrl;

test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        const uid = req.headers['x-test-user'];
        if (uid) {
            req.session = { isAuthenticated: true, user: { id: uid, role: fx.users[uid]?.role || 'user' } };
            if (fx.users[uid]?.role === 'admin') req.session.isAdmin = true;
        }
        next();
    });
    app.use('/ai', router);
    // The routes throw rather than answer; the real terminal handler is what
    // turns that into a status, so the test must mount one too.
    app.use((err, _req, res, _next) => res.status(Number(err?.status) || 500).json({ error: err.message }));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => { await new Promise((resolve) => server.close(resolve)); });

async function call(method, url, { user = null, body = null } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (user) headers['x-test-user'] = user;
    const res = await fetch(`${baseUrl}${url}`, {
        method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
}

test.beforeEach(() => {
    written.length = 0;
    fx.userThrows = false;
    fx.groups = [{ id: 'g1', organizationId: 'orgB' }];
    fx.users = {
        'u-home': { id: 'u-home', role: 'user', orgRole: 'org_admin', organizationId: 'orgA', groups: [] },
        'u-group': { id: 'u-group', role: 'user', orgRole: 'org_admin', organizationId: null, groups: ['g1'] },
        'u-plain': { id: 'u-plain', role: 'user', orgRole: 'member', organizationId: 'orgA', groups: [] },
        'u-super': { id: 'u-super', role: 'admin', orgRole: null, organizationId: null, groups: [] },
    };
});

// ── The org a connection is written to ──────────────────────────────

test('an org admin writes the connection under their own org', async () => {
    const r = await call('PUT', '/ai/n8n/config', { user: 'u-home', body: { n8nUrl: 'https://n8n.example' } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(written, [['n8n_url_org_orgA', 'https://n8n.example']]);
});

test('a member with no org of their own is still an org, through their group', async () => {
    // Reading the connection is the surface that used to come back empty for
    // exactly this account shape.
    const r = await call('GET', '/ai/n8n/config', { user: 'u-group' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.configured, false, 'answers for the group org rather than refusing');
});

test('an org_admin role does not travel through a group into another org', async () => {
    const r = await call('PUT', '/ai/n8n/config', { user: 'u-group', body: { n8nUrl: 'https://n8n.example' } });
    assert.strictEqual(r.status, 403, 'the role belongs to a home org this account does not have');
    assert.strictEqual(r.json.error, 'No organization');
    assert.deepStrictEqual(written, [], 'nothing reaches the store');
});

test('a plain member cannot write the org connection', async () => {
    const r = await call('PUT', '/ai/n8n/config', { user: 'u-plain', body: { n8nUrl: 'https://n8n.example' } });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.json.error, 'Org admin required');
    assert.deepStrictEqual(written, []);
});

test('a super-admin in no org falls back to the shared system scope', async () => {
    const r = await call('PUT', '/ai/n8n/config', { user: 'u-super', body: { n8nUrl: 'https://n8n.example' } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(written, [['n8n_url_org___system__', 'https://n8n.example']]);
});

// ── A failed read is not "no org" ───────────────────────────────────

test('an unreadable identity refuses rather than falling back to the system scope', async () => {
    fx.userThrows = true;
    const r = await call('PUT', '/ai/n8n/config', { user: 'u-super', body: { n8nUrl: 'https://n8n.example' } });
    assert.notStrictEqual(r.status, 200, 'a store hiccup must not look like "this super-admin has no org"');
    assert.deepStrictEqual(written, [], 'a tenant credential never lands in the shared scope by accident');
});

test('an unreadable identity refuses the read too', async () => {
    fx.userThrows = true;
    const r = await call('GET', '/ai/n8n/config', { user: 'u-home' });
    assert.notStrictEqual(r.status, 200);
});
