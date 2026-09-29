/**
 * Unit tests for the MS Graph subscription provisioning + revocation
 * helpers in triggerBus.js.
 *
 * Run: cd server && node --test automation/msgraphSubscription.test.js
 *
 * NO DATABASE. `automation/triggerBus.js` requires `../stores/automationStore`
 * at module load, and that store opens a real pg pool + runs schema init the
 * moment it is evaluated (ECONNREFUSED 127.0.0.1:5432 on a box without
 * Postgres). So the store is swapped for an in-memory double via the sanctioned
 * seam, `testUtils/stubRequire`, BEFORE triggerBus is required.
 *
 * NOTE on the stub keys: installResolveStub matches the require string exactly
 * as written inside the requiring module, not relative to this file. The store
 * is reached from two depths in the graph pulled in by triggerBus —
 *   automation/triggerBus.js            → require('../stores/automationStore')
 *   automation/triggerBus/dispatch.js   → require('../../stores/automationStore')
 * — so BOTH spellings are mapped to the same double. Mapping only one would
 * fail silently: the other spelling resolves to the real store and the pool
 * opens anyway.
 *
 * Everything else in triggerBus's load graph (triggers/dslFilters,
 * triggerBus/filters, triggerSources/pollDiff, automation/publicUrl) is pure
 * or lazy, so nothing further needs stubbing. Network is handled by patching
 * global.fetch per test, which also lets us assert the exact request sent to
 * Graph.
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../testUtils/stubRequire');

// In-memory automationStore double. Only the methods triggerBus touches at
// module load / from the helpers under test need to exist.
const automationStoreStub = {
    getSubscriptionsForProvider: async () => [],
    updateSubscription: async () => null,
    getPollingSubscriptions: async () => [],
    getExpiringSubscriptions: async () => [],
    incrementSubscriptionFailures: async () => ({ consecutiveFailures: 0, errorNotifiedAt: null }),
    resetSubscriptionFailures: async () => null,
    getAutomation: async () => null,
};

const restore = installResolveStub({
    '../stores/automationStore': automationStoreStub,      // as written in triggerBus.js
    '../../stores/automationStore': automationStoreStub,   // as written in triggerBus/dispatch.js
});
after(restore);

// Stable env so the clientState HMAC is deterministic across runs.
// buildClientState rejects secrets shorter than 32 chars (OAuth-state CSRF
// hardening), so the fixture has to clear that bar.
process.env.MSGRAPH_CLIENT_STATE_SECRET = 'test-fixture-msgraph-client-state-secret-0123456789';
delete process.env.PUBLIC_BASE_URL;
delete process.env.SERVER_PUBLIC_URL;

const triggerBus = require('./triggerBus');

const SAMPLE_SESSION = { accessToken: 'test-bearer', refreshToken: 'rt' };

/** Run `fn` with global.fetch replaced, always restoring the original. */
async function withFetch(impl, fn) {
    const originalFetch = global.fetch;
    global.fetch = impl;
    try {
        return await fn();
    } finally {
        global.fetch = originalFetch;
    }
}

test('buildClientState is pure HMAC; same inputs ⇒ same output', () => {
    const stateA = triggerBus.buildClientState('user-1', 'automation-1');
    const stateB = triggerBus.buildClientState('user-1', 'automation-1');
    const stateC = triggerBus.buildClientState('user-2', 'automation-1');
    assert.strictEqual(typeof stateA, 'string');
    assert.strictEqual(stateA.length, 64, 'HMAC-SHA256 hex digest is 64 chars');
    assert.strictEqual(stateA, stateB, 'deterministic for same inputs');
    assert.notStrictEqual(stateA, stateC, 'differs across users');
});

test('provisionSubscription returns null when PUBLIC_BASE_URL missing', async () => {
    const result = await triggerBus.provisionSubscription(
        { id: 's1', provider: 'msgraph', userId: 'u1', automationId: 'a1', eventType: 'mail.new' },
        SAMPLE_SESSION,
    );
    assert.strictEqual(result, null, 'no public URL → null (caller falls back to polling)');
});

test('provisionSubscription returns null for unsupported eventType', async () => {
    process.env.PUBLIC_BASE_URL = 'https://test.example.com';
    try {
        const result = await triggerBus.provisionSubscription(
            { id: 's1', provider: 'msgraph', userId: 'u1', automationId: 'a1', eventType: 'something.unknown' },
            SAMPLE_SESSION,
        );
        assert.strictEqual(result, null, 'unmapped eventType → null');
    } finally {
        delete process.env.PUBLIC_BASE_URL;
    }
});

test('provisionSubscription POSTs the right body and returns externalRef', async () => {
    process.env.PUBLIC_BASE_URL = 'https://test.example.com/'; // trailing slash to verify trim
    let captured = null;
    try {
        await withFetch(
            async (url, opts) => {
                captured = { url, opts };
                return {
                    ok: true,
                    status: 201,
                    json: async () => ({
                        id: 'graph-sub-id-xyz',
                        expirationDateTime: '2099-01-01T00:00:00.000Z',
                    }),
                };
            },
            async () => {
                const result = await triggerBus.provisionSubscription(
                    { id: 's1', provider: 'msgraph', userId: 'u1', automationId: 'a1', eventType: 'mail.new' },
                    SAMPLE_SESSION,
                );
                assert.ok(result, 'returns shape on success');
                assert.strictEqual(result.externalRef, 'graph-sub-id-xyz');
                assert.strictEqual(result.expiresAt, '2099-01-01T00:00:00.000Z');
                assert.strictEqual(typeof result.clientState, 'string');
                assert.strictEqual(result.clientState.length, 64);

                assert.strictEqual(captured.url, 'https://graph.microsoft.com/v1.0/subscriptions');
                assert.strictEqual(captured.opts.method, 'POST');
                assert.strictEqual(captured.opts.headers.Authorization, 'Bearer test-bearer');
                const body = JSON.parse(captured.opts.body);
                assert.strictEqual(body.changeType, 'created');
                assert.strictEqual(body.resource, "me/mailFolders('Inbox')/messages");
                assert.strictEqual(
                    body.notificationUrl,
                    'https://test.example.com/api/automation/events/msgraph',
                    'trims trailing slash before appending path',
                );
                assert.ok(body.expirationDateTime, 'sets expirationDateTime');
                assert.strictEqual(
                    body.clientState,
                    triggerBus.buildClientState('u1', 'a1'),
                    'request body uses our HMAC clientState',
                );
            },
        );
    } finally {
        delete process.env.PUBLIC_BASE_URL;
    }
});

test('provisionSubscription handles HTTP failure gracefully', async () => {
    process.env.PUBLIC_BASE_URL = 'https://test.example.com';
    try {
        await withFetch(
            async () => ({
                ok: false,
                status: 401,
                text: async () => '{"error":"unauthorized"}',
            }),
            async () => {
                const result = await triggerBus.provisionSubscription(
                    { id: 's1', provider: 'msgraph', userId: 'u1', automationId: 'a1', eventType: 'mail.new' },
                    SAMPLE_SESSION,
                );
                assert.strictEqual(result, null, 'HTTP 401 → null (caller logs)');
            },
        );
    } finally {
        delete process.env.PUBLIC_BASE_URL;
    }
});

test('revokeSubscription DELETEs the right URL', async () => {
    let captured = null;
    await withFetch(
        async (url, opts) => {
            captured = { url, opts };
            return { ok: true, status: 204 };
        },
        async () => {
            const ok = await triggerBus.revokeSubscription(
                { id: 's1', provider: 'msgraph', externalRef: 'graph-sub-id-xyz' },
                SAMPLE_SESSION,
            );
            assert.strictEqual(ok, true);
            assert.strictEqual(captured.url, 'https://graph.microsoft.com/v1.0/subscriptions/graph-sub-id-xyz');
            assert.strictEqual(captured.opts.method, 'DELETE');
        },
    );
});

test('revokeSubscription treats 404 as success (already gone)', async () => {
    await withFetch(
        async () => ({ ok: false, status: 404 }),
        async () => {
            const ok = await triggerBus.revokeSubscription(
                { id: 's1', provider: 'msgraph', externalRef: 'gone' },
                SAMPLE_SESSION,
            );
            assert.strictEqual(ok, true, '404 is treated as already-gone');
        },
    );
});

test('revokeSubscription is a no-op when externalRef missing', async () => {
    let called = false;
    await withFetch(
        async () => { called = true; return { ok: true }; },
        async () => {
            const ok = await triggerBus.revokeSubscription(
                { id: 's1', provider: 'msgraph', externalRef: null },
                SAMPLE_SESSION,
            );
            assert.strictEqual(ok, false);
            assert.strictEqual(called, false, 'no fetch when nothing to revoke');
        },
    );
});
