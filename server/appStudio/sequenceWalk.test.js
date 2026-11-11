'use strict';

/**
 * The shared server walker on its own, with a recording host (no executor, no store).
 *
 * Run: cd server && node --test appStudio/sequenceWalk.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { newWalkState, walkAction, stepPaths, outcomeView } = require('./sequenceWalk.mts');
const { flattenSteps, normalizeSequence } = require('./actionSequence');
const { childStepSlots, childStepLists } = require('../shared/appDefinition/stepFlow.mjs');

const pick = (path, root) => String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), root);

function host(over = {}) {
    const ends = [];
    const starts = [];
    let t = 0;
    const h = {
        ends, starts,
        decide: async (step) => ({ run: true, step }),
        execute: async (step) => ({ ok: true, result: { ran: step.kind, tag: step.tag ?? null } }),
        resolve: async (b, _ctx, scope) => (b && b.kind === 'formula' ? pick(b.expr, scope) : (b && b.kind === 'static' ? b.value : null)),
        evaluate: (expr, scope) => pick(expr, scope),
        buildScope: (ctx) => ({ vars: ctx.vars, item: ctx.item }),
        ctxFor: (w) => ({ vars: w.vars, item: w.item, index: w.index }),
        onStepStart: (e) => { starts.push(e.path); },
        onStepEnd: (e) => { ends.push(e); },
        sleep: async () => {},
        now: () => { t += 1; return t; },
        ...over,
    };
    return h;
}

const NESTED = {
    kind: 'sequence', steps: [
        { kind: 'ai_generate', tag: 'a' },
        { kind: 'condition', expr: 'vars.go', then: [{ kind: 'ai_extract', tag: 'b' }], else: [{ kind: 'kb_query', tag: 'c' }] },
        { kind: 'switch', expr: 'vars.mode', cases: [{ value: 'x', steps: [{ kind: 'ai_generate', tag: 'd' }] }, { value: 'y', steps: [] }], default: [{ kind: 'toast', tag: 'e' }] },
        { kind: 'loop', source: { kind: 'formula', expr: 'vars.rows' }, steps: [{ kind: 'dataset_query', tag: 'f' }] },
    ],
};

test('stepPaths: every walker path of a nested action, in pre-order, with its flattenSteps ordinal', () => {
    const paths = stepPaths(NESTED);
    assert.deepEqual(paths.map((p) => p.path), [
        'steps[0]', 'steps[1]', 'steps[1].then[0]', 'steps[1].else[0]',
        'steps[2]', 'steps[2].cases[0].steps[0]', 'steps[2].default[0]',
        'steps[3]', 'steps[3].steps[0]',
    ]);
    const flat = flattenSteps(normalizeSequence(NESTED));
    for (const p of paths) assert.equal(p.kind, flat[p.ordinal].kind, `${p.path} is ordinal ${p.ordinal}`);
    assert.deepEqual(paths.map((p) => p.ordinal), [0, 1, 2, 3, 4, 5, 6, 7, 8], 'pre-order: the same order flattenSteps uses');
});

test('stepPaths of a bare action is action[0]', () => {
    assert.deepEqual(stepPaths({ kind: 'ai_generate' }), [{ path: 'action[0]', kind: 'ai_generate', ordinal: 0 }]);
});

test('the report paths of a walk are the stepPaths of the branches taken', async () => {
    const h = host();
    const w = newWalkState({ vars: { go: true, mode: 'x', rows: [1] } });
    await walkAction(w, NESTED, h, { actionId: 'act_1' });
    const known = new Set(stepPaths(NESTED).map((p) => p.path));
    for (const e of h.ends) assert.ok(known.has(e.path), `${e.path} is a stepPaths path`);
    assert.deepEqual(h.ends.map((e) => e.path), [
        'steps[0]', 'steps[1]', 'steps[1].then[0]', 'steps[2]', 'steps[2].cases[0].steps[0]', 'steps[3]', 'steps[3].steps[0]',
    ]);
    assert.deepEqual(h.starts, h.ends.map((e) => e.path), 'onStepStart before every onStepEnd');
    // The ordinal of a walked step is the browser's stepIndex.
    assert.equal(h.ends.find((e) => e.path === 'steps[2].cases[0].steps[0]').ordinal, 5);
});

test('a loop keeps the outcome of the last iteration with the count; ms and loop info ride on the event', async () => {
    const h = host();
    const w = newWalkState({ vars: { rows: ['r1', 'r2', 'r3'] } });
    await walkAction(w, { kind: 'sequence', steps: [{ kind: 'loop', source: { kind: 'formula', expr: 'vars.rows' }, itemVar: 'row', steps: [{ kind: 'ai_generate' }] }] }, h, { actionId: 'act_1' });
    const body = w.outcomes.get('steps[0].steps[0]');
    assert.equal(body.count, 3);
    assert.equal(body.status, 'ok');
    const loopEnds = h.ends.filter((e) => e.path === 'steps[0].steps[0]');
    assert.deepEqual(loopEnds.map((e) => [e.iteration, e.loop.count]), [[0, 3], [1, 3], [2, 3]]);
    assert.ok(h.ends.every((e) => typeof e.ms === 'number' && e.ms >= 0));
    assert.deepEqual(w.outcomes.get('steps[0]').result, { iterations: 3 });
    assert.equal(w.vars.row, undefined, 'itemVar is iteration-scoped');
});

test('an untaken path reads not_run in the outcome view', async () => {
    const h = host();
    const w = newWalkState({ vars: { go: false, mode: 'zzz', rows: [] } });
    await walkAction(w, NESTED, h, { actionId: 'act_1' });
    const view = outcomeView(w);
    assert.equal(view.steps.get('steps[1].then[0]').status, 'not_run');
    assert.equal(view.steps.get('steps[1].then[0]').count, 0);
    assert.equal(view.steps.get('steps[1].else[0]').status, 'ok');
    assert.equal(view.steps.get('steps[2].default[0]').status, 'ok');
    assert.equal(view.steps.get('steps[3].steps[0]').status, 'not_run');
    assert.equal(view.ok, true);
});

test('lastResult is the result of the last step that ran; resultVar lands in vars', async () => {
    const h = host();
    const w = newWalkState();
    await walkAction(w, { kind: 'sequence', steps: [{ kind: 'ai_generate', tag: 1, resultVar: 'one' }, { kind: 'ai_extract', tag: 2 }, { kind: 'toast' }] },
        host({ ...h, decide: async (step) => (step.kind === 'toast' ? { run: false, status: 'skipped', reason: 'client' } : { run: true, step }) }), { actionId: 'act_1' });
    assert.deepEqual(w.lastResult, { ran: 'ai_extract', tag: 2 }, 'a skipped step does not replace it');
    assert.deepEqual(w.vars.one, { ran: 'ai_generate', tag: 1 });
    assert.equal(outcomeView(w).result, w.lastResult);
});

test('onStepEnd is called once per step that ran, a failing step stops the walk', async () => {
    const h = host({ execute: async (step) => (step.tag === 'boom' ? { ok: false, error: 'Step failed', code: 'x' } : { ok: true, result: 1 }) });
    const w = newWalkState();
    await walkAction(w, { kind: 'sequence', steps: [{ kind: 'ai_generate' }, { kind: 'ai_generate', tag: 'boom' }, { kind: 'ai_generate' }] }, h, { actionId: 'act_1' });
    assert.deepEqual(h.ends.map((e) => [e.path, e.status]), [['steps[0]', 'ok'], ['steps[1]', 'error']]);
    assert.equal(w.stopped, 'steps[1] failed');
    assert.deepEqual(w.failed, { path: 'steps[1]', kind: 'ai_generate', ordinal: 1, error: 'Step failed', code: 'x' });
    assert.equal(outcomeView(w).ok, false);
    assert.equal(outcomeView(w).steps.get('steps[2]').status, 'not_run');
});

test('a mock answers instead of execute; the prompt is kept on the outcome', async () => {
    const executed = [];
    const h = host({
        execute: async (step) => { executed.push(step); return { ok: true, result: 'real' }; },
        mockFor: (path) => (path === 'steps[0]' ? { value: 'fixed' } : null),
        mocked: (_step, value) => ({ ok: true, result: { text: value } }),
        promptOf: (step, ctx) => `Hi ${ctx.vars.name}`,
    });
    const w = newWalkState({ vars: { name: 'Ada' } });
    await walkAction(w, { kind: 'sequence', steps: [{ kind: 'ai_generate', resultVar: 'g' }, { kind: 'ai_generate' }] }, h, { actionId: 'act_1' });
    assert.equal(executed.length, 1);
    assert.deepEqual(w.vars.g, { text: 'fixed' });
    assert.equal(w.outcomes.get('steps[0]').mocked, true);
    assert.equal(w.outcomes.get('steps[0]').prompt, 'Hi Ada');
    assert.equal(h.ends[0].mocked, true);
    assert.equal('prompt' in h.ends[0], false, 'the prompt stays out of the event');
});

test('shouldStop ends the walk as truncated; a binding that throws fails the step with its message', async () => {
    let n = 0;
    const stopping = host({ shouldStop: () => (n++ >= 1 ? 'budget' : null) });
    const w = newWalkState();
    await walkAction(w, { kind: 'sequence', steps: [{ kind: 'ai_generate' }, { kind: 'ai_generate' }] }, stopping, { actionId: 'a' });
    assert.equal(w.stopped, 'budget');
    assert.equal(w.truncated, true);
    assert.equal(outcomeView(w).ok, false);

    const refusing = host({ resolve: async () => { throw Object.assign(new Error('Not allowed to read that table'), { code: 'forbidden' }); } });
    const w2 = newWalkState();
    await walkAction(w2, { kind: 'sequence', steps: [{ kind: 'set_variable', name: 'x', value: { kind: 'records', tableId: 't' } }] }, refusing, { actionId: 'a' });
    assert.equal(w2.failed.error, 'Not allowed to read that table');
    assert.equal(w2.failed.code, 'forbidden');
});

test('set_variable calls onVar; a loop over a non-list is skipped with a note', async () => {
    const vars = [];
    const h = host({ onVar: (name, value) => vars.push([name, value]) });
    const w = newWalkState({ vars: { n: 5 } });
    await walkAction(w, { kind: 'sequence', steps: [
        { kind: 'set_variable', name: 'x', value: { kind: 'static', value: 7 } },
        { kind: 'loop', source: { kind: 'formula', expr: 'vars.n' }, steps: [{ kind: 'ai_generate' }] },
    ] }, h, { actionId: 'a' });
    assert.deepEqual(vars, [['x', 7]]);
    assert.equal(w.outcomes.get('steps[1]').status, 'skipped');
    assert.match([...w.notes].join(' '), /steps\[1\]: the loop source did not resolve to a list/);
});

test('stepFlow: the child slots of each kind, in the order flattenSteps visits them', () => {
    assert.deepEqual(childStepSlots({ kind: 'condition', then: [1], else: [2] }).map((s) => [s.suffix, s.steps, s.walked]), [['.then', [1], true], ['.else', [2], true]]);
    assert.deepEqual(childStepSlots({ kind: 'loop', steps: [1] }).map((s) => s.suffix), ['.steps']);
    assert.deepEqual(childStepSlots({ kind: 'switch', cases: [{ steps: [1] }, null], default: [2] }).map((s) => [s.suffix, s.steps]),
        [['.cases[0].steps', [1]], ['.cases[1].steps', []], ['.default', [2]]]);
    assert.deepEqual(childStepSlots({ kind: 'ai_generate' }), []);
    assert.deepEqual(childStepSlots(null), []);
    assert.deepEqual(childStepLists({ kind: 'condition', then: 'x' }), [[], []], 'a malformed list reads as empty');
});

// ── call_action ─────────────────────────────────────────────────────────────

function callHost(actions, over = {}) {
    return host({
        execute: async (step, _f, w) => ({ ok: true, result: { double: (w.params.n ?? 0) * 2, kind: step.kind } }),
        buildScope: (ctx) => ({ vars: ctx.vars, item: ctx.item, params: ctx.params }),
        ctxFor: (w) => ({ vars: w.vars, item: w.item, index: w.index, params: w.params }),
        resolveCallee: (id) => (Object.hasOwn(actions, id) ? actions[id] : null),
        ...over,
    });
}

test('spec: an action calls another with params and uses its result', async () => {
    const actions = {
        act_main: { kind: 'sequence', steps: [
            { kind: 'call_action', actionId: 'act_calc', params: { n: { kind: 'static', value: 2 } }, resultVar: 'calc' },
            { kind: 'set_variable', name: 'total', value: { kind: 'formula', expr: 'vars.calc.double' } },
        ] },
        act_calc: { kind: 'sequence', steps: [{ kind: 'ai_generate' }] },
    };
    const h = callHost(actions);
    const w = newWalkState();
    await walkAction(w, actions.act_main, h, { actionId: 'act_main' });
    assert.equal(w.stopped, null);
    assert.equal(w.vars.total, 4);
    const inner = h.ends.find((e) => e.path === 'steps[0].call.steps[0]');
    assert.ok(inner, h.ends.map((e) => e.path).join(', '));
    assert.equal(inner.ownerActionId, 'act_calc');
    assert.equal(inner.ordinal, 0, 'ordinals are the callee\'s own');
    assert.deepEqual(w.params, {}, 'params are restored after the call');
    const paths = stepPaths(actions.act_main, { resolveCallee: h.resolveCallee, rootId: 'act_main' });
    assert.deepEqual(paths.map((p) => p.path), ['steps[0]', 'steps[0].call.steps[0]', 'steps[1]']);
    assert.equal(paths[1].ownerActionId, 'act_calc');
});

test('call_action: the callee does not inherit item; vars writes carry back', async () => {
    const actions = {
        act_main: { kind: 'sequence', steps: [{ kind: 'call_action', actionId: 'act_sub' }] },
        act_sub: { kind: 'sequence', steps: [
            { kind: 'set_variable', name: 'seen', value: { kind: 'formula', expr: 'item' } },
            { kind: 'set_variable', name: 'mark', value: { kind: 'static', value: 'set' } },
        ] },
    };
    const w = newWalkState({ item: { id: 'r1' } });
    await walkAction(w, actions.act_main, callHost(actions), { actionId: 'act_main' });
    assert.equal(w.vars.seen ?? null, null);
    assert.equal(w.vars.mark, 'set');
    assert.deepEqual(w.item, { id: 'r1' }, 'the caller keeps its item');
});

test('call_action: a cycle in a hand-written definition stops the run', async () => {
    const actions = {
        act_a: { kind: 'sequence', steps: [{ kind: 'call_action', actionId: 'act_b' }] },
        act_b: { kind: 'sequence', steps: [{ kind: 'call_action', actionId: 'act_a' }] },
    };
    const w = newWalkState();
    await walkAction(w, actions.act_a, callHost(actions), { actionId: 'act_a' });
    assert.ok(w.stopped);
    assert.match(w.failed.error, /act_a → act_b → act_a calls itself/);
});

test('call_action: more than three calls deep is refused; a missing callee fails the step', async () => {
    const actions = {};
    for (let i = 0; i < 5; i++) actions[`act_${i}`] = { kind: 'sequence', steps: i < 4 ? [{ kind: 'call_action', actionId: `act_${i + 1}` }] : [{ kind: 'ai_generate' }] };
    const w = newWalkState();
    await walkAction(w, actions.act_0, callHost(actions), { actionId: 'act_0' });
    assert.match(w.failed.error, /more than 3 calls deep/);
    const w2 = newWalkState();
    await walkAction(w2, { kind: 'sequence', steps: [{ kind: 'call_action', actionId: 'act_gone' }] }, callHost({}), { actionId: 'act_x' });
    assert.match(w2.failed.error, /no action "act_gone"/);
    assert.equal(w2.failed.code, 'call_missing');
});

test('call_action: a send_email inside a callee called from a loop sees the loop', async () => {
    const actions = {
        act_main: { kind: 'sequence', steps: [{ kind: 'loop', source: { kind: 'static', value: [1] }, steps: [{ kind: 'call_action', actionId: 'act_mail' }] }] },
        act_mail: { kind: 'sequence', steps: [{ kind: 'send_email' }] },
    };
    const loops = [];
    const h = callHost(actions, {
        decide: async (step, f) => {
            if (step.kind === 'send_email') { loops.push(f.loop); return { run: false, status: 'refused', reason: 'send_email inside a loop' }; }
            return { run: true, step };
        },
    });
    await walkAction(newWalkState(), actions.act_main, h, { actionId: 'act_main' });
    assert.equal(loops.length, 1);
    assert.ok(loops[0], 'the loop frame reaches the callee');
    assert.equal(h.ends.find((e) => e.path === 'steps[0].steps[0].call.steps[0]').status, 'refused');
});

test('call_action: a failure inside the callee is the call step\'s failure', async () => {
    const actions = {
        act_main: { kind: 'sequence', steps: [{ kind: 'call_action', actionId: 'act_bad' }, { kind: 'toast' }] },
        act_bad: { kind: 'sequence', steps: [{ kind: 'ai_generate' }] },
    };
    const h = callHost(actions, { execute: async () => ({ ok: false, error: 'boom' }) });
    const w = newWalkState();
    await walkAction(w, actions.act_main, h, { actionId: 'act_main' });
    assert.equal(w.failed.path, 'steps[0]');
    assert.match(w.failed.error, /act_bad" failed at steps\[0\]\.call\.steps\[0\]: boom/);
    assert.ok(!h.ends.some((e) => e.path === 'steps[1]'), 'the run stops');
});

// ── Error handling: onError handlers and retry (package 2) ──────────────────

/** A host whose execute answers per call from `answers` (a function of step + attempt count). */
function failingHost(answer, over = {}) {
    const calls = [];
    return { calls, h: host({
        execute: async (step, _f, w) => { calls.push({ kind: step.kind, tag: step.tag ?? null, error: w.error ?? null }); return answer(step, calls.filter((c) => c.tag === (step.tag ?? null)).length, w); },
        buildScope: (ctx) => ({ vars: ctx.vars, item: ctx.item, error: ctx.error ?? null }),
        ctxFor: (w) => ({ vars: w.vars, item: w.item, error: w.error }),
        ...over,
    }) };
}

test('spec: a failing ai_generate with onError writes a fallback and the sequence continues', async () => {
    const { h, calls } = failingHost((step) => (step.kind === 'ai_generate'
        ? { ok: false, error: 'The AI provider had a temporary problem. Try again.', code: 'provider_unavailable', retryable: true }
        : { ok: true, result: { saved: true } }));
    const w = newWalkState();
    const action = { kind: 'sequence', steps: [
        { kind: 'ai_generate', prompt: 'x', resultVar: 'draft', onError: { steps: [
            { kind: 'set_variable', name: 'fallback', value: { kind: 'formula', expr: 'error.message' } },
            { kind: 'set_variable', name: 'failedStep', value: { kind: 'formula', expr: 'error.step' } },
        ] } },
        { kind: 'create_record', tag: 'save', values: {} },
        { kind: 'set_variable', name: 'after', value: { kind: 'formula', expr: 'vars.fallback' } },
    ] };
    await walkAction(w, action, h, { actionId: 'a' });
    const view = outcomeView(w);
    assert.equal(view.ok, true, 'a handled failure leaves the run ok');
    assert.equal(w.failed, null);
    assert.equal(w.stopped, null);
    assert.equal(w.vars.fallback, 'The AI provider had a temporary problem. Try again.');
    assert.equal(w.vars.failedStep, 'ai_generate');
    assert.equal(w.vars.after, w.vars.fallback, 'a later step reads the fallback');
    assert.ok(calls.some((c) => c.tag === 'save'), 'the step after the handler ran');
    const first = view.steps.get('steps[0]');
    assert.equal(first.status, 'error');
    assert.equal(first.handled, true);
    assert.equal(view.steps.get('steps[0].onError.steps[0]').status, 'ok');
    assert.equal(w.error, undefined, 'the error scope is restored after the handler');
    const end = h.ends.find((e) => e.path === 'steps[0]');
    assert.equal(end.handled, true);
    assert.equal(end.code, 'provider_unavailable');
});

test('spec: retry succeeds on the second attempt', async () => {
    const slept = [];
    const { h, calls } = failingHost((_step, n) => (n === 1 ? { ok: false, error: 'busy', code: 'db_busy', retryable: true } : { ok: true, result: { id: 'r1' } }),
        { sleep: async (ms) => { slept.push(ms); } });
    const w = newWalkState();
    await walkAction(w, { kind: 'sequence', steps: [{ kind: 'create_record', retry: { times: 2, delayMs: 0 }, resultVar: 'row' }] }, h, { actionId: 'a' });
    assert.equal(calls.length, 2);
    assert.deepEqual(slept, [], 'delayMs 0 does not wait');
    assert.equal(w.failed, null);
    assert.deepEqual(w.vars.row, { id: 'r1' });
    assert.equal(w.executed, 2, 'each attempt counts as an executed step');
    const o = w.outcomes.get('steps[0]');
    assert.equal(o.status, 'ok');
    assert.equal(o.attempts, 2);
});

test('retry: waits delayMs (default 1000) between attempts, stops at times, and reports the attempts', async () => {
    const slept = [];
    const { h, calls } = failingHost(() => ({ ok: false, error: 'busy', retryable: true }), { sleep: async (ms) => { slept.push(ms); } });
    const w = newWalkState();
    await walkAction(w, { kind: 'sequence', steps: [
        { kind: 'update_record', retry: { times: 2 }, onError: { steps: [{ kind: 'set_variable', name: 'n', value: { kind: 'formula', expr: 'error.attempts' } }] } },
    ] }, h, { actionId: 'a' });
    assert.equal(calls.length, 3, '1 + times');
    assert.deepEqual(slept, [1000, 1000]);
    assert.equal(w.vars.n, 3, 'the handler sees error.attempts');
});

test('retry: a failure that says retryable:false is not tried again; nor is a kind that is never retried', async () => {
    const { h, calls } = failingHost(() => ({ ok: false, error: 'Record not found', retryable: false }));
    const w = newWalkState();
    await walkAction(w, { kind: 'sequence', steps: [{ kind: 'update_record', retry: { times: 3, delayMs: 0 } }] }, h, { actionId: 'a' });
    assert.equal(calls.length, 1);
    assert.equal(w.failed.error, 'Record not found');
    const mail = failingHost(() => ({ ok: false, error: 'smtp down', retryable: true }));
    const w2 = newWalkState();
    await walkAction(w2, { kind: 'sequence', steps: [{ kind: 'send_email', retry: { times: 3, delayMs: 0 } }] }, mail.h, { actionId: 'a' });
    assert.equal(mail.calls.length, 1, 'send_email is never retried, whatever the definition says');
});

test('retry: a budget stop (shouldStop) ends the attempts', async () => {
    let n = 0;
    const { h, calls } = failingHost(() => ({ ok: false, error: 'busy', retryable: true }), { shouldStop: () => (++n > 2 ? 'budget' : null) });
    const w = newWalkState();
    await walkAction(w, { kind: 'sequence', steps: [{ kind: 'ai_generate', retry: { times: 3, delayMs: 0 } }] }, h, { actionId: 'a' });
    assert.ok(calls.length < 4, `stopped early (${calls.length} attempts)`);
});

test('onError stop:true ends the run quietly after the handler', async () => {
    const { h, calls } = failingHost((step) => (step.tag === 'boom' ? { ok: false, error: 'no' } : { ok: true, result: 1 }));
    const w = newWalkState();
    await walkAction(w, { kind: 'sequence', steps: [
        { kind: 'ai_generate', tag: 'boom', onError: { steps: [{ kind: 'kb_query', tag: 'fallback' }], stop: true } },
        { kind: 'create_record', tag: 'never' },
    ] }, h, { actionId: 'a' });
    assert.deepEqual(calls.map((c) => c.tag), ['boom', 'fallback']);
    assert.equal(w.failed, null);
    assert.match(w.stopped, /onError handler ends the run/);
    assert.equal(outcomeView(w).ok, true);
    assert.equal(calls[1].error.message, 'no', 'the handler\'s server step gets error in its ctx');
});

test('a failure inside a handler without its own handler stops the run as usual', async () => {
    const { h } = failingHost(() => ({ ok: false, error: 'down' }));
    const w = newWalkState();
    await walkAction(w, { kind: 'sequence', steps: [
        { kind: 'ai_generate', tag: 'a', onError: { steps: [{ kind: 'kb_query', tag: 'b' }] } },
        { kind: 'create_record', tag: 'c' },
    ] }, h, { actionId: 'a' });
    assert.equal(w.failed.path, 'steps[0].onError.steps[0]');
    assert.equal(outcomeView(w).ok, false);
    assert.equal(w.outcomes.get('steps[1]'), undefined, 'the run stopped');
});

test('onError on call_action handles a failure inside the called action', async () => {
    const actions = {
        act_main: { kind: 'sequence', steps: [
            { kind: 'call_action', actionId: 'act_sub', onError: { steps: [
                { kind: 'set_variable', name: 'why', value: { kind: 'formula', expr: 'error.message' } },
                { kind: 'set_variable', name: 'which', value: { kind: 'formula', expr: 'error.step' } },
            ] } },
            { kind: 'set_variable', name: 'done', value: { kind: 'static', value: true } },
        ] },
        act_sub: { kind: 'sequence', steps: [{ kind: 'ai_generate' }] },
    };
    const { h } = failingHost(() => ({ ok: false, error: 'model down' }), { resolveCallee: (id) => actions[id] ?? null });
    const w = newWalkState();
    await walkAction(w, actions.act_main, h, { actionId: 'act_main' });
    assert.equal(w.failed, null);
    assert.equal(w.vars.done, true);
    assert.match(w.vars.why, /act_sub.*model down/);
    assert.equal(w.vars.which, 'ai_generate', 'error.step is the step that failed inside the called action, as in the browser');
    assert.equal(w.outcomes.get('steps[0].onError.steps[0]').status, 'ok');
    assert.equal(w.outcomes.get('steps[0]').handled, true);
});

test('a transaction hands its children\'s resultVars to the steps after it (as the browser does)', async () => {
    const h = host({
        execute: async (step) => (step.kind === 'transaction'
            ? { ok: true, result: { results: [{ id: 'rec_1' }], vars: { order: { id: 'rec_1' } }, count: 1 } }
            : { ok: true, result: { ran: step.kind } }),
    });
    const w = newWalkState();
    await walkAction(w, { kind: 'sequence', steps: [
        { kind: 'transaction', steps: [{ kind: 'create_record', resultVar: 'order' }], resultVar: 'tx' },
        { kind: 'set_variable', name: 'orderId', value: { kind: 'formula', expr: 'vars.order.id' } },
    ] }, h, { actionId: 'act_1' });
    assert.equal(w.failed, null);
    assert.equal(w.vars.orderId, 'rec_1');
    assert.equal(w.vars.tx.count, 1, 'the step\'s own resultVar still holds the whole result');
});

test('stepPaths lists handler steps; their ordinals come after the whole tree', () => {
    const action = { kind: 'sequence', steps: [
        { kind: 'ai_generate', onError: { steps: [{ kind: 'toast' }] } },
        { kind: 'condition', expr: 'x', then: [{ kind: 'kb_query', onError: { steps: [{ kind: 'set_variable', name: 'a', value: { kind: 'static', value: 1 } }] } }] },
        { kind: 'transaction', steps: [{ kind: 'create_record' }] },
    ] };
    const paths = stepPaths(action);
    assert.deepEqual(paths.map((p) => [p.path, p.ordinal]), [
        ['steps[0]', 0], ['steps[0].onError.steps[0]', 4],
        ['steps[1]', 1], ['steps[1].then[0]', 2], ['steps[1].then[0].onError.steps[0]', 5],
        ['steps[2]', 3],
    ], 'a transaction\'s children get no path and no ordinal');
});

test('stepFlow: handler and transaction slots; the helpers', () => {
    const { errorHandlerOf, retryPlanOf, clampErrorScope } = require('../shared/appDefinition/stepFlow.mjs');
    assert.deepEqual(childStepSlots({ kind: 'ai_generate', onError: { steps: [1] } }).map((s) => [s.suffix, s.walked]), [['.onError.steps', true]]);
    assert.deepEqual(childStepSlots({ kind: 'transaction', steps: [1], onError: { steps: [2] } }).map((s) => [s.suffix, s.steps, s.walked]),
        [['.steps', [1], false], ['.onError.steps', [2], true]]);
    assert.deepEqual(childStepSlots({ kind: 'kb_query', onError: [3] }).map((s) => s.steps), [[3]], 'the legacy array form');
    assert.deepEqual(errorHandlerOf({ onError: [1] }), { steps: [1], stop: true });
    assert.equal(errorHandlerOf({ onError: [] }), null, 'an empty legacy list never handled anything');
    assert.deepEqual(errorHandlerOf({ onError: { steps: [] } }), { steps: [], stop: false });
    assert.equal(errorHandlerOf({ onError: { toast: { message: 'x' } } }), null, 'an effects object is not a step handler');
    assert.deepEqual(retryPlanOf({ kind: 'ai_generate', retry: { times: 9, delayMs: 99999 } }), { times: 3, delayMs: 30000 });
    assert.deepEqual(retryPlanOf({ kind: 'ai_generate', retry: { times: 1 } }), { times: 1, delayMs: 1000 });
    assert.deepEqual(retryPlanOf({ kind: 'ai_generate', retry: 2 }), { times: 2, delayMs: 1000 });
    assert.deepEqual(retryPlanOf({ kind: 'send_email', retry: { times: 2 } }), { times: 0, delayMs: 0 });
    assert.deepEqual(retryPlanOf({ kind: 'ai_generate' }), { times: 0, delayMs: 0 });
    assert.deepEqual(clampErrorScope({ message: 'x'.repeat(900), step: 'ai_generate', attempts: 99, stepIndex: 2, extra: 1 }),
        { message: 'x'.repeat(500), step: 'ai_generate', code: null, attempts: 4, stepIndex: 2 });
    assert.equal(clampErrorScope('nope'), null);
});

test('a switch case with whenExpr and no value is picked when its formula is true; a case with a value still compares', async () => {
    const action = { kind: 'sequence', steps: [{ kind: 'switch', expr: 'vars.mode', cases: [
        { value: 'x', steps: [{ kind: 'ai_generate', tag: 'x' }] },
        { whenExpr: 'vars.big', steps: [{ kind: 'ai_generate', tag: 'big' }] },
    ], default: [{ kind: 'ai_generate', tag: 'none' }] }] };
    const run = async (vars) => {
        const h = host();
        await walkAction(newWalkState({ vars }), action, h, { actionId: 'act_1' });
        return h.ends.map((e) => e.path);
    };
    assert.deepEqual(await run({ mode: 'q', big: true }), ['steps[0]', 'steps[0].cases[1].steps[0]']);
    assert.deepEqual(await run({ mode: 'x', big: true }), ['steps[0]', 'steps[0].cases[0].steps[0]'], 'the first case that matches wins');
    assert.deepEqual(await run({ mode: 'q', big: false }), ['steps[0]', 'steps[0].default[0]']);
});
