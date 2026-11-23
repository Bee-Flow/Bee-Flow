// @typecheck
/**
 * A plan as a person reads it (./planView.mts): steps in order with their kind, their effect and their outside-text
 * mark, and the count behind "5 fixed, 2 AI, 1 waits for you".
 *
 * Run: cd server && node --test core/cowork/plan/planView.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { planViewOf } = require('./planView.mts');
const { fakeLookups, planOf, supplierRadar, literal, ref } = require('./plan.testkit');

const lookups = fakeLookups();

test('the running example reads as seven steps: four fixed, two AI, one result', () => {
    const view = planViewOf(supplierRadar(), lookups);
    assert.strictEqual(view.trigger, 'schedule');
    assert.deepStrictEqual(view.steps.map((s) => [s.id, s.kind]), [
        ['mail', 'fixed'], ['orders', 'ai'], ['overdue', 'fixed'], ['table', 'fixed'], ['reply', 'ai'], ['draft', 'fixed'], ['digest', 'deliver'],
    ]);
    assert.deepStrictEqual(view.makeUp, { fixed: 4, ai: 2, ask: 0, deliver: 1 });
});

test('each step says what it does to the world, and which app it does it in', () => {
    const byId = Object.fromEntries(planViewOf(supplierRadar(), lookups).steps.map((s) => [s.id, s]));
    assert.deepStrictEqual([byId.mail.effect, byId.mail.app, byId.mail.tool], ['reads', 'outlook', 'outlook_search']);
    assert.deepStrictEqual([byId.draft.effect, byId.draft.app], ['writes', 'outlook']);
    assert.deepStrictEqual([byId.table.effect, byId.table.app], ['writes', null], 'a table step is no app action');
    assert.strictEqual(byId.digest.effect, 'sends');
    assert.strictEqual(byId.orders.effect, 'reads', 'an AI step without tools changes nothing');
});

test('an AI step that reads outside text is marked; the mark is for AI steps only', () => {
    const view = planViewOf(supplierRadar(), lookups);
    assert.deepStrictEqual(view.steps.filter((s) => s.readsOutsideText).map((s) => s.id), ['orders', 'reply']);
});

test('an AI step on the plan\'s own data is not marked', () => {
    const plan = planOf([
        { id: 'docs', type: 'integration_action', tool: 'drive_search', inputs: { query: literal('minutes') } },
        { id: 'sum', type: 'ai_step', prompt: 'Summarise {{steps.docs.output.files}}' },
    ]);
    assert.deepStrictEqual(planViewOf(plan, lookups).steps.map((s) => s.readsOutsideText), [false, false]);
});

test('a step is called by its label, else by its tool or type in plain words', () => {
    const plan = planOf([
        { id: 'a', type: 'integration_action', label: '  Get the mail  ', tool: 'outlook_search' },
        { id: 'b', type: 'integration_action', tool: 'outlook_create_draft' },
        { id: 'c', type: 'data_extraction', label: '' },
    ]);
    assert.deepStrictEqual(planViewOf(plan, lookups).steps.map((s) => s.title), ['Get the mail', 'Outlook create draft', 'Data extraction']);
});

test('the steps inside a loop follow it, one level deeper', () => {
    const plan = planOf([
        { id: 'each', type: 'loop', items: literal([1, 2]), body: [{ id: 'one', type: 'ai_step', prompt: 'x' }, { id: 'two', type: 'set', values: {} }] },
        { id: 'after', type: 'notification', title: 'Done', body: 'Done.' },
    ]);
    assert.deepStrictEqual(planViewOf(plan, lookups).steps.map((s) => [s.id, s.depth]), [['each', 0], ['one', 1], ['two', 1], ['after', 0]]);
});

test('a canvas note is no step: it is neither shown nor counted', () => {
    const plan = planOf([{ id: 'n', type: 'note', text: 'remember' }, { id: 'a', type: 'approval', prompt: 'OK?' }]);
    const view = planViewOf(plan, lookups);
    assert.deepStrictEqual(view.steps.map((s) => s.id), ['a']);
    assert.deepStrictEqual(view.makeUp, { fixed: 0, ai: 0, ask: 1, deliver: 0 });
});

test('a step a plan may not hold is still shown, so the refusal has something to point at', () => {
    const view = planViewOf(planOf([{ id: 'c', type: 'code', label: 'Calculate' }]), lookups);
    assert.deepStrictEqual(view.steps.map((s) => [s.id, s.type, s.kind, s.title]), [['c', 'code', 'fixed', 'Calculate']]);
});

test('a built-in tool no app owns has no app', () => {
    const view = planViewOf(planOf([{ id: 'r', type: 'integration_action', tool: 'set_reminder', inputs: { at: ref('trigger.output.time') } }]), lookups);
    assert.deepStrictEqual([view.steps[0].app, view.steps[0].effect], [null, 'writes']);
});

test('nothing to read gives an empty view, not an error', () => {
    for (const plan of [null, undefined, {}, { steps: 'no' }]) {
        assert.deepStrictEqual(planViewOf(plan, lookups), { trigger: null, steps: [], makeUp: { fixed: 0, ai: 0, ask: 0, deliver: 0 } });
    }
});
