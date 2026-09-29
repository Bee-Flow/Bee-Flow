/**
 * perUserRateLimit — the Redis-backed fleet-wide window and its guarantees:
 * unnamed limiters never touch Redis, named ones count there, and ANY Redis
 * failure fails OPEN to the original in-memory window (a rate limiter must
 * never become an outage).
 *
 * Run: cd server && node --test utils/perUserRateLimit.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { perUserRateLimit } = require('./perUserRateLimit');

function fakeRes() {
    const res = {
        headers: {},
        statusCode: null,
        body: null,
        set(k, v) { this.headers[k] = v; return this; },
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; },
    };
    return res;
}

function req(userId = 'u1') {
    return { session: { user: { id: userId } }, ip: '1.2.3.4' };
}

// Run the middleware and await its (possibly async) settlement.
function invoke(mw, r, res) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; resolve(v); } };
        const origJson = res.json.bind(res);
        res.json = (b) => { const out = origJson(b); done('denied'); return out; };
        mw(r, res, () => done('next'));
    });
}

test('an UNNAMED limiter never touches Redis (memory path only)', async () => {
    const redis = { incr: async () => { throw new Error('must not be called'); } };
    const mw = perUserRateLimit({ windowMs: 60_000, max: 2, _redis: redis });
    assert.equal(await invoke(mw, req(), fakeRes()), 'next');
    assert.equal(await invoke(mw, req(), fakeRes()), 'next');
    const res = fakeRes();
    assert.equal(await invoke(mw, req(), res), 'denied');
    assert.equal(res.statusCode, 429);
    assert.ok(Number(res.headers['Retry-After']) >= 1);
});

test('a NAMED limiter counts in Redis: allows to max, then 429 with Retry-After', async () => {
    const calls = [];
    let count = 0;
    const redis = {
        incr: async (key) => { calls.push(key); return ++count; },
        pexpire: async () => 1,
    };
    const mw = perUserRateLimit({ windowMs: 60_000, max: 2, name: 'test-limit', _redis: redis });

    assert.equal(await invoke(mw, req(), fakeRes()), 'next');
    assert.equal(await invoke(mw, req(), fakeRes()), 'next');
    const res = fakeRes();
    assert.equal(await invoke(mw, req(), res), 'denied');
    assert.equal(res.statusCode, 429);
    assert.ok(Number(res.headers['Retry-After']) >= 1);

    // Key shape: rl:{name}:{key}:{windowIndex} — same window, same key.
    assert.equal(new Set(calls).size, 1);
    assert.match(calls[0], /^rl:test-limit:u1:\d+$/);
});

test('Redis errors fail OPEN to the in-memory window', async () => {
    const redis = { incr: async () => { throw new Error('redis down'); } };
    const mw = perUserRateLimit({ windowMs: 60_000, max: 1, name: 'test-fallback', _redis: redis });

    assert.equal(await invoke(mw, req(), fakeRes()), 'next', 'first request passes via memory');
    const res = fakeRes();
    assert.equal(await invoke(mw, req(), res), 'denied', 'memory window still enforces');
    assert.equal(res.statusCode, 429);
});

test('keys are per user — one user at the limit does not block another', async () => {
    let counts = new Map();
    const redis = {
        incr: async (key) => { const n = (counts.get(key) || 0) + 1; counts.set(key, n); return n; },
        pexpire: async () => 1,
    };
    const mw = perUserRateLimit({ windowMs: 60_000, max: 1, name: 'test-peruser', _redis: redis });
    assert.equal(await invoke(mw, req('alice'), fakeRes()), 'next');
    assert.equal(await invoke(mw, req('alice'), fakeRes()), 'denied');
    assert.equal(await invoke(mw, req('bob'), fakeRes()), 'next', 'bob has his own window');
});

test('pexpire is set on the FIRST hit of a window only', async () => {
    let count = 0;
    const expires = [];
    const redis = {
        incr: async () => ++count,
        pexpire: async (key, ms) => { expires.push({ key, ms }); return 1; },
    };
    const mw = perUserRateLimit({ windowMs: 60_000, max: 5, name: 'test-expire', _redis: redis });
    await invoke(mw, req(), fakeRes());
    await invoke(mw, req(), fakeRes());
    assert.equal(expires.length, 1, 'only the window-creating hit sets the TTL');
    assert.ok(expires[0].ms > 60_000, 'TTL covers the window plus skew grace');
});

// ── costFn: charging per unit of work, not per request ──────────────
// The batching read endpoint is why this exists: one request may carry 25
// reads, so a request-counting window stops limiting the work it exists to
// limit.

test('costFn charges a request for what it asks for (memory path)', async () => {
    const mw = perUserRateLimit({ windowMs: 60_000, max: 10, costFn: (r) => r.cost });
    const withCost = (c) => ({ ...req(), cost: c });
    assert.equal(await invoke(mw, withCost(6), fakeRes()), 'next', '6 of 10');
    assert.equal(await invoke(mw, withCost(4), fakeRes()), 'next', '10 of 10 exactly');
    const res = fakeRes();
    assert.equal(await invoke(mw, withCost(1), res), 'denied', 'the 11th unit is refused');
    assert.ok(res.headers['Retry-After'], 'still says how long to wait');
});

test('a costly request is refused WHOLE — a partial charge would overrun the budget', async () => {
    const mw = perUserRateLimit({ windowMs: 60_000, max: 10, costFn: (r) => r.cost });
    const withCost = (c) => ({ ...req(), cost: c });
    assert.equal(await invoke(mw, withCost(8), fakeRes()), 'next');
    assert.equal(await invoke(mw, withCost(5), fakeRes()), 'denied', '8 + 5 > 10');
    assert.equal(await invoke(mw, withCost(2), fakeRes()), 'next', 'a request that still fits is served');
});

test('a nonsense cost counts as 1, never as free', async () => {
    const mw = perUserRateLimit({ windowMs: 60_000, max: 2, costFn: (r) => r.cost });
    const withCost = (c) => ({ ...req(), cost: c });
    assert.equal(await invoke(mw, withCost(0), fakeRes()), 'next');
    assert.equal(await invoke(mw, withCost(-5), fakeRes()), 'next');
    assert.equal(await invoke(mw, withCost('nope'), fakeRes()), 'denied', 'three requests, three units');
});

test('cost 1 still issues a plain INCR; a bigger cost uses INCRBY', async () => {
    const seen = [];
    let total = 0;
    const redis = {
        incr: async (key) => { seen.push(['incr', key, 1]); total += 1; return total; },
        incrby: async (key, by) => { seen.push(['incrby', key, by]); total += by; return total; },
        pexpire: async () => 1,
    };
    const mw = perUserRateLimit({ windowMs: 60_000, max: 50, name: 'test-cost', costFn: (r) => r.cost, _redis: redis });
    await invoke(mw, { ...req(), cost: 1 }, fakeRes());
    await invoke(mw, { ...req(), cost: 12 }, fakeRes());
    assert.equal(seen[0][0], 'incr', 'unit cost keeps the command every other call site issues');
    assert.deepEqual(seen[1].slice(0, 3), ['incrby', seen[1][1], 12]);
});

test('the Redis window counts UNITS, and the TTL is still set once', async () => {
    let total = 0;
    const expires = [];
    const redis = {
        incr: async () => { total += 1; return total; },
        incrby: async (key, by) => { total += by; return total; },
        pexpire: async (key, ms) => { expires.push(ms); return 1; },
    };
    const mw = perUserRateLimit({ windowMs: 60_000, max: 10, name: 'test-units', costFn: (r) => r.cost, _redis: redis });
    assert.equal(await invoke(mw, { ...req(), cost: 7 }, fakeRes()), 'next');
    assert.equal(expires.length, 1, 'the window-creating hit sets the TTL even at cost 7');
    assert.equal(await invoke(mw, { ...req(), cost: 7 }, fakeRes()), 'denied', '14 units against a 10-unit budget');
    assert.equal(expires.length, 1, 'and no second TTL write');
});

test('a Redis failure falls open to the memory window WITH the cost intact', async () => {
    const redis = { incr: async () => { throw new Error('redis down'); }, incrby: async () => { throw new Error('redis down'); } };
    const mw = perUserRateLimit({ windowMs: 60_000, max: 10, name: 'test-cost-fallback', costFn: (r) => r.cost, _redis: redis });
    assert.equal(await invoke(mw, { ...req(), cost: 9 }, fakeRes()), 'next');
    assert.equal(await invoke(mw, { ...req(), cost: 4 }, fakeRes()), 'denied', 'the fallback charges the cost too');
});
