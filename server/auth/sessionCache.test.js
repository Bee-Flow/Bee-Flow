// @typecheck
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { wrapWithRedisCache } = require('./sessionCache');

function fakeRedis({ failSet = false } = {}) {
    const calls = [];
    return {
        calls,
        async get(k) { calls.push(['get', k]); return null; },
        async set(...args) {
            calls.push(['set', ...args]);
            if (failSet) throw new Error('boom');
            return 'OK';
        },
        async del(k) { calls.push(['del', k]); return 1; },
    };
}

function fakePgStore(rows = {}) {
    return {
        get(sid, cb) { cb(null, rows[sid] || null); },
        set(sid, sess, cb) { rows[sid] = sess; cb(null); },
        touch(sid, sess, cb) { rows[sid] = sess; cb(null); },
        destroy(sid, cb) { delete rows[sid]; cb(null); },
    };
}

const tick = () => new Promise((r) => setImmediate(r));

test('returns the pg store unchanged without a redis client', () => {
    const pg = fakePgStore();
    assert.equal(wrapWithRedisCache(pg, null), pg);
});

test('set writes to pg and passes the TTL as a node-redis options object', async () => {
    const redis = fakeRedis();
    const rows = {};
    const store = wrapWithRedisCache(fakePgStore(rows), redis);
    await new Promise((res, rej) => store.set('s1', { user: 1 }, (e) => (e ? rej(e) : res())));
    await tick();
    assert.deepEqual(rows.s1, { user: 1 });
    const set = redis.calls.find((c) => c[0] === 'set');
    assert.equal(set[1], 'bf:sess:s1');
    assert.equal(set[2], JSON.stringify({ user: 1 }));
    assert.deepEqual(set[3], { EX: 15 * 60 });
    assert.equal(set.length, 4, 'no ioredis-style positional EX arguments');
});

test('the TTL follows a shorter cookie expiry, capped at 15 minutes', async () => {
    const redis = fakeRedis();
    const store = wrapWithRedisCache(fakePgStore(), redis);
    const soon = new Date(Date.now() + 120 * 1000).toISOString();
    await new Promise((res) => store.set('s2', { cookie: { expires: soon } }, res));
    await tick();
    const ex = redis.calls.find((c) => c[0] === 'set')[3].EX;
    assert.ok(ex > 100 && ex <= 120, `unexpected EX ${ex}`);
});

test('get on a cache miss falls back to pg and writes back with a TTL', async () => {
    const redis = fakeRedis();
    const store = wrapWithRedisCache(fakePgStore({ s3: { a: 1 } }), redis);
    const got = await new Promise((res, rej) => store.get('s3', (e, v) => (e ? rej(e) : res(v))));
    await tick();
    assert.deepEqual(got, { a: 1 });
    assert.deepEqual(redis.calls.find((c) => c[0] === 'set')[3], { EX: 15 * 60 });
});

test('a failing redis SET does not fail the session write', async () => {
    const store = wrapWithRedisCache(fakePgStore(), fakeRedis({ failSet: true }));
    const err = await new Promise((res) => store.set('s4', { a: 1 }, res));
    assert.equal(err, null);
});

test('destroy removes the redis key as well', async () => {
    const redis = fakeRedis();
    const store = wrapWithRedisCache(fakePgStore({ s5: { a: 1 } }), redis);
    await new Promise((res) => store.destroy('s5', res));
    await tick();
    assert.deepEqual(redis.calls.find((c) => c[0] === 'del'), ['del', 'bf:sess:s5']);
});
