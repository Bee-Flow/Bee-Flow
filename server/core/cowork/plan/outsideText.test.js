// @typecheck
/**
 * Outside text (./outsideText.mts): which steps bring text a stranger wrote into a run, and which steps carry it on.
 *
 * Run: cd server && node --test core/cowork/plan/outsideText.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { outsideTextOf, bringsOutsideText, triggerBringsOutsideText } = require('./outsideText.mts');
const { fakeLookups, planOf, supplierRadar, ref, literal, template } = require('./plan.testkit');

const lookups = fakeLookups();
const sorted = (set) => [...set].sort();

test('a read of a mailbox and a read on the open web bring outside text in; a read of the owner\'s own data does not', () => {
    const brings = (tool) => bringsOutsideText({ type: 'integration_action', tool }, lookups);
    assert.strictEqual(brings('outlook_read'), true);
    assert.strictEqual(brings('gmail_read'), true);
    assert.strictEqual(brings('read_url'), true);
    assert.strictEqual(brings('agent_search'), true);
    assert.strictEqual(brings('drive_search'), false);
    assert.strictEqual(brings('contacts_search'), false);
});

test('a write to a mail app brings nothing in, and neither does a step that is no app action', () => {
    assert.strictEqual(bringsOutsideText({ type: 'integration_action', tool: 'outlook_create_draft' }, lookups), false);
    assert.strictEqual(bringsOutsideText({ type: 'ai_step', tool: 'outlook_read' }, lookups), false);
    assert.strictEqual(bringsOutsideText({ type: 'integration_action' }, lookups), false);
});

test('a trigger an outside party fires brings outside text: a new mail, a webhook; the clock and a person do not', () => {
    const of = (trigger) => triggerBringsOutsideText({ trigger, steps: [] });
    assert.strictEqual(of({ kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new' } }), true);
    assert.strictEqual(of({ kind: 'app_event', appEvent: { provider: 'msgraph', event: 'mail.new' } }), true);
    assert.strictEqual(of({ kind: 'webhook' }), true);
    assert.strictEqual(of({ kind: 'app_event', appEvent: { provider: 'approvals', event: 'approval.decided' } }), false);
    assert.strictEqual(of({ kind: 'schedule' }), false);
    assert.strictEqual(of({ kind: 'manual' }), false);
    assert.strictEqual(triggerBringsOutsideText(null), false);
});

test('in the running example the mail step brings it in and everything that reads it carries it on', () => {
    const outside = outsideTextOf(supplierRadar(), lookups);
    assert.deepStrictEqual(sorted(outside.carries), ['digest', 'draft', 'mail', 'orders', 'overdue', 'reply', 'table']);
    assert.deepStrictEqual(sorted(outside.reads), ['digest', 'draft', 'orders', 'overdue', 'reply', 'table'], 'the mail step itself reads none: it is where it enters');
});

test('a value a model extracted from a mail is still the mail\'s: the mark crosses an AI step', () => {
    const plan = planOf([
        { id: 'mail', type: 'integration_action', tool: 'outlook_read', inputs: { id: literal('m1') } },
        { id: 'pick', type: 'data_extraction', source: ref('steps.mail.output.body'), fields: [{ name: 'amount' }] },
        { id: 'sum', type: 'set', values: { total: ref('steps.pick.output.amount') } },
    ]);
    assert.deepStrictEqual(sorted(outsideTextOf(plan, lookups).carries), ['mail', 'pick', 'sum']);
});

test('a step that reads only the owner\'s own data carries nothing, even next to steps that do', () => {
    const plan = planOf([
        { id: 'mail', type: 'integration_action', tool: 'outlook_read', inputs: { id: literal('m1') } },
        { id: 'contacts', type: 'integration_action', tool: 'contacts_search', inputs: { query: literal('group:Suppliers') } },
        { id: 'names', type: 'set', values: { who: ref('steps.contacts.output.items') } },
    ]);
    const outside = outsideTextOf(plan, lookups);
    assert.deepStrictEqual(sorted(outside.carries), ['mail']);
    assert.deepStrictEqual(sorted(outside.reads), []);
});

test('the mark follows a reference wherever it is written: a template, an expression, a nested field', () => {
    const plan = planOf([
        { id: 'page', type: 'integration_action', tool: 'read_url', inputs: { url: literal('https://example.com') } },
        { id: 'a', type: 'ai_step', prompt: 'Summarise: {{steps.page.output.text}}' },
        { id: 'b', type: 'condition', expr: 'steps.a.output.text != ""' },
        { id: 'c', type: 'set', values: { deep: { nested: [template('x {{ steps.b.output.result }} y')] } } },
    ]);
    assert.deepStrictEqual(sorted(outsideTextOf(plan, lookups).carries), ['a', 'b', 'c', 'page']);
});

test('the item of a loop carries what the loop iterates over', () => {
    const plan = planOf([
        { id: 'mail', type: 'integration_action', tool: 'outlook_search', inputs: { query: literal('is:unread') } },
        {
            id: 'each', type: 'loop', items: ref('steps.mail.output.messages'),
            body: [{ id: 'one', type: 'ai_step', prompt: 'Answer {{loop.item.subject}}' }],
        },
        {
            id: 'own', type: 'loop', items: literal(['a', 'b']),
            body: [{ id: 'clean', type: 'ai_step', prompt: 'Describe {{loop.item}}' }],
        },
    ]);
    const outside = outsideTextOf(plan, lookups);
    assert.ok(outside.reads.has('one'), 'the body reads the mail through the loop item');
    assert.ok(!outside.reads.has('clean'), 'a loop over the plan\'s own list carries nothing');
});

test('the output of an outside trigger is outside text for every step that reads it', () => {
    const trigger = { id: 'trg', type: 'trigger', kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new' } };
    const plan = planOf([
        { id: 'a', type: 'ai_step', prompt: 'Reply to {{trigger.output.body}}' },
        { id: 'b', type: 'set', values: { fixed: literal('x') } },
    ], trigger);
    const outside = outsideTextOf(plan, lookups);
    assert.deepStrictEqual(sorted(outside.reads), ['a']);
    assert.deepStrictEqual(sorted(outsideTextOf(planOf(plan.steps), lookups).reads), [], 'on a schedule the trigger output is the plan\'s own');
});

test('a reference that points ahead is followed too: the answer does not depend on the order of the steps', () => {
    const plan = planOf([
        { id: 'late', type: 'set', values: { x: ref('steps.mail.output.body') } },
        { id: 'later', type: 'set', values: { y: ref('steps.late.output.x') } },
        { id: 'mail', type: 'integration_action', tool: 'outlook_read', inputs: { id: literal('m1') } },
    ]);
    assert.deepStrictEqual(sorted(outsideTextOf(plan, lookups).carries), ['late', 'later', 'mail']);
});

test('a notification\'s message is read as text, although a loop keeps its child steps under the same field name', () => {
    const plan = planOf([
        { id: 'mail', type: 'integration_action', tool: 'outlook_read', inputs: { id: literal('m1') } },
        { id: 'tell', type: 'notification', title: 'New mail', body: 'It says: {{steps.mail.output.body}}', channels: ['notification'] },
    ]);
    assert.ok(outsideTextOf(plan, lookups).reads.has('tell'));
});

test('nothing to read is nothing to mark', () => {
    for (const plan of [null, undefined, {}, { steps: 'no' }, planOf([])]) {
        const outside = outsideTextOf(plan, lookups);
        assert.strictEqual(outside.carries.size + outside.reads.size, 0);
    }
});
