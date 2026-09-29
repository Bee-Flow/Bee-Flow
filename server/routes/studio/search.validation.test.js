/**
 * What GET /api/studio/search accepts, and what it says when it refuses
 * (routes/studio/search.js).
 *
 * Anything but a single `q` used to become the empty query and be answered
 * 200 `tooShort: true` — "type at least two characters" — to somebody who had
 * typed a word; `?kind=apps` searched every kind. What this file pins:
 *
 *   - the 400 NAMES what was wrong (`query.q`, or the stray key), in words;
 *   - no gate or store is consulted for a refused request;
 *   - the session is still checked first (401 before 400);
 *   - a long q is still clamped, not refused.
 *
 * Run: cd server && node --test routes/studio/search.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const { createSearchRouter, MAX_QUERY_LENGTH } = require('./search');
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

// Every gate and store call lands in `touched`. A refused request must leave it empty.
const touched = [];
const no = (what) => async () => { touched.push(what); return false; };
const deps = {
    modules: { isModuleActive: no('module') },
    license: { featureAllowedForRequest: async () => { touched.push('licence'); return { allowed: false, resolution: {} }; } },
    entitlements: { hasCapability: no('capability') },
    permissions: { hasPermission: no('permission') },
    auth: { resolveUserOrgIds: async () => { touched.push('orgs'); return new Set(); } },
    kbShared: {
        resolveIsOrgAdmin: async () => false,
        resolveEnabledSystemSlugs: async () => [],
        listFilterFromQuery: () => ({}),
        resolveUserGroups: async () => [],
    },
    kbStore: { listKBs: async () => [{ id: 'kb1', name: 'Invoices' }], filterByGroupAccess: (kbs) => kbs },
    configStore: { getConfig: async () => null },
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
    app.use('/api/studio', createSearchRouter(deps));
    app.use(terminalErrorHandler);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));
test.beforeEach(() => { touched.length = 0; });

async function get(qs, user = 'u1') {
    const res = await fetch(`${baseUrl}/api/studio/search${qs}`, { headers: user ? { 'x-test-user': user } : {} });
    return { status: res.status, body: await res.json() };
}

async function refuses(qs, field) {
    const res = await get(qs);
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === field), `the 400 must name ${field}: ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request consults no gate and no store');
    return res;
}

test('the wrong key is refused by name, not answered "type at least two characters"', async () => {
    const res = await refuses('?query=invoice', 'query');
    assert.match(res.body.error, /^The search takes only q/);
    assert.match(res.body.error, /"query"/);
});

test('a filter the search does not have is refused, not ignored over all nine kinds', async () => {
    const res = await refuses('?q=invoice&kind=apps', 'query');
    assert.match(res.body.error, /"kind"/);
});

test('q sent twice is refused in a sentence', async () => {
    const res = await refuses('?q=aa&q=bb', 'query.q');
    assert.strictEqual(res.body.error, 'q is the text to search for, sent once.');
});

test('the session is still checked before the query', async () => {
    const res = await get('?query=invoice', null);
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(touched, []);
});

test('a well-formed q is searched, and a long one is still clamped rather than refused', async () => {
    const ok = await get('?q=invoice');
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ok.body.results.knowledge, [{ id: 'kb1', name: 'Invoices' }]);

    const long = await get(`?q=${'a'.repeat(MAX_QUERY_LENGTH + 50)}`);
    assert.strictEqual(long.status, 200);
    assert.strictEqual(long.body.query.length, MAX_QUERY_LENGTH);
});
