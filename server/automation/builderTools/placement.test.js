/**
 * Where did an append LAND, and what does a rejected batch say about itself.
 *
 * REGRESSION (2026-09-11): with afterStepId omitted, a step chains after the
 * current tail. Right after a condition's first branch step that tail is the
 * branch step, not the condition — so a model wanting the OTHER branch saw its
 * step land in the wrong place, removed it, and re-sent the identical call
 * (narrating a `branch` it never passed) seven times in one build. The echo
 * now names the landing spot and the one call that moves the step.
 *
 * Run: cd server && node --test --test-force-exit automation/builderTools/placement.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { applyToolCall, emptyDefinition } = require('../builderTools');

const wrap = () => ({ userId: 'u_test', def: emptyDefinition() });

test('the first append after a condition lands on its then-branch — reported, no hint needed', async () => {
    const dw = wrap();
    const cond = (await applyToolCall('builder_add_condition', { expr: 'trigger.output.x == 1' }, dw)).added;
    const r = await applyToolCall('builder_add_notification', { title: 'failed' }, dw);
    assert.strictEqual(r.placedAfter, `${cond.id} (then)`);
    assert.ok(!r._hint, 'it went where the model would expect');
});

test('the second append chains after the then-step; the echo names the empty else branch and the move call', async () => {
    const dw = wrap();
    const cond = (await applyToolCall('builder_add_condition', { expr: 'trigger.output.x == 1' }, dw)).added;
    const failed = (await applyToolCall('builder_add_notification', { title: 'failed' }, dw)).added;
    const r = await applyToolCall('builder_add_notification', { title: 'complete' }, dw);
    assert.strictEqual(r.placedAfter, failed.id);
    assert.match(r._hint, /"else"/);
    assert.ok(r._hint.includes(`afterStepId:"${cond.id}"`));
    assert.ok(r._hint.includes(`stepId:"${r.added.id}"`));
    assert.match(r._hint, /builder_update_step/);
    assert.match(r._hint, /Do not remove and re-add/);
});

test('an explicit afterStepId reports no placement — the model chose it', async () => {
    const dw = wrap();
    const a = (await applyToolCall('builder_add_notification', { title: 'a' }, dw)).added;
    const r = await applyToolCall('builder_add_notification', { title: 'b', afterStepId: a.id }, dw);
    assert.ok(!('placedAfter' in r));
    assert.ok(!r._hint);
});

test('a plain chain with no half-wired condition gets the placement but no hint', async () => {
    const dw = wrap();
    const a = (await applyToolCall('builder_add_notification', { title: 'a' }, dw)).added;
    const r = await applyToolCall('builder_add_notification', { title: 'b' }, dw);
    assert.strictEqual(r.placedAfter, a.id);
    assert.ok(!r._hint);
});

test('a $tempId failure in builder_add_steps is labelled as such, not as a binding error', async () => {
    const dw = wrap();
    const r = await applyToolCall('builder_add_steps', { steps: [
        { type: 'notification', spec: { title: 'a' } },
        { type: 'notification', spec: { title: '{{steps.$a.output.x}}' } },
    ] }, dw);
    assert.ok(r.error);
    assert.match(r._fixHint, /tempId handle/);
    assert.ok(!/invalid input binding/.test(r._fixHint), 'the generic binding stamp must not override the specific hint');
});

test('the generic binding stamp fires for a real binding error and stays off a scope error', async () => {
    const dw = wrap();
    const a = (await applyToolCall('builder_add_notification', { title: 'a' }, dw)).added;
    // A genuine bad ref path → stamped, so the prompt's pitfalls section catches it.
    const bad = await applyToolCall('builder_update_step', { stepId: a.id, patch: { title: '{{nope.field}}', forEach: { overRef: 'nope.items' } } }, dw);
    assert.ok(bad.error, 'precondition: a bad ref is refused');
    assert.match(bad._fixHint || '', /invalid input binding/);
    // "Unknown flowlet scope" is not a binding problem and must not be relabelled as one.
    const scope = await applyToolCall('builder_add_notification', { title: 'x', scope: 'nope' }, dw);
    assert.match(scope.error, /Unknown flowlet scope/);
    assert.ok(!scope._fixHint, `no binding stamp on a scope error, got: ${scope._fixHint}`);
});
