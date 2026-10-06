'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const quota = require('./gmailQuota');

test('a burst passes at once; past it a call waits for the refill (100 units a second)', () => {
    quota._buckets.clear();
    const t0 = 1_000_000;
    // 1,500 units of burst: 75 message gets of 20 go out without waiting.
    for (let i = 0; i < 75; i++) assert.equal(quota.reserve('k', 20, t0), 0);
    // The 76th waits 200 ms (20 units at 0.1 unit/ms).
    assert.equal(quota.reserve('k', 20, t0), 200);
    // A second later 100 units came back.
    quota._buckets.clear();
    for (let i = 0; i < 75; i++) quota.reserve('k', 20, t0);
    assert.equal(quota.reserve('k', 20, t0 + 1000), 0);
});

test('accounts do not share a bucket, and the key is a hash, never the token', () => {
    quota._buckets.clear();
    const a = quota.accountKey({ refreshToken: 'rt-a' });
    const b = quota.accountKey({ refreshToken: 'rt-b' });
    assert.notEqual(a, b);
    assert.ok(!a.includes('rt-a'));
    for (let i = 0; i < 75; i++) quota.reserve(a, 20, 0);
    assert.equal(quota.reserve(b, 20, 0), 0);
});

test('withQuota passes calls through unchanged, charging the method\'s units', async () => {
    quota._buckets.clear();
    const calls = [];
    const gmail = { users: { messages: {
        get(args) { calls.push(['get', args, this === gmail.users.messages]); return Promise.resolve({ data: { id: args.id } }); },
        attachments: { get(args) { calls.push(['att', args]); return Promise.resolve({ data: { size: 1 } }); } },
    } }, other: 1 };
    const session = { refreshToken: 'rt-x' };
    const g = quota.withQuota(gmail, session);
    assert.deepEqual((await g.users.messages.get({ id: 'm1' })).data, { id: 'm1' });
    await g.users.messages.attachments.get({ id: 'a1' });
    assert.deepEqual(calls, [['get', { id: 'm1' }, true], ['att', { id: 'a1' }]]);
    assert.equal(g.other, 1);
    // 20 + 20 units spent from this account's burst.
    assert.equal(quota._buckets.get(quota.accountKey(session)).units <= quota.BURST - 40 + 1, true);
});

test('withQuota works on the real, frozen client google.gmail() returns', async () => {
    // googleapis freezes the client, so `users` is a read-only,
    // non-configurable property. A Proxy over the client itself that hands
    // back a wrapped `users` breaks a JavaScript invariant and threw
    // "'get' on proxy: property 'users' is a read-only and non-configurable
    // data property" on every Gmail call.
    // Only the Gmail API: all of `googleapis` takes ~20 s to load.
    const { gmail } = require('googleapis/build/src/apis/gmail');
    const real = gmail({ version: 'v1' });
    assert.equal(Object.isFrozen(real), true);
    const g = quota.withQuota(real, { refreshToken: 'rt-frozen' });
    assert.equal(typeof g.users.messages.get, 'function');
    assert.equal(typeof g.users.messages.attachments.get, 'function');
    assert.equal(g.context, real.context);

    // And a call still goes through the bucket on a frozen client.
    quota._buckets.clear();
    const calls = [];
    const frozen = Object.freeze({ users: { messages: { get(args) { calls.push(args.id); return Promise.resolve({ data: { id: args.id } }); } } } });
    const session = { refreshToken: 'rt-frozen-fake' };
    const wrapped = quota.withQuota(frozen, session);
    assert.deepEqual((await wrapped.users.messages.get({ id: 'm9' })).data, { id: 'm9' });
    assert.deepEqual(calls, ['m9']);
    assert.ok(quota._buckets.get(quota.accountKey(session)).units <= quota.BURST - 20 + 1);
});
