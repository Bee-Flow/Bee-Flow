/**
 * httpAuth host binding (D18): a step whose `auth.allowedHosts` is a non-empty
 * array only receives the credential for a request to a listed hostname. The
 * store is injected through deps, no module is replaced.
 *
 * Run: cd server && node --test core/automationRunner/httpAuth.allowedHosts.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { resolveHttpAuthHeaders, hostAllowed } = require('./httpAuth');

const ctx = { userId: 'u1', orgId: 'orgA', userGroupIds: [] };
const OPAQUE = /not available to this automation's owner/;

function fakeStore() {
    const calls = { authorize: 0, secret: 0 };
    const connection = { id: 'c1', provider: 'http', label: 'Api', kind: 'bearer', status: 'active', secretMeta: {}, updatedAt: '2026-10-01T00:00:00Z' };
    return {
        calls,
        authorizeConnectionUse: async () => { calls.authorize++; return { ok: true, mode: 'own', connection }; },
        getConnectionWithSecret: async () => { calls.secret++; return { ...connection, secret: { token: 'tok-123' } }; },
        markNeedsReauth: async () => {},
        touchLastUsed: async () => {},
    };
}

test('an allowed host passes and gets the credential', async () => {
    const store = fakeStore();
    const r = await resolveHttpAuthHeaders(
        { connectionId: 'c1', allowedHosts: ['api.example.com'], url: 'https://API.Example.com:8443/v1/items?x=1' },
        ctx, { store },
    );
    assert.strictEqual(r.headers.Authorization, 'Bearer tok-123');
    assert.strictEqual(store.calls.secret, 1);
});

test('another host is refused with the opaque message, before the credential is read', async () => {
    const store = fakeStore();
    await assert.rejects(
        () => resolveHttpAuthHeaders({ connectionId: 'c1', allowedHosts: ['api.example.com'], url: 'https://evil.example.net/collect' }, ctx, { store }),
        OPAQUE,
    );
    // Lookalikes are not the listed host either.
    for (const url of ['https://api.example.com.evil.net/', 'https://evil.net/?h=api.example.com', 'https://api.example.com@evil.net/', 'https://sub.api.example.com/']) {
        await assert.rejects(() => resolveHttpAuthHeaders({ connectionId: 'c1', allowedHosts: ['api.example.com'], url }, ctx, { store }), OPAQUE, url);
    }
    assert.strictEqual(store.calls.authorize, 0);
    assert.strictEqual(store.calls.secret, 0);
});

test('a host made from a variable is refused when it is not listed', async () => {
    const store = fakeStore();
    // What execHttpRequest resolves `{{vars.api_base}}/v1` to after a stage
    // editor changed the variable.
    const vars = { api_base: 'https://attacker.example.org' };
    const url = `${vars.api_base}/v1/items`;
    await assert.rejects(
        () => resolveHttpAuthHeaders({ connectionId: 'c1', allowedHosts: ['api.example.com'], url }, ctx, { store }),
        OPAQUE,
    );
    assert.strictEqual(store.calls.secret, 0);
});

test('a list with no URL, an unparseable URL or no usable entry refuses', async () => {
    const store = fakeStore();
    await assert.rejects(() => resolveHttpAuthHeaders({ connectionId: 'c1', allowedHosts: ['api.example.com'] }, ctx, { store }), OPAQUE);
    await assert.rejects(() => resolveHttpAuthHeaders({ connectionId: 'c1', allowedHosts: ['api.example.com'], url: 'not a url' }, ctx, { store }), OPAQUE);
    await assert.rejects(() => resolveHttpAuthHeaders({ connectionId: 'c1', allowedHosts: [null, 42], url: 'https://api.example.com/' }, ctx, { store }), OPAQUE);
    assert.strictEqual(store.calls.secret, 0);
});

test('no list behaves as before: any host gets the credential', async () => {
    for (const allowedHosts of [undefined, null, [], 'api.example.com']) {
        const store = fakeStore();
        const r = await resolveHttpAuthHeaders({ connectionId: 'c1', allowedHosts, url: 'https://anything.example.org/' }, ctx, { store });
        assert.strictEqual(r.headers.Authorization, 'Bearer tok-123', JSON.stringify(allowedHosts));
    }
    // And without a url at all (callers from before host binding).
    const store = fakeStore();
    const r = await resolveHttpAuthHeaders({ connectionId: 'c1' }, ctx, { store });
    assert.strictEqual(r.headers.Authorization, 'Bearer tok-123');
});

test('hostAllowed: exact, lower-case hostname, no port', () => {
    assert.strictEqual(hostAllowed(['API.example.com'], 'https://api.EXAMPLE.com/x'), true);
    assert.strictEqual(hostAllowed(['api.example.com'], 'http://api.example.com:8080/'), true);
    assert.strictEqual(hostAllowed(['api.example.com:8080'], 'http://api.example.com:8080/'), false);
    assert.strictEqual(hostAllowed(['example.com'], 'https://api.example.com/'), false);
    assert.strictEqual(hostAllowed(null, 'https://x.y/'), true);
});

test('the step\'s whole auth object carries the list too', async () => {
    const store = fakeStore();
    const auth = { connectionId: 'c1', allowedHosts: ['api.example.com'] };
    await assert.rejects(() => resolveHttpAuthHeaders({ connectionId: 'c1', auth, url: 'https://evil.example.net/' }, ctx, { store }), OPAQUE);
    await assert.rejects(() => resolveHttpAuthHeaders({ connectionId: 'c1', auth }, ctx, { store }), OPAQUE, 'a list and no url fails closed');
    assert.strictEqual(store.calls.authorize, 0);
    const r = await resolveHttpAuthHeaders({ connectionId: 'c1', auth, url: 'https://api.example.com/x' }, ctx, { store });
    assert.strictEqual(r.headers.Authorization, 'Bearer tok-123');
});
