/**
 * What GET /api/studio/attention accepts: nothing (routes/studio/attention.js).
 *
 * A parameter this route does not read used to be answered 200 as if it had
 * been: `?refresh=1` after fixing something got the cached list of up to a
 * minute ago. What this file pins:
 *
 *   - any query parameter is a 400 that names it, in a sentence;
 *   - no source runs for a refused request;
 *   - the session is still checked first (401 before 400);
 *   - the bare request is answered as before.
 *
 * Run: cd server && node --test routes/studio/attention.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const { createAttentionRouter } = require('./attention');
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

// Every gate call lands in `touched`: with every gate closed, each source is
// `gated` and nothing is loaded. A refused request must leave it empty.
const touched = [];
const no = (what) => async () => { touched.push(what); return false; };
const deps = {
    modules: { isModuleActive: no('module') },
    license: { featureAllowedForRequest: async () => { touched.push('licence'); return { allowed: false, resolution: {} }; } },
    entitlements: { hasCapability: no('capability') },
    permissions: { hasPermission: no('permission') },
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
    app.use('/api/studio', createAttentionRouter(deps));
    app.use(terminalErrorHandler);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));
test.beforeEach(() => { touched.length = 0; });

async function get(qs = '', user = 'u1') {
    const res = await fetch(`${baseUrl}/api/studio/attention${qs}`, { headers: user ? { 'x-test-user': user } : {} });
    return { status: res.status, body: await res.json() };
}

test('a refresh flag the route does not have is refused, not answered from the cache', async () => {
    const res = await get('?refresh=1');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === 'query'));
    assert.match(res.body.error, /^The attention list takes no parameters/);
    assert.match(res.body.error, /"refresh"/);
    assert.deepStrictEqual(touched, [], 'a refused request runs no source');
});

test('the session is still checked before the query', async () => {
    const res = await get('?source=apps', null);
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(touched, []);
});

test('the bare request is answered as before', async () => {
    const res = await get();
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.rows));
    assert.strictEqual(typeof res.body.complete, 'boolean');
    assert.ok(touched.length > 0, 'the sources ran');
});
