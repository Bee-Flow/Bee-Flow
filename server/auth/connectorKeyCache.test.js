'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createKeyCache } = require('./connectorKeyCache');

test('an entry is served while fresh and forgotten after the time to live', () => {
    let t = 0;
    const cache = createKeyCache({ ttlMs: 1000, now: () => t });
    cache.set('alice', 'k1');
    t = 999; assert.strictEqual(cache.get('alice'), 'k1');
    t = 2001; assert.strictEqual(cache.get('alice'), null);
    assert.strictEqual(cache.size, 0);
});

test('the cache holds a bounded number of entries and drops the oldest', () => {
    const cache = createKeyCache({ maxEntries: 2 });
    cache.set('a', '1'); cache.set('b', '2'); cache.set('c', '3');
    assert.strictEqual(cache.size, 2);
    assert.strictEqual(cache.get('a'), null);
    assert.strictEqual(cache.get('c'), '3');
});
