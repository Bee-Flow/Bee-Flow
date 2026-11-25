const test = require('node:test');
const assert = require('node:assert');
const { sweepHabits } = require('./habitSweep.mts');

const WEEK_MS = 7 * 86_400_000;

function fakeStore(users) {
    const calls = { pruned: [], forgotten: [] };
    return {
        calls,
        store: {
            pruneAll: async (before) => { calls.pruned.push(before.toISOString()); },
            users: async () => users,
            forget: async (u) => { calls.forgotten.push(u); },
        },
    };
}

test('the sweep drops notes older than eight weeks for everyone, and all notes of a person who is no longer on or allowed', async () => {
    const now = new Date('2026-11-24T12:00:00Z');
    const { calls, store } = fakeStore(['on', 'switched-off', 'org-disallowed']);
    const forgotten = await sweepHabits(now, { enabled: async (u) => u === 'on', store });
    assert.deepStrictEqual(calls.pruned, [new Date(now.getTime() - 8 * WEEK_MS).toISOString()]);
    assert.deepStrictEqual([forgotten, calls.forgotten], [2, ['switched-off', 'org-disallowed']]);
});

test('a person whose state cannot be read keeps their notes this time, and the others are still swept; nothing throws', async () => {
    const { calls, store } = fakeStore(['broken', 'off']);
    const enabled = async (u) => { if (u === 'broken') throw new Error('config down'); return false; };
    assert.strictEqual(await sweepHabits(new Date(), { enabled, store }), 1);
    assert.deepStrictEqual(calls.forgotten, ['off']);
    const failing = { ...store, pruneAll: async () => { throw new Error('db down'); } };
    assert.strictEqual(await sweepHabits(new Date(), { enabled, store: failing }), 0);
});
