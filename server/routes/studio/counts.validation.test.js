/**
 * What GET /api/studio/counts accepts: nothing (routes/studio/counts.js).
 *
 * `?scope=org` used to be answered 200 with the caller's OWN numbers —
 * automations and runs are counted per user — so a caller who asked for the
 * organisation read personal counts as the organisation's. What this file pins:
 *
 *   - any query parameter is a 400 that names it, in a sentence;
 *   - no gate or store is consulted for a refused request;
 *   - the session is still checked first (401 before 400);
 *   - the bare request is answered as before.
 *
 * Run: cd server && node --test routes/studio/counts.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const { createCountsRouter } = require('./counts');
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

// Every gate and store call lands in `touched`. A refused request must leave it empty.
const touched = [];
const no = (what) => async () => { touched.push(what); return false; };
const deps = {
    modules: { isModuleActive: no('module') },
    license: { featureAllowedForRequest: async () => { touched.push('licence'); return { allowed: false, resolution: {} }; } },
    entitlements: { hasCapability: no('capability') },
    permissions: { hasPermission: no('permission') },
    // `knowledge` is ungated; its store says there is nothing to count.
    auth: { resolveUserOrgIds: async () => { touched.push('orgs'); return new Set(); } },
    kbShared: {
        resolveIsOrgAdmin: async () => false,
        resolveEnabledSystemSlugs: async () => [],
        listFilterFromQuery: () => ({}),
        resolveUserGroups: async () => [],
    },
    kbStore: { listKBs: async () => [], filterByGroupAccess: () => [] },
    configStore: { getConfig: async () => null },
    now: () => Date.now(),
};

let server;
let baseUrl;
test.before(async () => {
    const app = express();
    app.use((req, _res, next) => {
        req.session = req.headers['x-test-user']
            ? { isAuthenticated: true, user: { id: req.headers['x-test-user'], organizationId: 'orgA' } }
            : {};
        next();
    });
    app.use('/api/studio', createCountsRouter(deps));
    app.use(terminalErrorHandler);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));
test.beforeEach(() => { touched.length = 0; });

async function get(qs = '', user = 'u1') {
    const res = await fetch(`${baseUrl}/api/studio/counts${qs}`, { headers: user ? { 'x-test-user': user } : {} });
    return { status: res.status, body: await res.json() };
}

test('a scope the counts do not have is refused by name, not answered with personal numbers', async () => {
    const res = await get('?scope=org');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === 'query'));
    assert.match(res.body.error, /^The counts take no parameters/);
    assert.match(res.body.error, /"scope"/);
    assert.deepStrictEqual(touched, [], 'a refused request consults no gate and no store');
});

test('the session is still checked before the query', async () => {
    const res = await get('?scope=org', null);
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(touched, []);
});

test('the bare request is answered as before', async () => {
    const res = await get();
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.counts, { knowledge: 0 });
    assert.ok(touched.length > 0);
});
