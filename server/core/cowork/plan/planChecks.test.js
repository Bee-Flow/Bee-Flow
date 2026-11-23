// @typecheck
/**
 * The rules a definition must meet to be a plan Cowork runs (./planChecks.mts): its shape, its step types, what an AI
 * step may be offered, and where outside text may and may not go.
 *
 * Run: cd server && node --test core/cowork/plan/planChecks.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { checkPlan } = require('./planChecks.mts');
const { fakeLookups, planOf, supplierRadar, ref, literal, template } = require('./plan.testkit');

const lookups = fakeLookups();
const codes = (plan) => checkPlan(plan, lookups).map((f) => f.code);
const mailStep = { id: 'mail', type: 'integration_action', tool: 'outlook_read', inputs: { id: literal('m1') } };

test('the running example is a plan: no finding', () => {
    assert.deepStrictEqual(checkPlan(supplierRadar(), lookups), []);
});

test('something that is no definition is refused in one finding', () => {
    for (const plan of [null, undefined, {}, { steps: 'no' }, 'text']) {
        assert.deepStrictEqual(codes(plan), ['plan.shape'], JSON.stringify(plan));
    }
});

test('a plan has at least one step that does something: notes alone are no plan', () => {
    assert.deepStrictEqual(codes(planOf([])), ['plan.empty']);
    assert.deepStrictEqual(codes(planOf([{ id: 'n', type: 'note', text: 'remember' }])), ['plan.empty']);
});

test('a plan starts on a schedule, by its owner or on an app event: a form or a webhook is refused', () => {
    const steps = [{ id: 'a', type: 'set', values: {} }];
    for (const kind of ['schedule', 'manual', 'app_event']) assert.deepStrictEqual(codes(planOf(steps, { id: 't', type: 'trigger', kind })), [], kind);
    for (const kind of ['form', 'webhook', 'agent_call', 'app_trigger', undefined]) {
        assert.deepStrictEqual(codes(planOf(steps, { id: 't', type: 'trigger', kind })), ['trigger.not_allowed'], String(kind));
    }
    assert.deepStrictEqual(codes({ steps, edges: [] }), ['trigger.not_allowed'], 'no trigger at all');
});

test('a plan has no sub-flows', () => {
    const plan = { ...planOf([{ id: 'a', type: 'set', values: {} }]), layers: { helper: { steps: [] } } };
    assert.deepStrictEqual(codes(plan), ['plan.layers']);
    assert.deepStrictEqual(codes({ ...plan, layers: {} }), [], 'an empty map is no sub-flow');
});

test('a step type that is not on Cowork\'s list is refused with its own reason, wherever it sits', () => {
    const plan = planOf([
        { id: 'c', type: 'code', code: 'function main() {}' },
        { id: 'each', type: 'loop', items: literal([1]), body: [{ id: 'h', type: 'http_request', url: 'https://example.com' }] },
        { id: 'x', type: 'teleport' },
    ]);
    const found = checkPlan(plan, lookups);
    assert.deepStrictEqual(found.map((f) => [f.code, f.stepId]), [['step.not_allowed', 'c'], ['step.not_allowed', 'h'], ['step.not_allowed', 'x']]);
    assert.match(found[0].message, /script/);
    assert.match(found[1].message, /free web address/);
    assert.match(found[2].message, /"teleport"/);
});

test('an AI step is offered tools by name: not the whole catalogue, not an agent\'s grants', () => {
    assert.deepStrictEqual(codes(planOf([{ id: 'a', type: 'ai_step', prompt: 'x', allowTools: true }])), ['ai.open_tools']);
    assert.deepStrictEqual(codes(planOf([{ id: 'a', type: 'ai_step', prompt: 'x', agentId: 'agent-1' }])), ['ai.agent']);
    assert.deepStrictEqual(codes(planOf([{ id: 'a', type: 'ai_step', prompt: 'x', agentId: '  ' }])), [], 'a blank id is no agent');
    assert.deepStrictEqual(codes(planOf([{ id: 'a', type: 'ai_step', prompt: 'x', tools: ['drive_search'] }])), [], 'named tools on trusted input are fine');
});

test('an AI step that reads outside text gets no tool at all', () => {
    const withTools = planOf([mailStep, { id: 'a', type: 'ai_step', prompt: 'Answer {{steps.mail.output.body}}', tools: ['drive_search'] }]);
    assert.deepStrictEqual(codes(withTools), ['ai.outside_text_with_tools']);
    const without = planOf([mailStep, { id: 'a', type: 'ai_step', prompt: 'Answer {{steps.mail.output.body}}' }]);
    assert.deepStrictEqual(codes(without), []);
    const emptyList = planOf([mailStep, { id: 'a', type: 'ai_step', prompt: 'Answer {{steps.mail.output.body}}', tools: [] }]);
    assert.deepStrictEqual(codes(emptyList), [], 'an empty list offers nothing');
});

test('the same AI step with the whole catalogue reads as both findings', () => {
    const plan = planOf([mailStep, { id: 'a', type: 'ai_step', prompt: '{{steps.mail.output.body}}', allowTools: true }]);
    assert.deepStrictEqual(codes(plan).sort(), ['ai.open_tools', 'ai.outside_text_with_tools']);
});

test('outside text never picks who receives something, in a send and in a draft alike', () => {
    const send = (tool, to) => planOf([mailStep, { id: 's', type: 'integration_action', tool, inputs: { to, body: ref('steps.mail.output.body') } }]);
    assert.deepStrictEqual(codes(send('outlook_compose', ref('steps.mail.output.from'))), ['send.destination_from_outside']);
    assert.deepStrictEqual(codes(send('outlook_create_draft', template('{{steps.mail.output.replyTo}}'))), ['send.destination_from_outside']);
    assert.deepStrictEqual(codes(send('outlook_compose', literal('orders@hoekstra-staal.example'))), [], 'an address the plan names is fine, and the body may quote the mail');
});

test('a recipient from the owner\'s own data is fine, next to a mail that fills the text', () => {
    const plan = planOf([
        mailStep,
        { id: 'who', type: 'integration_action', tool: 'contacts_search', inputs: { query: literal('group:Suppliers') } },
        { id: 's', type: 'integration_action', tool: 'outlook_compose', inputs: { to: ref('steps.who.output.items[0].email'), cc: literal('me@example.com'), body: ref('steps.mail.output.body') } },
    ]);
    assert.deepStrictEqual(codes(plan), []);
});

test('recipient fields are recognised whatever their spelling', () => {
    for (const name of ['To', 'CC', 'bcc', 'recipients', 'user_id', 'userIds', 'share-with', 'attendees']) {
        const plan = planOf([mailStep, { id: 's', type: 'integration_action', tool: 'outlook_compose', inputs: { [name]: ref('steps.mail.output.from') } }]);
        assert.deepStrictEqual(codes(plan), ['send.destination_from_outside'], name);
    }
});

test('outside text never picks what is changed: a file, a folder, a table', () => {
    const plan = planOf([mailStep, { id: 'w', type: 'integration_action', tool: 'drive_upload', inputs: { path: template('/in/{{steps.mail.output.subject}}.txt'), content: ref('steps.mail.output.body') } }]);
    const found = checkPlan(plan, lookups);
    assert.deepStrictEqual(found.map((f) => [f.code, f.stepId]), [['write.target_from_outside', 'w']]);
    assert.match(found[0].message, /"path"/);
    const fixed = planOf([mailStep, { id: 'w', type: 'integration_action', tool: 'drive_upload', inputs: { path: literal('/in/latest.txt'), content: ref('steps.mail.output.body') } }]);
    assert.deepStrictEqual(codes(fixed), [], 'outside text may be the content');
});

test('a read is not held to the recipient and target rules: looking something up by a value from a mail is allowed', () => {
    const plan = planOf([mailStep, { id: 'find', type: 'integration_action', tool: 'drive_search', inputs: { path: ref('steps.mail.output.subject'), to: ref('steps.mail.output.from') } }]);
    assert.deepStrictEqual(codes(plan), []);
});

test('a step that goes to the open web takes nothing from outside text: an address built from a mail carries the mail out', () => {
    const fromMail = planOf([mailStep, { id: 'web', type: 'integration_action', tool: 'read_url', inputs: { url: template('https://example.com/?q={{steps.mail.output.body}}') } }]);
    assert.deepStrictEqual(codes(fromMail), ['web.input_from_outside']);
    const search = planOf([mailStep, { id: 'web', type: 'integration_action', tool: 'agent_search', inputs: { query: ref('steps.mail.output.subject') } }]);
    assert.deepStrictEqual(codes(search), ['web.input_from_outside']);
    const own = planOf([{ id: 'web', type: 'integration_action', tool: 'agent_search', inputs: { query: literal('EU AI rules this week') } }]);
    assert.deepStrictEqual(codes(own), [], 'the plan\'s own query is fine');
});

test('one web page may not choose the next: a page read from a link found on another page is refused', () => {
    const plan = planOf([
        { id: 'find', type: 'integration_action', tool: 'agent_search', inputs: { query: literal('AI news') } },
        { id: 'open', type: 'integration_action', tool: 'read_url', inputs: { url: ref('steps.find.output.results[0].url') } },
    ]);
    assert.deepStrictEqual(codes(plan), ['web.input_from_outside']);
});

test('outside text may decide which of the plan\'s own branches runs', () => {
    const plan = planOf([
        mailStep,
        { id: 'pick', type: 'data_extraction', source: ref('steps.mail.output.body'), fields: [{ name: 'overdue' }] },
        { id: 'if', type: 'condition', expr: 'steps.pick.output.overdue == true' },
        { id: 'tell', type: 'notification', title: 'Overdue', body: 'An order is overdue.', channels: ['notification'] },
    ]);
    assert.deepStrictEqual(codes(plan), []);
});

test('a mail trigger marks its own output: an AI step that reads the new mail gets no tools', () => {
    const trigger = { id: 'trg', type: 'trigger', kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new' } };
    const plan = planOf([{ id: 'a', type: 'ai_step', prompt: 'Reply to {{trigger.output.body}}', tools: ['drive_search'] }], trigger);
    assert.deepStrictEqual(codes(plan), ['ai.outside_text_with_tools']);
});

test('every finding is a sentence that names its step', () => {
    const plan = planOf([mailStep, { id: 'a', type: 'ai_step', prompt: '{{steps.mail.output.body}}', tools: ['drive_search'] }, { id: 'c', type: 'code' }]);
    for (const f of checkPlan(plan, lookups)) {
        assert.ok(f.stepId, f.code);
        assert.ok(f.message.length > 20 && f.message.endsWith('.'), f.message);
    }
});
