/**
 * Run: cd server && node --test --test-force-exit compliance/countsCache.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const cache = require('./countsCache');

test('a stored body comes back until the TTL passes', () => {
    cache.clear();
    cache.set('org1', { attention_open: 3 }, 1000);
    assert.deepStrictEqual(cache.get('org1', 1000 + cache.CACHE_TTL_MS), { attention_open: 3 });
    assert.strictEqual(cache.get('org1', 1000 + cache.CACHE_TTL_MS + 1), null);
    assert.strictEqual(cache.size(), 0, 'an expired entry is dropped, not just hidden');
});

test('org ids are compared as strings, so a numeric id and its text form are one entry', () => {
    cache.clear();
    cache.set(7, { a: 1 }, 0);
    assert.deepStrictEqual(cache.get('7', 0), { a: 1 });
    cache.invalidate(7);
    assert.strictEqual(cache.get('7', 0), null);
});

test('invalidate() without an org drops every entry', () => {
    cache.clear();
    cache.set('a', {}, 0); cache.set('b', {}, 0);
    cache.invalidate();
    assert.strictEqual(cache.size(), 0);
});

test('the cache is bounded — the oldest entry is evicted at the ceiling', () => {
    cache.clear();
    for (let i = 0; i < cache.CACHE_MAX_ENTRIES + 5; i++) cache.set(`org${i}`, { i }, 0);
    assert.ok(cache.size() <= cache.CACHE_MAX_ENTRIES, `size ${cache.size()} exceeds the ceiling`);
    assert.strictEqual(cache.get('org0', 0), null, 'the first org in is the first out');
    cache.clear();
});

test('no compliance module reaches up into the counts ROUTE for invalidation', () => {
    const dir = __dirname;
    const offenders = [];
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.js') || f.endsWith('.test.js')) continue;
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        if (/require\(\s*['"]\.\.\/routes\/compliance\/counts['"]\s*\)/.test(src)) offenders.push(f);
    }
    assert.deepStrictEqual(offenders, [], 'these must use ./countsCache instead');
});
