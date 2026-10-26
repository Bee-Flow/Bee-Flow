// @typecheck
'use strict';
/** The leaf switch dispatches the two table steps to the executors RUN_DEPS holds. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeLeafRunner } = require('./stepLeaf');

const state = () => ({ trigger: { output: {} }, steps: {}, vars: {}, secrets: {}, loop: {}, _templateWarnings: [] });

test('read_table and table go to deps.execReadTable / deps.execTable with the step, ctx, state and mode', async () => {
    /** @type {unknown[][]} */
    const calls = [];
    const deps = {
        engine: {},
        execFlatten: async () => ({ output: null }),
        execReadTable: async (/** @type {unknown[]} */ ...a) => { calls.push(['read_table', ...a]); return { output: { from: 'read' } }; },
        execTable: async (/** @type {unknown[]} */ ...a) => { calls.push(['table', ...a]); return { output: { from: 'table' } }; },
    };
    const run = makeLeafRunner(deps, () => async () => ({}));
    const ctx = { runId: 'r1' };
    const st = state();
    const read = { id: 'a', type: 'read_table', source: { kind: 'ref', path: 'trigger.output.upload' } };
    const table = { id: 'b', type: 'table', source: { kind: 'ref', path: 'steps.a.output.table' }, ops: [] };
    assert.deepEqual(await run(read, ctx, st, 'live'), { output: { from: 'read' } });
    assert.deepEqual(await run(table, ctx, st, 'dry_run'), { output: { from: 'table' } });
    assert.deepEqual(calls.map(c => [c[0], /** @type {{ id: string }} */ (c[1]).id, c[2], c[3] === st, c[4]]), [['read_table', 'a', ctx, true, 'live'], ['table', 'b', ctx, true, 'dry_run']]);
});
