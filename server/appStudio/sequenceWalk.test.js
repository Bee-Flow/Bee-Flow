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
