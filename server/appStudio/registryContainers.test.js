'use strict';

/**
 * Every reader of an action's step tree sees the child lists a container of the step
 * registry adds (a try's `catch` and `finally`, a while's `steps`): a step put there is
 * found, counted, renamed and redacted like a step in a condition branch.
 *
 * Run: cd server && node --test appStudio/registryContainers.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const stepFlow = require('../shared/appDefinition/stepFlow.mjs');
const { automationsInAction } = require('./automationRefs');
const { collectVariableWrites } = require('./collectVariableRefs');
const { documentPool } = require('./appDocuments/pool.mts');
const { countSteps } = require('./actionStepCounts');
const { hookAllSteps } = require('./mailboxHookPolicy.mts');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { summariseSteps } = require('./builderPrompt/summariseSteps.mts');
const { flattenSteps } = require('./actionSequence');

const inCatch = (step) => ({ kind: 'try', steps: [{ kind: 'toast', message: 'x' }], catch: [step] });
const inFinally = (step) => ({ kind: 'try', steps: [], finally: [{ kind: 'while', expr: 'false', steps: [step] }] });
const seq = (...steps) => ({ kind: 'sequence', steps });

test('extraChildSlots names what a by-name reader misses, and nothing for a base kind', () => {
    const step = { kind: 'try', steps: [{ kind: 'toast' }], catch: [{ kind: 'refresh' }], finally: [] };
    assert.deepEqual(stepFlow.extraChildSlots(step), [{ field: 'catch', steps: step.catch }, { field: 'finally', steps: step.finally }]);
    assert.deepEqual(stepFlow.extraChildLists({ kind: 'try', steps: [] }), [], 'an absent slot is not a list');
    assert.deepEqual(stepFlow.extraChildLists({ kind: 'while', expr: 'x', steps: [{ kind: 'toast' }] }), [], 'a while body is `steps`, which every reader walks');
    for (const base of [{ kind: 'condition', then: [{}], else: [{}] }, { kind: 'switch', cases: [{ steps: [{}] }], default: [{}] }, { kind: 'loop', steps: [{}] }, { kind: 'toast', catch: [{}] }, null, 'x']) {
        assert.deepEqual(stepFlow.extraChildLists(base), []);
    }
});

test('an automation run from a catch or a finally is a reference of the app', () => {
    const run = (id) => ({ kind: 'run_automation', automationId: id });
    assert.deepEqual(automationsInAction(seq(inCatch(run('auto_catch')), inFinally(run('auto_finally')))).ids.sort(), ['auto_catch', 'auto_finally']);
});

test('a variable written in a catch or a finally is a write', () => {
    const def = { actions: { act_a: seq(inCatch({ kind: 'set_variable', name: 'why', value: { kind: 'static', value: 1 } }), inFinally({ kind: 'ai_generate', resultVar: 'draft' })) } };
    const { names } = collectVariableWrites(def);
    assert.ok(names.has('why') && names.has('draft'), [...names].join(', '));
});

test('a document copied from a catch is in the app\'s document pool', () => {
    const def = { screens: [], actions: { act_a: seq(inCatch({ kind: 'copy_document', source: { kind: 'static', value: 'doc_template1' } })) } };
    const pool = documentPool(def, { actionAllowed: () => true, screenAllowed: () => true, nodeAllowed: () => true });
    assert.ok(pool.ids.has('doc_template1'));
});

test('steps in catch and finally are counted, numbered, summarised and seen by the mailbox hook policy', () => {
    const steps = [inCatch({ kind: 'send_email' }), inFinally({ kind: 'toast' })];
    assert.equal(countSteps(steps), 3 + 3);
    assert.deepEqual(flattenSteps(steps).map((s) => s.kind), ['try', 'toast', 'send_email', 'try', 'while', 'toast']);
    assert.deepEqual(hookAllSteps(seq(...steps)).map((s) => s.kind), ['try', 'toast', 'send_email', 'try', 'while', 'toast']);
    assert.equal(summariseSteps(steps), 'steps[2]{try{…}!catch → try{…}+finally}');
});

test('a renamed screen id is rewritten in a navigate inside a catch', () => {
    const def = {
        schemaVersion: 2, meta: { name: 'T' }, homeScreenId: 'Home Screen',
        screens: [{ id: 'Home Screen', name: 'Home', sections: [{ id: 'sec_main01', children: [] }] }],
        actions: { act_main01: seq(inCatch({ kind: 'navigate', screenId: 'Home Screen' }), { kind: 'condition', expr: 'true', then: [{ kind: 'navigate', screenId: 'Home Screen' }], else: [] }) },
    };
    const out = canonicalizeAppDefinition(def).def;
    const id = out.screens[0].id;
    assert.notEqual(id, 'Home Screen', 'the invalid id was replaced');
    assert.equal(out.actions.act_main01.steps[1].then[0].screenId, id, 'as before, in a condition branch');
    assert.equal(out.actions.act_main01.steps[0].catch[0].screenId, id, 'and in a catch');
});
