/**
 * Where a step that makes a run wait may be (validate/durableStepChecks.mts): a long wait or an
 * await_approval needs a run on the server, a long wait cannot sit in a parallel branch, a wait
 * gives exactly one of seconds and until. The short browser wait stays valid everywhere.
 *
 * Run: cd server && node --test appStudio/validate/durableStepChecks.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateAppDefinition } = require('../validate');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { stepPolicy } = require('../componentSpecs/stepRegistry');

const ASK = { kind: 'await_approval', prompt: { kind: 'static', value: 'OK?' }, resultVar: 'ok' };
const wait = (more) => ({ kind: 'wait', ...more });

/** The error codes of a definition whose clicked action is `act_go0001` (and `others`), as `code @ path`. */
function errorsOf(action, others = {}) {
    const definition = {
        schemaVersion: 3, meta: { name: 'Waits' }, homeScreenId: 'scr_wait01', roles: [],
        screens: [{ id: 'scr_wait01', name: 'Home', sections: [{ id: 'sec_wait01', children: [{ id: 'cmp_wait01', type: 'button', props: { label: 'Go' }, onClick: 'act_go0001' }] }] }],
        actions: { act_go0001: action, ...others },
    };
    const { def } = canonicalizeAppDefinition(definition);
    return validateAppDefinition(def, {}).errors.filter((e) => e.path.startsWith('actions.')).map((e) => `${e.code} @ ${e.path}`);
}

const seq = (steps, more = {}) => ({ kind: 'sequence', steps, ...more });

test('a short wait is valid in a click; a long one or one until a moment needs a server run', () => {
    assert.deepEqual(errorsOf(seq([wait({ seconds: 30 })])), []);
    assert.deepEqual(errorsOf(seq([wait({ seconds: 31 })])), ['action.wait_needs_server_run @ actions.act_go0001.steps[0]']);
    assert.deepEqual(errorsOf(seq([wait({ until: { kind: 'formula', expr: 'vars.at' } })])), ['action.wait_needs_server_run @ actions.act_go0001.steps[0]']);
    assert.deepEqual(errorsOf(seq([wait({ seconds: 86_400 })], { runOn: 'server' })), []);
    assert.deepEqual(errorsOf(seq([wait({ seconds: 86_400 })], { background: true })), []);
    assert.deepEqual(errorsOf(seq([wait({ seconds: 2_592_001 })], { runOn: 'server' })), ['action.step_field_invalid @ actions.act_go0001.steps[0].seconds']);
});

test('a wait gives exactly one of seconds and until', () => {
    assert.deepEqual(errorsOf(seq([wait({})], { runOn: 'server' })), ['action.wait_without_duration @ actions.act_go0001.steps[0]']);
    assert.deepEqual(errorsOf(seq([wait({ seconds: 5, until: { kind: 'static', value: '2026-12-01T09:00:00Z' } })], { runOn: 'server' })), ['action.wait_two_durations @ actions.act_go0001.steps[0]']);
});

test('await_approval needs a server run: its own, or that of the action calling it', () => {
    assert.deepEqual(errorsOf(seq([ASK])), ['action.await_approval_needs_server_run @ actions.act_go0001.steps[0]']);
    assert.deepEqual(errorsOf(seq([ASK], { runOn: 'server' })), []);
    const called = seq([ASK, wait({ seconds: 3600 })]);
    assert.deepEqual(errorsOf(seq([{ kind: 'call_action', actionId: 'act_sub001' }], { runOn: 'server' }), { act_sub001: called }), []);
    assert.deepEqual(errorsOf(seq([{ kind: 'call_action', actionId: 'act_sub001' }]), { act_sub001: called }), [
        'action.await_approval_needs_server_run @ actions.act_sub001.steps[0]',
        'action.wait_needs_server_run @ actions.act_sub001.steps[1]',
    ]);
});

test('inside a parallel branch only the short wait fits', () => {
    const branches = (step) => seq([{ kind: 'parallel', branches: [{ steps: [step] }, { steps: [] }] }], { runOn: 'server' });
    assert.deepEqual(errorsOf(branches(wait({ seconds: 3 }))), []);
    assert.deepEqual(errorsOf(branches(wait({ seconds: 300 }))), ['action.wait_in_parallel @ actions.act_go0001.steps[0].branches[0].steps[0]']);
    assert.deepEqual(errorsOf(branches(ASK)), ['action.step_in_parallel @ actions.act_go0001.steps[0].branches[0].steps'], 'the parallel check refuses an approval in a branch');
});

test('the policy: a click, a public page and a mailbox hook never ask for an approval; a test run mocks it', () => {
    assert.equal(stepPolicy('await_approval', 'click'), 'refuse');
    assert.equal(stepPolicy('await_approval', 'public'), 'refuse');
    assert.equal(stepPolicy('await_approval', 'mailboxHook'), 'refuse');
    assert.equal(stepPolicy('await_approval', 'background'), 'run');
    assert.equal(stepPolicy('await_approval', 'mcpRun'), 'refuse');
    assert.equal(stepPolicy('await_approval', 'mcpDryRun'), 'mock');
    assert.equal(stepPolicy('wait', 'background'), 'run');
    assert.equal(stepPolicy('wait', 'click'), 'browser');
});

test('a short wait keeps its bytes; the new fields are written only when present', () => {
    const { def } = canonicalizeAppDefinition({ schemaVersion: 3, actions: { act_w00001: seq([wait({ seconds: 2 })]) } });
    assert.deepEqual(def.actions.act_w00001.steps[0], { kind: 'wait', seconds: 2 });
    const asked = canonicalizeAppDefinition({ schemaVersion: 3, actions: { act_w00001: seq([{ ...ASK, timeoutHours: 4 }], { runOn: 'server' }) } }).def.actions.act_w00001.steps[0];
    assert.equal(asked.timeoutHours, 4);
    assert.equal(asked.expiresInHours, undefined);
    assert.equal(asked.resultVar, 'ok');
});
