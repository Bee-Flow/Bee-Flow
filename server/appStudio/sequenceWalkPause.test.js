'use strict';

/**
 * Pausing a walk and walking on (sequenceWalkPause.mts): the same action is walked once
 * straight through and once pausing at every step that waits, with the state taken through
 * JSON and a fresh host between the stretches. Both walks must run the same steps, record the
 * same step ends and finish with the same variables, result and failure, wherever the waiting
 * step sits: in a loop, a while, a try (its steps, catch, finally), a called action, an onError
 * handler, and nested in each other.
 *
 * Run: cd server && node --test appStudio/sequenceWalkPause.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { newWalkState, resumedWalkState, walkAction, outcomeView } = require('./sequenceWalk.mts');
const { tryEvaluate } = require('../shared/expr/index.mjs');

function host(log, over = {}) {
    let t = 0;
    return {
        decide: async (step) => ({ run: true, step }),
        execute: async (step) => {
            log.ran.push(step.tag ?? step.kind);
            if (step.fail) return { ok: false, error: `${step.tag} failed`, code: 'boom', retryable: false };
            if (step.wait && over.canPause) return { ok: true, pause: { until: 1, timeoutResult: null } };
            return { ok: true, result: { tag: step.tag ?? null } };
        },
        resolve: async (b, _ctx, scope) => (b && b.kind === 'formula' ? tryEvaluate(b.expr, scope).value : (b && b.kind === 'static' ? b.value : null)),
        evaluate: (expr, scope) => tryEvaluate(expr, scope).value,
        buildScope: (ctx) => ({ vars: ctx.vars, item: ctx.item, index: ctx.index, error: ctx.error ?? null, params: ctx.params }),
        ctxFor: (w) => ({ vars: w.vars, item: w.item, index: w.index, error: w.error, params: w.params }),
        onStepEnd: (e) => { log.ends.push(`${e.path} ${e.kind} ${e.status}${e.handled ? ' handled' : ''}${e.iteration !== null ? ` #${e.iteration}` : ''}`); },
        sleep: async () => {},
        now: () => { t += 1; return t; },
        ...over,
    };
}

const seq = (steps) => ({ kind: 'sequence', steps });
const leaf = (tag, extra = {}) => ({ kind: 'ai_generate', tag, ...extra });
const wait = (tag, extra = {}) => ({ kind: 'ai_generate', tag, wait: true, ...extra });
const setVar = (name, expr) => ({ kind: 'set_variable', name, value: { kind: 'formula', expr } });

const summary = (w, log) => {
    const view = outcomeView(w);
    return { ran: log.ran, ends: log.ends, vars: view.vars, result: view.result, ok: view.ok, failed: view.failed, stopped: view.stopped };
};

/** Straight through: the waiting steps answer at once. */
async function straight(action, actions, init) {
    const log = { ran: [], ends: [] };
    const w = newWalkState(init);
    await walkAction(w, action, host(log, { resolveCallee: (id) => actions[id] ?? null }), { actionId: 'act_root' });
    return summary(w, log);
}

/** Pausing at every waiting step; each stretch gets a fresh host and a state that went through JSON. */
async function paused(action, actions, init, resultOf = (tag) => ({ result: { tag } })) {
    const log = { ran: [], ends: [] };
    const over = { resolveCallee: (id) => actions[id] ?? null, canPause: true };
    let w = newWalkState(init);
    let pauses = 0;
    for (;;) {
        await walkAction(w, action, host(log, over), { actionId: 'act_root' });
        if (!w.paused) break;
        pauses += 1;
        assert.ok(pauses < 50, 'the walk keeps pausing');
        const state = JSON.parse(JSON.stringify(w.paused.state));
        // The paused step ran once already; the straight walk counts it once too.
        const tag = log.ran[log.ran.length - 1];
        w = resumedWalkState(state, resultOf(tag));
        assert.ok(w, 'the snapshot restores');
    }
    return { ...summary(w, log), pauses };
}

async function same(action, { actions = {}, init = {}, pauses } = {}) {
    const a = await straight(action, actions, init);
    const { pauses: n, ...b } = await paused(action, actions, init);
    assert.deepEqual(b, a);
    if (pauses !== undefined) assert.equal(n, pauses);
    return a;
}

test('a pause at the top of a sequence: the step ends with the resume result, its resultVar is set, the walk goes on', async () => {
    const out = await same(seq([leaf('a'), wait('w', { resultVar: 'got' }), setVar('after', 'vars.got.tag'), leaf('b')]), { pauses: 1 });
    assert.deepEqual(out.ran, ['a', 'w', 'b']);
    assert.deepEqual(out.vars, { got: { tag: 'w' }, after: 'w' });
});

test('inside a condition and a switch: the path says which branch, nothing is evaluated twice', async () => {
    const action = seq([
        setVar('n', '1'),
        { kind: 'condition', expr: 'vars.n == 1', then: [setVar('n', '2'), wait('w1'), leaf('then')], else: [leaf('else')] },
        { kind: 'switch', expr: 'vars.n', cases: [{ value: 1, steps: [leaf('one')] }, { value: 2, steps: [wait('w2'), leaf('two')] }], default: [leaf('other')] },
    ]);
    const out = await same(action, { pauses: 2 });
    // The condition's expr is false by the time the walk resumes (n is 2): the resumed walk still finishes `then`.
    assert.deepEqual(out.ran, ['w1', 'then', 'w2', 'two']);
});

test('inside a loop: the rows still to do, the round, the item and the loop variables come back; they are restored after it', async () => {
    const action = seq([
        setVar('row', '"before"'),
        { kind: 'loop', source: { kind: 'static', value: ['a', 'b', 'c'] }, itemVar: 'row', indexVar: 'i', steps: [setVar('seen', 'concat(vars.seen, vars.row, vars.i)'), wait('w'), setVar('after', 'concat(vars.after, item)')] },
        leaf('end'),
    ]);
    const out = await same(action, { init: { vars: { seen: '', after: '' } }, pauses: 3 });
    assert.deepEqual(out.vars, { seen: 'a0b1c2', after: 'abc', row: 'before' });
});

test('a loop frame keeps only the rows from its round on', async () => {
    const log = { ran: [], ends: [] };
    const w = newWalkState();
    const action = seq([{ kind: 'loop', source: { kind: 'static', value: ['a', 'b', 'c', 'd'] }, steps: [{ kind: 'condition', expr: 'index == 2', then: [wait('w')], else: [] }] }]);
    await walkAction(w, action, host(log, { canPause: true }), { actionId: 'act_root' });
    assert.equal(w.paused.path, 'steps[0].steps[0].then[0]');
    const frame = w.paused.state.frames['steps[0]#loop'];
    assert.deepEqual(frame.source, ['c', 'd']);
    assert.equal(frame.offset, 2);
    assert.equal(frame.n, 2);
});

test('inside a while, with break and continue around the pause', async () => {
    const action = seq([
        setVar('n', '0'),
        { kind: 'while', expr: 'vars.n < 5', steps: [
            setVar('n', 'vars.n + 1'),
            { kind: 'condition', expr: 'vars.n == 2', then: [{ kind: 'continue' }], else: [] },
            wait('w'),
            { kind: 'condition', expr: 'vars.n == 4', then: [{ kind: 'break' }], else: [] },
        ] },
        leaf('end'),
    ]);
    const out = await same(action, { pauses: 3 });
    assert.equal(out.vars.n, 4);
});

test('inside a try: in its steps, in its catch (the error scope survives) and in its finally (what was pending is put back)', async () => {
    const inSteps = seq([{ kind: 'try', steps: [wait('w'), leaf('x', { fail: true })], catch: [setVar('msg', 'error.message')], finally: [leaf('fin')] }, leaf('end')]);
    assert.deepEqual((await same(inSteps, { pauses: 1 })).vars, { msg: 'x failed' });

    const inCatch = seq([{ kind: 'try', steps: [leaf('x', { fail: true })], catch: [wait('w'), setVar('msg', 'error.message')], finally: [leaf('fin')] }, setVar('gone', 'error == null'), leaf('end')]);
    assert.deepEqual((await same(inCatch, { pauses: 1 })).vars, { msg: 'x failed', gone: true });

    // No catch: the failure is pending while `finally` runs, and stops the walk after it.
    const inFinally = seq([{ kind: 'try', steps: [leaf('x', { fail: true })], finally: [wait('w'), leaf('fin')] }, leaf('never')]);
    const out = await same(inFinally, { pauses: 1 });
    assert.equal(out.ok, false);
    assert.equal(out.failed.path, 'steps[0].steps[0]');
    assert.deepEqual(out.ran, ['x', 'w', 'fin']);

    // A return on its way out through `finally` still returns its value after the pause.
    const returning = seq([{ kind: 'try', steps: [{ kind: 'return', value: { kind: 'static', value: 7 } }], finally: [wait('w')] }, leaf('never')]);
    assert.equal((await same(returning, { pauses: 1 })).result, 7);
});

test('inside a called action: params, the caller\'s item and result come back; a nested call too', async () => {
    const actions = {
        act_inner: seq([wait('inner'), { kind: 'return', value: { kind: 'formula', expr: 'concat(params.who, "!")' } }]),
        act_outer: seq([leaf('pre'), { kind: 'call_action', actionId: 'act_inner', params: { who: { kind: 'formula', expr: 'params.name' } }, resultVar: 'deep' }, wait('outer')]),
        // No server step before the pause: the call has no result of its own yet.
        act_empty: seq([wait('quiet')]),
    };
    const action = seq([
        { kind: 'loop', source: { kind: 'static', value: ['x', 'y'] }, steps: [{ kind: 'call_action', actionId: 'act_outer', params: { name: { kind: 'formula', expr: 'item' } }, resultVar: 'r' }, setVar('items', 'concat(vars.items, item, vars.deep)')] },
        { kind: 'call_action', actionId: 'act_empty', resultVar: 'e' },
    ]);
    const out = await same(action, { actions, init: { vars: { items: '' } }, pauses: 5 });
    assert.equal(out.vars.items, 'xx!yy!');
});

test('inside an onError handler: the error scope and a handler that ends the run', async () => {
    const goesOn = seq([leaf('x', { fail: true, onError: { steps: [wait('w'), setVar('msg', 'error.message')] } }), setVar('gone', 'error == null'), leaf('end')]);
    assert.deepEqual((await same(goesOn, { pauses: 1 })).vars, { msg: 'x failed', gone: true });
    const stops = seq([leaf('x', { fail: true, onError: { stop: true, steps: [wait('w')] } }), leaf('never')]);
    const out = await same(stops, { pauses: 1 });
    assert.match(out.stopped, /onError handler ends the run/);
    const onCall = seq([{ kind: 'call_action', actionId: 'act_bad', onError: { steps: [wait('w'), leaf('handled')] } }, leaf('end')]);
    await same(onCall, { actions: { act_bad: seq([leaf('x', { fail: true })]) }, pauses: 1 });
});

test('a resume that fails the step: its onError handler or an enclosing try takes it, else the run fails there', async () => {
    const action = seq([{ kind: 'try', steps: [wait('w'), leaf('never')], catch: [setVar('code', 'error.code')] }, leaf('end')]);
    const out = await paused(action, {}, {}, () => ({ error: 'Nothing continued the run', code: 'pause_expired' }));
    assert.deepEqual(out.vars, { code: 'pause_expired' });
    assert.deepEqual(out.ran, ['w', 'end']);
    const bare = await paused(seq([wait('w'), leaf('never')]), {}, {}, () => ({ error: 'Nothing continued the run', code: 'pause_expired' }));
    assert.equal(bare.ok, false);
    assert.equal(bare.failed.code, 'pause_expired');
    assert.deepEqual(bare.ran, ['w']);
});

test('a host that cannot pause fails the step; so does a branch of a parallel step', async () => {
    const log = { ran: [], ends: [] };
    const pausing = { execute: async () => ({ ok: true, pause: { until: 1 } }) };
    const w = newWalkState();
    await walkAction(w, seq([leaf('a'), leaf('never')]), host(log, pausing), { actionId: 'act_root' });
    assert.equal(w.paused ?? null, null);
    assert.equal(w.failed.code, 'pause_unsupported');

    const w2 = newWalkState();
    await walkAction(w2, seq([{ kind: 'parallel', branches: [{ steps: [leaf('a')] }, { steps: [leaf('b')] }] }]), host(log, { ...pausing, canPause: true }), { actionId: 'act_root' });
    assert.equal(w2.paused ?? null, null);
    assert.equal(w2.failed.code, 'not_in_parallel');
});

test('the host may refuse a pause: the step fails with its code, and the handler runs', async () => {
    const log = { ran: [], ends: [] };
    const w = newWalkState();
    const h = host(log, { canPause: true, acceptPause: async () => ({ error: 'Too many runs on hold', code: 'pause_limit' }) });
    await walkAction(w, seq([wait('w', { onError: { steps: [setVar('code', 'error.code')] } }), leaf('end')]), h, { actionId: 'act_root' });
    assert.equal(w.paused ?? null, null);
    assert.deepEqual(w.vars, { code: 'pause_limit' });
    assert.deepEqual(log.ran, ['w', 'end']);
});

test('a paused walk records nothing for the step or the containers around it until they really end', async () => {
    const log = { ran: [], ends: [] };
    const w = newWalkState();
    const action = seq([{ kind: 'while', expr: 'true', maxIterations: 2, steps: [{ kind: 'try', steps: [wait('w')] }] }]);
    await walkAction(w, action, host(log, { canPause: true }), { actionId: 'act_root' });
    assert.ok(w.paused);
    assert.deepEqual(log.ends, []);
    assert.equal(w.stopped, 'steps[0].steps[0].steps[0] paused');
    assert.equal(w.truncated, true);
});

test('a snapshot that is not one, or a path that leads nowhere, fails the run instead of walking somewhere else', async () => {
    assert.equal(resumedWalkState({ v: 2, cursor: 'steps[0]' }, { result: null }), null);
    assert.equal(resumedWalkState(null, { result: null }), null);
    const log = { ran: [], ends: [] };
    const w = resumedWalkState({ v: 1, cursor: 'steps[7]', frames: {} }, { result: null });
    await walkAction(w, seq([leaf('a'), leaf('b')]), host(log, {}), { actionId: 'act_root' });
    assert.deepEqual(log.ran, []);
    assert.equal(w.failed.code, 'resume_lost');
    // A loop on the path without its frame.
    const w2 = resumedWalkState({ v: 1, cursor: 'steps[0].steps[1]', frames: {} }, { result: null });
    await walkAction(w2, seq([{ kind: 'loop', source: { kind: 'static', value: [1] }, steps: [leaf('a'), leaf('b')] }, leaf('c')]), host(log, {}), { actionId: 'act_root' });
    assert.deepEqual(log.ran, []);
    assert.equal(w2.failed.code, 'resume_lost');
});
