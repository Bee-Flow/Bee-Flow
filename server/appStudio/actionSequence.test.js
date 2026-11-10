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
    // A field rule's sentences ride along, bounded; anything else in the map is dropped.
    assert.deepEqual(stepFailureExtras({ ok: false, retryable: false, fieldErrors: { qty: 'Too low.', bad: 5, ['x'.repeat(65)]: 'long key' } }), { retryable: false, fieldErrors: { qty: 'Too low.' } });
    assert.deepEqual(stepFailureExtras({ ok: false, fieldErrors: [] }), {});
    assert.equal(sanitizeErrorScope(undefined), undefined);
    assert.deepEqual(sanitizeErrorScope({ message: 'm', step: 'ai_generate', attempts: 2 }), { message: 'm', step: 'ai_generate', code: null, attempts: 2 });
});
