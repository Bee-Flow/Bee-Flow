/**
 * Read-only Gmail fetches in a "run once per item" step run a few at a time
 * (reads five, attachments three), in item order; anything else stays one at a time.
 *
 * Run: cd server && node --test core/automationRunner/execFlow.parallelReads.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { execForEachStep } = require('./execFlow');

const STATE = { trigger: { output: {} }, steps: { a1: { output: { items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] } } }, vars: {}, secrets: {}, loop: {} };
const step = (tool) => ({ id: 's', type: 'integration_action', tool, forEach: { overRef: 'steps.a1.output.items', itemVar: 'x' } });

function measuringLeaf() {
    const seen = { active: 0, max: 0 };
    const leaf = async (_s, _ctx, sub) => {
        seen.active += 1;
        seen.max = Math.max(seen.max, seen.active);
        await new Promise(r => setTimeout(r, 5));
        seen.active -= 1;
        return { output: { n: sub.loop.x } };
    };
    return { seen, leaf };
}

test('attachments are fetched three at a time (each is also parsed here), and the results keep their order', async () => {
    const { seen, leaf } = measuringLeaf();
    const out = await execForEachStep(step('gmail_read_attachment'), {}, STATE, 'live', leaf);
    assert.strictEqual(seen.max, 3);
    assert.deepStrictEqual(out.output.results.map(r => r.output.n), STATE.steps.a1.output.items);
});

test('mail reads stay at five at a time', async () => {
    const { seen, leaf } = measuringLeaf();
    await execForEachStep(step('gmail_read'), {}, STATE, 'live', leaf);
    assert.strictEqual(seen.max, 5);
});

test('a tool that may have side effects stays one at a time', async () => {
    const { seen, leaf } = measuringLeaf();
    await execForEachStep(step('gmail_send'), {}, STATE, 'live', leaf);
    assert.strictEqual(seen.max, 1);
});

test('askOnce keeps a read serial, so a repeated id reuses the first answer', async () => {
    const { seen, leaf } = measuringLeaf();
    await execForEachStep({ ...step('gmail_read_attachment'), askOnce: true }, {}, STATE, 'live', leaf);
    assert.strictEqual(seen.max, 1);
});
