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
        { id: 'c', type: 'parallel' },
        { id: 'each', type: 'loop', items: literal([1]), body: [{ id: 'h', type: 'http_request', url: 'https://example.com' }] },
        { id: 'x', type: 'teleport' },
    ]);
    const found = checkPlan(plan, lookups);
    assert.deepStrictEqual(found.map((f) => [f.code, f.stepId]), [['step.not_allowed', 'c'], ['step.not_allowed', 'h'], ['step.not_allowed', 'x']]);
    assert.match(found[0].message, /one after another/);
    assert.match(found[1].message, /free web address/);
    assert.match(found[2].message, /"teleport"/);
});

test('an AI step is offered tools by name: not the whole catalogue, not an agent\'s grants', () => {
    assert.deepStrictEqual(codes(planOf([{ id: 'a', type: 'ai_step', prompt: 'x', allowTools: true }])), ['ai.open_tools']);
    assert.deepStrictEqual(codes(planOf([{ id: 'a', type: 'ai_step', prompt: 'x', agentId: 'agent-1' }])), ['ai.agent']);
    assert.deepStrictEqual(codes(planOf([{ id: 'a', type: 'ai_step', prompt: 'x', agentId: '  ' }])), [], 'a blank id is no agent');
    assert.deepStrictEqual(codes(planOf([{ id: 'a', type: 'ai_step', prompt: 'x', tools: ['drive_search'] }])), [], 'named tools on trusted input are fine');
});

test('the tools switch with a list is the list: that is how the builder stores named tools, and an empty list is no tools', () => {
    assert.deepStrictEqual(codes(planOf([{ id: 'a', type: 'ai_step', prompt: 'x', allowTools: true, tools: ['drive_search'] }])), []);
    assert.deepStrictEqual(codes(planOf([{ id: 'a', type: 'ai_step', prompt: 'x', allowTools: true, tools: [] }])), []);
    assert.deepStrictEqual(codes(planOf([{ id: 'a', type: 'ai_step', prompt: 'x', allowTools: true, tools: null }])), ['ai.open_tools']);
    const onMail = (over) => planOf([mailStep, { id: 'a', type: 'ai_step', prompt: 'Answer {{steps.mail.output.body}}', ...over }]);
    assert.deepStrictEqual(codes(onMail({ allowTools: true, tools: ['drive_search'] })), ['ai.outside_text_with_tools']);
    assert.deepStrictEqual(codes(onMail({ allowTools: true, tools: [] })), [], 'the switch on with nothing to offer');
    assert.deepStrictEqual(codes(onMail({ allowTools: false, tools: null })), []);
});

test('an AI step in a plan uses no skills and no memory', () => {
    const ai = (over) => planOf([{ id: 'a', type: 'ai_step', prompt: 'x', ...over }]);
    assert.deepStrictEqual(codes(ai({ skillIds: ['skill-1'] })), ['ai.skills']);
    assert.deepStrictEqual(codes(ai({ useMemory: true })), ['ai.memory']);
    assert.deepStrictEqual(codes(ai({ skillIds: [], useMemory: false, knowledgeBaseIds: [], agentId: null })), [], 'as the builder stores a plain AI step');
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

test('a step that waits for a decision asks the owner: another approver, a panel, a final say, an escalation or stages are refused', () => {
    const ask = (over) => planOf([{ id: 'ok', type: 'approval', prompt: 'Send these?', ...over }]);
    assert.deepStrictEqual(codes(ask({})), []);
    assert.deepStrictEqual(codes(ask({ assignee: null, approvers: [], stages: [] })), [], 'empty is nobody');
    for (const over of [
        { assignee: { userId: 'u2' } }, { assignee: { groupId: 'g1' } }, { approvers: [{ userId: 'u2' }] },
        { finalApprover: { userId: 'u3' } }, { escalateTo: { userId: 'u4' }, escalateAfterHours: 4 }, { stages: [{ name: 'Finance', approvers: [{ groupId: 'g1' }] }] },
    ]) {
        assert.deepStrictEqual(codes(ask(over)), ['ask.other_people'], JSON.stringify(over));
    }
});

test('every finding is a sentence that names its step', () => {
    const plan = planOf([mailStep, { id: 'a', type: 'ai_step', prompt: '{{steps.mail.output.body}}', tools: ['drive_search'] }, { id: 'c', type: 'parallel' }]);
    for (const f of checkPlan(plan, lookups)) {
        assert.ok(f.stepId, f.code);
        assert.ok(f.message.length > 20 && f.message.endsWith('.'), f.message);
    }
});

test('other approvers are refused in the shape the engine reads them: under the step\'s approval', () => {
    const ask = (approval) => planOf([{ id: 'ask', type: 'approval', prompt: 'Send?', approval }]);
    assert.deepStrictEqual(codes(ask({ assignee: { userId: 'u-other' } })), ['ask.other_people']);
    assert.deepStrictEqual(codes(ask({ escalateTo: { userId: 'u4' }, escalateAfterHours: 2 })), ['ask.other_people']);
    assert.deepStrictEqual(codes(ask({ approvers: [{ groupId: 'g1' }], rule: 'all' })), ['ask.other_people']);
    assert.deepStrictEqual(codes(ask({ details: 'The orders', fields: [] })), [], 'details and questions for the owner are fine');
});

test('an AI step offered a tool that reads mail reads outside text itself: it may hold no tool, and what it writes is marked', () => {
    const reader = { id: 'a', type: 'ai_step', prompt: 'Reply to what my supplier mail asks', tools: ['outlook_search', 'outlook_compose'] };
    assert.deepStrictEqual(codes(planOf([reader])), ['ai.outside_text_with_tools']);
    const onlyReads = { id: 'a', type: 'ai_step', prompt: 'Summarise my supplier mail', tools: ['outlook_search'] };
    assert.deepStrictEqual(codes(planOf([onlyReads])), ['ai.outside_text_with_tools'], 'the read itself is a tool it may not hold');
    const send = { id: 's', type: 'integration_action', tool: 'outlook_compose', inputs: { to: template('{{steps.a.output.text}}'), body: literal('Hi') } };
    assert.ok(codes(planOf([onlyReads, send])).includes('send.destination_from_outside'), 'its answer cannot pick a recipient');
});

test('outside text reaches a loop inside a loop: the outer item is in reach there too', () => {
    const outer = (body) => planOf([mailStep, { id: 'outer', type: 'loop', overRef: '{{steps.mail.output.messages}}', itemVar: 'm', body: [
        { id: 'inner', type: 'loop', overRef: '{{steps.mail.output.fixed}}', itemVar: 'x', body },
    ] }]);
    const fixedOnly = planOf([{ id: 'fixed', type: 'set', fields: {} }, { id: 'outer', type: 'loop', overRef: '{{steps.fixed.output.list}}', itemVar: 'm', body: [
        { id: 'inner', type: 'loop', overRef: '{{steps.fixed.output.list}}', itemVar: 'x', body: [{ id: 'c', type: 'integration_action', tool: 'outlook_compose', inputs: { to: template('{{loop.m.from}}') } }] },
    ] }]);
    assert.ok(codes(outer([{ id: 'c', type: 'integration_action', tool: 'outlook_compose', inputs: { to: template('{{loop.m.from}}') } }])).includes('send.destination_from_outside'));
    assert.ok(codes(outer([{ id: 'r', type: 'ai_step', prompt: '{{loop.m.body}}', tools: ['outlook_compose'] }])).includes('ai.outside_text_with_tools'));
    assert.deepStrictEqual(codes(fixedOnly), [], 'loops over the owner\'s own data stay fine');
});

test('outside text never picks the Talk conversation a message goes to, nor the message a reply answers', () => {
    const talk = fakeLookups({ nextcloud_talk_send_message: ['nextcloud-talk', 'sends'] });
    const toRoom = planOf([mailStep, { id: 't', type: 'integration_action', tool: 'nextcloud_talk_send_message', inputs: { token: ref('steps.mail.output.subject'), message: template('{{steps.mail.output.body}}') } }]);
    assert.deepStrictEqual(checkPlan(toRoom, talk).map((f) => f.code), ['send.destination_from_outside']);
    const reply = planOf([mailStep, { id: 'r', type: 'integration_action', tool: 'outlook_compose', inputs: { replyToMessageId: ref('steps.mail.output.id'), body: literal('Thanks') } }]);
    assert.deepStrictEqual(codes(reply), ['send.destination_from_outside']);
});

test('outside text never picks which rows of a table are changed or deleted; it may fill the values', () => {
    const write = (over) => planOf([mailStep, { id: 'd', type: 'datatable', op: 'delete_rows', datatableId: 'dt-1', ...over }]);
    assert.deepStrictEqual(codes(write({ where: [{ field: 'supplier', op: 'eq', value: '{{steps.mail.output.from}}' }] })), ['write.target_from_outside']);
    assert.deepStrictEqual(codes(write({ where: [{ field: 'status', op: 'eq', value: 'done' }] })), []);
    const add = planOf([mailStep, { id: 'd', type: 'datatable', op: 'add_row', datatableId: 'dt-1', values: { subject: template('{{steps.mail.output.subject}}') } }]);
    assert.deepStrictEqual(codes(add), [], 'a row\'s content may come from the mail');
});

test('a draft may answer the sender of the mail that started the run, and nothing else from outside (decision 0044)', () => {
    const draft = (tool, inputs) => planOf([{ id: 'd', type: 'integration_action', tool, inputs: { body: ref('trigger.output.mail.body'), ...inputs } }]);
    const { asStartedBy } = require('../startKinds.mts');
    const started = (plan) => checkPlan(asStartedBy(plan, { triggerKind: 'app_event' }), lookups).map((f) => f.code);
    assert.deepStrictEqual(started(draft('outlook_create_draft', { to: ref('trigger.output.mail.from') })), [], 'a draft to the sender');
    assert.deepStrictEqual(started(draft('gmail_create_draft', { to: template('{{trigger.output.mail.from}}') })), []);
    assert.deepStrictEqual(started(draft('outlook_create_draft', { to: template('{{trigger.output.mail.from}}, boss@evil.example') })), ['send.destination_from_outside'], 'nothing added to it');
    assert.deepStrictEqual(started(draft('outlook_create_draft', { to: ref('trigger.output.mail.from'), cc: ref('trigger.output.mail.cc') })), ['send.destination_from_outside'], 'no cc from the mail');
    assert.deepStrictEqual(started(draft('outlook_create_draft', { to: ref('trigger.output.mail.body') })), ['send.destination_from_outside'], 'only the sender, not an address in the text');
    assert.deepStrictEqual(started(draft('outlook_compose', { to: ref('trigger.output.mail.from') })), ['mail.sends', 'send.destination_from_outside'], 'a send stays refused');
});

test('a plan a mail starts never sends, not even to an address the plan names; telling or asking the owner stays (decision 0044)', () => {
    const { asStartedBy } = require('../startKinds.mts');
    const onMail = (steps) => checkPlan(asStartedBy(planOf(steps), { triggerKind: 'app_event' }), lookups).map((f) => [f.code, f.stepId]);
    const send = { id: 's', type: 'integration_action', tool: 'outlook_compose', inputs: { to: literal('orders@hoekstra-staal.example'), body: ref('trigger.output.mail.subject') } };
    assert.deepStrictEqual(onMail([send]), [['mail.sends', 's']]);
    assert.deepStrictEqual(onMail([{ ...send, tool: 'outlook_reply_in_thread' }]), [['mail.sends', 's']]);
    assert.deepStrictEqual(codes(planOf([send])), [], 'on the clock the same step may send');
    const own = [
        { id: 'd', type: 'integration_action', tool: 'outlook_create_draft', inputs: { to: ref('trigger.output.mail.from'), body: literal('Thanks') } },
        { id: 'n', type: 'notification', title: 'A draft is ready', body: 'See your drafts.' },
    ];
    assert.deepStrictEqual(onMail(own), [], 'a draft and a note to the owner');
    const mailTrigger = { id: 'trg', type: 'trigger', kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new' } };
    assert.deepStrictEqual(codes(planOf([send], mailTrigger)), ['mail.sends'], 'a plan whose own trigger is a mail');
});

test('every step runs as the plan shows it: no saved output served instead, no switched-off step, no saved start data', () => {
    const send = { id: 's', type: 'integration_action', tool: 'outlook_compose', inputs: { to: ref('steps.who.output.email'), body: literal('Hi') } };
    const pinned = planOf([{ id: 'who', type: 'set', values: {}, pinnedOutput: { email: 'boss@evil.example' } }, send]);
    assert.deepStrictEqual(checkPlan(pinned, lookups).map((f) => [f.code, f.stepId]), [['step.pinned', 'who']]);
    const off = planOf([{ id: 'check', type: 'condition', disabled: true, condition: '{{steps.x.output}} < 100' }, send]);
    assert.deepStrictEqual(checkPlan(off, lookups).map((f) => [f.code, f.stepId]), [['step.disabled', 'check']]);
    const startPin = planOf([send], { id: 'trg', type: 'trigger', kind: 'manual', pinnedOutput: { email: 'boss@evil.example' } });
    assert.deepStrictEqual(codes(startPin), ['trigger.pinned']);
    assert.deepStrictEqual(codes(planOf([{ ...send, pinnedOutput: null, disabled: false }])), [], 'cleared fields are no finding');
});
