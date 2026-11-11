/**
 * REST connector with method POST and a JSON body template, and the
 * STUDIO_APP_CONNECTOR_MAX_ROWS ceiling. Run: node --test appStudio/connectors.restPost.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const connectors = require('./connectors');
const dm = require('./dataModel');

const app = { id: 'app-1', userId: 'owner-1', organizationId: 'org-1' };
const fakeResp = (body) => { const text = JSON.stringify(body); return { ok: true, status: 200, text: async () => text }; };
const model = (c) => ({ modelVersion: 1, tables: [], roles: [], roleMapping: { default: 'app', byGroup: {} }, connectors: [c] });
const errsOf = (c) => dm.validateDataModel(model(c)).errors;

const post = {
    id: 'conn_post01', kind: 'rest', method: 'POST',
    url: 'https://api.example.com/search',
    params: [{ key: 'q', type: 'text' }, { key: 'n', type: 'number' }],
    body: { query: '{q}', limit: '{n}', label: 'x-{q}', nested: { list: ['{q}', 1, true, null] } },
    rowsPath: 'hits',
};

test('POST: sends a rendered JSON body with the SSRF-screened safeFetch', async () => {
    let seen;
    const res = await connectors.runConnector(post, {
        app, params: { q: 'a "b"', n: 7, extra: 'dropped' },
        _deps: { safeFetch: async (u, o) => { seen = { u, o }; return fakeResp({ hits: [{ id: 1 }] }); } },
    });
    assert.deepStrictEqual(res.rows, [{ id: 1 }]);
    assert.strictEqual(seen.o.method, 'POST');
    assert.strictEqual(seen.o.headers['Content-Type'], 'application/json');
    assert.deepStrictEqual(JSON.parse(seen.o.body), { query: 'a "b"', limit: 7, label: 'x-a "b"', nested: { list: ['a "b"', 1, true, null] } });
});

test('POST: a missing param reads null / empty and undeclared params never enter', async () => {
    let body;
    await connectors.runConnector(post, {
        app, params: { other: 'x' },
        _deps: { safeFetch: async (u, o) => { body = JSON.parse(o.body); return fakeResp({ hits: [] }); } },
    });
    assert.strictEqual(body.query, null);
    assert.strictEqual(body.label, 'x-');
});

test('POST: private host is still refused before any fetch', async () => {
    await assert.rejects(
        () => connectors.runConnector({ ...post, url: 'https://127.0.0.1/x' }, { app, params: {}, _deps: { safeFetch: async () => { throw new Error('no fetch'); } } }),
        (e) => e.status === 403,
    );
});

test('GET connectors are unchanged: GET, no body, no content type', async () => {
    let seen;
    await connectors.runConnector({ id: 'c1', kind: 'rest', url: 'https://api.example.com/x' }, {
        app, params: {}, _deps: { safeFetch: async (u, o) => { seen = o; return fakeResp([]); } },
    });
    assert.strictEqual(seen.method, 'GET');
    assert.ok(!('body' in seen));
    assert.ok(!('Content-Type' in seen.headers));
});

test('validation: method and body rules', () => {
    assert.deepStrictEqual(errsOf(post), []);
    assert.ok(errsOf({ ...post, method: 'PUT' }).some((e) => /method must be/.test(e)));
    assert.ok(errsOf({ ...post, method: undefined }).some((e) => /needs method: 'POST'/.test(e)));
    assert.ok(errsOf({ ...post, body: 'text' }).some((e) => /JSON object or array/.test(e)));
    assert.ok(errsOf({ ...post, body: { q: '{nope}' } }).some((e) => /undeclared param \{nope\}/.test(e)));
    assert.ok(errsOf({ ...post, body: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } } }).some((e) => /nested deeper/.test(e)));
    assert.ok(errsOf({ ...post, body: { big: 'x'.repeat(20000) } }).some((e) => /larger than/.test(e)));
    assert.ok(errsOf({ id: 'conn_aut001', kind: 'automation', automationId: 'a', method: 'POST' }).some((e) => /only supported for rest/.test(e)));
});

// The cap is read once at load, so each value needs a fresh process. The child gets the
// module's absolute path: a relative id would resolve from the child's cwd, not from here.
const CONNECTORS_MODULE = require.resolve('./connectors');

function capIn(env) {
    const r = spawnSync(process.execPath, ['-e', `console.log(String(require(${JSON.stringify(CONNECTORS_MODULE)})._MAX_CONNECTOR_ROWS))`], {
        cwd: require('node:path').join(__dirname, '..'), env: { ...process.env, ...env }, encoding: 'utf8',
    });
    return r.stdout.trim();
}

test('STUDIO_APP_CONNECTOR_MAX_ROWS: default 500, configurable, 0 unlimited, junk falls back', () => {
    assert.strictEqual(capIn({ STUDIO_APP_CONNECTOR_MAX_ROWS: '' }), '500');
    assert.strictEqual(capIn({ STUDIO_APP_CONNECTOR_MAX_ROWS: '5000' }), '5000');
    assert.strictEqual(capIn({ STUDIO_APP_CONNECTOR_MAX_ROWS: '0' }), 'Infinity');
    assert.strictEqual(capIn({ STUDIO_APP_CONNECTOR_MAX_ROWS: 'abc' }), '500');
});
