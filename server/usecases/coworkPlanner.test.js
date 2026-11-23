/**
 * The Cowork planner (./coworkPlanner.mts): a scripted model drafts a plan with the builder's REAL tools and
 * validation, so what is asserted here is a definition the automation engine would accept. What reads the database
 * (the owner's catalog and tables, storing the draft, the item's plan pointer) is handed in, so nothing is mocked.
 *
 * Run: cd server && node --test usecases/coworkPlanner.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { makePlan, builderPort, MAX_PLANNER_ROUNDS } = require('./coworkPlanner.mts');
const { PLANNER_TOOL_NAMES } = require('./coworkPlannerPrompt.mts');
const { fakeLookups } = require('../core/cowork/plan/plan.testkit');

const ITEM = { id: 'cw-1', userId: 'u1', title: 'Supplier radar', prompt: 'Every morning, read the supplier mail and tell me what is overdue.', triggerKind: 'schedule', planAutomationId: null };
const TOOLS = ['outlook_search', 'outlook_create_draft', 'drive_search'];
const INPUTS = { type: 'object', properties: { query: { type: 'string' }, to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } } };

const catalog = () => ({
    apps: [{ id: 'outlook', name: 'Outlook', available: true, actions: TOOLS.map((name) => ({ name, description: name, inputSchema: INPUTS })) }],
    toolNames: new Set(TOOLS),
});

/** One reply of the scripted model: tool calls, or its closing words. */
const calls = (...list) => ({ toolCalls: list.map(([name, args], i) => ({ id: `call_${name}_${i}`, function: { name, arguments: JSON.stringify(args) } })), usage: { input_tokens: 100, output_tokens: 20 } });
const says = (content) => ({ content, toolCalls: [], usage: { input_tokens: 50, output_tokens: 10 } });

const INSPECT = calls(['builder_inspect_tool', { tools: TOOLS }]);
const BATCH = [
    { tempId: 'mail', type: 'integration_action', spec: { tool: 'outlook_search', label: 'Get the new supplier mail', inputs: { query: { kind: 'literal', value: 'from:suppliers newer_than:1d' } } } },
    { tempId: 'sum', type: 'ai_step', spec: { label: 'Say what is overdue', prompt: 'Say which of these orders are overdue: {{steps.$mail.output}}' } },
    { tempId: 'tell', type: 'notification', spec: { label: 'Send me the digest', title: 'Supplier mail', body: '{{steps.$sum.output.text}}' } },
];
const DONE = says('Each run reads the supplier mail, says what is overdue and tells you.');

function world({ script = [INSPECT, calls(['builder_add_steps', { steps: BATCH }]), DONE], refusal = null, model = 'model-thinking', stored = { id: 'auto-new' }, maxMs = 60_000, mayAsk = true, attachWins = true } = {}) {
    const seen = { chats: [], persisted: [], attached: [], usage: [], progress: [] };
    let turn = 0;
    const deps = {
        store: { attachPlanAutomation: async (scheduleId, automationId, opts) => { seen.attached.push([scheduleId, automationId]); seen.onlyIfNone = opts?.onlyIfNone; return attachWins; } },
        ownerRefusal: async () => refusal,
        resolveModel: async () => model,
        tiersFor: async () => ({ fast: 'model-fast', thinking: 'model-thinking', swarm: 'model-swarm' }),
        chat: async (modelId, messages, options) => {
            seen.chats.push({ modelId, messages: structuredClone(messages), options });
            const next = script[turn++];
            if (typeof next === 'function') return next({ messages, options });
            return next ?? DONE;
        },
        logUsage: (call) => { seen.usage.push(call); },
        builder: {
            ...builderPort(),
            catalogFor: async () => catalog(),
            datatablesFor: async () => [],
            persistDraft: async (draft, opts) => { seen.persisted.push({ draft: structuredClone({ ...draft, _availableToolNames: null, _inspectedTools: null, _allowedModelTiers: null }), opts }); return stored; },
        },
        lookups: fakeLookups(),
        mayAsk: async () => mayAsk,
        now: () => 1_795_000_000_000,
        maxMs,
    };
    const input = (over = {}) => ({ item: ITEM, userOrgId: 'org-1', onProgress: (p) => seen.progress.push(p), ...over });
    return { deps, seen, input };
}

const httpError = (status, code) => (err) => err.status === status && err.code === code;
const stepsOf = (seen) => seen.persisted[0].draft.def.steps;

test('from a brief to a plan: the model looks up the tools, builds the steps in one batch, and the draft is stored and named as the item\'s plan', async () => {
    const { deps, seen, input } = world();
    const made = await makePlan(input(), deps);
    assert.deepStrictEqual(made, { automationId: 'auto-new', summary: 'Each run reads the supplier mail, says what is overdue and tells you.', findings: [], rounds: 3 });
    assert.deepStrictEqual(stepsOf(seen).map((s) => [s.type, s.label]), [
        ['integration_action', 'Get the new supplier mail'], ['ai_step', 'Say what is overdue'], ['notification', 'Send me the digest'],
    ]);
    const { draft, opts } = seen.persisted[0];
    const ids = draft.def.steps.map((s) => s.id);
    assert.deepStrictEqual(draft.def.edges, [{ from: 'trg', to: ids[0] }, { from: ids[0], to: ids[1] }, { from: ids[1], to: ids[2] }], 'wired in order from the trigger');
    assert.ok(draft.def.steps[1].prompt.includes(`steps.${ids[0]}.output`), 'the handle of the batch became the real step id');
    assert.deepStrictEqual([draft.userId, draft.orgId, draft.title, opts.finalize], ['u1', 'org-1', 'Supplier radar', true]);
    assert.match(draft.builderSessionId, /^cw_cw-1_/);
    assert.deepStrictEqual(seen.attached, [['cw-1', 'auto-new']]);
});

test('the trigger stays the item\'s own business: the draft keeps the builder\'s manual trigger', async () => {
    const { deps, seen, input } = world();
    await makePlan(input(), deps);
    assert.strictEqual(seen.persisted[0].draft.def.trigger.kind, 'manual');
});

test('the model is given the brief and the catalog, the planner\'s menu only, and the owner\'s model', async () => {
    const { deps, seen, input } = world();
    await makePlan(input(), deps);
    const first = seen.chats[0];
    assert.strictEqual(first.modelId, 'model-thinking');
    assert.deepStrictEqual(first.options.tools.map((t) => t.function.name).sort(), [...PLANNER_TOOL_NAMES].sort());
    const system = first.messages[0].content;
    assert.ok(system.includes(ITEM.prompt) && system.includes('outlook_search') && system.includes('Title: Supplier radar'));
    assert.deepStrictEqual(first.messages.map((m) => m.role), ['system', 'user']);
    assert.ok(first.options.signal instanceof AbortSignal);
});

test('every round is booked as planner usage of its owner, and the page hears what is being drafted', async () => {
    const { deps, seen, input } = world();
    await makePlan(input(), deps);
    assert.strictEqual(seen.usage.length, 3);
    assert.ok(seen.usage.every((u) => u.source === 'cowork_planner' && u.userId === 'u1' && u.orgId === 'org-1' && u.model === 'model-thinking'));
    assert.deepStrictEqual(seen.progress.map((p) => p.phase), ['thinking', 'thinking', 'drafted', 'thinking', 'saving']);
    const drafted = seen.progress.find((p) => p.phase === 'drafted');
    assert.deepStrictEqual(drafted.steps.map((s) => [s.title, s.kind]), [['Get the new supplier mail', 'fixed'], ['Say what is overdue', 'ai'], ['Send me the digest', 'deliver']]);
});

test('a step a plan may not hold is refused before anything is built, in words the model can act on', async () => {
    const withScript = [...BATCH.slice(0, 1), { tempId: 'calc', type: 'http_request', spec: { url: 'https://example.com' } }, ...BATCH.slice(1)];
    const { deps, seen, input } = world({ script: [INSPECT, calls(['builder_add_steps', { steps: withScript }]), calls(['builder_add_steps', { steps: BATCH }]), DONE] });
    const made = await makePlan(input(), deps);
    const told = seen.chats[2].messages.at(-1);
    assert.strictEqual(told.role, 'tool');
    assert.match(told.content, /Entry 1 was not added, and neither was the rest of this call: A plan reaches the outside world through a connected app/);
    assert.deepStrictEqual(stepsOf(seen).map((s) => s.type), ['integration_action', 'ai_step', 'notification'], 'nothing of the refused batch was kept');
    assert.strictEqual(made.rounds, 4);
});

test('a tool that is not on the planner\'s menu changes nothing, whatever the model asks for', async () => {
    const outside = calls(['builder_add_trigger', { kind: 'webhook' }], ['builder_finalize', {}], ['builder_add_http_request', { url: 'https://example.com' }]);
    const { deps, seen, input } = world({ script: [outside, INSPECT, calls(['builder_add_steps', { steps: BATCH }]), DONE] });
    await makePlan(input(), deps);
    const answers = seen.chats[1].messages.filter((m) => m.role === 'tool').map((m) => m.content);
    assert.strictEqual(answers.length, 3);
    assert.ok(answers.every((a) => /not available when making a plan/.test(a)));
    assert.strictEqual(seen.persisted[0].draft.def.trigger.kind, 'manual');
    assert.ok(stepsOf(seen).every((s) => s.type !== 'http_request'));
});

test('what Cowork would not run goes back to the model as a report, and the model fixes it', async () => {
    const withTools = [BATCH[0], { tempId: 'sum', type: 'ai_step', spec: { label: 'Say what is overdue', prompt: 'Read {{steps.$mail.output}}', tools: ['drive_search'] } }, BATCH[2]];
    const fix = ({ messages }) => {
        const added = JSON.parse(messages.findLast((m) => m.role === 'tool').content);
        return calls(['builder_update_step', { stepId: added.idMap.sum, patch: { tools: [] } }]);
    };
    const { deps, seen, input } = world({ script: [INSPECT, calls(['builder_add_steps', { steps: withTools }]), fix, DONE] });
    const made = await makePlan(input(), deps);
    const report = seen.chats[2].messages.at(-1);
    assert.strictEqual(report.role, 'user');
    assert.match(report.content, /^\[PLAN REPORT - machine-generated\]/);
    assert.match(report.content, /ai\.outside_text_with_tools/);
    assert.deepStrictEqual(made.findings, [], 'fixed before the planner stopped');
    assert.strictEqual(seen.chats[3].messages.at(-1).role, 'tool', 'a clean draft gets no second report');
});

test('a plan the model left with a finding is still stored and named, and says what stops it: its owner sees why on the card', async () => {
    const withTools = [BATCH[0], { tempId: 'sum', type: 'ai_step', spec: { prompt: 'Read {{steps.$mail.output}}', tools: ['drive_search'] } }];
    const { deps, seen, input } = world({ script: [INSPECT, calls(['builder_add_steps', { steps: withTools }]), DONE] });
    const made = await makePlan(input(), deps);
    assert.deepStrictEqual(made.findings.map((f) => f.code), ['ai.outside_text_with_tools']);
    assert.deepStrictEqual(seen.attached, [['cw-1', 'auto-new']]);
});

test('a scope the model names is dropped: a plan is one list of steps', async () => {
    const { deps, seen, input } = world({ script: [INSPECT, calls(['builder_add_steps', { scope: 'some_layer', steps: BATCH }]), DONE] });
    await makePlan(input(), deps);
    assert.strictEqual(stepsOf(seen).length, 3);
    assert.ok(!seen.persisted[0].draft.def.layers || Object.keys(seen.persisted[0].draft.def.layers).length === 0);
});

test('an item that may not get a plan made is refused before any model is asked', async () => {
    const cases = [
        [{ item: { ...ITEM, planAutomationId: 'auto-1' } }, {}, httpError(409, 'cowork_plan_refused')],
        [{ item: { ...ITEM, prompt: '   ' } }, {}, httpError(422, 'cowork_plan_refused')],
        [{}, { refusal: 'not_entitled' }, httpError(403, 'cowork_plan_refused')],
        [{}, { refusal: 'inactive' }, httpError(403, 'cowork_plan_refused')],
        [{}, { model: null }, httpError(409, 'cowork_planner_no_model')],
    ];
    for (const [over, setup, expected] of cases) {
        const { deps, seen, input } = world(setup);
        await assert.rejects(makePlan(input(over), deps), expected, JSON.stringify([over, setup]));
        assert.deepStrictEqual([seen.chats.length, seen.persisted.length, seen.attached.length], [0, 0, 0]);
    }
});

test('a brief no plan came out of stores nothing, and passes on what the model said', async () => {
    const { deps, seen, input } = world({ script: [says('The brief needs a calendar, and no calendar is connected.')] });
    await assert.rejects(makePlan(input(), deps), (err) => err.status === 422 && err.code === 'cowork_planner_empty' && /no calendar is connected/.test(err.message));
    assert.deepStrictEqual([seen.persisted.length, seen.attached.length], [0, 0]);
});

test('a model that never stops is stopped after the planner\'s rounds, and what it built is kept', async () => {
    const again = () => INSPECT;
    const { deps, seen, input } = world({ script: [INSPECT, calls(['builder_add_steps', { steps: BATCH }]), ...Array(20).fill(again)] });
    const made = await makePlan(input(), deps);
    assert.strictEqual(made.rounds, MAX_PLANNER_ROUNDS);
    assert.strictEqual(seen.chats.length, MAX_PLANNER_ROUNDS);
    assert.strictEqual(stepsOf(seen).length, 3);
});

/** A model call that ends only when its signal does. */
const hangs = ({ options }) => new Promise((resolve, reject) => {
    if (options.signal.aborted) return reject(options.signal.reason);
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
});

test('making a plan has a time limit: past it the caller hears so, and nothing is stored', async () => {
    const { deps, seen, input } = world({ script: [hangs], maxMs: 30 });
    // The limit's own timer does not hold the process open (a server has other reasons to stay up); the test does.
    const keepAlive = setTimeout(() => {}, 10_000);
    try {
        await assert.rejects(makePlan(input(), deps), httpError(504, 'cowork_planner_timeout'));
    } finally {
        clearTimeout(keepAlive);
    }
    assert.deepStrictEqual([seen.persisted.length, seen.attached.length], [0, 0]);
});

test('a caller that left ends the work at once, as itself and not as a time-out', async () => {
    const gone = new AbortController();
    const { deps, seen, input } = world({ script: [({ options }) => { gone.abort(new Error('the page was closed')); return hangs({ options }); }] });
    await assert.rejects(makePlan(input({ signal: gone.signal }), deps), /the page was closed/);
    assert.deepStrictEqual([seen.persisted.length, seen.attached.length], [0, 0]);
});

test('a draft that could not be stored is an error, and the item gets no plan', async () => {
    for (const stored of [{ error: 'the store refused the write' }, null, {}]) {
        const { deps, seen, input } = world({ stored });
        await assert.rejects(makePlan(input(), deps), /could not store its draft/);
        assert.deepStrictEqual(seen.attached, []);
    }
});

test('the catalog the model builds from is read through the caller\'s session, and an AI step may name only a tier its owner has', async () => {
    const { deps, seen, input } = world();
    let asked = null;
    deps.builder.catalogFor = async (userId, session) => { asked = [userId, session]; return catalog(); };
    const tiered = [BATCH[0], { tempId: 'sum', type: 'ai_step', spec: { prompt: 'Read {{steps.$mail.output}}', modelTier: 'swarm' } }, BATCH[2]];
    deps.chat = (() => { const script = [INSPECT, calls(['builder_add_steps', { steps: tiered }]), calls(['builder_add_steps', { steps: BATCH.slice(1) }]), DONE]; let i = 0; return async (m, messages) => { seen.chats.push({ messages: structuredClone(messages) }); return script[i++] ?? DONE; }; })();
    await makePlan(input({ session: { user: { id: 'u1' } } }), deps);
    assert.deepStrictEqual(asked, ['u1', { user: { id: 'u1' } }]);
    const refused = seen.chats[2].messages.findLast((m) => m.role === 'tool').content;
    assert.match(refused, /swarm|tier/i, 'the builder refused a tier the owner does not have');
});

test('where the licence has no approvals the model is told so, and a step that waits for a decision comes back as a finding', async () => {
    const withAsk = [BATCH[0], { tempId: 'ask', type: 'approval', spec: { prompt: 'Send the digest?' } }, { tempId: 'tell', type: 'notification', spec: { title: 'Supplier mail', body: 'Checked the mail.' } }];
    const { deps, seen, input } = world({ mayAsk: false, script: [INSPECT, calls(['builder_add_steps', { steps: withAsk }]), DONE] });
    const made = await makePlan(input(), deps);
    assert.match(seen.chats[0].messages[0].content, /There is NO approval step on this workspace/);
    assert.match(seen.chats[2].messages.at(-1).content, /ask\.not_licensed/, 'the report after the change says so');
    assert.deepStrictEqual(made.findings.map((f) => f.code), ['ask.not_licensed']);
    const licensed = world();
    await makePlan(licensed.input(), licensed.deps);
    assert.match(licensed.seen.chats[0].messages[0].content, /asks the owner: never name another approver/);
});

test('a plan made while another making already named one does not replace it, and says so', async () => {
    const { deps, seen, input } = world({ attachWins: false });
    await assert.rejects(makePlan(input(), deps), (err) => err.status === 409 && /got a plan while this one was being made/.test(err.message));
    assert.strictEqual(seen.onlyIfNone, true);
});
