// @typecheck
/**
 * The claim of one attempt of a Cowork run (./runClaim.mts): only a store that answers null refuses, the tick asks
 * for a due schedule and a run-now does not, and the id of the opened row is read from whatever the store hands back.
 *
 * Run: cd server && node --test core/cowork/runClaim.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { claimAttempt } = require('./runClaim.mts');

const storeThat = (answer, asked = []) => ({ markRunning: async (id, opts) => { asked.push([id, opts]); return answer; } });

test('null refuses: another attempt holds the schedule, or its moment was already run', async () => {
    assert.strictEqual(await claimAttempt(storeThat(null), { id: 's1' }, { due: true }), null);
});

test('the row id is read from a string, or from a row with an id', async () => {
    assert.deepStrictEqual(await claimAttempt(storeThat('run-1'), { id: 's1' }), { runId: 'run-1' });
    assert.deepStrictEqual(await claimAttempt(storeThat({ id: 'run-2' }), { id: 's1' }), { runId: 'run-2' });
});

test('a store that answers nothing, or something that is no id, is a claim without a row', async () => {
    for (const answer of [undefined, true, '', {}, { id: 7 }, 0]) {
        assert.deepStrictEqual(await claimAttempt(storeThat(answer), { id: 's1' }), { runId: null }, JSON.stringify(answer));
    }
});

test('the tick asks for a due schedule, a run-now asks as a person, and neither by default', async () => {
    const asked = [];
    const store = storeThat('run-1', asked);
    await claimAttempt(store, { id: 's1' }, { due: true });
    await claimAttempt(store, { id: 's1' }, { manual: true });
    await claimAttempt(store, { id: 's1' });
    assert.deepStrictEqual(asked, [
        ['s1', { triggerKind: 'schedule', due: true }],
        ['s1', { triggerKind: 'manual', due: false }],
        ['s1', { triggerKind: 'schedule', due: false }],
    ]);
});
