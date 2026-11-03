'use strict';

/** Run: cd server && node --test appStudio/actionStepCounts.test.js */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { countSteps, stepCountsByTopLevel, describeStepCounts } = require('./actionStepCounts');
const { LIMITS, emptyDefinition } = require('./componentSpecs');
const { applySetActionTool } = require('./builderTools/definitionTools');
const { validateAppDefinition } = require('./validate');

const toast = () => ({ kind: 'toast', message: 'x' });
const toasts = (n) => Array.from({ length: n }, toast);
const loopOf = (n) => ({ kind: 'loop', source: { kind: 'formula', expr: 'vars.rows' }, steps: toasts(n) });

test('the ceiling is 120 recursive steps', () => {
    assert.equal(LIMITS.MAX_ACTION_STEPS, 120);
});

test('countSteps counts nested steps in condition, loop and switch', () => {
    const steps = [
        toast(),
        { kind: 'condition', expr: 'true', then: toasts(2), else: toasts(1) },
        { kind: 'switch', expr: 'vars.a', cases: [{ value: 1, steps: toasts(3) }], default: toasts(1) },
        loopOf(4),
    ];
    assert.equal(countSteps(steps), 1 + (1 + 3) + (1 + 4) + (1 + 4));
    assert.deepEqual(stepCountsByTopLevel(steps).map((c) => [c.index, c.kind, c.count]), [[0, 'toast', 1], [1, 'condition', 4], [2, 'switch', 5], [3, 'loop', 5]]);
});

test('stepCountsByTopLevel carries a step id when there is one, and describeStepCounts lists the biggest first', () => {
    const counts = stepCountsByTopLevel([toast(), { ...loopOf(9), id: 'stp_big' }]);
    assert.equal(counts[1].id, 'stp_big');
    assert.match(describeStepCounts(counts), /^Steps per top-level step \(recursive\): #1 loop "stp_big" = 10, #0 toast = 1\.$/);
});

function wrapWith() {
    return { userId: 'u1', appId: 'app_1', def: emptyDefinition('Limit'), dataModel: null };
}

test('app_set_action: exactly 120 steps is allowed', async () => {
    const wrap = wrapWith();
    const r = await applySetActionTool(wrap, { action: { kind: 'sequence', steps: [loopOf(60), ...toasts(59)] } });
    assert.ok(!r.error, JSON.stringify(r).slice(0, 400));
    assert.equal(countSteps(wrap.def.actions[r.actionId].steps), 120);
});

test('app_set_action: 121 steps is refused with the recursive count per top-level step', async () => {
    const wrap = wrapWith();
    const r = await applySetActionTool(wrap, { action: { kind: 'sequence', steps: [toast(), loopOf(70), ...toasts(49)] } });
    assert.match(r.error, /more than 120 steps \(121 counting every nested step\)/);
    assert.equal(r.maxSteps, 120);
    assert.equal(r.stepCounts.length, 51);
    assert.deepEqual(r.stepCounts[1], { index: 1, kind: 'loop', count: 71 });
    assert.deepEqual(r.stepCounts[0], { index: 0, kind: 'toast', count: 1 });
    assert.match(r.error, /#1 loop = 71/, 'the sentence names the big one too');
    assert.equal(wrap.def.actions && Object.keys(wrap.def.actions).length, 0, 'nothing was created');
});

test('the validator reports the same counts in its hint', () => {
    const def = emptyDefinition('Limit');
    def.actions = { act_big1: { kind: 'sequence', steps: [loopOf(125)] } };
    const out = validateAppDefinition(def, {});
    const err = out.errors.find((e) => e.code === 'action.too_many_steps');
    assert.ok(err, 'refused');
    assert.match(err.hint, /#0 loop = 126/);
});
