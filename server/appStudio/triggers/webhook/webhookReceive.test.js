'use strict';

/**
 * A delivery to a webhook trigger, end to end against the REAL stores on PGlite with a fake clock
 * (testUtils/webhookTriggerHarness.testkit.js): what is accepted, what every refusal answers,
 * what a second copy of a delivery does, and what the run reads.
 *
 * Run: cd server && node --test appStudio/triggers/webhook/webhookReceive.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { webhookHarness } = require('../../../testUtils/webhookTriggerHarness.testkit');
const { jsonDepth, isNonce, readTimestamp, pickHeaders } = require('./webhookReceive.mts');

const h = webhookHarness({ before, after, beforeEach });
const { s, t, w, publish, unpublish, signed, receive, deliveries, definition, hook, row, settle, runs } = h;

const statuses = async () => (await deliveries()).map((d) => d.status);
const live = () => publish(definition([hook()]));

// ── Accepted ────────────────────────────────────────────────────────────────

test('a signed delivery answers 202 with a delivery id and starts one run as the owner, with the body in trigger.webhook', async () => {
    await live();
    const out = await receive(await signed({ order: 7, lines: [{ sku: 'A' }] }, { headers: { 'user-agent': 'sender/1', 'x-beeflow-event': 'order.created', authorization: 'Bearer x', 'x-forwarded-for': '203.0.113.9' } }));
    assert.equal(out.status, 202);
    assert.match(out.body.deliveryId, /^whd_/);
    const armed = await row('hook');
    const run = await settle(armed.lastRunId);
    assert.equal(run.status, 'success');
    assert.equal(run.origin, 'trigger');
    assert.equal(run.viewerUserId, 'owner');
    const { ctx } = s.executed[0];
    assert.equal(ctx.viewerId, 'owner');
    assert.equal(ctx.role, 'owner');
    assert.deepEqual(ctx.trigger, {
        kind: 'webhook',
        webhook: {
            body: { order: 7, lines: [{ sku: 'A' }] },
            headers: { content_type: 'application/json', user_agent: 'sender/1', x_beeflow_event: 'order.created' },
            deliveryId: out.body.deliveryId, receivedAt: new Date(s.clock).toISOString(),
        },
    });
    const [logged] = await deliveries();
    assert.deepEqual([logged.status, logged.runId, logged.bodyBytes], ['accepted', armed.lastRunId, 33]);
    assert.match(logged.bodyHash, /^[0-9a-f]{64}$/);
});

test('the scope a formula reads has trigger only in a run a trigger started', () => {
    const { buildServerScope } = require('../../actionExecutor/shared');
    assert.equal(Object.hasOwn(buildServerScope({ viewerId: 'u' }), 'trigger'), false);
    assert.deepEqual(buildServerScope({ viewerId: 'u', trigger: { kind: 'webhook', webhook: { body: { a: 1 } } } }).trigger, { kind: 'webhook', webhook: { body: { a: 1 } } });
});

// ── Every refusal a caller without the secret can cause is the same answer ────

test('unknown address, missing or wrong signature, a timestamp outside the window, a paused trigger and an unpublished app all answer 404 and start nothing', async () => {
    await live();
    const good = await signed({ a: 1 });
    const cases = {
        'unknown address': await signed({ a: 1 }, { endpointId: 'f'.repeat(48) }),
        'malformed address': await signed({ a: 1 }, { endpointId: '../etc' }),
        'no signature': { ...good, signature: '' },
        'wrong secret': await signed({ a: 1 }, { secret: 'not-the-secret' }),
        'signature of another body': { ...good, rawBody: Buffer.from('{"a":2}') },
        'signature of another delivery id': { ...good, nonce: 'another-delivery' },
        'no timestamp': { ...good, timestamp: '' },
        'timestamp too old': await signed({ a: 1 }, { timestamp: Math.floor(s.clock / 1000) - 301 }),
        'timestamp too far ahead': await signed({ a: 1 }, { timestamp: Math.floor(s.clock / 1000) + 301 }),
        'delivery id with other characters': await signed({ a: 1 }, { nonce: 'has spaces in it' }),
    };
    for (const [name, delivery] of Object.entries(cases)) assert.deepEqual(await receive(delivery), { status: 404 }, name);
    assert.deepEqual(await runs(), []);
    assert.deepEqual(await statuses(), ['bad_signature', 'bad_signature', 'bad_signature', 'bad_signature', 'bad_signature', 'stale_timestamp', 'stale_timestamp', 'bad_signature'],
        'the owner reads the reason in the log; an unknown address logs nothing');

    await h.switchTrigger('hook', false);
    assert.deepEqual(await receive(await signed({ a: 1 })), { status: 404 }, 'paused by the owner');
    await h.switchTrigger('hook', true);
    await unpublish();
    assert.deepEqual(await receive(await signed({ a: 1 })), { status: 404 }, 'unpublished');
    assert.deepEqual((await statuses()).slice(-2), ['disarmed', 'disarmed']);
    assert.deepEqual(await runs(), []);
});

test('a published copy that changed without a publish disarms the trigger at the delivery: 404, no run', async () => {
    await live();
    t.app.publishedDefinition = definition([hook()], [h.write('other')]);
    assert.deepEqual(await receive(await signed({ a: 1 })), { status: 404 });
    assert.equal(await row('hook'), null);
    assert.deepEqual(await runs(), []);
});

test('an owner whose account is not active: the delivery is not started and may be sent again', async () => {
    await live();
    t.owner.status = 'deactivated';
    const delivery = await signed({ a: 1 });
    assert.equal((await receive(delivery)).status, 429);
    t.owner.status = 'active';
    assert.equal((await receive(delivery)).status, 202, 'the same delivery id is free again');
});

// ── Replay and retried deliveries ───────────────────────────────────────────

test('the same delivery again answers the first delivery id and starts nothing', async () => {
    await live();
    const delivery = await signed({ a: 1 });
    const first = await receive(delivery);
    await settle((await row('hook')).lastRunId);
    const again = await receive(delivery);
    assert.deepEqual(again, { status: 202, body: { accepted: true, deliveryId: first.body.deliveryId, duplicate: true } });
    assert.equal((await runs()).length, 1);
    assert.deepEqual(await statuses(), ['accepted', 'replay']);
});

test('two identical deliveries at once start one run', async () => {
    await live();
    const delivery = await signed({ a: 1 });
    const out = await Promise.all([receive(delivery), receive(delivery)]);
    assert.deepEqual(out.map((o) => o.status).sort(), [202, 429], 'one is accepted, the other is told to come back');
    assert.equal((await runs()).length, 1);
    await settle((await row('hook')).lastRunId);
    assert.equal((await receive(delivery)).body.duplicate, true);
    assert.equal((await runs()).length, 1);
});

test('a delivery while the trigger\'s run is still going is not started and not lost: 429, and the retry runs', async () => {
    await live();
    let release;
    s.execute = () => new Promise((resolve) => { release = () => resolve({ ok: true }); });
    assert.equal((await receive(await signed({ n: 1 }))).status, 202);
    const second = await signed({ n: 2 });
    const held = await receive(second);
    assert.deepEqual([held.status, held.code], [429, 'busy']);
    release();
    await settle((await row('hook')).lastRunId);
    s.execute = async () => ({ ok: true });
    assert.equal((await receive(second)).status, 202, 'no pass of the job was needed in between');
    assert.equal((await runs()).length, 2);
    assert.deepEqual(await statuses(), ['accepted', 'busy', 'accepted']);
});

// ── Limits ──────────────────────────────────────────────────────────────────

test('the trigger takes only its deliveries per minute: the next one answers 429 and starts nothing', async () => {
    await live();
    w.limits.rpmPerTrigger = 1;
    assert.equal((await receive(await signed({ n: 1 }))).status, 202);
    await settle((await row('hook')).lastRunId);
    const over = await receive(await signed({ n: 2 }));
    assert.deepEqual([over.status, over.code, over.retryAfterSecs], [429, 'rate_limited', 30]);
    assert.equal((await runs()).length, 1);
    assert.deepEqual(await statuses(), ['accepted', 'rate_limited']);
});

test('a wrong signature does not spend the trigger\'s budget, and refused deliveries are logged up to the limit', async () => {
    await live();
    Object.assign(w.limits, { rpmPerTrigger: 1, rejectLogPerMinute: 2 });
    for (let i = 0; i < 5; i++) await receive(await signed({ i }, { secret: 'wrong' }));
    assert.deepEqual(await statuses(), ['bad_signature', 'bad_signature']);
    assert.equal((await receive(await signed({ ok: true }))).status, 202);
});

test('a body that is not a JSON object or list, or nests too deep, is refused to a signed caller with 400', async () => {
    await live();
    w.limits.bodyMaxDepth = 3;
    for (const [body, code] of [['not json', 'invalid_json'], ['"text"', 'invalid_body'], ['null', 'invalid_body'], [{ a: { b: { c: {} } } }, 'body_too_deep']]) {
        const out = await receive(await signed(body));
        assert.deepEqual([out.status, out.code], [400, code]);
    }
    assert.equal((await receive(await signed({ a: { b: { c: 1 } } }))).status, 202);
    assert.equal((await runs()).length, 1);
});

test('the delivery log keeps the newest N once they are older than the replay window', async () => {
    await live();
    w.limits.deliveryLogMax = 2;
    const send = async (i) => {
        await receive(await signed({ i }));
        await settle((await row('hook')).lastRunId);
        s.clock += h.MINUTE;
    };
    for (let i = 0; i < 4; i++) await send(i);
    assert.equal((await deliveries()).length, 4, 'a delivery inside the window stays, whatever the count: its id refuses a second copy');
    s.clock += 11 * h.MINUTE;
    await send(4);
    assert.deepEqual((await deliveries()).length, 2);
});

// ── Readers of request text ─────────────────────────────────────────────────

test('the small readers: depth, delivery id, timestamp, header allow-list', () => {
    assert.deepEqual([jsonDepth(1, 9), jsonDepth({}, 9), jsonDepth({ a: [1] }, 9), jsonDepth([[[[]]]], 2)], [0, 1, 2, 3]);
    assert.deepEqual([isNonce('abcdefgh'), isNonce('short'), isNonce('a'.repeat(129)), isNonce('abc def gh'), isNonce(12345678)], [true, false, false, false, false]);
    assert.deepEqual([readTimestamp('1700000000'), readTimestamp(''), readTimestamp('17e8'), readTimestamp('1'.repeat(13))], [1700000000, null, null, null]);
    assert.deepEqual(pickHeaders({ 'content-type': 'application/json', 'x-beeflow-signature': 'sha256=1', 'x-beeflow-nonce': 'n', cookie: 'c', 'x-request-id': ['a', 'b'] }),
        { content_type: 'application/json', x_request_id: 'a, b' });
});
