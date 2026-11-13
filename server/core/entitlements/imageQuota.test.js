'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const userStore = require('../../stores/userStore');
const usageStore = require('../../stores/usageStore');
const { checkImageLimit, getImageQuota } = require('./imageQuota.mts');

/** Stub the reads; returns the calls the count query received. */
function stub(t, { userLimits = null, groupLimits = [], orgLimits = null, used = {} }) {
    const calls = [];
    t.mock.method(userStore, 'getImageLimitInputs', async () => ({ userLimits, groupLimits, orgLimits }));
    t.mock.method(usageStore, 'getUserImageCounts', async (userId, windowMs) => {
        calls.push({ userId, windowMs });
        return { hour: 0, day: 0, week: 0, month: 0, ...used };
    });
    return calls;
}

test('no limits anywhere: allowed, and the usage log is not read', async (t) => {
    const calls = stub(t, {});
    assert.equal(await checkImageLimit('u1'), null);
    assert.equal(calls.length, 0);
});

test('a call without a user has no limit', async (t) => {
    const calls = stub(t, { orgLimits: '{"day":1}', used: { day: 9 } });
    assert.equal(await checkImageLimit(null), null);
    assert.equal(calls.length, 0);
});

test('under the limit passes, counted over rolling windows', async (t) => {
    const calls = stub(t, { userLimits: '{"day":5}', used: { day: 4 } });
    assert.equal(await checkImageLimit('u1'), null);
    assert.equal(calls[0].userId, 'u1');
    assert.deepEqual(calls[0].windowMs, { hour: 3_600_000, day: 86_400_000, week: 604_800_000, month: 2_592_000_000 });
});

test('at the limit is blocked with the window and the number', async (t) => {
    stub(t, { orgLimits: '{"hour":3,"month":50}', used: { hour: 3, month: 20 } });
    const hit = await checkImageLimit('u1');
    assert.equal(hit.window, 'hour');
    assert.equal(hit.limit, 3);
    assert.equal(hit.used, 3);
    assert.match(hit.message, /3 per hour/);
});

test('the group limit applies when the user has none of their own', async (t) => {
    stub(t, { groupLimits: ['{"week":10}', '{"week":40}'], orgLimits: '{"week":5}', used: { week: 12 } });
    assert.equal(await checkImageLimit('u1'), null);
});

test('the quota carries the limits that apply and what is used', async (t) => {
    stub(t, { userLimits: { day: 5 }, orgLimits: { day: 2, month: 60 }, used: { day: 1, month: 7 } });
    assert.deepEqual(await getImageQuota('u1'), {
        limits: { day: 5, month: 60 },
        used: { hour: 0, day: 1, week: 0, month: 7 },
    });
});

test('a failed read blocks with a 503 instead of lifting the limit', async (t) => {
    t.mock.method(userStore, 'getImageLimitInputs', async () => { throw new Error('db down'); });
    await assert.rejects(checkImageLimit('u1'), (err) => err.status === 503 && err.code === 'image_limit_unavailable');
});
