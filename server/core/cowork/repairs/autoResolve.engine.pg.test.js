/**
 * The automatic fix of a broken reference on the REAL automation engine and the real stores (PGlite behind db.js); only
 * the app (Fireflies) is a stub. The case it was built for: "summarise my Fireflies meetings of last week". The plan
 * lists the meetings, then gets a summary per meeting over `steps.list.output.transcripts` (the name inside the tool),
 * while the tool hands its list on as `results`:
 *
 *   - the run is INCOMPLETE, not a success: the per-meeting step found nothing to work on, and the item says so;
 *   - the fix reads only the SHAPE of what the list step returned (a marker planted in every meeting title appears
 *     nowhere it keeps or hands on), takes `output.results` (the one list), changes only that reference, keeps the
 *     permissions exactly, replays it on the run's own recording, and approves it as a new version by Cowork itself,
 *     with a trail entry and an Undo on the item;
 *   - the item runs once more right away and now gets a summary of every meeting; Undo restores the old fingerprint;
 *   - a list that resolved and was empty is a success and sets off nothing;
 *   - `autoFix: false`, a read-only organisation, a day's attempt used: nothing is applied;
 *   - a fix the replay does not prove is never applied: it becomes a repair its owner decides.
 *
 * Run: cd server && node --test core/cowork/repairs/autoResolve.engine.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { pg, store } = require('../coworkEngine.testkit').coworkOnEngine();

const automationStore = require('../../../stores/automationStore');
const proposalsStore = require('../../../stores/coworkProposals.mts');
const { executeTask } = require('../../aiTaskRunner');
const { attachPlan } = require('../../../usecases/coworkPlan.mts');
const { autoResolve, autoResolveDeps } = require('../../../usecases/coworkAutoResolve.mts');
const { proposalsOf } = require('../../../usecases/coworkProposals.mts');
const { restoreVersion } = require('../../../usecases/coworkPlanVersions.mts');
const { trailOf } = require('../../../usecases/coworkAudit.mts');
const { permissionsOf, planFingerprint } = require('../plan/planPermissions.mts');
const { toolLookups } = require('../plan/planLookups.mts');
const { checkAfterRun, stop, AUTO_FIX_APPROVER } = require('./autoResolve.mts');

const OWNER = 'u-auto-fix-engine';
const MARKER = 'MARKER-7f3a-do-not-leak';
const TOOLS = ['fireflies_list_transcripts', 'fireflies_get_summary'];
const literal = (value) => ({ kind: 'literal', value });
const ref = (path) => ({ kind: 'ref', path });
const OPEN = { ceiling: 'on_its_own', readOnly: false, unattendedApps: null, monthlyBudget: null, habitsAllowed: true, autoFix: true };

/** What the stub app answers: the real tool's shape (integrations/firefliesTools.js), with the marker in every title. */
let meetings = [];
const calls = [];
const original = {};
before(async () => {
    await automationStore.initDB();
    await proposalsStore.initDB();
    await require('../../../stores/coworkReplays.mts').initDB();
    const toolDispatcher = require('../../tools/toolDispatcher');
    const integrationTools = require('../../integrations/integrationTools');
    Object.assign(original, { toolDispatcher, integrationTools, executeTool: toolDispatcher.executeTool, getIntegrationTools: integrationTools.getIntegrationTools });
    toolDispatcher.executeTool = async (tool, inputs) => {
        calls.push({ tool, inputs });
        if (tool === 'fireflies_list_transcripts') return { results: meetings, count: meetings.length, message: `Found ${meetings.length} transcript(s).` };
        return { id: inputs.transcriptId, title: `${MARKER} summary`, summary: { overview: `${MARKER} overview` } };
    };
    integrationTools.getIntegrationTools = async () => ({ tools: TOOLS.map((name) => ({ type: 'function', function: { name } })) });
});
after(() => {
    stop();
    original.toolDispatcher.executeTool = original.executeTool;
    original.integrationTools.getIntegrationTools = original.getIntegrationTools;
});

/** List the meetings, summarise each one over `listPath`, tell the owner. */
function plan(listPath = 'steps.list.output.transcripts') {
    const steps = [
        { id: 'list', type: 'integration_action', label: 'List meetings', tool: 'fireflies_list_transcripts', inputs: { fromDate: literal('2026-11-16') } },
        { id: 'sums', type: 'integration_action', label: 'Get summaries', tool: 'fireflies_get_summary', inputs: { transcriptId: ref('loop.t.id') }, forEach: { overRef: listPath, itemVar: 't' } },
        { id: 'tell', type: 'notification', label: 'Send me the overview', title: 'Your meetings', body: 'The summaries are ready.', channels: ['notification'] },
    ];
    const ids = ['trg', ...steps.map((s) => s.id)];
    return { schemaVersion: 1, trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} }, steps, edges: ids.slice(1).map((to, i) => ({ from: ids[i], to })), vars: {} };
}

/**
 * An item whose plan was approved before the reference check existed: stored as approved directly, as an older
 * approval left it (the approval of today refuses `transcripts`: core/cowork/plan/planRefs.mts).
 */
async function itemWithPlan(definition = plan(), title = 'Meeting overview') {
    const automation = await automationStore.createAutomation({ userId: OWNER, title, definition, triggerType: 'manual' });
    const schedule = await store.createSchedule({ userId: OWNER, title, prompt: 'Summarise my Fireflies meetings of last week and send me the overview.', repeatInterval: 'weekly', nextRunAt: new Date(Date.now() + 86_400_000).toISOString() });
    const attached = await attachPlan({ item: await store.getSchedule(schedule.id), automationId: automation.id });
    await store.approvePlan({ scheduleId: schedule.id, automationId: automation.id, definition, permissions: attached.draft.permissions, fingerprint: attached.draft.fingerprint, approvedBy: OWNER });
    return { item: await store.getSchedule(schedule.id), automation };
}

const latestRun = async (item) => (await pg.query('SELECT * FROM cowork_runs WHERE schedule_id = $1 ORDER BY started_at DESC, id DESC LIMIT 1', [item.id])).rows[0];
const runNow = async (item) => { await executeTask(await store.getSchedule(item.id), { manual: true, store }); return latestRun(item); };

/** The fix's own wiring, with the policy open, the rerun on this engine, and what the model would be asked recorded. */
function fixDeps(over = {}) {
    const asked = [];
    const deps = {
        ...autoResolveDeps(),
        rerun: async (item) => executeTask(await store.getSchedule(item.id), { manual: true, store }),
        chooseList: async (input) => { asked.push(JSON.stringify(input)); return 0; },
        ...over,
    };
    return { asked, deps };
}
const checkDeps = (policy = OPEN) => ({
    getSchedule: (id) => store.getSchedule(id),
    judgedRun: (id, runId) => require('../../../stores/coworkRunOutcomes.mts').coworkRunOutcomes().judgedRun(id, runId),
    proposals: proposalsStore.coworkProposals(),
    policyOf: async () => policy,
    now: () => new Date(),
});

let fireflies = null;
test('the Fireflies plan: the run is incomplete, not a success, and says why', async () => {
    meetings = [1, 2, 3].map((n) => ({ id: `t${n}`, title: `${MARKER} weekly ${n}`, date: '2026-11-17', participants: [`p${n}@example.com`] }));
    const { item, automation } = await itemWithPlan();
    const run = await runNow(item);
    assert.strictEqual(run.status, 'incomplete', run.error);
    assert.strictEqual(run.result, "Did not do its work: step 'Get summaries' found nothing to work on.");
    const outcome = JSON.parse(run.outcome_json);
    assert.deepStrictEqual(outcome, { kind: 'incomplete', unresolved: [{ stepId: 'sums', field: 'forEach.overRef', ref: 'steps.list.output.transcripts', sourceStepId: 'list', found: 'nothing' }] });
    assert.strictEqual((await store.getSchedule(item.id)).lastStatus, 'incomplete', 'the item says it too');
    const stats = await store.getRunStats(item.id);
    assert.deepStrictEqual([stats.success, stats.failed], [0, 1], 'it counts as something that went wrong');
    assert.deepStrictEqual(calls.map((c) => c.tool), ['fireflies_list_transcripts'], 'no summary was asked for');
    fireflies = { item, automation, run };
});

test('the fix reads the shape only, changes only the reference, keeps the permissions, replays, approves as Cowork and runs the item again', async () => {
    const { item, run } = fireflies;
    const before = await store.getApprovedPlan(item.id);
    const callsBefore = calls.length;
    const { asked, deps } = fixDeps();
    let outcome = null;
    const checked = await checkAfterRun(item, run.id, async (it, judged, fact) => { outcome = await autoResolve(it, judged, fact, deps); }, checkDeps());
    assert.deepStrictEqual([checked, outcome], ['resolving', 'fixed_and_rerun']);
    assert.deepStrictEqual(asked, [], 'the one list answered it: no model');

    const fixed = await store.getApprovedPlan(item.id);
    assert.strictEqual(fixed.version, before.version + 1);
    assert.strictEqual(fixed.definition.steps.find((s) => s.id === 'sums').forEach.overRef, 'steps.list.output.results');
    assert.strictEqual(planFingerprint(fixed.definition), planFingerprint(plan('steps.list.output.results')), 'only that reference changed');
    assert.deepStrictEqual(permissionsOf(fixed.definition, toolLookups()), permissionsOf(before.definition, toolLookups()), 'the permissions are exactly the same');
    const row = (await pg.query('SELECT approved_by FROM cowork_plans WHERE schedule_id = $1 AND version = $2', [item.id, fixed.version])).rows[0];
    assert.strictEqual(row.approved_by, AUTO_FIX_APPROVER);

    // The replay touched no app; the rerun did, once per meeting, and ended well.
    const rerunCalls = calls.slice(callsBefore).map((c) => c.tool);
    assert.deepStrictEqual(rerunCalls, ['fireflies_list_transcripts', 'fireflies_get_summary', 'fireflies_get_summary', 'fireflies_get_summary']);
    const again = await latestRun(item);
    assert.deepStrictEqual([again.status, again.plan_id], ['success', fixed.id], again.error);

    // The item shows it with its Undo, and the trail says what happened, by Cowork.
    const { proposals } = await proposalsOf(await store.getSchedule(item.id));
    const note = proposals.find((p) => p.reasonCode === 'reference_fixed');
    assert.deepStrictEqual([note.status, note.stepTitle, note.undoVersion], ['approved', 'Get summaries', before.version]);
    const trail = await trailOf(item.id, OWNER);
    const entry = trail.find((t) => t.action === 'cowork.plan_auto_fixed');
    assert.ok(entry && !entry.byYou, 'a trail entry, not by the owner');
    assert.deepStrictEqual([entry.values.stepId, entry.values.version], ['sums', fixed.version]);
});

test('no value of the output reached the stored facts, the trail or the proposal', async () => {
    const { item } = fireflies;
    const kept = JSON.stringify([
        (await pg.query('SELECT outcome_json, result, error FROM cowork_runs WHERE schedule_id = $1', [item.id])).rows,
        (await pg.query('SELECT * FROM cowork_proposals WHERE schedule_id = $1', [item.id])).rows,
        (await pg.query(`SELECT * FROM access_audit_log WHERE target_id = $1`, [item.id])).rows,
        (await pg.query('SELECT definition_json, permissions_json FROM cowork_plans WHERE schedule_id = $1', [item.id])).rows,
    ]);
    assert.ok(!kept.includes(MARKER), 'the marker in the meetings is nowhere');
    assert.ok(!kept.includes('example.com'), 'nor a participant');
});

test('Undo brings the old fingerprint back', async () => {
    const { item } = fireflies;
    const original = planFingerprint(plan());
    const { proposals } = await proposalsOf(await store.getSchedule(item.id));
    const note = proposals.find((p) => p.reasonCode === 'reference_fixed');
    await restoreVersion({ item: await store.getSchedule(item.id), version: note.undoVersion });
    assert.strictEqual((await store.getApprovedPlan(item.id)).fingerprint, original);
    const after = await proposalsOf(await store.getSchedule(item.id));
    assert.strictEqual(after.proposals.find((p) => p.reasonCode === 'reference_fixed').undoVersion, null, 'undone: no Undo any more');
});

test('a day\'s attempt is used: the same item is not fixed again by itself', async () => {
    const { item } = fireflies;
    const run = await runNow(item);
    assert.strictEqual(run.status, 'incomplete');
    const checked = await checkAfterRun(item, run.id, async () => assert.fail('not again today'), checkDeps());
    assert.strictEqual(checked, 'tried_today');
});

test('a list that resolved and was empty is a success and sets off nothing', async () => {
    meetings = [];
    const { item } = await itemWithPlan(plan('steps.list.output.results'), 'No meetings this week');
    const run = await runNow(item);
    assert.strictEqual(run.status, 'success', run.error);
    assert.strictEqual(run.outcome_json, null);
    assert.strictEqual(await checkAfterRun(item, run.id, async () => assert.fail('nothing to fix'), checkDeps()), 'not_incomplete');
});

test('autoFix switched off, or a read-only organisation: nothing is applied', async () => {
    meetings = [{ id: 't9', title: 'Retro' }];
    const { item } = await itemWithPlan(plan(), 'Switched off');
    const run = await runNow(item);
    assert.strictEqual(run.status, 'incomplete');
    const never = async () => assert.fail('never applied');
    assert.strictEqual(await checkAfterRun(item, run.id, never, checkDeps({ ...OPEN, autoFix: false })), 'switched_off');
    assert.strictEqual(await checkAfterRun(item, run.id, never, checkDeps({ ...OPEN, readOnly: true })), 'read_only');
    assert.strictEqual((await store.getApprovedPlan(item.id)).version, 1);
});

test('a fix the replay does not prove is never applied: it becomes a repair its owner decides', async () => {
    meetings = [{ id: 't7', title: `${MARKER} planning` }];
    const { item } = await itemWithPlan(plan(), 'Not proven');
    const run = await runNow(item);
    const { deps } = fixDeps({ replayOnRecording: async () => null, rerun: async () => assert.fail('no rerun') });
    let outcome = null;
    await checkAfterRun(item, run.id, async (it, judged, fact) => { outcome = await autoResolve(it, judged, fact, deps); }, checkDeps());
    assert.strictEqual(outcome, 'proposed');
    assert.strictEqual((await store.getApprovedPlan(item.id)).version, 1, 'the plan stays as approved');
    const { proposals: [repair] } = await proposalsOf(await store.getSchedule(item.id));
    assert.deepStrictEqual([repair.status, repair.reasonCode, repair.stepTitle], ['open', 'reference_unresolved', 'Get summaries']);
    assert.deepStrictEqual(repair.changes.map((c) => [c.id, c.change]), [['sums', 'changed']]);
});

test('when the shape does not answer, the model chooses among the lists from their paths and the titles alone', async () => {
    meetings = [{ id: 't5', title: `${MARKER} kickoff` }];
    const definition = plan();
    // A step before it that hands on two lists (and a title match): the one-list rule does not answer.
    definition.steps[0].inputs.title = literal('kickoff');
    const { item } = await itemWithPlan(definition, 'Two lists');
    const original = original_list();
    const run = await runNow(item);
    restore_list(original);
    const { asked, deps } = fixDeps({ rerun: async () => {} });
    await checkAfterRun(item, run.id, (it, judged, fact) => autoResolve(it, judged, fact, deps), checkDeps());
    assert.strictEqual(asked.length, 1, 'the model was asked once');
    assert.ok(!asked[0].includes(MARKER) && asked[0].includes('steps.list.output.results') && asked[0].includes('Get summaries'), 'paths and titles, no value');
    assert.strictEqual((await store.getApprovedPlan(item.id)).definition.steps.find((s) => s.id === 'sums').forEach.overRef, 'steps.list.output.results');
});

/** For one run, the list tool also hands on `exactMatches`, as it does when a title was asked. */
function original_list() {
    const toolDispatcher = original.toolDispatcher;
    const before = toolDispatcher.executeTool;
    toolDispatcher.executeTool = async (tool, inputs) => {
        const out = await before(tool, inputs);
        return tool === 'fireflies_list_transcripts' ? { ...out, matchQuality: 'exact', exactMatches: meetings } : out;
    };
    return before;
}
function restore_list(before) { original.toolDispatcher.executeTool = before; }
