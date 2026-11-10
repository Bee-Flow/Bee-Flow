'use strict';

/**
 * The control kinds of the step registry on the shared server walker: return, break,
 * continue, while, raise_error and try, with a recording host (no executor, no store).
 *
 * Run: cd server && node --test appStudio/sequenceWalkFlow.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { newWalkState, walkAction, stepPaths, outcomeView, CONTROL_KINDS } = require('./sequenceWalk.mts');
const { flattenSteps, normalizeSequence } = require('./actionSequence');
const { tryEvaluate } = require('../shared/expr/index.mjs');
const { EXTENSION_STEP_ENTRIES } = require('./componentSpecs/stepRegistry');

function host(over = {}) {
    const ran = [];
    let t = 0;
    return {
        ran,
        decide: async (step) => ({ run: true, step }),
        execute: async (step) => {
            ran.push(step.tag ?? step.kind);
            return step.fail ? { ok: false, error: `${step.tag} failed`, code: step.failCode, retryable: step.retryable !== false } : { ok: true, result: { tag: step.tag ?? null } };
        },
        resolve: async (b, _ctx, scope) => (b && b.kind === 'formula' ? tryEvaluate(b.expr, scope).value : (b && b.kind === 'static' ? b.value : null)),
        evaluate: (expr, scope) => tryEvaluate(expr, scope).value,
        buildScope: (ctx) => ({ vars: ctx.vars, item: ctx.item, error: ctx.error ?? null, params: ctx.params }),
        ctxFor: (w) => ({ vars: w.vars, item: w.item, index: w.index, error: w.error, params: w.params }),
        sleep: async () => {},
        now: () => { t += 1; return t; },
        ...over,
    };
}

const seq = (steps) => ({ kind: 'sequence', steps });
const leaf = (tag, extra = {}) => ({ kind: 'ai_generate', tag, ...extra });
const setVar = (name, expr) => ({ kind: 'set_variable', name, value: { kind: 'formula', expr } });
const when = (expr, then) => ({ kind: 'condition', expr, then, else: [] });

async function run(action, init = {}, over = {}, actions = {}) {
    const h = host({ resolveCallee: (id) => (Object.hasOwn(actions, id) ? actions[id] : null), ...over });
    const w = newWalkState(init);
    await walkAction(w, action, h, { actionId: 'act_root' });
    return { w, h, view: outcomeView(w) };
}

test('the walker runs every control kind the registry ships', () => {
    const control = EXTENSION_STEP_ENTRIES.filter((e) => e.side === 'control').map((e) => e.kind);
    for (const kind of control) assert.ok(CONTROL_KINDS.includes(kind), `${kind} has a walker`);
});

test('a new container is numbered in pre-order where it stands; ordinals before it do not move', () => {
    const action = seq([
        leaf('a'),
        { kind: 'while', expr: 'false', steps: [leaf('b'), { kind: 'break' }] },
        { kind: 'try', steps: [leaf('c')], catch: [leaf('d')], finally: [leaf('e')] },
        leaf('f'),
    ]);
    const flat = flattenSteps(normalizeSequence(action));
    assert.deepEqual(flat.map((s) => s.tag ?? s.kind), ['a', 'while', 'b', 'break', 'try', 'c', 'd', 'e', 'f']);
    assert.deepEqual(stepPaths(action).map((p) => `${p.ordinal} ${p.path}`), [
        '0 steps[0]', '1 steps[1]', '2 steps[1].steps[0]', '3 steps[1].steps[1]',
        '4 steps[2]', '5 steps[2].steps[0]', '6 steps[2].catch[0]', '7 steps[2].finally[0]', '8 steps[3]',
    ]);
});

test('return ends the action as a success and its value is the result', async () => {
    const { w, h, view } = await run(seq([leaf('a'), when('vars.done', [{ kind: 'return', value: { kind: 'formula', expr: 'vars.n + 1' } }]), leaf('never')]), { vars: { done: true, n: 41 } });
    assert.deepEqual(h.ran, ['a']);
    assert.equal(view.ok, true);
    assert.equal(view.stopped, null);
    assert.equal(view.result, 42);
    assert.equal(w.signal, null);
    assert.equal(view.steps.get('steps[2]').status, 'not_run');
});

test('return without a value keeps the last server result', async () => {
    const { view } = await run(seq([leaf('a'), { kind: 'return' }, leaf('never')]));
    assert.deepEqual(view.result, { tag: 'a' });
});

test('return inside a called action ends only that action; the value is the call result', async () => {
    const actions = { act_sub: seq([{ kind: 'loop', source: { kind: 'static', value: [1, 2, 3] }, steps: [{ kind: 'return', value: { kind: 'formula', expr: 'item * 10' } }] }, leaf('never')]) };
    const { w, h, view } = await run(seq([{ kind: 'call_action', actionId: 'act_sub', resultVar: 'got' }, leaf('after')]), {}, {}, actions);
    assert.deepEqual(h.ran, ['after']);
    assert.equal(w.vars.got, 10);
    assert.equal(view.ok, true);
});

test('break leaves the nearest loop, continue skips the rest of the round', async () => {
    const body = [when('item == 2', [{ kind: 'continue' }]), when('item == 4', [{ kind: 'break' }]), leaf('row')];
    const { w, h } = await run(seq([{ kind: 'loop', source: { kind: 'static', value: [1, 2, 3, 4, 5] }, itemVar: 'row', steps: body }, leaf('after')]));
    assert.deepEqual(h.ran, ['row', 'row', 'after']);
    assert.equal(w.outcomes.get('steps[0].steps[2]').count, 2);
    assert.equal(w.vars.row, undefined, 'the loop still restores its variables after a break');
    assert.equal(w.signal, null);
});

test('break only leaves the inner loop', async () => {
    const inner = { kind: 'loop', source: { kind: 'static', value: ['x', 'y'] }, steps: [{ kind: 'break' }, leaf('never')] };
    const { h } = await run(seq([{ kind: 'loop', source: { kind: 'static', value: [1, 2] }, steps: [inner, leaf('outer')] }]));
    assert.deepEqual(h.ran, ['outer', 'outer']);
});

test('break outside a loop, and inside a called action of a loop, fails the step', async () => {
    const alone = await run(seq([{ kind: 'break' }, leaf('never')]));
    assert.equal(alone.view.ok, false);
    assert.equal(alone.view.failed.code, 'not_in_loop');
    const actions = { act_sub: seq([{ kind: 'continue' }]) };
    const called = await run(seq([{ kind: 'loop', source: { kind: 'static', value: [1] }, steps: [{ kind: 'call_action', actionId: 'act_sub' }] }]), {}, {}, actions);
    assert.equal(called.view.ok, false);
    assert.match(called.view.failed.error, /only works inside a loop or while/);
});

test('while runs while its formula holds and records the rounds', async () => {
    const { w, h, view } = await run(seq([{ kind: 'while', expr: 'vars.n < 3', steps: [leaf('round'), setVar('n', 'vars.n + 1')] }, leaf('after')]), { vars: { n: 0 } });
    assert.deepEqual(h.ran, ['round', 'round', 'round', 'after']);
    assert.equal(w.vars.n, 3);
    assert.deepEqual(view.steps.get('steps[0]').result, { iterations: 3 });
    assert.equal(view.steps.get('steps[0].steps[0]').count, 3);
});

test('while stops at maxIterations with a note, and the action goes on', async () => {
    const { w, h, view } = await run(seq([{ kind: 'while', expr: 'true', maxIterations: 4, steps: [leaf('round')] }, leaf('after')]));
    assert.equal(h.ran.filter((t) => t === 'round').length, 4);
    assert.deepEqual(view.steps.get('steps[0]').result, { iterations: 4, capped: true });
    assert.ok([...w.notes].some((n) => /ended after 4 rounds/.test(n)));
    assert.equal(view.ok, true);
    assert.equal(h.ran.at(-1), 'after');
});

test('while never runs more than the catalogue ceiling, whatever the step says', async () => {
    const { view } = await run(seq([{ kind: 'while', expr: 'true', maxIterations: 100000, steps: [setVar('n', 'vars.n + 1')] }]), { vars: { n: 0 } });
    assert.equal(view.steps.get('steps[0]').result.iterations, 200);
});

test('break and continue work in a while; its body is a loop for the host (loop is set, count 0)', async () => {
    const seen = [];
    const body = [setVar('n', 'vars.n + 1'), when('vars.n == 2', [{ kind: 'continue' }]), when('vars.n == 4', [{ kind: 'break' }]), leaf('round')];
    const { h, w } = await run(seq([{ kind: 'while', expr: 'true', steps: body }, leaf('after')]), { vars: { n: 0 } }, { onStepEnd: (e) => { if (e.kind === 'ai_generate') seen.push(e.loop); } });
    assert.deepEqual(h.ran, ['round', 'round', 'after']);
    assert.equal(w.vars.n, 4);
    assert.deepEqual(seen, [{ index: 0, count: 0 }, { index: 2, count: 0 }, null]);
});

test('raise_error fails the action with the message and code', async () => {
    const { view, h } = await run(seq([{ kind: 'raise_error', message: { kind: 'formula', expr: '"No lines on " + vars.order' }, code: 'no_lines' }, leaf('never')]), { vars: { order: 'A7' } });
    assert.equal(view.ok, false);
    assert.equal(view.failed.error, 'No lines on A7');
    assert.equal(view.failed.code, 'no_lines');
    assert.equal(view.failed.kind, 'raise_error');
    assert.deepEqual(h.ran, []);
    const plain = await run(seq([{ kind: 'raise_error', message: { kind: 'static', value: 'Stop' } }]));
    assert.equal(plain.view.failed.code, 'raised');
});

test('try: a failing step runs catch with the error in scope, then the action goes on', async () => {
    const action = seq([
        { kind: 'try', steps: [leaf('a'), leaf('b', { fail: true, failCode: 'boom' }), leaf('skipped')], catch: [setVar('why', 'error.message + "/" + error.step + "/" + error.code + "/" + error.stepIndex')] },
        leaf('after'),
    ]);
    const { w, h, view } = await run(action);
    assert.deepEqual(h.ran, ['a', 'b', 'after']);
    assert.equal(w.vars.why, 'b failed/ai_generate/boom/2');
    assert.equal(view.ok, true);
    assert.equal(view.failed, null);
    assert.equal(w.error, undefined, 'the error scope ends with the catch');
    assert.deepEqual(view.steps.get('steps[0]').result, { caught: true });
    const failed = view.steps.get('steps[0].steps[1]');
    assert.equal(failed.status, 'error');
    assert.equal(failed.handled, true);
});

test('try: finally runs after success, after a catch, and before a failure leaves a try without catch', async () => {
    const ok = await run(seq([{ kind: 'try', steps: [leaf('a')], catch: [leaf('c')], finally: [leaf('f')] }, leaf('after')]));
    assert.deepEqual(ok.h.ran, ['a', 'f', 'after']);
    const caught = await run(seq([{ kind: 'try', steps: [leaf('a', { fail: true })], catch: [leaf('c')], finally: [leaf('f')] }, leaf('after')]));
    assert.deepEqual(caught.h.ran, ['a', 'c', 'f', 'after']);
    const uncaught = await run(seq([{ kind: 'try', steps: [leaf('a', { fail: true })], finally: [leaf('f')] }, leaf('never')]));
    assert.deepEqual(uncaught.h.ran, ['a', 'f']);
    assert.equal(uncaught.view.ok, false);
    assert.equal(uncaught.view.failed.error, 'a failed');
    assert.equal(uncaught.view.failed.path, 'steps[0].steps[0]');
});

test('try: an empty catch handles the failure; no catch at all does not', async () => {
    const empty = await run(seq([{ kind: 'try', steps: [leaf('a', { fail: true })], catch: [] }, leaf('after')]));
    assert.deepEqual(empty.h.ran, ['a', 'after']);
    assert.equal(empty.view.ok, true);
    const none = await run(seq([{ kind: 'try', steps: [leaf('a', { fail: true })] }, leaf('never')]));
    assert.equal(none.view.ok, false);
});

test('try: return, break and continue pass through, and finally runs first', async () => {
    const ret = await run(seq([{ kind: 'try', steps: [{ kind: 'return', value: { kind: 'static', value: 'r' } }, leaf('never')], catch: [leaf('c')], finally: [leaf('f')] }, leaf('never2')]));
    assert.deepEqual(ret.h.ran, ['f']);
    assert.equal(ret.view.result, 'r');
    assert.equal(ret.view.ok, true);
    const loop = { kind: 'loop', source: { kind: 'static', value: [1, 2, 3] }, steps: [{ kind: 'try', steps: [when('item == 2', [{ kind: 'break' }]), leaf('row')], finally: [leaf('f')] }] };
    const brk = await run(seq([loop, leaf('after')]));
    assert.deepEqual(brk.h.ran, ['row', 'f', 'f', 'after']);
});

test('try: a failure in catch or in finally ends the action (finally still runs after a failing catch)', async () => {
    const inCatch = await run(seq([{ kind: 'try', steps: [leaf('a', { fail: true })], catch: [leaf('c', { fail: true })], finally: [leaf('f')] }, leaf('never')]));
    assert.deepEqual(inCatch.h.ran, ['a', 'c', 'f']);
    assert.equal(inCatch.view.failed.error, 'c failed');
    const inFinally = await run(seq([{ kind: 'try', steps: [{ kind: 'return' }], finally: [leaf('f', { fail: true })] }, leaf('never')]));
    assert.equal(inFinally.view.ok, false);
    assert.equal(inFinally.view.failed.error, 'f failed');
});

test('try composes with a step\'s own retry and onError: both come first', async () => {
    let calls = 0;
    const flaky = { execute: async (step) => { calls += 1; return step.tag === 'flaky' && calls < 3 ? { ok: false, error: 'not yet' } : { ok: true, result: calls }; } };
    const retried = await run(seq([{ kind: 'try', steps: [leaf('flaky', { retry: { times: 2, delayMs: 0 } })], catch: [setVar('caught', 'true')] }]), {}, flaky);
    assert.equal(retried.w.vars.caught, undefined, 'the retry succeeded: nothing to catch');
    assert.equal(retried.view.steps.get('steps[0].steps[0]').attempts, 3);

    const own = await run(seq([{ kind: 'try', steps: [leaf('a', { fail: true, onError: { steps: [setVar('own', 'true')] } }), leaf('b')], catch: [setVar('caught', 'true')] }]));
    assert.equal(own.w.vars.own, true);
    assert.equal(own.w.vars.caught, undefined, 'the step handled its own failure');
    assert.deepEqual(own.h.ran, ['a', 'b']);

    const exhausted = await run(seq([{ kind: 'try', steps: [leaf('a', { fail: true, retry: { times: 1, delayMs: 0 } })], catch: [setVar('n', 'error.attempts')] }]));
    assert.equal(exhausted.w.vars.n, 2, 'catch sees the attempts made');

    const quiet = await run(seq([{ kind: 'try', steps: [leaf('a', { fail: true, onError: { steps: [], stop: true } })], catch: [setVar('caught', 'true')], finally: [leaf('f')] }, leaf('never')]));
    assert.equal(quiet.w.vars.caught, undefined, 'a handler that ends the run quietly is not a failure for catch');
    assert.deepEqual(quiet.h.ran, ['a', 'f']);
    assert.equal(quiet.view.ok, true);
});

test('try catches a failed transaction as one step, and a failure inside a called action with the inner kind', async () => {
    const tx = await run(seq([{ kind: 'try', steps: [{ kind: 'transaction', tag: 'tx', fail: true, failCode: 'conflict', steps: [{ kind: 'create_record' }] }], catch: [setVar('why', 'error.step + ":" + error.code')] }]));
    assert.equal(tx.w.vars.why, 'transaction:conflict');
    const actions = { act_sub: seq([{ kind: 'kb_query', tag: 'inner', fail: true }]) };
    const called = await run(seq([{ kind: 'try', steps: [{ kind: 'call_action', actionId: 'act_sub' }], catch: [setVar('why', 'error.step + "@" + error.stepIndex')] }, leaf('after')]), {}, {}, actions);
    assert.equal(called.w.vars.why, 'kb_query@1');
    assert.equal(called.view.ok, true);
    assert.deepEqual(called.h.ran, ['inner', 'after']);
});

test('try: raise_error is caught like any failure', async () => {
    const { w, view } = await run(seq([{ kind: 'try', steps: [{ kind: 'raise_error', message: { kind: 'static', value: 'Nope' }, code: 'nope' }], catch: [setVar('why', 'error.message + ":" + error.code + ":" + error.step')] }]));
    assert.equal(w.vars.why, 'Nope:nope:raise_error');
    assert.equal(view.ok, true);
});

test('a budget stop is not caught and runs no finally', async () => {
    let n = 0;
    const over = { shouldStop: () => { n += 1; return n > 2 ? 'out of budget' : null; } };
    const { h, view } = await run(seq([{ kind: 'try', steps: [leaf('a'), leaf('b'), leaf('c')], catch: [leaf('catch')], finally: [leaf('finally')] }]), {}, over);
    assert.deepEqual(h.ran, ['a']);
    assert.equal(view.ok, false);
    assert.equal(view.stopped, 'out of budget');
});
