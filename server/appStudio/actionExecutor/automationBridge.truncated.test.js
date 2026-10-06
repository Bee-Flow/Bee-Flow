/**
 * An app's actionResult reads the automation's REAL answer, also when it is big.
 *
 * deriveRunOutcome reads the persisted run-step rows, and a step output over
 * 256 KB is persisted as the truncation sentinel `{ __truncated__, … }` with
 * the full copy kept beside the row (fullOutputRef). The app got the sentinel:
 * a list bound to `value[0].subject` stayed empty as soon as the data got big,
 * with nothing saying why. The answer row's sentinel is now swapped for the
 * kept copy (replaySeeding.withFullOutput, the resume path's reader). When no
 * copy exists (the output was larger than the copy limit) the outcome says so
 * with `outputTooLarge`, instead of handing the app the sentinel as if it
 * were data.
 *
 * Run: cd server && node --test appStudio/actionExecutor/automationBridge.truncated.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const automationStore = require('../../stores/automationStore');
const { truncatePayload } = require('../../automation/payloadTruncation');
const { deriveRunOutcome } = require('./automationBridge');

const BIG = { value: Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, subject: `Mail ${i}`, body: 'x'.repeat(900) })) };

async function withStore(over, fn) {
    const orig = {};
    for (const k of Object.keys(over)) { orig[k] = automationStore[k]; automationStore[k] = over[k]; }
    try { return await fn(); } finally { Object.assign(automationStore, orig); }
}

function sentinelRow({ keptCopy }) {
    const t = truncatePayload(BIG);
    assert.equal(t.truncated, true, 'the fixture is over the cap');
    const output = keptCopy ? { ...t.value, fullOutputRef: { runId: 'r1', stepId: 's1', attempts: 1 } } : t.value;
    return { runId: 'r1', stepId: 's1', stepType: 'integration_action', parentStepId: null, attempts: 1, output };
}

test('a truncated answer row is swapped for the kept full copy', async () => {
    const asked = [];
    await withStore({
        getRunSteps: async () => [sentinelRow({ keptCopy: true })],
        getRunFullOutput: async (runId, stepId, attempts) => { asked.push([runId, stepId, attempts]); return BIG; },
    }, async () => {
        const out = await deriveRunOutcome({ id: 'r1', status: 'success' });
        assert.deepEqual(asked, [['r1', 's1', 1]]);
        assert.equal(out.output.value[0].subject, 'Mail 0');
        assert.equal(out.output.value.length, 300);
        assert.equal(out.outputTooLarge, undefined);
    });
});

test('without a kept copy the outcome says the output was too large', async () => {
    await withStore({
        getRunSteps: async () => [sentinelRow({ keptCopy: false })],
        getRunFullOutput: async () => { throw new Error('must not be asked: the sentinel names no copy'); },
    }, async () => {
        const out = await deriveRunOutcome({ id: 'r1', status: 'success' });
        assert.equal(out.outputTooLarge, true);
        assert.equal(out.output, null, 'the sentinel is not data and is not handed to the app');
    });
});

test('an ordinary answer is untouched and never fetches a copy', async () => {
    await withStore({
        getRunSteps: async () => [{ runId: 'r1', stepId: 's1', stepType: 'set', parentStepId: null, attempts: 1, output: { ok: 1 } }],
        getRunFullOutput: async () => { throw new Error('not expected'); },
    }, async () => {
        const out = await deriveRunOutcome({ id: 'r1', status: 'success' });
        assert.deepEqual(out.output, { ok: 1 });
        assert.equal('outputTooLarge' in out, false);
    });
});
