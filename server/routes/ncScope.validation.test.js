/**
 * What "What Bee Flow may access" (Settings → Integrations → Nextcloud)
 * accepts, and what it says when it refuses (routes/ncScope.js).
 *
 * The core drops whatever it does not recognise, which is right for a stored
 * document and a silent no-op for a request: a misspelled app id or mode left
 * the app OPEN under "saved"; `mode: 'selected'` on an app that cannot be
 * narrowed was stored as 'off'; and POST /reset with a per-app option reset
 * EVERY app to "everything". What this file pins:
 *
 *   - the 400 names the app and the field, in a sentence;
 *   - the bodies the settings screen sends still save;
 *   - a refused request writes nothing and resets nothing.
 *
 * The core module is real here (its isScopable/normalizeFolderPath are what the
 * schema asks); only the stores under it are fakes.
 *
 * Run: cd server && node --test routes/ncScope.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

// Every scope write lands in `touched`. A refused request must leave it empty.
const touched = [];
const store = new Map();
const pass = (req, res, next) => next();

// The core's own stores, by resolved path: the real core requires them itself.
function inject(rel, exportsObj) {
    const resolved = require.resolve(path.join(__dirname, rel));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
inject('../stores/configStore.js', {
    getConfig: async (k) => store.get(k) ?? null,
    setConfig: async (k, v) => { touched.push({ what: 'setConfig', args: [k, v] }); store.set(k, v); },
    deleteConfig: async (k) => { touched.push({ what: 'deleteConfig', args: [k] }); store.delete(k); },
});
inject('../stores/guardrailEventStore.js', { logGuardrailEvent: async () => {} });

const MOCKS = {
    '../auth/permissions': { requireAuth: pass },
    '../core/tools/toolDispatcher': {
        executeNextcloudFamilyTool: async (toolName, args) => {
            touched.push({ what: 'listTool', args: [toolName, args] });
            return { path: args.path, items: [] };
        },
    },
    '../core/integrations/ncScopeGuard': { invalidateScopeCache: () => {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:nc-scope-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]ncScope\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./ncScope');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ method, url, body, query = {} }) {
    return new Promise((resolve, reject) => {
        // `ip` and `app` are what express-rate-limit reads to key the limiter.
        const req = {
            method, url, originalUrl: url, path: url, body, query, headers: {},
            ip: '127.0.0.1', app: { get: () => false },
            session: { user: { id: 'u1', organizationId: 'org1' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false, _headers: {},
            status(c) { this.statusCode = c; return this; },
            setHeader(k, v) { this._headers[k] = v; },
            getHeader(k) { return this._headers[k]; },
            append() { return this; },
            set() { return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

const save = (body) => dispatch({ method: 'PUT', url: '/', body });

test.beforeEach(() => { touched.length = 0; store.clear(); });

test('a misspelled app id is refused by name, instead of leaving the app open', async () => {
    const res = await save({ integrations: { 'nextcloud-calender': { mode: 'off' } } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/nextcloud-calender/.test(res.body.error), `the 400 names the app: ${res.body.error}`);
    assert.deepStrictEqual(touched, [], 'nothing was written');
});

test('a misspelled mode is refused in a sentence, instead of leaving the app on', async () => {
    const res = await save({ integrations: { 'nextcloud-calendar': { mode: 'Off' } } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, "mode is 'all', 'selected' or 'off'.");
    assert.ok(res.body.details.some((d) => d.path === 'body.integrations.nextcloud-calendar.mode'));
    assert.deepStrictEqual(touched, []);
});

test('`integration` without the s is refused, instead of saving nothing', async () => {
    const res = await save({ integration: { nextcloud: { mode: 'off' } } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.integrations'));
    assert.deepStrictEqual(touched, []);
});

test('"selected" on an app that cannot be narrowed is refused, not stored as off', async () => {
    const res = await save({ integrations: { 'nextcloud-status': { mode: 'selected', selected: ['x'] } } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'User Status cannot be narrowed to a selection — choose all or off.');
    assert.deepStrictEqual(touched, []);
});

test('a folder outside Nextcloud is refused, not dropped from the selection', async () => {
    const res = await save({ integrations: { nextcloud: { mode: 'selected', selected: ['/Projects', '../secret'] } } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A folder is a path inside your Nextcloud, like /Projects.');
    assert.ok(res.body.details.some((d) => d.path === 'body.integrations.nextcloud.selected.1'));
    assert.deepStrictEqual(touched, []);
});

test('a selection past the cap is refused, not cut to 200', async () => {
    const selected = Array.from({ length: 201 }, (_, i) => `cal-${i}`);
    const res = await save({ integrations: { 'nextcloud-calendar': { mode: 'selected', selected } } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'At most 200 calendars can be selected.');
    assert.deepStrictEqual(touched, []);
});

test('the bodies the settings screen sends still save', async () => {
    const off = await save({ integrations: { 'nextcloud-deck': { mode: 'off' } } });
    assert.strictEqual(off.statusCode, 200);
    const narrowed = await save({ integrations: { 'nextcloud-calendar': { mode: 'selected', selected: ['work', 7] } } });
    assert.strictEqual(narrowed.statusCode, 200);
    assert.strictEqual(narrowed.body.integrations['nextcloud-deck'].mode, 'off');
    assert.deepStrictEqual(narrowed.body.integrations['nextcloud-calendar'].selected, ['work', '7']);
});

test('null still hands an app back to "everything"', async () => {
    await save({ integrations: { 'nextcloud-deck': { mode: 'off' } } });
    const res = await save({ integrations: { 'nextcloud-deck': null } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.integrations['nextcloud-deck'].mode, 'all');
});

test('reset takes no body — a per-app option is refused, not a reset of every app', async () => {
    store.set('user_nc_scope_u1', { v: 1, integrations: { 'nextcloud-deck': { mode: 'off' } } });
    const res = await dispatch({ method: 'POST', url: '/reset', body: { integrationId: 'nextcloud' } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/integrationId/.test(res.body.error), res.body.error);
    assert.deepStrictEqual(touched, [], 'the scope was not deleted');
});

test('revoke-all takes no body either, and still works without one', async () => {
    const refused = await dispatch({ method: 'POST', url: '/revoke-all', body: { integrationId: 'nextcloud' } });
    assert.strictEqual(refused.statusCode, 400);
    const res = await dispatch({ method: 'POST', url: '/revoke-all', body: undefined });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.revoked, true);
});

test('the folder picker takes one path, not a list glued into "a,b"', async () => {
    const refused = await dispatch({ method: 'GET', url: '/resources/nextcloud', query: { path: ['/a', '/b'] } });
    assert.strictEqual(refused.statusCode, 400);
    assert.strictEqual(refused.body.error, 'path is one folder path, like /Projects.');
    assert.deepStrictEqual(touched, []);
    const res = await dispatch({ method: 'GET', url: '/resources/nextcloud', query: { path: '/Projects' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched, [{ what: 'listTool', args: ['nextcloud_list_files', { path: '/Projects' }] }]);
});
