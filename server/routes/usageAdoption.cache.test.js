'use strict';
/**
 * The Adoption report's 60 s answer cache (routes/usageAdoption.js createCache)
 * and what a people page keeps in it (routes/usageAdoptionShape.js compactPeople).
 *
 *   - bounded by its entries AND by the people rows they hold, oldest first;
 *   - expired entries leave on the next write, not only when read again;
 *   - a partial answer, or one larger than the whole row budget, is not kept;
 *   - a cached people page holds the fields the report shows, not member rows,
 *     and the names of every group of the organisation.
 *
 * Run: cd server && node --test routes/usageAdoption.cache.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCache, CACHE_TTL_MS } = require('./usageAdoption');
const { compactPeople } = require('./usageAdoptionShape');

const page = (n) => ({ people: Array.from({ length: n }, (_, i) => ({ i })), partial: false });

test('the row budget bounds the cache, the oldest entries going first', async () => {
    let t = 0;
    const cache = createCache(() => t, { maxEntries: 100, maxRows: 10 });
    await cache.get('a', async () => page(4));
    await cache.get('b', async () => page(4));
    assert.deepEqual(cache.stats(), { entries: 2, rows: 8 });
    await cache.get('c', async () => page(4));
    assert.deepEqual(cache.stats(), { entries: 2, rows: 8 }, 'a made room for c');
    let loads = 0;
    await cache.get('a', async () => { loads++; return page(4); });
    assert.equal(loads, 1, 'a was evicted');
    await cache.get('c', async () => { loads++; return page(4); });
    assert.equal(loads, 1, 'c is still cached');
    // Another route's answer weighs one row.
    await cache.get('summary', async () => ({ members: {}, partial: false }));
    assert.ok(cache.stats().rows <= 10);
});

test('the entry cap still holds', async () => {
    const cache = createCache(() => 0, { maxEntries: 3, maxRows: 1000 });
    for (const k of ['a', 'b', 'c', 'd', 'e']) await cache.get(k, async () => ({ partial: false }));
    assert.deepEqual(cache.stats(), { entries: 3, rows: 3 });
});

test('expired entries leave on the next write', async () => {
    let t = 0;
    const cache = createCache(() => t, { maxEntries: 100, maxRows: 1000 });
    for (const k of ['a', 'b', 'c']) await cache.get(k, async () => page(5));
    assert.deepEqual(cache.stats(), { entries: 3, rows: 15 });
    t = CACHE_TTL_MS + 1;
    await cache.get('d', async () => page(2));
    assert.deepEqual(cache.stats(), { entries: 1, rows: 2 }, 'only the fresh entry is kept');
});

test('a partial answer and one over the whole budget are not kept; the same key never counts twice', async () => {
    const cache = createCache(() => 0, { maxEntries: 100, maxRows: 10 });
    await cache.get('p', async () => ({ ...page(3), partial: true }));
    await cache.get('big', async () => page(11));
    assert.deepEqual(cache.stats(), { entries: 0, rows: 0 });
    // Two loads of one key racing: the second write replaces the first.
    await Promise.all([cache.get('k', async () => page(3)), cache.get('k', async () => page(3))]);
    assert.deepEqual(cache.stats(), { entries: 1, rows: 3 });
});

test('a cached people page holds the shown fields, not the member rows, and every group name', () => {
    const member = {
        id: 'u1', username: 'ann', displayName: 'Ann', email: 'ann@example.test', phone: '+31 6 0000',
        orgRole: 'member', lastSeenAt: '2026-10-01T10:00:00.000Z', avatarType: 'emoji', groups: ['g1', 'g2'],
    };
    const out = compactPeople({
        people: [{ id: 'u1', member, groupIds: ['g1'], status: 'ai_active', calls: 2, cost: 1.5, areas: ['chat'], built: { agent: 1 }, firstAiUseAt: null }],
        groups: [{ id: 'g1', name: 'Narrowed' }],
        allGroups: [{ id: 'g1', name: 'Sales' }, { id: 'g2', name: 'Support' }],
        total: 1, nextCursor: null, partial: false,
    });
    assert.deepEqual(Object.keys(out.people[0].member).sort(), ['avatarType', 'displayName', 'lastSeenAt', 'orgRole', 'username']);
    assert.ok(!JSON.stringify(out).includes('ann@example.test'));
    assert.ok(!JSON.stringify(out).includes('+31'));
    assert.deepEqual(out.groupNames, [['g1', 'Sales'], ['g2', 'Support']], 'allGroups wins over the narrowed groups');
    const narrowedOnly = compactPeople({ people: [], groups: [{ id: 'g1', name: 'Sales' }], total: 0, nextCursor: null, partial: false });
    assert.deepEqual(narrowedOnly.groupNames, [['g1', 'Sales']]);
});
