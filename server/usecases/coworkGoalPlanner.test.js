/**
 * The goal planner (./coworkGoalPlanner.mts): a scripted model drafts a goal's check with the builder's REAL tools and
 * validation, on the read-only menu. What reads the database (the owner's catalog, storing the draft, the goal's
 * check pointer) is handed in; nothing is mocked.
 *
 * Run: cd server && node --test usecases/coworkGoalPlanner.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { draftGoalCheck } = require('./coworkGoalPlanner.mts');
const { builderPort } = require('./coworkDraftLoop.mts');
const { goalStepTypes } = require('./coworkGoalPlannerPrompt.mts');
const { fakeLookups } = require('../core/cowork/plan/plan.testkit');

const ITEM = { id: 'cw-goal', userId: 'u1', title: 'Supplier radar', prompt: 'Answer the supplier mail.' };
const GOAL = { sentence: 'Every supplier mail gets an answer within two working days', targetPercent: 95 };
const INPUTS = { type: 'object', properties: { query: { type: 'string' } } };
const toolCall = (name, args, i = 0) => ({ id: `c_${name}_${i}`, function: { name, arguments: JSON.stringify(args) } });
const reply = (...list) => ({ toolCalls: list.map(([name, args], i) => toolCall(name, args, i)), usage: {} });
const words = (content) => ({ content, toolCalls: [], usage: {} });
const lit = (value) => ({ kind: 'literal', value });
const expr = (value) => ({ kind: 'expr', value });

const READ = { tempId: 'mail', type: 'integration_action', spec: { tool: 'outlook_search', label: 'Read the supplier mail of the week', inputs: { query: lit('from:suppliers newer_than:7d') } } };
const COUNT = { tempId: 'count', type: 'set', spec: { label: 'Count the answers in time', fields: { met: expr('len(filter(steps.$mail.output.messages, workdaysBetween(it.receivedAt, it.answeredAt) <= 2))'), total: expr('len(steps.$mail.output.messages)'), period: lit('this week') } } };

function scripted(script, { stored = { id: 'auto-check' }, setCheck = true } = {}) {
    const seen = { chats: [], persisted: [], checks: [] };
    let turn = 0;
    const deps = {
        store: { setCheck: async (id, automationId) => { seen.checks.push([id, automationId]); return setCheck; } },
        ownerRefusal: async () => null,
        resolveModel: async () => 'model-thinking',
        tiersFor: async () => ({ fast: 'f', thinking: 't' }),
        chat: async (modelId, messages, options) => { seen.chats.push({ messages: structuredClone(messages), options }); return script[turn++] ?? words('Done.'); },
        logUsage: () => {},
        builder: {
            ...builderPort(),
            catalogFor: async () => ({ apps: [{ id: 'outlook', name: 'Outlook', available: true, actions: [{ name: 'outlook_search', description: 'Search mail', inputSchema: INPUTS }] }], toolNames: new Set(['outlook_search']) }),
            datatablesFor: async () => [],
            persistDraft: async (draft, opts) => { seen.persisted.push({ def: structuredClone(draft.def), title: draft.title, opts }); return stored; },
        },
        lookups: fakeLookups(),
        now: () => 1_795_000_000_000,
        maxMs: 60_000,
    };
    return { deps, seen };
}

const INSPECT = reply(['builder_inspect_tool', { tools: ['outlook_search'] }]);

test('from a goal to a check: read, count, stored as an automation and named as the goal\'s check', async () => {
    const { deps, seen } = scripted([INSPECT, reply(['builder_add_steps', { steps: [READ, COUNT] }]), words('Each run counts the supplier mail answered within two working days.')]);
    const drafted = await draftGoalCheck({ item: ITEM, goal: GOAL, userOrgId: 'org-1' }, deps);
    assert.deepStrictEqual([drafted.automationId, drafted.findings, drafted.rounds], ['auto-check', [], 3]);
    assert.deepStrictEqual(seen.persisted[0].def.steps.map((s) => s.type), ['integration_action', 'set']);
    assert.strictEqual(seen.persisted[0].title, 'Goal check: Supplier radar');
    assert.deepStrictEqual(seen.checks, [['cw-goal', 'auto-check']]);
    const system = seen.chats[0].messages[0].content;
    assert.ok(system.includes(GOAL.sentence) && system.includes('Target: 95%') && system.includes('workdaysBetween'));
});

test('the menu offers only fixed steps that read and count; an AI step, a notification or an approval is refused', async () => {
    const types = goalStepTypes();
    for (const never of ['ai_step', 'data_extraction', 'approval', 'notification', 'generate_document']) assert.ok(!types.includes(never), never);
    const { deps, seen } = scripted([
        reply(['builder_add_steps', { steps: [READ, { tempId: 'judge', type: 'ai_step', spec: { prompt: 'Judge it' } }, COUNT] }]),
        reply(['builder_add_steps', { steps: [READ, { tempId: 'tell', type: 'notification', spec: { title: 'x', body: 'y' } }] }]),
        reply(['builder_add_trigger', { kind: 'webhook' }]),
        reply(['builder_add_steps', { steps: [READ, COUNT] }]),
    ]);
    await draftGoalCheck({ item: ITEM, goal: GOAL }, deps);
    const told = seen.chats.slice(1, 4).map((c) => c.messages.at(-1).content);
    assert.match(told[0], /Entry 1 was not added, and neither was the rest of this call: A goal's check only reads and counts.*ai_step.*Build the goal check without it\./);
    assert.match(told[1], /notification\\" is not one of its steps/);
    assert.match(told[2], /not available when making a goal check/);
    const enumOf = seen.chats[0].options.tools.find((t) => t.function.name === 'builder_add_steps').function.parameters.properties.steps.items.properties.type.enum;
    assert.ok(!enumOf.includes('ai_step') && !enumOf.includes('notification') && enumOf.includes('set'));
    assert.deepStrictEqual(seen.persisted[0].def.steps.map((s) => s.type), ['integration_action', 'set']);
});

test('a draft that is no check goes back to the model as a report, and what it ends on says why', async () => {
    const noTotal = { ...COUNT, spec: { ...COUNT.spec, fields: { met: lit(1) } } };
    const { deps, seen } = scripted([reply(['builder_add_steps', { steps: [READ, noTotal] }]), words('Counted.')]);
    const drafted = await draftGoalCheck({ item: ITEM, goal: GOAL }, deps);
    assert.match(seen.chats[1].messages.at(-1).content, /^\[PLAN REPORT - machine-generated\].*goal\.no_count/s);
    assert.deepStrictEqual(drafted.findings.map((f) => f.code), ['goal.no_count']);
});

test('no sentence, no model, nothing drafted or a goal taken off meanwhile: refused in words, nothing named', async () => {
    const empty = scripted([]);
    await assert.rejects(draftGoalCheck({ item: ITEM, goal: { sentence: '  ', targetPercent: 100 } }, empty.deps), (e) => e.status === 422 && e.code === 'cowork_goal_refused');
    const noModel = scripted([]);
    noModel.deps.resolveModel = async () => null;
    await assert.rejects(draftGoalCheck({ item: ITEM, goal: GOAL }, noModel.deps), (e) => e.status === 409);
    const nothing = scripted([words('No mail app is connected.')]);
    await assert.rejects(draftGoalCheck({ item: ITEM, goal: GOAL }, nothing.deps), (e) => e.code === 'cowork_goal_check_empty' && /No mail app/.test(e.message));
    const gone = scripted([reply(['builder_add_steps', { steps: [READ, COUNT] }])], { setCheck: false });
    await assert.rejects(draftGoalCheck({ item: ITEM, goal: GOAL }, gone.deps), (e) => e.status === 409 && e.code === 'cowork_goal_refused');
    for (const w of [empty, noModel, nothing]) assert.deepStrictEqual(w.seen.checks, []);
});
