/**
 * The answers of the automation webhook address (routes/automation/webhookReceive.mts):
 * one answer for an address that does not accept a delivery, and the documented answers
 * (replayed nonce, automation not active, trigger not live, accepted) for a delivery that
 * was signed with the webhook's secret. Dependencies are handed in; no module is mocked.
 *
 * Run: cd server && node --test routes/automation/webhookReceive.test.js
 */

'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { NOT_ACCEPTED, verifyDeliverySignature, startSignedDelivery, _resetRefusedLog } = require('./webhookReceive.mts');
const { checkWebhookSignature } = require('./webhookSignature');

beforeEach(() => _resetRefusedLog());

const SECRET = 'ab'.repeat(32);
const sign = (secret, message) => 'sha256=' + crypto.createHmac('sha256', secret).update(message).digest('hex');

/** A world with one webhook (`hook1`, automation `auto1`), and what happened in it. */
function world({ automation = { id: 'auto1', isActive: true, isDraft: false }, secret = SECRET, previousSecret = null, seenNonces = [], live = true, rejectLogPerMinute = 20, logDelivery } = {}) {
    const seen = { checks: [], executions: [], touched: [], nonces: [...seenNonces], logged: [] };
    const deps = {
        store: {
            getWebhook: async (slug) => (slug === 'hook1' ? { id: 'hook1', automationId: 'auto1', secret, previousSecret, triggerStepId: 'trg2' } : null),
            checkAndStoreNonce: async (nonce) => { if (seen.nonces.includes(nonce)) return false; seen.nonces.push(nonce); return true; },
            touchWebhook: async (slug) => { seen.touched.push(slug); },
            getAutomation: async () => automation,
        },
        check: (input) => { seen.checks.push(input); return checkWebhookSignature(input); },
        liveHasTrigger: () => live,
        execute: async (a, options) => { seen.executions.push({ automation: a, options }); },
        logDelivery: logDelivery || (async (d) => { seen.logged.push(d); }),
        rejectLogPerMinute: () => rejectLogPerMinute,
        log: { error() {}, warn() {} },
    };
    return { deps, seen };
}

function delivery({ slug = 'hook1', body = { order: 1 }, nonce = 'nonce-1', secret = SECRET, timestamp = null, signature } = {}) {
    const rawBody = JSON.stringify(body);
    const message = timestamp === null ? `${nonce}\n${rawBody}` : `${nonce}\n${timestamp}\n${rawBody}`;
    return { slug, signature: signature ?? sign(secret, message), nonce, timestamp, rawBody, body, headers: { content_type: 'application/json' } };
}

/** The answer a sender gets: the route's two steps in one. */
async function answer(d, deps) {
    const verified = await verifyDeliverySignature(d, deps);
    return verified.ok ? startSignedDelivery(verified.webhook, d, deps) : NOT_ACCEPTED;
}

const flush = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

test('an address that does not accept a delivery gives one answer, whatever the reason', async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    const refused = {
        'no such address': delivery({ slug: 'nobody' }),
        'no signature': delivery({ signature: '' }),
        'no nonce': delivery({ nonce: '' }),
        'a signature under another secret': delivery({ secret: 'cd'.repeat(32) }),
        'a signature without its prefix': delivery({ signature: 'deadbeef' }),
        'a timestamp outside the window': delivery({ timestamp: stale }),
    };
    for (const [why, d] of Object.entries(refused)) {
        const { deps, seen } = world();
        const out = await answer(d, deps);
        assert.deepStrictEqual(out, { status: 401, body: { error: 'Delivery not accepted' } }, why);
        await flush();
        assert.deepStrictEqual([seen.executions.length, seen.nonces.length, seen.touched.length], [0, 0, 0], `${why}: nothing starts, no nonce is spent`);
    }
});

test('a webhook of an automation that is not active gives the same answer to a delivery that is not signed for it', async () => {
    const { deps } = world({ automation: { id: 'auto1', isActive: false, isDraft: false } });
    assert.deepStrictEqual(await answer(delivery({ secret: 'cd'.repeat(32) }), deps), NOT_ACCEPTED);
});

test('an address that names no webhook is still checked, against a key that is not a webhook secret', async () => {
    const { deps, seen } = world();
    const verified = await verifyDeliverySignature(delivery({ slug: 'nobody' }), deps);
    assert.deepStrictEqual(verified, { ok: false, webhook: null, reason: 'unknown' });
    assert.strictEqual(seen.checks.length, 2, 'as many checks as an address with a webhook gets');
    for (const check of seen.checks) {
        assert.match(check.secret, /^[0-9a-f]{64}$/);
        assert.notStrictEqual(check.secret, SECRET);
    }

    // A delivery signed with a real webhook's secret is not accepted at another address.
    const other = world();
    assert.deepStrictEqual(await answer(delivery({ slug: 'nobody' }), other.deps), NOT_ACCEPTED);
});

test('a webhook whose stored secret cannot be read accepts nothing', async () => {
    const { deps, seen } = world({ secret: null });
    for (const d of [delivery(), delivery({ secret: '' })]) assert.deepStrictEqual(await answer(d, deps), NOT_ACCEPTED);
    assert.ok(seen.checks.every((c) => typeof c.secret === 'string' && c.secret.length === 64));
});

test('the refusal says why to the caller of the function, never to the sender', async () => {
    const { deps } = world();
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    assert.strictEqual((await verifyDeliverySignature(delivery({ signature: '' }), deps)).reason, 'missing');
    assert.strictEqual((await verifyDeliverySignature(delivery({ secret: 'cd'.repeat(32) }), deps)).reason, 'bad_signature');
    assert.strictEqual((await verifyDeliverySignature(delivery({ timestamp: stale }), deps)).reason, 'stale_timestamp');
});

test('during a rotation\'s overlap the new secret and the one before both sign; any other secret does not', async () => {
    const OLD = 'ee'.repeat(32);
    for (const [secret, status] of [[SECRET, 202], [OLD, 202], ['cd'.repeat(32), 401]]) {
        const { deps, seen } = world({ previousSecret: OLD });
        assert.strictEqual((await answer(delivery({ secret }), deps)).status, status);
        assert.strictEqual(seen.checks.length, 2, 'every delivery is checked against both');
    }
    // After the overlap the store hands no previous secret: only the new one signs.
    const { deps } = world();
    assert.deepStrictEqual(await answer(delivery({ secret: OLD }), deps), NOT_ACCEPTED);
});

test('a signed delivery starts one run and answers 202', async () => {
    const { deps, seen } = world();
    const d = delivery({ timestamp: String(Math.floor(Date.now() / 1000)) });
    assert.deepStrictEqual(await answer(d, deps), { status: 202, body: { accepted: true, automationId: 'auto1' } });
    await flush();
    assert.strictEqual(seen.executions.length, 1);
    assert.deepStrictEqual(seen.executions[0].options, {
        triggerKind: 'webhook', triggerPayload: { order: 1 }, triggerHeaders: { content_type: 'application/json' }, rootStepId: 'trg2',
    });
    assert.deepStrictEqual(seen.touched, ['hook1']);
});

test('the same signed delivery a second time is refused as a replay and starts nothing', async () => {
    const { deps, seen } = world();
    const d = delivery();
    assert.strictEqual((await answer(d, deps)).status, 202);
    assert.deepStrictEqual(await answer(d, deps), { status: 401, body: { error: 'Replayed nonce' } });
    await flush();
    assert.strictEqual(seen.executions.length, 1);
});

test('a signed delivery to an automation that is not active answers 409', async () => {
    for (const automation of [null, { id: 'auto1', isActive: false, isDraft: false }, { id: 'auto1', isActive: true, isDraft: true }]) {
        const { deps, seen } = world({ automation });
        assert.deepStrictEqual(await answer(delivery(), deps), { status: 409, body: { error: 'Automation is not active' } });
        await flush();
        assert.strictEqual(seen.executions.length, 0);
    }
});

test('a signed delivery for a trigger that is not live yet answers 409 with its code', async () => {
    const { deps, seen } = world({ automation: { id: 'auto1', isActive: true, isDraft: false, liveVersion: 3 }, live: false });
    const out = await answer(delivery(), deps);
    assert.strictEqual(out.status, 409);
    assert.strictEqual(out.body.code, 'trigger_not_live');
    await flush();
    assert.strictEqual(seen.executions.length, 0);
});

// ── The delivery log ────────────────────────────────────────────────────────

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

test('every delivery to an address with a webhook is logged with what became of it, its size and never its body', async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    const body = { order: 1, note: 'do not keep me' };
    const raw = JSON.stringify(body);
    const cases = [
        ['accepted', world(), delivery({ body })],
        ['bad_signature', world(), delivery({ body, secret: 'cd'.repeat(32) })],
        ['bad_signature', world(), delivery({ body, signature: '' })],
        ['stale_timestamp', world(), delivery({ body, timestamp: stale })],
        ['replay', world({ seenNonces: ['hook1:nonce-1'] }), delivery({ body })],
        ['inactive', world({ automation: { id: 'auto1', isActive: false } }), delivery({ body })],
        ['trigger_not_live', world({ automation: { id: 'auto1', isActive: true, liveVersion: 2 }, live: false }), delivery({ body })],
    ];
    for (const [status, { deps, seen }, d] of cases) {
        await answer(d, deps);
        await flush();
        assert.strictEqual(seen.logged.length, 1, status);
        const signed = status !== 'bad_signature' && status !== 'stale_timestamp';
        assert.deepStrictEqual(seen.logged[0], { webhookId: 'hook1', status, bodyBytes: Buffer.byteLength(raw), bodySha256: signed ? sha256(raw) : null }, status);
        assert.ok(!JSON.stringify(seen.logged[0]).includes('do not keep me'));
    }
});

test('an address that names no webhook writes nothing', async () => {
    const { deps, seen } = world();
    await answer(delivery({ slug: 'nobody' }), deps);
    await flush();
    assert.deepStrictEqual(seen.logged, []);
});

test('deliveries that start no run are written up to the limit per webhook per minute; accepted ones always', async () => {
    const { deps, seen } = world({ rejectLogPerMinute: 3 });
    for (let i = 0; i < 10; i++) await answer(delivery({ secret: 'cd'.repeat(32), nonce: `bad-${i}` }), deps);
    await flush();
    assert.strictEqual(seen.logged.length, 3);
    for (let i = 0; i < 5; i++) assert.strictEqual((await answer(delivery({ nonce: `good-${i}` }), deps)).status, 202);
    assert.strictEqual(seen.logged.filter((d) => d.status === 'accepted').length, 5);

    const unlimited = world({ rejectLogPerMinute: 0 });
    for (let i = 0; i < 30; i++) await answer(delivery({ secret: 'cd'.repeat(32), nonce: `bad-${i}` }), unlimited.deps);
    await flush();
    assert.strictEqual(unlimited.seen.logged.length, 30, '0 = every one');
});

test('a log that cannot be written changes no answer and stops no run', async () => {
    const { deps, seen } = world({ logDelivery: async () => { throw new Error('no table'); } });
    assert.strictEqual((await answer(delivery(), deps)).status, 202);
    assert.deepStrictEqual(await answer(delivery({ secret: 'cd'.repeat(32) }), deps), NOT_ACCEPTED);
    await flush();
    assert.strictEqual(seen.executions.length, 1);
});
