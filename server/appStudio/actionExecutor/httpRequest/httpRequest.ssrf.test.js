/**
 * Where an http_request step can and cannot reach.
 *
 * Covers:
 *   - the origin comes from the connector's URL only: a connector that is not https, that
 *     templates its host or that carries user info is refused;
 *   - the path cannot leave that origin (a second slash, a backslash, "@", dot segments in any
 *     spelling, "?" and "#"), and a placeholder value is URL-encoded so it cannot either;
 *   - a connector that points at a private, loopback or metadata address is refused before the
 *     credential is read and before anything is sent;
 *   - a public-looking name that RESOLVES to a private address is refused at connect time,
 *     through the real ssrfGuard dispatcher with a stubbed lookup, as a step failure;
 *   - a redirect is followed only within the same origin; the credential never travels to
 *     another host, another port or plain http.
 *
 * No network access required. Run:
 *   node --test server/appStudio/actionExecutor/httpRequest/httpRequest.ssrf.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const realGuard = require('../../../utils/ssrfGuard');
const { isPrivateTarget } = require('../../../utils/isPrivateTarget');
const { runHttpRequest } = require('../steps/http_request.mts');
const { connectorOrigin, pathProblem } = require('./request.mts');

const APP = { id: 'app_1', userId: 'owner_1', organizationId: 'org_1', name: 'Orders' };
const modelFor = (url, extra = {}) => ({ connectors: [{ id: 'conn_ab12cd', kind: 'rest', url, auth: { credentialProvider: 'acme' }, ...extra }] });
const STEP = { kind: 'http_request', connectorId: 'conn_ab12cd' };

function harness(respond) {
    const calls = [];
    const credentialReads = [];
    const deps = {
        safeFetch: async (url, init) => { calls.push({ url: String(url), init }); return respond(String(url), init); },
        isPrivateTarget,
        isPrivateAddressError: realGuard.isPrivateAddressError,
        getProviderAuth: async (...a) => { credentialReads.push(a); return { accessToken: 'tok-secret' }; },
        capture: async (fn) => { try { return { ok: true, value: await fn(), probe: null }; } catch (error) { return { ok: false, error, probe: null }; } },
        env: {},
        safety: {
            resolveAutomationPolicy: async () => ({}),
            buildAuditBase: () => ({}),
            guardToolInput: async (payload) => ({ value: payload, tokenMap: null, categories: [], markers: [] }),
            logEgress: async () => {},
        },
    };
    return { deps, calls, credentialReads };
}

const ok = () => ({ status: 200, headers: new Headers(), text: async () => '{}' });
const redirect = (location, status = 302) => ({ status, headers: new Headers({ location }), text: async () => '' });

test('the origin is read from the connector URL and from nothing else', () => {
    assert.equal(connectorOrigin({ url: 'https://api.example.test/v1/items?since={since}' }), 'https://api.example.test');
    assert.equal(connectorOrigin({ url: 'HTTPS://API.Example.test:8443' }), 'https://api.example.test:8443');
    assert.equal(connectorOrigin({ url: 'https://api.example.test?x={x}' }), 'https://api.example.test');
    for (const url of [
        'http://api.example.test/', 'ftp://api.example.test/', '//api.example.test/', 'api.example.test/x', '',
        'https://{host}/x', 'https://api.{tenant}.example.test/x', 'https://user:pw@api.example.test/', 'https://api.example.test@evil.example/',
        'https://api.example.test\\@evil.example/', 'https:///x', 'https://', undefined, 42,
    ]) {
        assert.equal(connectorOrigin({ url }), null, String(url));
    }
});

test('a connector without a usable https origin fails the step', async () => {
    for (const url of ['http://api.example.test/x', 'https://{host}/x', 'https://user:pw@api.example.test/']) {
        const h = harness(ok);
        const res = await runHttpRequest(APP, modelFor(url), { ...STEP, path: '/x' }, {}, h.deps);
        assert.equal(res.code, 'http_connector_invalid', url);
        assert.equal(h.calls.length + h.credentialReads.length, 0, url);
    }
});

test('a path that could leave the origin is refused', async () => {
    const paths = [
        '//evil.example/x', '/\\evil.example/x', '\\\\evil.example', 'https://evil.example/x', '@evil.example/x', 'x',
        '/a/../b', '/a/./b', '/..', '/a/%2e%2e/b', '/a/%2E%2e', '/a/.%2e/b', '/x?y=1', '/x#frag', '/x y', '/x\ty', '/x\r\ny',
    ];
    for (const path of paths) {
        assert.notEqual(pathProblem(path), null, JSON.stringify(path));
        const h = harness(ok);
        const res = await runHttpRequest(APP, modelFor('https://api.example.test/v1'), { ...STEP, path }, {}, h.deps);
        assert.equal(res.code, 'http_path_refused', JSON.stringify(path));
        assert.equal(h.calls.length + h.credentialReads.length, 0, JSON.stringify(path));
    }
    for (const path of ['/', '/v1/orders', '/v1/a%20b', '/v1/a..b/c', '/v1/.well-known/x', '/v1/a%2Fb']) assert.equal(pathProblem(path), null, path);
});

test('a placeholder value cannot change the host or the path it was put in', async () => {
    const hostile = ['../../admin', '..', '.', '/etc/passwd', '@evil.example', '//evil.example', 'x?admin=1', 'x#y', 'a\\b', 'a b', '%2e%2e', 'https://evil.example/'];
    for (const id of hostile) {
        const h = harness(ok);
        const res = await runHttpRequest(APP, modelFor('https://api.example.test/v1'), { ...STEP, path: '/v1/orders/{{form.id}}/lines' }, { formValues: { id } }, h.deps);
        if (id === '..' || id === '.') {
            assert.equal(res.code, 'http_path_refused', id);
            assert.equal(h.calls.length, 0, id);
            continue;
        }
        assert.equal(res.ok, true, id);
        const sent = new URL(h.calls[0].url);
        assert.equal(sent.origin, 'https://api.example.test', id);
        assert.equal(sent.pathname, `/v1/orders/${encodeURIComponent(id)}/lines`, id);
        assert.equal(sent.search, '', id);
        assert.equal(sent.hash, '', id);
    }
    // Two values that only together make a dot segment.
    const h = harness(ok);
    const res = await runHttpRequest(APP, modelFor('https://api.example.test/v1'), { ...STEP, path: '/v1/{{form.a}}{{form.b}}/x' }, { formValues: { a: '.', b: '.' } }, h.deps);
    assert.equal(res.code, 'http_path_refused');
    // A placeholder with nothing behind it fails instead of leaving a hole.
    const hole = harness(ok);
    assert.equal((await runHttpRequest(APP, modelFor('https://api.example.test/v1'), { ...STEP, path: '/v1/orders/{{form.missing}}' }, { formValues: {} }, hole.deps)).code, 'http_bad_input');
    assert.equal(hole.calls.length, 0);
});

test('a query value cannot add a host, a path or a fragment', async () => {
    const h = harness(ok);
    await runHttpRequest(APP, modelFor('https://api.example.test/v1'), { ...STEP, path: '/s', query: { q: { kind: 'field', name: 'q' } } }, { formValues: { q: 'a&admin=1#x/../y' } }, h.deps);
    const sent = new URL(h.calls[0].url);
    assert.equal(sent.pathname, '/s');
    assert.deepEqual([...sent.searchParams.entries()], [['q', 'a&admin=1#x/../y']]);
    assert.equal(sent.hash, '');
});

test('a connector that points at a private, loopback or metadata address is refused before the credential is read', async () => {
    const targets = [
        'https://127.0.0.1/x', 'https://localhost/x', 'https://169.254.169.254/latest/meta-data', 'https://10.0.0.5/x', 'https://192.168.1.10/x',
        'https://172.16.0.1/x', 'https://[::1]/x', 'https://2130706433/x', 'https://0x7f000001/x', 'https://127.1/x', 'https://0.0.0.0/x',
        'https://metadata.google.internal/x', 'https://[::ffff:10.0.0.5]/x',
    ];
    for (const url of targets) {
        const h = harness(ok);
        const res = await runHttpRequest(APP, modelFor(url), { ...STEP, path: '/x' }, {}, h.deps);
        assert.equal(res.ok, false, url);
        assert.equal(res.code, 'http_private_target', url);
        assert.equal(res.retryable, false, url);
        assert.equal(h.calls.length, 0, `${url}: nothing sent`);
        assert.equal(h.credentialReads.length, 0, `${url}: credential not read`);
    }
});

test('a public-looking name that resolves to a private address is refused at connect time, as a step failure', async () => {
    let lookups = 0;
    const stubLookup = (hostname, options, cb) => {
        lookups += 1;
        if (options && options.all) return process.nextTick(cb, null, [{ address: '10.0.0.5', family: 4 }]);
        return process.nextTick(cb, null, '10.0.0.5', 4);
    };
    const dispatcher = realGuard.makeSafeDispatcher({ lookup: stubLookup });
    const h = harness(ok);
    h.deps.safeFetch = (url, init) => realGuard.safeFetch(url, { ...init, dispatcher });
    const res = await runHttpRequest(APP, modelFor('https://rebind.example.test/v1'), { ...STEP, path: '/x' }, {}, h.deps);
    assert.deepEqual(res, { ok: false, code: 'http_private_target', error: 'The connection points at a private or internal address, which a step does not reach.', retryable: false });
    assert.ok(lookups >= 1, 'the name was resolved through the guarded lookup');
    await dispatcher.close?.();
});

test('a redirect is followed only within the same origin, and the credential never goes anywhere else', async () => {
    const away = ['https://evil.example/x', 'http://api.example.test/x', 'https://api.example.test:8443/x', 'https://api.example.test.evil.example/x', '//evil.example/x', 'https://127.0.0.1/x'];
    for (const location of away) {
        const h = harness((url) => (url === 'https://api.example.test/start' ? redirect(location) : ok()));
        const res = await runHttpRequest(APP, modelFor('https://api.example.test/v1'), { ...STEP, path: '/start' }, {}, h.deps);
        assert.equal(res.ok, false, location);
        assert.equal(res.code, 'http_redirect_refused', location);
        assert.deepEqual(h.calls.map((c) => c.url), ['https://api.example.test/start'], `${location}: no request left the origin`);
    }
    const h = harness((url) => (url.endsWith('/start') ? redirect('/moved') : ok()));
    const res = await runHttpRequest(APP, modelFor('https://api.example.test/v1'), { ...STEP, path: '/start' }, {}, h.deps);
    assert.equal(res.ok, true);
    assert.deepEqual(h.calls.map((c) => c.url), ['https://api.example.test/start', 'https://api.example.test/moved']);
    assert.equal(h.calls[1].init.headers.Authorization, 'Bearer tok-secret');
    assert.equal(h.calls[1].init.redirect, 'manual');
});

test('a redirect loop ends as a step failure', async () => {
    const h = harness(() => redirect('/again'));
    const res = await runHttpRequest(APP, modelFor('https://api.example.test/v1'), { ...STEP, path: '/again' }, {}, h.deps);
    assert.equal(res.code, 'http_redirect_refused');
    assert.ok(h.calls.length <= 7);
});
