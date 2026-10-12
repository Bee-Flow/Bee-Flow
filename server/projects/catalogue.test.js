'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { searchCatalogue, allPages } = require('./catalogue');
test('search filters titles and task descriptions, pages deterministically and omits descriptions', () => {
    const items = Array.from({ length: 85 }, (_, i) => ({ type: 'task', id: String(i).padStart(3, '0'), title: `Task ${i}`, description: 'Weekly launch' }));
    items.push({ type: 'file', id: 'f', title: 'Launch.pdf' });
    const first = searchCatalogue(items, { q: ' LAUNCH ', type: 'task', cursor: 0, limit: 40 });
    assert.equal(first.items.length, 40);
    assert.equal(first.nextCursor, '40');
    assert.equal('description' in first.items[0], false);
    const second = searchCatalogue(items, { q: 'launch', type: 'task', cursor: 40, limit: 40 });
    assert.equal(new Set([...first.items, ...second.items].map(i => i.id)).size, 80);
    assert.equal(searchCatalogue(items, { q: 'launch', type: 'task', cursor: 80, limit: 40 }).nextCursor, null);
    assert.deepEqual(searchCatalogue(items, { q: 'launch', type: 'file' }).items.map(i => i.id), ['f']);
});
test('collects all content pages, including an exact page boundary', async () => {
    const offsets = [];
    const result = await allPages(async ({ offset, limit }) => { offsets.push(offset); return Array.from({ length: Math.min(limit, 400 - offset) }, (_, n) => ({ id: offset + n })); });
    assert.equal(result.length, 400);
    assert.deepEqual(offsets, [0, 200, 400]);
});
