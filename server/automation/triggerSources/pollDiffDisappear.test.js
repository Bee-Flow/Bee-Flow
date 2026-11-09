/**
 * emitDisappeared: an item that is gone becomes one event; over the per-tick
 * cap it stays in the cursor, so the next tick reports it.
 *
 * Run: cd server && node --test automation/triggerSources/pollDiffDisappear.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { emitDisappeared } = require('./pollDiffDisappear');

test('gone items are emitted up to the cap, the rest keep their cursor entry', () => {
    const prevMap = new Map([
        ['seen', { chg12: 'c0', vals: { sku: 'W-0' } }],
        ['gone1', { chg12: 'c1', vals: { sku: 'W-1' } }],
        ['gone2', { chg12: 'c2', vals: { sku: 'W-2' } }],
        ['gone3', { chg12: 'c3' }],
    ]);
    const emitted = [{ sku: 'W-9', _reason: 'changed' }];
    const entries = [];
    emitDisappeared({ prevMap, seenIds: new Set(['seen']), emitted, entries, maxPerTick: 2 });

    assert.strictEqual(emitted.length, 2, 'the cap counts the events of the whole tick');
    assert.strictEqual(emitted[1].sku, 'W-1');
    assert.strictEqual(emitted[1]._reason, 'disappeared');
    assert.deepStrictEqual(emitted[1].changedKeys, []);
    assert.deepStrictEqual(entries, [
        { id12: 'gone2', chg12: 'c2', vals: { sku: 'W-2' } },
        { id12: 'gone3', chg12: 'c3', vals: undefined },
    ]);
});
