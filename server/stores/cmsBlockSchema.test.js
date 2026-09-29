/**
 * Unit — server block sanitization/normalization (Workstream B).
 *
 * Guards the contract that makes JSON import fail LOUDLY instead of silently
 * dropping blocks into an empty page: sanitizeBlocks normalizes near-misses
 * (aliased type strings, fields at top level, missing id) and reports what it
 * had to drop and why.
 *
 * DB is mocked so importing cmsStore does no real I/O and the process exits.
 * Run: node --test server/stores/cmsBlockSchema.test.js
 */

const assert = require('assert');
const test = require('node:test');
const Module = require('module');

process.env.NODE_ENV = 'test';
process.env.MASTER_ENCRYPTION_KEY = 'test-master-key-for-unit-tests-32chars!!';
process.env.CONFIG_INVALIDATION_LISTENER = '0';

const mockDb = {
    exec: async () => ({}),
    run: async () => ({ rows: [], rowCount: 0 }),
    getAll: async () => [],
    getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
    getOne: async () => null,
};
const dbPath = require.resolve('./../db');
require.cache[dbPath] = new Module(dbPath);
require.cache[dbPath].exports = mockDb;
require.cache[dbPath].loaded = true;

const { sanitizeBlocks } = require('./cmsStore');

test('conforming blocks round-trip with zero drops', () => {
    const { blocks, dropped } = sanitizeBlocks([
        { id: 'b1', type: 'hero', content: { eyebrow: 'Hi' }, style: {} },
        { id: 'b2', type: 'features', content: {}, enabled: false },
    ]);
    assert.strictEqual(dropped.length, 0);
    assert.strictEqual(blocks.length, 2);
    assert.strictEqual(blocks[0].content.eyebrow, 'Hi');
    assert.strictEqual(blocks[1].enabled, false);
});

test('unknown block type is dropped and reported by index + original type', () => {
    const { blocks, dropped } = sanitizeBlocks([
        { id: 'b1', type: 'landing', content: {} },
        { id: 'b2', type: 'hero', content: {} },
    ]);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].type, 'hero');
    assert.strictEqual(dropped.length, 1);
    assert.deepStrictEqual(dropped[0], { index: 0, type: 'landing', reason: 'unknown-type' });
});

test('aliased type string is resolved to the canonical type', () => {
    const { blocks, dropped } = sanitizeBlocks([{ id: 'b1', type: 'social-proof', content: {} }]);
    assert.strictEqual(dropped.length, 0);
    assert.strictEqual(blocks[0].type, 'socialProof');
});

test('top-level fields are wrapped into content', () => {
    const { blocks, dropped } = sanitizeBlocks([{ id: 'b1', type: 'hero', eyebrow: 'Hi', lead: 'x' }]);
    assert.strictEqual(dropped.length, 0);
    assert.strictEqual(blocks[0].content.eyebrow, 'Hi');
    assert.strictEqual(blocks[0].content.lead, 'x');
});

test('missing id is generated; missing-type and non-object are dropped', () => {
    const { blocks, dropped } = sanitizeBlocks([
        { type: 'hero', content: {} },   // no id → generated
        { content: {} },                 // no type → dropped
        'not-an-object',                 // → dropped
    ]);
    assert.strictEqual(blocks.length, 1);
    assert.ok(/^blk_/.test(blocks[0].id), 'generated a blk_ id');
    assert.deepStrictEqual(dropped.map(d => d.reason).sort(), ['missing-type', 'not-an-object']);
});

test('non-array input yields empty result, no throw', () => {
    assert.deepStrictEqual(sanitizeBlocks(null), { blocks: [], dropped: [] });
    assert.deepStrictEqual(sanitizeBlocks(undefined), { blocks: [], dropped: [] });
});
