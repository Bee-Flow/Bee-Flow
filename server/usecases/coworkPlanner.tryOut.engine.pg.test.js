/**
 * The planner tries its own plan before its owner sees it (./coworkPlannerTry.mts), on the REAL automation engine,
 * builder and stores (PGlite behind db.js). The planner's model is scripted; Fireflies and the model of the plan's AI
 * step are stood in for (core/cowork/firefliesWorld.testkit.js):
 *
 *   - the first draft passes every static check but asks a summary per meeting by its TITLE, so the try-out fails
 *     (and Fireflies' error quotes the title); what goes back to the model is facts: the step, the error class, what it
 *     reads and the keys the list really has; never a meeting title;
 *   - the second draft reads the summary by id and passes its try-out: the plan arrives with how that went (a read of 2
 *     meetings and their 2 summaries, the AI's answer, nothing changed or sent), and it can be approved;
 *   - a draft that never passes is tried three times, says what still fails, and gets no Approve;
 *   - every try-out first asks the budget.
 *
 * Run: cd server && node --test usecases/coworkPlanner.tryOut.engine.pg.test.js
 */

'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert');

const { pg, store } = require('../core/cowork/coworkEngine.testkit').coworkOnEngine();
const world = require('../core/cowork/firefliesWorld.testkit').firefliesWorld();

const automationStore = require('../stores/automationStore');
const { makePlan, plannerDeps, builderPort } = require('./coworkPlanner.mts');
const { planStateOf, approvePlan } = require('./coworkPlan.mts');
const { MAX_TRY_ROUNDS } = require('./coworkPlannerTry.mts');

const OWNER = 'u-planner-try';
const TOOLS = world.TOOLS;

before(async () => { await automationStore.initDB(); });

const INPUTS = {
    fireflies_list_transcripts: { type: 'object', properties: { fromDate: { type: 'string' } } },
    fireflies_get_summary: { type: 'object', properties: { transcriptId: { type: 'string' } }, required: ['transcriptId'] },
};
const catalog = () => ({
    apps: [{ id: 'fireflies', name: 'Fireflies', available: true, actions: TOOLS.map((name) => ({ name, description: name, inputSchema: INPUTS[name] })) }],
    toolNames: new Set(TOOLS),
});

const calls = (...list) => ({ toolCalls: list.map(([name, args], i) => ({ id: `call_${name}_${i}`, function: { name, arguments: JSON.stringify(args) } })), usage: { input_tokens: 100, output_tokens: 20 } });
const says = (content) => ({ content, toolCalls: [], usage: { input_tokens: 50, output_tokens: 10 } });
const ref = (path) => ({ kind: 'ref', path });

/** The first draft: wired right, but a summary is asked by the meeting's title. */
const BATCH = [
    { tempId: 'now', type: 'datetime', spec: { label: 'Now', op: 'now' } },
    { tempId: 'week', type: 'datetime', spec: { label: 'A week ago', op: 'addDays', amount: -7, input: 'steps.$now.output.iso' } },
    { tempId: 'list', type: 'integration_action', spec: { tool: 'fireflies_list_transcripts', label: 'List meetings', inputs: { fromDate: ref('steps.$week.output.iso') } } },
    { tempId: 'sums', type: 'integration_action', spec: { tool: 'fireflies_get_summary', label: 'Get summaries', forEach: { overRef: 'steps.$list.output.results', itemVar: 't' }, inputs: { transcriptId: ref('loop.t.title') } } },
    { tempId: 'ai', type: 'ai_step', spec: { label: 'Write the overview', prompt: 'Write a short overview of these meetings: {{steps.$sums.output.results}}' } },
    { tempId: 'tell', type: 'notification', spec: { label: 'Send me the overview', title: 'Your meetings', body: '{{steps.$ai.output}}' } },
];
const INSPECT = calls(['builder_inspect_tool', { tools: TOOLS }]);
const DONE = says('Each Monday it lists last week\'s meetings, gets their summaries, writes an overview and tells you.');

/** The real step id of a batch handle, from the builder's answer in the conversation. */
function idOf(messages, handle) {
    for (const m of messages) {
        if (m.role !== 'tool' || typeof m.content !== 'string' || !m.content.includes('idMap')) continue;
        const id = JSON.parse(m.content).idMap?.[handle];
        if (id) return id;
    }
    throw new Error(`no id for ${handle}`);
}

/** After a try-out report: read the summary by id. */
const repairById = ({ messages }) => calls(['builder_update_step', { stepId: idOf(messages, 'sums'), patch: { inputs: { transcriptId: ref('loop.t.id') } } }]);

function planner(script) {
    const seen = { chats: [], progress: [], spends: 0 };
    let turn = 0;
    const real = plannerDeps();
    const deps = {
        ...real,
        ownerRefusal: async () => null,
        resolveModel: async () => 'planner-model',
        tiersFor: async () => ({ fast: 'model-fast', thinking: 'model-thinking' }),
        chat: async (modelId, messages, options) => {
            seen.chats.push(structuredClone(messages));
            const next = script[turn++];
            return typeof next === 'function' ? next({ messages, options }) : next ?? DONE;
        },
        logUsage: () => {},
        builder: { ...builderPort(), catalogFor: async () => catalog(), datatablesFor: async () => [] },
        mayAsk: async () => false,
        tries: { ...real.tries, spendLeft: async () => { seen.spends += 1; } },
    };
    return { deps, seen };
}

async function newItem(title) {
    const created = await store.createSchedule({ userId: OWNER, title, prompt: 'Every Monday, summarise my Fireflies meetings of last week and send me the overview.', repeatInterval: 'weekly', nextRunAt: new Date(Date.now() + 86_400_000).toISOString() });
    return store.getSchedule(created.id);
}

let made = null;
test('the first draft fails its try-out, the facts go back without a meeting title, and the second draft passes', async () => {
    const item = await newItem('Meeting overview');
    const reports = [];
    const repair = (input) => { reports.push(input.messages.at(-1)); return repairById(input); };
    const { deps, seen } = planner([INSPECT, calls(['builder_add_steps', { steps: BATCH }]), DONE, repair, DONE]);
    made = { item, result: await makePlan({ item, userOrgId: null, onProgress: (p) => seen.progress.push(p.phase) }, deps), seen };
    const { result } = made;

    assert.deepStrictEqual([result.tried.status, result.tried.rounds, result.findings], ['passed', 2, []]);
    assert.deepStrictEqual(result.tried.summary.reads, [{ title: 'List meetings', items: 2 }, { title: 'Get summaries', items: 2 }]);
    assert.strictEqual(result.tried.summary.ai, 1);
    assert.deepStrictEqual(seen.progress.filter((p) => p === 'trying' || p === 'repairing'), ['trying', 'repairing', 'trying']);
    assert.strictEqual(seen.spends, 2, 'one try-out per round, each through the budget');

    const [report] = reports;
    assert.strictEqual(report.role, 'user');
    assert.match(report.content, /^\[TRY-OUT REPORT - machine-generated\]/);
    const facts = JSON.parse(report.content.slice(report.content.indexOf('\n') + 1));
    const failed = facts.find((f) => f.kind === 'step_failed');
    assert.strictEqual(failed.step, 'Get summaries');
    assert.ok(typeof failed.errorClass === 'string' && failed.errorClass.length > 0);
    assert.deepStrictEqual(failed.reads[0], { from: 'List meetings', field: 'results', keys: ['results', 'count', 'message'] });
    assert.deepStrictEqual(facts.filter((f) => f.kind === 'not_reached').map((f) => f.step), ['Write the overview', 'Send me the overview']);
});

test('no meeting text reached the planner\'s prompts, the try-out record or the plan', async () => {
    const { item, seen } = made;
    assert.ok(world.calls.some((c) => c.tool === 'fireflies_get_summary'), 'the try-outs did read the meetings');
    const told = JSON.stringify(seen.chats);
    assert.ok(!told.includes(world.MARKER), 'no title, no overview and no app error text in any prompt');
    assert.ok(!told.includes('example.com'), 'no participant');
    const kept = JSON.stringify((await pg.query('SELECT plan_try_json FROM cowork_schedules WHERE id = $1', [item.id])).rows);
    assert.ok(!kept.includes(world.MARKER));
});

test('the plan is shown with its try-out, and it can be approved', async () => {
    const item = await store.getSchedule(made.item.id);
    const state = await planStateOf(item);
    assert.deepStrictEqual(
        { status: state.tried.status, current: state.tried.current, required: state.tried.required, blocksApproval: state.tried.blocksApproval, reads: state.tried.summary.reads },
        { status: 'passed', current: true, required: true, blocksApproval: false, reads: [{ title: 'List meetings', items: 2 }, { title: 'Get summaries', items: 2 }] },
    );
    const approved = await approvePlan({ item, fingerprint: state.draft.fingerprint });
    assert.strictEqual(approved.approved.version, 1);
});

test('a draft that never passes is tried three times, says what fails, and gets no Approve', async () => {
    const item = await newItem('Never passes');
    const { deps, seen } = planner([INSPECT, calls(['builder_add_steps', { steps: BATCH }]), DONE, DONE, DONE]);
    const result = await makePlan({ item, userOrgId: null }, deps);
    assert.deepStrictEqual([result.tried.status, result.tried.rounds], ['failed', MAX_TRY_ROUNDS]);
    assert.strictEqual(seen.spends, MAX_TRY_ROUNDS);
    assert.ok(result.tried.problems.some((p) => p.startsWith('\'Get summaries\' failed')), result.tried.problems.join(' | '));
    assert.ok(!JSON.stringify(result.tried).includes(world.MARKER));

    const fresh = await store.getSchedule(item.id);
    const state = await planStateOf(fresh);
    assert.deepStrictEqual([state.draft.findings, state.tried.blocksApproval], [[], true]);
    await assert.rejects(approvePlan({ item: fresh, fingerprint: state.draft.fingerprint }), (e) => e.status === 422 && e.code === 'cowork_plan_untried');
});
