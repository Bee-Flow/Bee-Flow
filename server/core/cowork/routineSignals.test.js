// @typecheck
/**
 * "Make it routine" (./routineSignals.mts, ./routineCompare.mts): what the last good runs did in names and counts, and
 * the item-by-item comparison of a routine's result with the run it was made from.
 *
 * Run: cd server && node --test core/cowork/routineSignals.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { routineSignals, hintsOf, MIN_RUNS } = require('./routineSignals.mts');
const { compareResults, itemsOf } = require('./routineCompare.mts');

const run = (/** @type {Array<[string, number]>} */ tools, status = 'success') => ({ status, activity: { tools: tools.map(([name, ok]) => ({ name, app: 'web', ok })) } });

test('the actions every good run used are the steady ones; a failed run and an unused action do not count', () => {
    const signals = routineSignals([
        run([['web_search', 4], ['read_url', 9]]), run([['web_search', 4], ['read_url', 11], ['calendar_list', 1]]),
        run([['web_search', 4], ['read_url', 8]]), run([['send_mail', 1]], 'error'), run([['web_search', 0]]),
    ]);
    assert.strictEqual(signals.runs, 4);
    assert.deepStrictEqual(signals.steady, [], 'the last run used no action, so none was used every time');
    const steady = routineSignals([run([['web_search', 4], ['read_url', 9]]), run([['web_search', 4], ['read_url', 11]]), run([['web_search', 4], ['read_url', 8]])]);
    assert.deepStrictEqual(steady.steady.map((h) => [h.tool, h.callsPerRun]), [['read_url', 9], ['web_search', 4]]);
    assert.strictEqual(steady.worthIt, true);
    assert.match(hintsOf(steady), /ran 3 times[\s\S]*read_url \(about 9 calls a run\)/);
    assert.strictEqual(routineSignals([run([['web_search', 1]])]).worthIt, false, `fewer than ${MIN_RUNS} runs is not enough`);
});

test('a result is split into its items; the same item in other words still counts, a new one is named', () => {
    assert.deepStrictEqual(itemsOf('Digest:\n- EU publishes the timetable for AI duties\n- Two new open models\n- ok'), ['EU publishes the timetable for AI duties', 'Two new open models']);
    const before = '- EU publishes the timetable for the next AI Act duties\n- Two new open models for document reading\n- Opinion: why AI will not replace planners';
    const after = '1. The EU publishes its timetable for the next AI Act duties\n2. Two new open models for reading documents\n3. A steel supplier portal adds AI order tracking';
    const c = compareResults(before, after);
    assert.deepStrictEqual([c.before, c.after, c.same], [3, 3, 2]);
    assert.deepStrictEqual(c.onlyBefore, ['Opinion: why AI will not replace planners']);
    assert.deepStrictEqual(c.onlyAfter, ['A steel supplier portal adds AI order tracking']);
});
