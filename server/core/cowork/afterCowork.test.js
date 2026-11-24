// @typecheck
/**
 * Hand-offs across owners on a desk (./afterCowork.mts): the follower of another owner gets only the result, the
 * fourth hand-off between owners does not happen, an item never starts twice in one chain, and a follower that is
 * both its owner's own and on the desk starts once. Every part is handed in.
 *
 * Run: cd server && node --test core/cowork/afterCowork.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { afterRunEnded, crossings, MAX_CROSS_OWNER } = require('./afterCowork.mts');

/** A run of `scheduleId` by `userId`, started after `after` (a run id) when given. */
const run = (/** @type {string} */ id, /** @type {string} */ scheduleId, /** @type {string} */ userId, /** @type {string | null} */ after = null) => ({
    id, scheduleId, userId, status: 'success', triggerKind: after ? 'after_cowork' : 'schedule', triggerRef: after ? `after_cowork:${after}` : null, result: `result of ${scheduleId}`,
});

/** @param {Record<string, any>} runs @param {any[]} own @param {any[]} desk */
function world(runs, own, desk) {
    /** @type {any[]} */
    const started = [];
    return {
        started,
        deps: {
            runOrigin: async (/** @type {string} */ id) => runs[id] ?? null,
            listFollowers: async () => own,
            listDeskFollowers: async () => desk,
            start: async (/** @type {any} */ item, /** @type {any} */ event) => { started.push([item.id, event]); return true; },
        },
    };
}

test('a follower of another owner starts with the result only: no title, its own owner, the desk\'s label', async () => {
    const w = world({ r1: run('r1', 'radar', 'ann') }, [], [{ id: 'intake', userId: 'bob' }]);
    assert.strictEqual(await afterRunEnded({ id: 'radar', userId: 'ann', title: 'Supplier radar' }, 'r1', /** @type {any} */ (w.deps)), 1);
    assert.deepStrictEqual(w.started, [['intake', { kind: 'after_cowork', ref: 'r1', label: 'a hand-off from a cowork on your desk', data: { after: { result: 'result of radar' } } }]]);
});

test('three hand-offs between owners end the chain: the fourth does not happen; a follower of the same owner still may', async () => {
    const runs = {
        r1: run('r1', 'radar', 'ann'),
        r2: run('r2', 'intake', 'bob', 'r1'),
        r3: run('r3', 'check', 'cas', 'r2'),
        r4: run('r4', 'report', 'dan', 'r3'),
    };
    assert.strictEqual(crossings([runs.r4, runs.r3, runs.r2, runs.r1]), 3);
    const w = world(runs, [{ id: 'archive', userId: 'dan' }], [{ id: 'audit', userId: 'eve' }]);
    assert.strictEqual(await afterRunEnded({ id: 'report', userId: 'dan', title: 'Friday report' }, 'r4', /** @type {any} */ (w.deps)), 1);
    assert.deepStrictEqual(w.started.map((s) => s[0]), ['archive'], `no more than ${MAX_CROSS_OWNER} hand-offs between owners`);

    const third = world(runs, [], [{ id: 'report', userId: 'dan' }]);
    assert.strictEqual(await afterRunEnded({ id: 'check', userId: 'cas' }, 'r3', /** @type {any} */ (third.deps)), 1, 'the third one still happens');
});

test('an item never starts twice in one chain, and a follower found both ways starts once', async () => {
    const runs = { r1: run('r1', 'radar', 'ann'), r2: run('r2', 'intake', 'bob', 'r1') };
    const w = world(runs, [], [{ id: 'radar', userId: 'ann' }, { id: 'intake', userId: 'bob' }]);
    assert.strictEqual(await afterRunEnded({ id: 'intake', userId: 'bob' }, 'r2', /** @type {any} */ (w.deps)), 0, 'radar is in the chain, intake is itself');
    const both = world({ r1: run('r1', 'radar', 'ann') }, [{ id: 'mine', userId: 'ann' }], [{ id: 'mine', userId: 'ann' }]);
    assert.strictEqual(await afterRunEnded({ id: 'radar', userId: 'ann', title: 'R' }, 'r1', /** @type {any} */ (both.deps)), 1);
});
