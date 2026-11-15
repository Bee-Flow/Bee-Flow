// @typecheck strict
/**
 * The bound on the config cache (stores/configCache.mts): it holds at most
 * CACHE_MAX entries, an overflow drops the expired entries and then the oldest,
 * and what was written last is still served.
 *
 * Run: node --test stores/configCache.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { cacheGet, cacheSet, cacheInvalidate, cacheClear, cacheSize, CACHE_MAX, CACHE_TTL_MS } = require('./configCache.mts');

beforeEach(() => cacheClear());

test('a miss is undefined, a cached "no value" is null, and an entry expires after the TTL', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    assert.equal(cacheGet('absent'), undefined);

    cacheSet('unset', null);
    cacheSet('set', { a: 1 });
    assert.equal(cacheGet('unset'), null);
    assert.deepEqual(cacheGet('set'), { a: 1 });

    t.mock.timers.tick(CACHE_TTL_MS + 1);
    assert.equal(cacheGet('set'), undefined);
    assert.equal(cacheSize(), 1, 'the expired entry that was read is gone, the other one waits for a sweep');
});

test('the default bound is 5000 entries', () => {
    assert.equal(CACHE_MAX, 5000);
});

test('more keys than the bound: the cache stays at the bound and the newest keys are served', () => {
    const total = CACHE_MAX + 1000;
    for (let i = 0; i < total; i++) cacheSet(`key:${i}`, i);

    assert.equal(cacheSize(), CACHE_MAX);
    assert.equal(cacheGet('key:0'), undefined, 'the oldest key was dropped');
    assert.equal(cacheGet(`key:${total - CACHE_MAX - 1}`), undefined, 'the last key outside the bound was dropped');
    assert.equal(cacheGet(`key:${total - CACHE_MAX}`), total - CACHE_MAX, 'the first key inside the bound is still there');
    assert.equal(cacheGet(`key:${total - 1}`), total - 1, 'the newest key is still there');
});

test('an overflow drops every expired entry, not only enough to fit', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    for (let i = 0; i < CACHE_MAX; i++) cacheSet(`old:${i}`, i);
    assert.equal(cacheSize(), CACHE_MAX);

    t.mock.timers.tick(CACHE_TTL_MS + 1);
    cacheSet('fresh', 'value');

    assert.equal(cacheSize(), 1);
    assert.equal(cacheGet('fresh'), 'value');
});

test('writing a key again makes it the newest, so the overflow drops other keys first', () => {
    cacheSet('rewritten', 1);
    for (let i = 0; i < CACHE_MAX - 1; i++) cacheSet(`filler:${i}`, i);
    cacheSet('rewritten', 2);
    cacheSet('one-too-many', true);

    assert.equal(cacheSize(), CACHE_MAX);
    assert.equal(cacheGet('rewritten'), 2);
    assert.equal(cacheGet('filler:0'), undefined, 'the oldest untouched key made room');
});

test('invalidating a key removes only that key', () => {
    cacheSet('a', 1);
    cacheSet('b', 2);
    cacheInvalidate('a');
    assert.equal(cacheGet('a'), undefined);
    assert.equal(cacheGet('b'), 2);
});
