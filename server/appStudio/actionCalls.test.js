'use strict';

/**
 * The call graph helpers (call_action): targets, closure, cycles, chains, params read.
 * Run: cd server && node --test appStudio/actionCalls.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { callTargets, closeOverCalls, findCallCycles, longestCallChain, someStepThroughCalls, paramNamesRead, ownAction } = require('./actionCalls.mts');

const call = (actionId) => ({ kind: 'call_action', actionId });
const seq = (...steps) => ({ kind: 'sequence', steps });

test('callTargets: every call in every child list, with its walker path; a bare call is action[0]', () => {
    const action = seq(call('act_a'), { kind: 'condition', expr: 'x', then: [call('act_b')], else: [] },
        { kind: 'switch', expr: 'x', cases: [{ value: 1, steps: [call('act_c')] }], default: [] },
        { kind: 'loop', source: {}, steps: [call('act_d')] });
    assert.deepEqual(callTargets(action), [
        { actionId: 'act_a', path: 'steps[0]' },
        { actionId: 'act_b', path: 'steps[1].then[0]' },
        { actionId: 'act_c', path: 'steps[2].cases[0].steps[0]' },
        { actionId: 'act_d', path: 'steps[3].steps[0]' },
    ]);
    assert.deepEqual(callTargets(call('act_x')), [{ actionId: 'act_x', path: 'action[0]' }]);
    assert.deepEqual(callTargets(null), []);
});

test('closeOverCalls: roots plus what they reach; depth-bounded; never a prototype key', () => {
    const actions = { act_r: seq(call('act_a')), act_a: seq(call('act_b')), act_b: seq(call('act_c')), act_c: seq(), act_x: seq() };
    assert.deepEqual([...closeOverCalls(actions, ['act_r'])].sort(), ['act_a', 'act_b', 'act_c', 'act_r']);
    assert.deepEqual([...closeOverCalls(actions, ['act_r'], 1)].sort(), ['act_a', 'act_r']);
    assert.equal(ownAction(actions, '__proto__'), null);
    assert.equal(ownAction(actions, 'toString'), null);
    const cyclic = { act_a: seq(call('act_b')), act_b: seq(call('act_a')) };
    assert.deepEqual([...closeOverCalls(cyclic, ['act_a'])].sort(), ['act_a', 'act_b'], 'a cycle terminates');
});

test('findCallCycles: each cycle once, lowest id first; a self-call', () => {
    const actions = { act_b: seq(call('act_a')), act_a: seq(call('act_b')), act_s: seq(call('act_s')), act_ok: seq() };
    assert.deepEqual(findCallCycles(actions), [['act_a', 'act_b', 'act_a'], ['act_s', 'act_s']]);
    assert.deepEqual(findCallCycles({ act_a: seq(call('act_b')), act_b: seq() }), []);
});

test('longestCallChain: the longest path, edges in a cycle ignored, capped one past the limit', () => {
    const actions = { a: seq(call('b'), call('c')), b: seq(), c: seq(call('d')), d: seq(call('a')) };
    assert.deepEqual(longestCallChain(actions, 'a'), ['a', 'c', 'd']);
    const deep = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`a${i}`, seq(call(`a${i + 1}`))]));
    assert.equal(longestCallChain(deep, 'a0').length - 1, 4, 'stops at MAX_CALL_DEPTH + 1');
});

test('someStepThroughCalls follows calls (seen-set, depth)', () => {
    const actions = { act_m: seq({ kind: 'send_email' }), act_mid: seq(call('act_m')), act_loop: seq(call('act_loop')) };
    const isMail = (s) => s.kind === 'send_email';
    assert.equal(someStepThroughCalls([call('act_mid')], actions, isMail), true);
    assert.equal(someStepThroughCalls([call('act_mid')], actions, isMail, 1), false, 'depth 1 does not reach act_m');
    assert.equal(someStepThroughCalls([call('act_loop')], actions, isMail), false, 'a cycle terminates');
    assert.equal(someStepThroughCalls([call('act_gone')], actions, isMail), false);
});

test('paramNamesRead: the params.<name> an action reads', () => {
    const a = seq({ kind: 'set_variable', name: 'x', value: { kind: 'formula', expr: 'params.size + params . kind' } }, { kind: 'toast', message: '{{params.name}}' });
    assert.deepEqual([...paramNamesRead(a)].sort(), ['kind', 'name', 'size']);
    assert.equal(paramNamesRead(null).size, 0);
});
