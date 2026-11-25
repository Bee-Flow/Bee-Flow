/**
 * "Replay on last month" on the REAL automation engine and stores (PGlite behind db.js). A plan that reads, changes
 * and sends runs for real twice; then the owner changes it and replays it on those two runs. What is proven against
 * the runner itself:
 *
 *   - a replay dispatches NOTHING to any app (the tool dispatcher's executeTool is the spy: it saw the live runs'
 *     calls and none of the replays'), and sends no notification;
 *   - the same plan comes out the same on each run; a changed mail differs at that step; a read that asks something
 *     else than then has no recording and the run is replayed in part;
 *   - a run that followed no plan, and one older than the run history keeps, are not replayable;
 *   - a live run ignores a harness with recorded reads: it reads from the app.
 *
 * The dispatcher and the tool catalog are the only things set by hand: this server has no Drive and no mailbox.
 *
 * Run: cd server && node --test core/cowork/replay/replay.engine.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { pg, store } = require('../coworkEngine.testkit').coworkOnEngine();

const automationStore = require('../../../stores/automationStore');
const { executeTask } = require('../../aiTaskRunner');
const { attachPlan, approvePlan } = require('../../../usecases/coworkPlan.mts');
const { startReplay, replayStateOf, replayDeps } = require('../../../usecases/coworkReplay.mts');
const { executeAutomation } = require('../../automationRunner');

const OWNER = 'u-replay-engine';
const TOOLS = ['drive_search', 'drive_create_folder', 'outlook_compose'];
const literal = (value) => ({ kind: 'literal', value });
const template = (value) => ({ kind: 'template', value });

/** Every call that reached the dispatcher. */
const calls = [];
/** The dispatcher and the catalog, loaded once the schema is in place (they start stores of their own). */
let toolDispatcher = null;
let integrationTools = null;
const original = {};
before(async () => {
    await automationStore.initDB();
    await require('../../../stores/coworkReplays.mts').initDB();
    toolDispatcher = require('../../tools/toolDispatcher');
    integrationTools = require('../../integrations/integrationTools');
    Object.assign(original, { executeTool: toolDispatcher.executeTool, getIntegrationTools: integrationTools.getIntegrationTools });
    toolDispatcher.executeTool = async (tool, inputs) => {
        calls.push({ tool, inputs });
        if (tool === 'drive_search') return { files: [{ id: 'f1', name: 'Order 12.pdf' }, { id: 'f2', name: 'Order 19.pdf' }], count: 2 };
        if (tool === 'drive_create_folder') return { id: 'folder-1', name: inputs.name };
        return { sent: true, id: 'mail-1' };
    };
    integrationTools.getIntegrationTools = async () => ({ tools: TOOLS.map((name) => ({ type: 'function', function: { name } })) });
});
after(() => {
    toolDispatcher.executeTool = original.executeTool;
    integrationTools.getIntegrationTools = original.getIntegrationTools;
});

/** Read the overdue orders, put them in a folder, mail the supplier. */
function plan({ query = 'overdue', subject = 'Overdue orders' } = {}) {
    const steps = [
        { id: 'files', type: 'integration_action', label: 'Find the overdue orders', tool: 'drive_search', inputs: { query: literal(query), modifiedAfter: { kind: 'ref', path: 'trigger.output.since' } } },
        { id: 'folder', type: 'integration_action', label: 'Put them in a folder', tool: 'drive_create_folder', inputs: { name: template('Overdue ({{steps.files.output.count}})') } },
        { id: 'send', type: 'integration_action', label: 'Mail the supplier', tool: 'outlook_compose', inputs: { to: literal('orders@supplier.example'), subject: literal(subject), body: template('{{steps.files.output.count}} orders are overdue.') } },
    ];
    const ids = ['trg', ...steps.map((s) => s.id)];
    return { schemaVersion: 1, trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} }, steps, edges: ids.slice(1).map((to, i) => ({ from: ids[i], to })), vars: {} };
}

const notifications = async () => (await pg.query('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1', [OWNER])).rows[0].n;

/** Start a replay whose background work the test keeps, wait for it, and read how it ended. */
async function replayed(item, limit) {
    let work = null;
    const deps = { ...replayDeps(), inBackground: (fn) => { work = fn(); } };
    const { replayId, total } = await startReplay({ item, limit }, deps);
    await work;
    const state = await replayStateOf({ item, replayId }, deps);
    return { total, state, byRun: new Map(state.runs.map((r) => [r.pastRunId, r])) };
}

let world = null;
test('two real runs of a plan that reads, changes and sends', async () => {
    const automation = await automationStore.createAutomation({ userId: OWNER, title: 'Overdue orders', definition: plan(), triggerType: 'manual' });
    const schedule = await store.createSchedule({ userId: OWNER, title: 'Overdue orders', prompt: 'Chase the supplier.', repeatInterval: 'daily', nextRunAt: new Date(Date.now() + 86_400_000).toISOString() });
    const attached = await attachPlan({ item: await store.getSchedule(schedule.id), automationId: automation.id });
    assert.deepStrictEqual(attached.draft.findings, [], 'a plan Cowork runs');
    await approvePlan({ item: await store.getSchedule(schedule.id), fingerprint: attached.draft.fingerprint });
    for (let i = 0; i < 2; i++) await executeTask(await store.getSchedule(schedule.id), { manual: true, store });
    const runs = await store.listRuns(schedule.id);
    assert.deepStrictEqual(runs.map((r) => r.status), ['success', 'success'], runs.map((r) => r.error).join(' / '));
    assert.deepStrictEqual(calls.map((c) => c.tool), [...TOOLS, ...TOOLS], 'the live runs read, changed and sent for real');
    assert.notDeepStrictEqual(calls[0].inputs.modifiedAfter, calls[3].inputs.modifiedAfter, 'each run read since its own last time');

    // A run that ran as a prompt, and one older than the run history keeps.
    const promptRun = await store.markRunning(schedule.id, { triggerKind: 'manual' });
    await store.markCompleted(schedule.id, 'Asked the AI.', { runId: promptRun });
    const oldRun = await store.markRunning(schedule.id, { triggerKind: 'manual' });
    await store.markCompleted(schedule.id, 'Long ago.', { runId: oldRun });
    await pg.query(`UPDATE cowork_runs SET started_at = NOW() - INTERVAL '100 days', finished_at = NOW() - INTERVAL '100 days' WHERE id = $1`, [oldRun]);
    world = { automation, scheduleId: schedule.id, planRuns: runs.map((r) => r.id), promptRun, oldRun };
});

test('the same plan comes out the same on every run, and a replay touches no app and sends nothing', async () => {
    const item = await store.getSchedule(world.scheduleId);
    const [callsBefore, sentBefore] = [calls.length, await notifications()];
    const { total, state, byRun } = await replayed(item, 20);
    assert.strictEqual(total, 4);
    assert.deepStrictEqual([state.status, state.same, state.differs, state.partial, state.notReplayable], ['done', 2, 0, 0, 2]);
    for (const id of world.planRuns) assert.deepStrictEqual([byRun.get(id).verdict, byRun.get(id).missingSteps], ['same', 0]);
    assert.deepStrictEqual([byRun.get(world.promptRun).reason, byRun.get(world.oldRun).reason], ['no_plan', 'too_old']);
    assert.strictEqual(calls.length, callsBefore, 'nothing was dispatched to any app');
    assert.strictEqual(await notifications(), sentBefore, 'no notification');
});

test('a changed mail differs at that step; a read that asks something else has no recording', async () => {
    const item = await store.getSchedule(world.scheduleId);
    const [callsBefore, sentBefore] = [calls.length, await notifications()];

    await automationStore.updateAutomation(world.automation.id, { definition: plan({ subject: 'URGENT: overdue orders' }) }, OWNER);
    const changed = await replayed(item, 3);
    for (const id of world.planRuns) assert.deepStrictEqual([changed.byRun.get(id).verdict, changed.byRun.get(id).differingSteps], ['differs', ['send']]);

    await automationStore.updateAutomation(world.automation.id, { definition: plan({ query: 'late' }) }, OWNER);
    const other = await replayed(item, 3);
    for (const id of world.planRuns) {
        const line = other.byRun.get(id);
        assert.deepStrictEqual([line.verdict, line.missingSteps], ['partial', 1], 'the search for "late" was never made then');
    }
    assert.strictEqual(calls.length, callsBefore, 'nothing was dispatched to any app, also not the read without a recording');
    assert.strictEqual(await notifications(), sentBefore, 'no notification');
});

test('one replay at a time per item', async () => {
    const item = await store.getSchedule(world.scheduleId);
    let work = null;
    const deps = { ...replayDeps(), inBackground: (fn) => { work = fn; } };
    await startReplay({ item, limit: 1 }, deps);
    await assert.rejects(() => startReplay({ item, limit: 1 }, deps), (e) => e.status === 409 && e.code === 'cowork_replay_running');
    await work();
});

test('a live run ignores a harness with recorded reads: it reads from the app', async () => {
    const before = calls.length;
    const harness = { recordedReads: { recordedOnly: true, byKey: {}, unchanged: {}, outputHashes: {}, skipUpstream: [] } };
    const row = await executeAutomation({ ...world.automation, definition: plan() }, { triggerKind: 'manual', mode: 'live', startedByUserId: OWNER, harness, triggerPayload: { since: '', now: new Date().toISOString() } });
    assert.strictEqual(row.status, 'success', row.error);
    assert.deepStrictEqual(calls.slice(before).map((c) => c.tool), TOOLS, 'every step went to the app');
    const steps = await automationStore.getRunSteps(row.id);
    assert.deepStrictEqual(steps.find((s) => s.stepId === 'files').output.count, 2, 'the read is the app\'s answer, not a recording');
});
