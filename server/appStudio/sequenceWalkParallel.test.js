'use strict';

/**
 * The `parallel` step kind on the shared server walker, with a recording host (no executor,
 * no store): forked state, the join in branch order, failures, failFast, the concurrency cap,
 * the kinds a branch refuses and the dry run's one-after-another walk.
 *
 * Run: cd server && node --test appStudio/sequenceWalkParallel.test.js
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { newWalkState, walkAction, stepPaths, outcomeView } = require('./sequenceWalk.mts');
const { forkState, parallelMax } = require('./sequenceWalkParallel.mts');
const { flattenSteps, normalizeSequence } = require('./actionSequence');
const { tryEvaluate } = require('../shared/expr/index.mjs');

const ENV = 'STUDIO_APP_PARALLEL_MAX';
const envBefore = process.env[ENV];
afterEach(() => { if (envBefore === undefined) delete process.env[ENV]; else process.env[ENV] = envBefore; });

/** A host whose leaves take `step.ticks` turns of the event loop, so branches really interleave. */
function host(over = {}) {
    const log = [];
    const live = { now: 0, peak: 0 };
    let t = 0;
    return {
        log, live,
        decide: async (step) => ({ run: true, step }),
        execute: async (step) => {
            live.now += 1;
            live.peak = Math.max(live.peak, live.now);
            log.push(`start ${step.tag}`);
            for (let i = 0; i < (step.ticks ?? 1); i += 1) await new Promise((resolve) => { setImmediate(resolve); });
            log.push(`end ${step.tag}`);
            live.now -= 1;
            return step.fail ? { ok: false, error: `${step.tag} failed`, code: 'boom', retryable: false } : { ok: true, result: { tag: step.tag } };
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
const parallel = (branches, extra = {}) => ({ kind: 'parallel', branches: branches.map((steps) => ({ steps })), ...extra });

async function run(action, init = {}, over = {}, actions = {}) {
    const h = host({ resolveCallee: (id) => (Object.hasOwn(actions, id) ? actions[id] : null), ...over });
    const w = newWalkState(init);
    await walkAction(w, action, h, { actionId: 'act_root' });
    return { w, h, view: outcomeView(w) };
}

test('the steps of every branch are numbered in pre-order, branch after branch', () => {
    const action = seq([leaf('a'), parallel([[leaf('b'), leaf('c')], [leaf('d')]]), leaf('e')]);
    assert.deepEqual(flattenSteps(normalizeSequence(action)).map((s) => s.tag ?? s.kind), ['a', 'parallel', 'b', 'c', 'd', 'e']);
    assert.deepEqual(stepPaths(action).map((p) => `${p.ordinal} ${p.path}`), [
        '0 steps[0]', '1 steps[1]', '2 steps[1].branches[0].steps[0]', '3 steps[1].branches[0].steps[1]',
        '4 steps[1].branches[1].steps[0]', '5 steps[2]',
    ]);
});

test('the branches run side by side and the walk goes on after the last one ended', async () => {
    const { h, view } = await run(seq([parallel([[leaf('slow', { ticks: 5 })], [leaf('quick')]]), leaf('after')]));
    assert.deepEqual(h.log, ['start slow', 'start quick', 'end quick', 'end slow', 'start after', 'end after']);
    assert.equal(view.ok, true);
    assert.deepEqual(view.steps.get('steps[0]').result, { branches: 2 });
    assert.equal(view.steps.get('steps[0].branches[1].steps[0]').status, 'ok');
});

test('a branch starts with the variables from before the step and does not see another branch write', async () => {
    const { w } = await run(seq([
        setVar('n', '1'),
        parallel([
            [leaf('wait', { ticks: 3 }), setVar('seenByA', 'vars.n'), setVar('a', '10')],
            [setVar('n', '99'), setVar('seenByB', 'vars.a == null')],
        ]),
    ]));
    assert.equal(w.vars.seenByA, 1, 'branch 1 read n as it was before the step, not the 99 branch 2 wrote meanwhile');
    assert.equal(w.vars.seenByB, true, 'branch 2 does not see what branch 1 writes');
    assert.equal(w.vars.n, 99);
    assert.equal(w.vars.a, 10);
});

test('the join applies the writes in branch order, whichever branch finished first', async () => {
    const { w, view } = await run(seq([
        parallel([
            [leaf('slow', { ticks: 6, resultVar: 'r' }), setVar('who', '"first"')],
            [leaf('quick', { resultVar: 'r' }), setVar('who', '"second"')],
        ]),
    ]));
    assert.equal(w.vars.who, 'second');
    assert.deepEqual(w.vars.r, { tag: 'quick' });
    assert.deepEqual(view.result, { tag: 'quick' }, 'the result is that of the last branch in order that produced one');
});

test('a branch without a server step leaves the result of the branches before it', async () => {
    const { view } = await run(seq([leaf('before'), parallel([[leaf('a')], [setVar('x', '1')]])]));
    assert.deepEqual(view.result, { tag: 'a' });
});

test('a failing branch ends the action after the other branches ran to their end', async () => {
    const { h, w, view } = await run(seq([
        parallel([[leaf('bad', { fail: true })], [leaf('one', { ticks: 2 }), leaf('two'), setVar('done', 'true')]]),
        leaf('never'),
    ]));
    assert.ok(h.log.includes('end two'), 'the other branch finished');
    assert.ok(!h.log.includes('start never'));
    assert.equal(view.ok, false);
    assert.equal(view.failed.path, 'steps[0].branches[0].steps[0]');
    assert.equal(w.vars.done, true, 'what the other branch wrote is kept');
    assert.deepEqual(view.steps.get('steps[0]').result, { branches: 2, failed: [0] });
});

test('when two branches fail, the first in branch order is the failure of the action', async () => {
    const { view } = await run(seq([parallel([[leaf('late', { ticks: 5, fail: true })], [leaf('early', { fail: true })]])]));
    assert.equal(view.failed.path, 'steps[0].branches[0].steps[0]');
    assert.deepEqual(view.steps.get('steps[0]').result, { branches: 2, failed: [0, 1] });
});

test('failFast ends the other branches before their next step and starts no further branch', async () => {
    process.env[ENV] = '2';
    const { h, view } = await run(seq([
        parallel([
            [leaf('bad', { fail: true })],
            [leaf('one', { ticks: 3 }), leaf('two')],
            [leaf('third')],
        ], { failFast: true }),
    ]));
    assert.ok(h.log.includes('end one'), 'a step already running finishes');
    assert.ok(!h.log.includes('start two'));
    assert.ok(!h.log.includes('start third'));
    assert.equal(view.ok, false);
    assert.equal(view.failed.path, 'steps[0].branches[0].steps[0]');
    assert.equal(view.steps.get('steps[0].branches[1].steps[1]').status, 'not_run');
});

test('a try around the step catches the failure of a branch, and a handler inside a branch keeps it there', async () => {
    const caught = await run(seq([
        { kind: 'try', steps: [parallel([[leaf('bad', { fail: true })], [leaf('fine')]])], catch: [setVar('msg', 'error.message')] },
        leaf('after'),
    ]));
    assert.equal(caught.view.ok, true);
    assert.equal(caught.w.vars.msg, 'bad failed');
    assert.ok(caught.h.log.includes('end after'));

    const handled = await run(seq([
        parallel([[leaf('bad', { fail: true, onError: { steps: [setVar('fallback', '"used"')] } })], [leaf('fine')]]),
        leaf('after'),
    ]));
    assert.equal(handled.view.ok, true);
    assert.equal(handled.w.vars.fallback, 'used');
    assert.deepEqual(handled.view.steps.get('steps[0]').result, { branches: 2 });
});

test('a handler that ends the run quietly in one branch ends the action without a failure', async () => {
    const { h, view } = await run(seq([
        parallel([[leaf('bad', { fail: true, onError: { steps: [], stop: true } })], [leaf('fine')]]),
        leaf('never'),
    ]));
    assert.ok(!h.log.includes('start never'));
    assert.equal(view.failed, null);
    assert.match(String(view.stopped), /onError handler ends the run/);
});

test('at most STUDIO_APP_PARALLEL_MAX branches run at once; 0 lifts the cap', async () => {
    const five = () => seq([parallel([1, 2, 3, 4, 5].map((n) => [leaf(`b${n}`, { ticks: 2 })]))]);
    delete process.env[ENV];
    assert.equal((await run(five())).h.live.peak, 4, 'the default');
    process.env[ENV] = '2';
    assert.equal((await run(five())).h.live.peak, 2);
    process.env[ENV] = '0';
    assert.equal((await run(five())).h.live.peak, 5);
});

test('parallelMax reads a whole number from 0 up and falls back to 4', () => {
    assert.equal(parallelMax(undefined), 4);
    assert.equal(parallelMax(''), 4);
    assert.equal(parallelMax('0'), 0);
    assert.equal(parallelMax('12'), 12);
    assert.equal(parallelMax('-1'), 4);
    assert.equal(parallelMax('2.5'), 4);
    assert.equal(parallelMax('many'), 4);
});

test('the step budget counts the steps of every branch, and a budget stop ends them all', async () => {
    const over = { shouldStop: (w) => (w.executed >= 3 ? 'step limit reached' : null) };
    const { w, view } = await run(seq([
        parallel([[leaf('a1'), leaf('a2'), leaf('a3')], [leaf('b1'), leaf('b2'), leaf('b3')]]),
        leaf('never'),
    ]), {}, over);
    assert.equal(w.executed, 3, 'both branches count on one counter (each alone would have run its three steps)');
    assert.equal(w.truncated, true);
    assert.equal(view.stopped, 'step limit reached');
    assert.equal(view.ok, false);
    assert.equal(view.failed, null);
});

test('a fork shares the step count and the outcome map, and keeps its own variables', () => {
    const w = newWalkState({ vars: { a: 1 } });
    const fork = forkState(w);
    fork.executed += 2;
    fork.vars = { ...fork.vars, a: 2 };
    fork.stopped = 'x';
    assert.equal(w.executed, 2);
    assert.equal(forkState(fork).executed, 2);
    assert.equal(w.vars.a, 1);
    assert.equal(w.stopped, null);
    assert.equal(fork.outcomes, w.outcomes);
    assert.equal(fork.notes, w.notes);
});

test('a branch refuses the kinds that may not run there, also in an action it calls', async () => {
    for (const kind of ['navigate', 'confirm', 'open_modal', 'transaction', 'send_email']) {
        const { view } = await run(seq([parallel([[{ kind }], [leaf('fine')]])]));
        assert.equal(view.failed.code, 'not_in_parallel', kind);
        assert.equal(view.failed.path, 'steps[0].branches[0].steps[0]', kind);
    }
    const nested = await run(seq([parallel([[parallel([[leaf('x')]])]])]));
    assert.equal(nested.view.failed.code, 'not_in_parallel');
    const actions = { act_sub: seq([{ kind: 'navigate', screenId: 's' }]) };
    const called = await run(seq([parallel([[{ kind: 'call_action', actionId: 'act_sub' }]])]), {}, {}, actions);
    assert.equal(called.view.failed.code, 'not_in_parallel');
});

test('a return directly in a branch is refused; in an action the branch calls it ends that action', async () => {
    const direct = await run(seq([parallel([[{ kind: 'return' }]])]));
    assert.equal(direct.view.failed.code, 'not_in_parallel');
    const actions = { act_sub: seq([{ kind: 'return', value: { kind: 'static', value: 7 } }, leaf('never')]) };
    const { w, h, view } = await run(seq([parallel([[{ kind: 'call_action', actionId: 'act_sub', resultVar: 'got' }], [leaf('fine')]]), leaf('after')]), {}, {}, actions);
    assert.equal(view.ok, true);
    assert.equal(w.vars.got, 7);
    assert.ok(h.log.includes('end after'));
});

test('a break in a branch cannot leave a loop around the step; a loop inside the branch works', async () => {
    const outer = await run(seq([{ kind: 'loop', source: { kind: 'static', value: [1, 2] }, steps: [parallel([[{ kind: 'break' }]])] }]));
    assert.equal(outer.view.failed.code, 'not_in_loop');
    const inner = await run(seq([parallel([[{ kind: 'loop', source: { kind: 'static', value: [1, 2, 3] }, steps: [setVar('n', 'item'), { kind: 'break' }] }]])]));
    assert.equal(inner.view.ok, true);
    assert.equal(inner.w.vars.n, 1);
});

test('more branches than the limit fail the step', async () => {
    const { view } = await run(seq([parallel(Array.from({ length: 9 }, (_, n) => [leaf(`b${n}`)]))]));
    assert.equal(view.failed.code, 'parallel_too_many');
});

test('a host with sequentialBranches walks the branches one after another and notes it', async () => {
    const { h, w, view } = await run(seq([parallel([[leaf('slow', { ticks: 4 })], [leaf('quick')]])]), {}, { sequentialBranches: 'one after another here' });
    assert.deepEqual(h.log, ['start slow', 'end slow', 'start quick', 'end quick']);
    assert.equal(view.ok, true);
    assert.deepEqual([...w.notes], ['steps[0]: one after another here']);
});

test('what a host throws out of a branch surfaces after every branch ended', async () => {
    const over = { onStepStart: (e) => { if (e.path === 'steps[0].branches[0].steps[0]') throw new Error('host down'); } };
    await assert.rejects(run(seq([parallel([[leaf('a')], [leaf('b', { ticks: 2 }), leaf('c')]])]), {}, over), /host down/);
});
