'use strict';

/**
 * resolveRequestedStep: the one step lookup of the /step routes, with callPath.
 * Run: cd server && node --test appStudio/actionSequence.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveRequestedStep, flattenSteps, normalizeSequence, stepNotes } = require('./actionSequence');

const DEF = { actions: {
    act_root: { kind: 'sequence', steps: [
        { kind: 'toast', message: 'x' },
        { kind: 'call_action', actionId: 'act_sub' },
        { kind: 'create_record', tableId: 'tbl_a' },
    ] },
    act_sub: { kind: 'sequence', steps: [{ kind: 'toast', message: 'y' }, { kind: 'call_action', actionId: 'act_leaf' }] },
    act_leaf: { kind: 'create_record', tableId: 'tbl_b' },
    act_self: { kind: 'sequence', steps: [{ kind: 'call_action', actionId: 'act_self' }] },
} };

test('without callPath it is the old lookup', () => {
    const flat = flattenSteps(normalizeSequence(DEF.actions.act_root));
    for (let i = 0; i < flat.length; i++) {
        assert.deepEqual(resolveRequestedStep(DEF, 'act_root', i), { step: flat[i], ownerActionId: 'act_root' });
        assert.deepEqual(resolveRequestedStep(DEF, 'act_root', String(i)), { step: flat[i], ownerActionId: 'act_root' }, 'a numeric string as before');
    }
    assert.deepEqual(resolveRequestedStep(DEF, 'act_root', 3), { error: 'step' });
    assert.deepEqual(resolveRequestedStep(DEF, 'act_root', -1), { error: 'step' });
    assert.deepEqual(resolveRequestedStep(DEF, 'act_gone', 0), { error: 'action' });
    assert.deepEqual(resolveRequestedStep(DEF, '__proto__', 0), { error: 'action' });
    assert.deepEqual(resolveRequestedStep(null, 'act_root', 0), { error: 'action' });
});

test('with callPath it resolves inside the called action and names its owner', () => {
    assert.deepEqual(resolveRequestedStep(DEF, 'act_root', 0, [1]), { step: DEF.actions.act_sub.steps[0], ownerActionId: 'act_sub' });
    assert.deepEqual(resolveRequestedStep(DEF, 'act_root', 0, [1, 1]), { step: DEF.actions.act_leaf, ownerActionId: 'act_leaf' });
    assert.deepEqual(resolveRequestedStep(DEF, 'act_root', 2, []), { step: DEF.actions.act_root.steps[2], ownerActionId: 'act_root' });
});

test('a hop that is not a call, a cycle, a bad entry or more than 3 hops is "call"; out of range in the callee is "step"', () => {
    assert.deepEqual(resolveRequestedStep(DEF, 'act_root', 0, [0]), { error: 'call' }, 'a toast is not a call');
    assert.deepEqual(resolveRequestedStep(DEF, 'act_root', 0, [9]), { error: 'call' });
    assert.deepEqual(resolveRequestedStep(DEF, 'act_root', 0, ['1']), { error: 'call' });
    assert.deepEqual(resolveRequestedStep(DEF, 'act_self', 0, [0]), { error: 'call' }, 'a call back into an action on the path');
    assert.deepEqual(resolveRequestedStep(DEF, 'act_root', 0, [1, 1, 0, 0]), { error: 'call' });
    assert.deepEqual(resolveRequestedStep(DEF, 'act_root', 5, [1]), { error: 'step' });
});

test('stepNotes: a notes sibling only when there are any', () => {
    assert.deepEqual(stepNotes({ ok: true }), {});
    assert.deepEqual(stepNotes({ notes: [] }), {});
    assert.deepEqual(stepNotes({ notes: ['a', 3] }), { notes: ['a'] });
});

// ── Error handlers and transactions (package 2) ─────────────────────────────

test('flattenSteps: without onError the order is unchanged; handlers follow the whole tree, nested after their owners', () => {
    const { flattenSteps } = require('./actionSequence');
    const plain = [{ kind: 'a' }, { kind: 'condition', then: [{ kind: 'b' }], else: [{ kind: 'c' }] }, { kind: 'loop', steps: [{ kind: 'd' }] }];
    assert.deepEqual(flattenSteps(plain).map((s) => s.kind), ['a', 'condition', 'b', 'c', 'loop', 'd']);
    const h2 = { kind: 'h2' };
    const tree = [
        { kind: 'a', onError: { steps: [{ kind: 'h1', onError: { steps: [h2] } }] } },
        { kind: 'condition', then: [{ kind: 'b', onError: [{ kind: 'legacy' }] }] },
        { kind: 'transaction', steps: [{ kind: 'create_record' }, { kind: 'update_record' }] },
        { kind: 'c' },
    ];
    assert.deepEqual(flattenSteps(tree).map((s) => s.kind), ['a', 'condition', 'b', 'transaction', 'c', 'h1', 'legacy', 'h2'],
        'main tree first (old ordinals unchanged), then handlers in owner order, a nested handler after its owner\'s; transaction children unnumbered');
});

test('resolveRequestedStep reaches a handler step by its ordinal', () => {
    const { resolveRequestedStep } = require('./actionSequence');
    const fallback = { kind: 'create_record', tableId: 't' };
    const def = { actions: { act_x: { kind: 'sequence', steps: [{ kind: 'ai_generate', onError: { steps: [fallback] } }, { kind: 'toast' }] } } };
    assert.deepEqual(resolveRequestedStep(def, 'act_x', 2), { step: fallback, ownerActionId: 'act_x' });
});

test('stepFailureExtras and sanitizeErrorScope', () => {
    const { stepFailureExtras, sanitizeErrorScope } = require('./actionSequence');
    assert.deepEqual(stepFailureExtras({ ok: false, retryable: false, ref: 'abcd1234' }), { retryable: false, ref: 'abcd1234' });
    assert.deepEqual(stepFailureExtras({ ok: false, ref: 'not a ref' }), {});
    assert.deepEqual(stepFailureExtras(null), {});
    assert.equal(sanitizeErrorScope(undefined), undefined);
    assert.deepEqual(sanitizeErrorScope({ message: 'm', step: 'ai_generate', attempts: 2 }), { message: 'm', step: 'ai_generate', code: null, attempts: 2 });
});

// ── The kind echo: a client that numbers or walks the steps differently is told so ──

const V3 = { actions: {
    act_plain: { kind: 'sequence', steps: [{ kind: 'toast', message: 'x' }, { kind: 'create_record', tableId: 'tbl_a' }] },
    act_loop: { kind: 'sequence', steps: [
        { kind: 'while', expr: 'vars.go', steps: [{ kind: 'create_record', tableId: 'tbl_a' }] },
        { kind: 'try', steps: [{ kind: 'update_record', tableId: 'tbl_a' }], catch: [{ kind: 'toast', message: 'x' }], finally: [{ kind: 'delete_record', tableId: 'tbl_a' }] },
        { kind: 'call_action', actionId: 'act_plain' },
    ] },
    act_exit: { kind: 'sequence', steps: [{ kind: 'condition', expr: 'vars.done', then: [{ kind: 'return' }], else: [] }, { kind: 'create_record', tableId: 'tbl_b' }] },
    act_caller: { kind: 'sequence', steps: [{ kind: 'call_action', actionId: 'act_exit' }, { kind: 'create_record', tableId: 'tbl_c' }] },
} };

test('an action of base kinds resolves with or without a sent kind, and a wrong one is a mismatch', () => {
    const step = V3.actions.act_plain.steps[1];
    assert.deepEqual(resolveRequestedStep(V3, 'act_plain', 1), { step, ownerActionId: 'act_plain' });
    assert.deepEqual(resolveRequestedStep(V3, 'act_plain', 1, undefined, 'create_record'), { step, ownerActionId: 'act_plain' });
    assert.deepEqual(resolveRequestedStep(V3, 'act_plain', 1, undefined, 'toast'), { error: 'mismatch' });
    for (const empty of [undefined, null, '', 7, {}]) assert.deepEqual(resolveRequestedStep(V3, 'act_plain', 1, undefined, empty), { step, ownerActionId: 'act_plain' }, 'not a kind: as if none was sent');
});

test('an action with a registry kind must be sent the kind of the step', () => {
    const flat = flattenSteps(normalizeSequence(V3.actions.act_loop));
    assert.deepEqual(flat.map((s) => s.kind), ['while', 'create_record', 'try', 'update_record', 'toast', 'delete_record', 'call_action']);
    for (const i of [1, 3, 5]) {
        assert.deepEqual(resolveRequestedStep(V3, 'act_loop', i), { error: 'mismatch' }, 'a client that sends no kind does not know the containers');
        assert.deepEqual(resolveRequestedStep(V3, 'act_loop', i, undefined, flat[i].kind), { step: flat[i], ownerActionId: 'act_loop' });
    }
    // The ordinal a client without the while would post for the first write of the try.
    assert.deepEqual(resolveRequestedStep(V3, 'act_loop', 2, undefined, 'update_record'), { error: 'mismatch' });
    // A leaf kind is enough: a client that does not know `return` would walk on past it.
    assert.deepEqual(resolveRequestedStep(V3, 'act_exit', 2), { error: 'mismatch' });
    assert.deepEqual(resolveRequestedStep(V3, 'act_exit', 2, undefined, 'create_record'), { step: V3.actions.act_exit.steps[1], ownerActionId: 'act_exit' });
});

test('the rule follows the callPath: a registry kind anywhere on the way asks for the kind', () => {
    const inner = V3.actions.act_plain.steps[1];
    assert.deepEqual(resolveRequestedStep(V3, 'act_loop', 1, [6]), { error: 'mismatch' }, 'the root holds a while');
    assert.deepEqual(resolveRequestedStep(V3, 'act_loop', 1, [6], 'create_record'), { step: inner, ownerActionId: 'act_plain' });
    assert.deepEqual(resolveRequestedStep(V3, 'act_caller', 2, [0]), { error: 'mismatch' }, 'the called action holds a return');
    assert.deepEqual(resolveRequestedStep(V3, 'act_caller', 1), { step: V3.actions.act_caller.steps[1], ownerActionId: 'act_caller' }, 'the caller itself is base only');
});

test('a missing action or step is still reported as such, before the kind', () => {
    assert.deepEqual(resolveRequestedStep(V3, 'act_nope', 0, undefined, 'toast'), { error: 'action' });
    assert.deepEqual(resolveRequestedStep(V3, 'act_loop', 99, undefined, 'toast'), { error: 'step' });
});
