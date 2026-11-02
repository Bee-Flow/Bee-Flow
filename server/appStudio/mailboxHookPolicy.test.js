'use strict';

/** Run: cd server && node --test appStudio/mailboxHookPolicy.test.js */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const policy = require('./mailboxHookPolicy.mts');
const { DATA_MUTATING_STEP_KINDS } = require('./componentSpecs');

test('every step kind a hook may run is a server step, and nothing that reaches people is among them', () => {
    for (const kind of policy.HOOK_STEP_KINDS) assert.ok(DATA_MUTATING_STEP_KINDS.includes(kind), kind);
    for (const kind of ['send_email', 'run_automation', 'request_approval', 'delete_record', 'ai_browse']) {
        assert.ok(!policy.HOOK_STEP_KINDS.includes(kind), kind);
    }
});

const seq = (...steps) => ({ kind: 'sequence', steps });

test('an action of allowed steps, with a condition around them, has no problems', () => {
    const action = seq(
        { kind: 'ai_generate', resultVar: 'summary' },
        { kind: 'condition', expr: 'true', then: [{ kind: 'update_record' }], else: [{ kind: 'create_record' }] },
    );
    assert.deepEqual(policy.hookActionProblems(action, 'act_a'), []);
});

test('send_email is refused wherever it sits, with a sentence of its own', () => {
    const action = seq({ kind: 'condition', expr: 'true', then: [{ kind: 'switch', expr: 'x', cases: [{ value: 1, steps: [{ kind: 'send_email' }] }] }] });
    const problems = policy.hookActionProblems(action, 'act_a');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /send_email/);
    assert.match(problems[0], /on its own/);
});

test('client steps, loops and a bare run_automation action are refused by name', () => {
    assert.match(policy.hookActionProblems(seq({ kind: 'toast' }))[0], /"toast"/);
    assert.match(policy.hookActionProblems(seq({ kind: 'loop', steps: [] }))[0], /"loop"/);
    assert.match(policy.hookActionProblems({ kind: 'run_automation', automationId: 'a' })[0], /"run_automation"/);
});

test('a missing, empty or oversized action is a problem', () => {
    assert.match(policy.hookActionProblems(null, 'act_x')[0], /does not exist/);
    assert.match(policy.hookActionProblems(seq())[0], /no steps/);
    const big = seq(...Array.from({ length: policy.HOOK_MAX_STEPS + 1 }, () => ({ kind: 'update_record' })));
    assert.match(policy.hookActionProblems(big)[0], /at most/);
});

test('onNewRecord shape: absent is fine, thread needs threads, unknown keys are refused', () => {
    assert.deepEqual(policy.onNewRecordErrors(undefined, {}, 'c'), []);
    assert.deepEqual(policy.onNewRecordErrors({ actionId: 'act_a', target: 'inbound_message' }, {}, 'c'), []);
    assert.deepEqual(policy.onNewRecordErrors({ actionId: 'act_a', target: 'thread' }, { groupIntoThreads: true }, 'c'), []);
    assert.match(policy.onNewRecordErrors({ actionId: 'act_a', target: 'thread' }, {}, 'c')[0], /needs groupIntoThreads/);
    assert.match(policy.onNewRecordErrors({ actionId: '', target: 'x' }, {}, 'c').join(' '), /actionId[\s\S]*target/);
    assert.match(policy.onNewRecordErrors({ actionId: 'act_a', target: 'thread', extra: 1 }, { groupIntoThreads: true }, 'c')[0], /extra/);
    assert.match(policy.onNewRecordErrors('act_a', {}, 'c')[0], /must be \{ actionId, target \}/);
});

test('readOnNewRecord returns the setting or null', () => {
    assert.deepEqual(policy.readOnNewRecord({ actionId: 'act_a', target: 'thread' }), { actionId: 'act_a', target: 'thread' });
    assert.equal(policy.readOnNewRecord({ actionId: 'act_a', target: 'nope' }), null);
    assert.equal(policy.readOnNewRecord(null), null);
});

test('limits: generous defaults, 0 = unlimited, junk falls back', () => {
    assert.deepEqual(policy.hookLimits({}), { perSync: 50, perMinute: 60 });
    assert.deepEqual(policy.hookLimits({ STUDIO_MAILBOX_HOOK_MAX_PER_SYNC: '0', STUDIO_MAILBOX_HOOK_MAX_PER_MINUTE: '5' }), { perSync: 0, perMinute: 5 });
    assert.deepEqual(policy.hookLimits({ STUDIO_MAILBOX_HOOK_MAX_PER_SYNC: 'many', STUDIO_MAILBOX_HOOK_MAX_PER_MINUTE: '-1' }), { perSync: 50, perMinute: 60 });
});
