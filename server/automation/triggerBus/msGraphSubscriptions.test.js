// @typecheck
/**
 * Unit tests for the MS Graph subscription provisioning, revocation and
 * renewal helpers in msGraphSubscriptions.js (moved here from
 * ../msgraphSubscription.test.js when triggerBus.js was split).
 *
 * Run: cd server && node --test automation/triggerBus/msGraphSubscriptions.test.js
 *
 * NO DATABASE, no require stubs: the module is a leaf. The renewal pass reads
 * the store, loadSession and the failure escalation through the `ctx` it is
 * handed, so the test passes a fake one. Network is handled by patching
 * global.fetch per test, which also lets us assert the exact request sent to
 * Graph.
 */

const { test } = require('node:test');
const assert = require('node:assert');

// Stable env so the clientState HMAC is deterministic across runs.
// buildClientState rejects secrets shorter than 32 chars (OAuth-state CSRF
// hardening), so the fixture has to clear that bar.
process.env.MSGRAPH_CLIENT_STATE_SECRET = 'test-fixture-msgraph-client-state-secret-0123456789';
delete process.env.PUBLIC_BASE_URL;
delete process.env.SERVER_PUBLIC_URL;

const graph = require('./msGraphSubscriptions');
const { RENEW_FAILURE_THRESHOLD } = require('./escalation');

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
    const stateA = graph.buildClientState('user-1', 'automation-1');
    const stateB = graph.buildClientState('user-1', 'automation-1');
    const stateC = graph.buildClientState('user-2', 'automation-1');
    assert.strictEqual(typeof stateA, 'string');
    assert.strictEqual(stateA.length, 64, 'HMAC-SHA256 hex digest is 64 chars');
    assert.strictEqual(stateA, stateB, 'deterministic for same inputs');
    assert.notStrictEqual(stateA, stateC, 'differs across users');
});

test('provisionSubscription returns null when PUBLIC_BASE_URL missing', async () => {
    const result = await graph.provisionSubscription(
        { id: 's1', provider: 'msgraph', userId: 'u1', automationId: 'a1', eventType: 'mail.new' },
        SAMPLE_SESSION,
    );
    assert.strictEqual(result, null, 'no public URL → null (caller falls back to polling)');
});

test('provisionSubscription returns null for unsupported eventType', async () => {
    process.env.PUBLIC_BASE_URL = 'https://test.example.com';
    try {
        const result = await graph.provisionSubscription(
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
                const result = await graph.provisionSubscription(
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
                    graph.buildClientState('u1', 'a1'),
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
                const result = await graph.provisionSubscription(
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
            const ok = await graph.revokeSubscription(
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
            const ok = await graph.revokeSubscription(
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
            const ok = await graph.revokeSubscription(
                { id: 's1', provider: 'msgraph', externalRef: null },
                SAMPLE_SESSION,
            );
            assert.strictEqual(ok, false);
            assert.strictEqual(called, false, 'no fetch when nothing to revoke');
        },
    );
});

// ── Renewal pass ────────────────────────────────────────────────────────

function renewCtx(subs, { session = SAMPLE_SESSION } = {}) {
    const calls = { updates: [], resets: [], escalations: [] };
    const ctx = {
        store: () => ({
            getExpiringSubscriptions: async () => subs,
            updateSubscription: async (id, updates) => { calls.updates.push({ id, updates }); },
            resetSubscriptionFailures: async (id) => { calls.resets.push(id); },
        }),
        loadSession: async () => session,
        escalate: async (sub, threshold, msg) => { calls.escalations.push({ id: sub.id, threshold, msg }); },
    };
    return { ctx, calls };
}

test('renewExpiringSubscriptions PATCHes msgraph subs, stores the new expiry and resets failures', async () => {
    const { ctx, calls } = renewCtx([
        { id: 's1', provider: 'msgraph', userId: 'u1', externalRef: 'graph-1' },
        { id: 's2', provider: 'gmail', userId: 'u1', externalRef: 'x' },
    ]);
    const requests = [];
    await withFetch(
        async (url, opts) => { requests.push({ url, opts }); return { ok: true, status: 200 }; },
        () => graph.renewExpiringSubscriptions(ctx),
    );
    assert.strictEqual(requests.length, 1, 'only msgraph rows are renewed');
    assert.strictEqual(requests[0].url, 'https://graph.microsoft.com/v1.0/subscriptions/graph-1');
    assert.strictEqual(requests[0].opts.method, 'PATCH');
    const sent = JSON.parse(requests[0].opts.body).expirationDateTime;
    assert.deepStrictEqual(calls.updates, [{ id: 's1', updates: { expiresAt: sent } }]);
    assert.deepStrictEqual(calls.resets, ['s1']);
    assert.deepStrictEqual(calls.escalations, []);
});

test('renewExpiringSubscriptions escalates with the renewal threshold on HTTP failure or no token', async () => {
    const failing = renewCtx([{ id: 's1', provider: 'msgraph', userId: 'u1', externalRef: 'graph-1' }]);
    await withFetch(
        async () => ({ ok: false, status: 403, text: async () => 'forbidden' }),
        () => graph.renewExpiringSubscriptions(failing.ctx),
    );
    assert.deepStrictEqual(failing.calls.escalations, [{ id: 's1', threshold: RENEW_FAILURE_THRESHOLD, msg: '403' }]);
    assert.deepStrictEqual(failing.calls.updates, []);

    const noToken = renewCtx([{ id: 's2', provider: 'msgraph', userId: 'u1', externalRef: 'graph-2' }], { session: null });
    await graph.renewExpiringSubscriptions(noToken.ctx);
    assert.deepStrictEqual(noToken.calls.escalations, [{ id: 's2', threshold: RENEW_FAILURE_THRESHOLD, msg: 'no access token' }]);
});
