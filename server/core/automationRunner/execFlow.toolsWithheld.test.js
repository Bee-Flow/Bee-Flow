/**
 * A fan-out AI step ("run once per item") reports the tools it was not given
 * once for the whole step, so the Runs tab can show them (handoff 5). The
 * leaf runner is injected; no module mocking.
 *
 * Run: cd server && node --test core/automationRunner/execFlow.toolsWithheld.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { execForEachStep } = require('./execFlow');

const STEP = { id: 'ai1', type: 'ai_step', forEach: { overRef: 'steps.a1.output.items', itemVar: 'f' } };
const STATE = { trigger: { output: {} }, steps: { a1: { output: { items: [1, 2, 3] } } }, vars: {}, secrets: {}, loop: {} };

test('withheld tools of every item are merged, first reason wins', async () => {
    let n = 0;
    const leaf = async () => {
        n += 1;
        return n === 1
            ? { output: { a: 1 }, toolsWithheld: ['gmail_compose'], toolsWithheldReasons: { gmail_compose: 'confirm' } }
            : { output: { a: n }, toolsWithheld: ['gmail_compose', 'automation_r1'], toolsWithheldReasons: { gmail_compose: 'permission', automation_r1: 'permission' } };
    };
    const out = await execForEachStep(STEP, {}, STATE, 'live', leaf);
    assert.strictEqual(out.output.succeeded, 3);
    assert.deepStrictEqual(out.toolsWithheld, ['gmail_compose', 'automation_r1']);
    assert.deepStrictEqual(out.toolsWithheldReasons, { gmail_compose: 'confirm', automation_r1: 'permission' });
});

test('a fan-out that withheld nothing carries no key', async () => {
    const out = await execForEachStep(STEP, {}, STATE, 'live', async () => ({ output: {} }));
    assert.ok(!('toolsWithheld' in out));
});
