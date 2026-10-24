// @typecheck
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Redis } = require('ioredis');
const { wrapWithRedisCache, installRedisCacheWhenReady } = require('./sessionCache');

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

test('set writes to pg and passes the TTL in the ioredis positional EX form', async () => {
    const redis = fakeRedis();
    const rows = {};
    const store = wrapWithRedisCache(fakePgStore(rows), redis);
    await /** @type {Promise<void>} */ (new Promise((res, rej) => store.set('s1', { user: 1 }, (e) => (e ? rej(e) : res()))));
    await tick();
    assert.deepEqual(rows.s1, { user: 1 });
    const set = redis.calls.find((c) => c[0] === 'set');
    assert.equal(set[1], 'bf:sess:s1');
    assert.equal(set[2], JSON.stringify({ user: 1 }));
    assert.equal(set[3], 'EX');
    assert.equal(set[4], 15 * 60);
    assert.equal(set.length, 5, 'no node-redis options object');
});

test('the TTL follows a shorter cookie expiry, capped at 15 minutes', async () => {
    const redis = fakeRedis();
    const store = wrapWithRedisCache(fakePgStore(), redis);
    const soon = new Date(Date.now() + 120 * 1000).toISOString();
    await new Promise((res) => store.set('s2', { cookie: { expires: soon } }, res));
    await tick();
    const set = redis.calls.find((c) => c[0] === 'set');
    assert.equal(set[3], 'EX');
    const ex = set[4];
    assert.ok(ex > 100 && ex <= 120, `unexpected EX ${ex}`);
});

test('get on a cache miss falls back to pg and writes back with a TTL', async () => {
    const redis = fakeRedis();
    const store = wrapWithRedisCache(fakePgStore({ s3: { a: 1 } }), redis);
    const got = await new Promise((res, rej) => store.get('s3', (e, v) => (e ? rej(e) : res(v))));
    await tick();
    assert.deepEqual(got, { a: 1 });
    assert.deepEqual(redis.calls.find((c) => c[0] === 'set').slice(3), ['EX', 15 * 60]);
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

/** A fake ioredis that keeps values and honours `SET key value EX seconds` against a settable clock. */
function expiringRedis() {
    let now = 0;
    const data = new Map();
    return {
        advance(seconds) { now += seconds * 1000; },
        async get(k) {
            const e = data.get(k);
            if (!e) return null;
            if (e.expiresAt !== null && now >= e.expiresAt) { data.delete(k); return null; }
            return e.value;
        },
        async set(k, value, mode, seconds) {
            data.set(k, { value, expiresAt: mode === 'EX' ? now + seconds * 1000 : null });
            return 'OK';
        },
        async del(k) { return data.delete(k) ? 1 : 0; },
    };
}

test('a cached session expires after its TTL and is then read from pg again', async () => {
    const redis = expiringRedis();
    const rows = {};
    let pgReads = 0;
    const pg = fakePgStore(rows);
    const pgGet = pg.get;
    pg.get = (sid, cb) => { pgReads++; pgGet(sid, cb); };
    const store = wrapWithRedisCache(pg, redis);
    const read = () => new Promise((res, rej) => store.get('s6', (e, v) => (e ? rej(e) : res(v))));

    await new Promise((res) => store.set('s6', { v: 1 }, res));
    await tick();
    // Change the durable row behind the cache's back: a hit must still serve the cached copy.
    rows.s6 = { v: 2 };
    assert.deepEqual(await read(), { v: 1 });
    assert.equal(pgReads, 0, 'served from redis');

    redis.advance(15 * 60 - 1);
    assert.deepEqual(await read(), { v: 1 }, 'still cached one second before expiry');
    assert.equal(pgReads, 0);

    redis.advance(1);
    assert.deepEqual(await read(), { v: 2 }, 'expired: falls back to pg');
    assert.equal(pgReads, 1);
});

test('the set reaches ioredis as SET key value EX seconds', async () => {
    const client = new Redis({ lazyConnect: true });
    /** @type {any[]} */
    const sent = [];
    /** @type {any} */ (client).sendCommand = (/** @type {any} */ cmd) => {
        sent.push([cmd.name, ...cmd.args.map(String)]);
        cmd.resolve(cmd.name === 'get' ? null : 'OK');
        return cmd.promise;
    };
    const store = wrapWithRedisCache(fakePgStore(), client);
    await new Promise((res) => store.set('s7', { a: 1 }, res));
    await tick();
    assert.deepEqual(sent, [['set', 'bf:sess:s7', JSON.stringify({ a: 1 }), 'EX', String(15 * 60)]]);
    client.disconnect();
});

test('installRedisCacheWhenReady waits for the ioredis ready event, once', async () => {
    const client = Object.assign(new EventEmitter(), fakeRedis(), { status: 'connecting' });
    const pg = fakePgStore({ s8: { a: 1 } });
    const originalGet = pg.get;
    assert.equal(installRedisCacheWhenReady(pg, pg, client), true);
    assert.equal(pg.get, originalGet, 'PG-only until redis is ready');
    client.emit('ready');
    assert.notEqual(pg.get, originalGet, 'cache active after ready');
    const afterFirst = pg.get;
    client.emit('ready'); // a reconnect must not wrap a second time
    assert.equal(pg.get, afterFirst);
    const got = await new Promise((res) => pg.get('s8', (_e, v) => res(v)));
    assert.deepEqual(got, { a: 1 });
});

test('installRedisCacheWhenReady activates at once on a ready client and not at all without one', () => {
    const pg = fakePgStore();
    const originalGet = pg.get;
    assert.equal(installRedisCacheWhenReady(pg, pg, null), false);
    assert.equal(pg.get, originalGet);
    const client = Object.assign(new EventEmitter(), fakeRedis(), { status: 'ready' });
    installRedisCacheWhenReady(pg, pg, client);
    assert.notEqual(pg.get, originalGet);
});

test('bustSessionsForUser rejects when the redis eviction fails, so a revoked session is not left cached silently', async () => {
    const { bustSessionsForUser, bustSessionsForOrg } = require('./sessionCache');
    const pool = { query: async () => ({ rows: [{ sid: 's1' }] }) };
    const redis = { unlink: async () => { throw new Error('down'); }, del: async () => { throw new Error('down'); } };
    const db = /** @type {any} */ ({ pool, getRedis: () => redis });
    await assert.rejects(() => bustSessionsForUser('u1', { db }), /eviction failed/);
    await assert.rejects(() => bustSessionsForOrg('o1', { db }), /eviction failed/);
});

test('bustSessionsForUser evicts the cached keys and returns the count', async () => {
    const { bustSessionsForUser } = require('./sessionCache');
    const seen = [];
    const pool = { query: async () => ({ rows: [{ sid: 's1' }, { sid: 's2' }] }) };
    const redis = { unlink: async (...k) => { seen.push(...k); } };
    assert.equal(await bustSessionsForUser('u1', { db: /** @type {any} */ ({ pool, getRedis: () => redis }) }), 2);
    assert.deepEqual(seen, ['bf:sess:s1', 'bf:sess:s2']);
});
