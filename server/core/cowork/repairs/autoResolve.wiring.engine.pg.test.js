/**
 * The automatic fix of a plan's WIRING on the REAL automation engine and the real stores (PGlite behind db.js); only
 * Fireflies and the model are stood in for (../firefliesWorld.testkit.js). The case is the owner's plan from dev,
 * version 1, as the planner made it:
 *
 *   - the trigger fans out to the AI step, "Nu" and "Een week geleden"; "Een week geleden" reads
 *     `{{steps.dt_ac3ed7.output.iso}}`, a step that is not in the plan; the AI step reads nothing and runs first;
 *   - the run FAILS at "Een week geleden" ("did not resolve to a parseable date"), and Fireflies is never reached;
 *   - the resolver fixes it by itself with identical permissions: "Een week geleden" reads from "Nu" and waits for it,
 *     the AI step waits for the summaries and reads them. The run never reached the reads, so a replay cannot prove
 *     it: the proof is a try-out in test mode;
 *   - it is approved by Cowork with a trail entry and a note with Undo, and the item runs again: that run reaches
 *     Fireflies, gets the summaries and ends well;
 *   - a marker planted in the meeting titles appears in no proposal, trail row or stored fact;
 *   - Undo gives the old version back.
 *
 * Run: cd server && node --test core/cowork/repairs/autoResolve.wiring.engine.pg.test.js
 */

'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert');

const { pg, store } = require('../coworkEngine.testkit').coworkOnEngine();
const world = require('../firefliesWorld.testkit').firefliesWorld();

const { autoResolve, autoResolveDeps } = require('../../../usecases/coworkAutoResolve.mts');
const { checkAfterRun, AUTO_FIX_APPROVER, WIRING_FIX_REASON } = require('./autoResolve.mts');
const automationStore = require('../../../stores/automationStore');
const proposalsStore = require('../../../stores/coworkProposals.mts');
const { executeTask } = require('../../aiTaskRunner');
const { attachPlan, approvePlan } = require('../../../usecases/coworkPlan.mts');
const { proposalsOf } = require('../../../usecases/coworkProposals.mts');
const { restoreVersion } = require('../../../usecases/coworkPlanVersions.mts');
const { trailOf } = require('../../../usecases/coworkAudit.mts');
const { permissionsOf, planFingerprint } = require('../plan/planPermissions.mts');
const { toolLookups } = require('../plan/planLookups.mts');

const OWNER = 'u-wiring-engine';
const ref = (path) => ({ kind: 'ref', path });
const OPEN = { ceiling: 'on_its_own', readOnly: false, unattendedApps: null, monthlyBudget: null, habitsAllowed: true, autoFix: true };

before(async () => {
    await automationStore.initDB();
    await proposalsStore.initDB();
    await require('../../../stores/coworkReplays.mts').initDB();
});

/** The owner's plan, version 1. */
function ownersPlan() {
    const steps = [
        { id: 'ai_1', type: 'ai_step', label: 'AI step', prompt: 'Write a short overview of last week\'s meetings.' },
        { id: 'dt_now', type: 'datetime', label: 'Nu', op: 'now' },
        { id: 'dt_week', type: 'datetime', label: 'Een week geleden', op: 'addDays', amount: -7, input: '{{steps.dt_ac3ed7.output.iso}}' },
        { id: 'ff_list', type: 'integration_action', label: 'Fireflies list transcripts', tool: 'fireflies_list_transcripts', inputs: { fromDate: ref('steps.dt_week.output.iso') } },
        { id: 'ff_sum', type: 'integration_action', label: 'Fireflies get summary', tool: 'fireflies_get_summary', inputs: { transcriptId: ref('loop.t.id') }, forEach: { overRef: 'steps.ff_list.output.results', itemVar: 't' } },
        { id: 'tell', type: 'notification', label: 'Stuur mij het overzicht', title: 'Meetings', body: '{{steps.ai_1.output}}', channels: ['notification'] },
    ];
    const edges = [
        { from: 'trg', to: 'ai_1' }, { from: 'trg', to: 'dt_now' }, { from: 'trg', to: 'dt_week' },
        { from: 'dt_week', to: 'ff_list' }, { from: 'ff_list', to: 'ff_sum' }, { from: 'ai_1', to: 'tell' }, { from: 'ff_sum', to: 'tell' },
    ];
    return { schemaVersion: 1, trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} }, steps, edges, vars: {} };
}

/** An item whose version 1 was approved before the wiring check existed: stored as approved directly. */
async function itemWithPlan() {
    const definition = ownersPlan();
    const automation = await automationStore.createAutomation({ userId: OWNER, title: 'Fireflies', definition, triggerType: 'manual' });
    const schedule = await store.createSchedule({ userId: OWNER, title: 'Fireflies', prompt: 'Summarise my Fireflies meetings of last week and send me the overview.', repeatInterval: 'weekly', nextRunAt: new Date(Date.now() + 86_400_000).toISOString() });
    const attached = await attachPlan({ item: await store.getSchedule(schedule.id), automationId: automation.id });
    await store.approvePlan({ scheduleId: schedule.id, automationId: automation.id, definition, permissions: attached.draft.permissions, fingerprint: attached.draft.fingerprint, approvedBy: OWNER });
    return { item: await store.getSchedule(schedule.id), attached };
}

const latestRun = async (item) => (await pg.query('SELECT * FROM cowork_runs WHERE schedule_id = $1 ORDER BY started_at DESC, id DESC LIMIT 1', [item.id])).rows[0];
const runNow = async (item) => { await executeTask(await store.getSchedule(item.id), { manual: true, store }); return latestRun(item); };
const checkDeps = () => ({
    getSchedule: (id) => store.getSchedule(id),
    judgedRun: (id, runId) => require('../../../stores/coworkRunOutcomes.mts').coworkRunOutcomes().judgedRun(id, runId),
    proposals: proposalsStore.coworkProposals(),
    policyOf: async () => OPEN,
    now: () => new Date(),
    approvedDefinition: async (id) => (await store.getApprovedPlan(id))?.definition ?? null,
    lookups: toolLookups(),
});

let owner = null;
test('version 1: refused for approval as miswired, and its run fails at "Een week geleden" before Fireflies', async () => {
    const { item, attached } = await itemWithPlan();
    assert.deepStrictEqual(attached.draft.findings.map((f) => [f.code, f.stepId]), [['wiring.ref_unknown_step', 'dt_week'], ['wiring.ai_without_input', 'ai_1']]);
    await assert.rejects(approvePlan({ item, fingerprint: attached.draft.fingerprint }), (e) => e.code === 'cowork_plan_not_allowed');

    const run = await runNow(item);
    assert.strictEqual(run.status, 'error');
    assert.deepStrictEqual(JSON.parse(run.outcome_json), { kind: 'step_failed', stepId: 'dt_week', errorClass: 'datetime_unresolved_input', sourceStepId: 'dt_ac3ed7' });
    assert.deepStrictEqual(world.calls, [], 'Fireflies was never reached');
    owner = { item, run };
});

test('the run sets off the fix: identical permissions, proven by a try-out, approved by Cowork, and the rerun reaches Fireflies', async () => {
    const { item, run } = owner;
    const before = await store.getApprovedPlan(item.id);
    const seen = { tries: 0, replays: 0 };
    const real = autoResolveDeps();
    const deps = {
        ...real,
        rerun: async (it) => executeTask(await store.getSchedule(it.id), { manual: true, store }),
        tryOut: async (input) => { seen.tries += 1; return real.tryOut(input); },
        replayOnRecording: async (...a) => { seen.replays += 1; return real.replayOnRecording(...a); },
        chooseList: async () => assert.fail('no model is asked'),
    };
    let outcome = null;
    const checked = await checkAfterRun(item, run.id, async (it, judged, fact) => { outcome = await autoResolve(it, judged, fact, deps); }, checkDeps());
    assert.deepStrictEqual([checked, outcome], ['resolving', 'fixed_and_rerun']);
    assert.deepStrictEqual(seen, { tries: 1, replays: 0 }, 'the failed run never reached the reads: a try-out is the proof');

    const fixed = await store.getApprovedPlan(item.id);
    assert.strictEqual(fixed.version, before.version + 1);
    const week = fixed.definition.steps.find((s) => s.id === 'dt_week');
    assert.strictEqual(week.input, 'steps.dt_now.output.iso');
    assert.ok(fixed.definition.edges.some((e) => e.from === 'dt_now' && e.to === 'dt_week'));
    assert.ok(fixed.definition.edges.some((e) => e.from === 'ff_sum' && e.to === 'ai_1'));
    assert.ok(!fixed.definition.edges.some((e) => e.from === 'trg' && e.to === 'ai_1'));
    assert.deepStrictEqual(permissionsOf(fixed.definition, toolLookups()), permissionsOf(before.definition, toolLookups()), 'exactly the same permissions');
    const row = (await pg.query('SELECT approved_by FROM cowork_plans WHERE schedule_id = $1 AND version = $2', [item.id, fixed.version])).rows[0];
    assert.strictEqual(row.approved_by, AUTO_FIX_APPROVER);

    // The try-out and the rerun read Fireflies; the rerun got a summary of every meeting and ended well.
    assert.deepStrictEqual(world.calls.map((c) => c.tool), ['fireflies_list_transcripts', 'fireflies_get_summary', 'fireflies_get_summary', 'fireflies_list_transcripts', 'fireflies_get_summary', 'fireflies_get_summary']);
    const again = await latestRun(item);
    assert.deepStrictEqual([again.status, again.plan_id], ['success', fixed.id], again.error);
    const aiAsked = JSON.stringify(world.modelRequests.at(-1));
    assert.ok(aiAsked.includes('overview of t1') && aiAsked.includes('overview of t2'), 'the AI step works on the summaries now');

    // The note with its Undo says what changed, in titles; the trail says it by Cowork.
    const { proposals } = await proposalsOf(await store.getSchedule(item.id));
    const note = proposals.find((p) => p.reasonCode === WIRING_FIX_REASON);
    assert.deepStrictEqual([note.status, note.undoVersion], ['approved', before.version]);
    assert.deepStrictEqual(note.wiring, [{ kind: 'reads', step: 'AI step', other: 'Fireflies get summary' }, { kind: 'reads', step: 'Een week geleden', other: 'Nu' }]);
    const entry = (await trailOf(item.id, OWNER)).find((t) => t.action === 'cowork.plan_wiring_fixed');
    assert.ok(entry && !entry.byYou);
    assert.deepStrictEqual([entry.values.proof, entry.values.version], ['try_out', fixed.version]);
    assert.deepStrictEqual(entry.values.wiring, [{ kind: 'reads', stepId: 'dt_week', otherId: 'dt_now' }, { kind: 'waits', stepId: 'ai_1', otherId: 'ff_sum' }]);
});

test('no meeting text reached a proposal, the trail or a stored fact', async () => {
    const { item } = owner;
    const kept = JSON.stringify([
        (await pg.query('SELECT outcome_json, error FROM cowork_runs WHERE schedule_id = $1', [item.id])).rows,
        (await pg.query('SELECT * FROM cowork_proposals WHERE schedule_id = $1', [item.id])).rows,
        (await pg.query('SELECT * FROM access_audit_log WHERE target_id = $1', [item.id])).rows,
        (await pg.query('SELECT definition_json, permissions_json FROM cowork_plans WHERE schedule_id = $1', [item.id])).rows,
        (await pg.query('SELECT plan_try_json FROM cowork_schedules WHERE id = $1', [item.id])).rows,
        await proposalsOf(await store.getSchedule(item.id)),
    ]);
    assert.ok(!kept.includes(world.MARKER), 'the marker in the meetings is nowhere');
    assert.ok(!kept.includes('example.com'), 'nor a participant');
});

test('Undo brings version 1 back', async () => {
    const { item } = owner;
    const { proposals } = await proposalsOf(await store.getSchedule(item.id));
    const note = proposals.find((p) => p.reasonCode === WIRING_FIX_REASON);
    await restoreVersion({ item: await store.getSchedule(item.id), version: note.undoVersion });
    assert.strictEqual((await store.getApprovedPlan(item.id)).fingerprint, planFingerprint(ownersPlan()));
    const after = await proposalsOf(await store.getSchedule(item.id));
    assert.strictEqual(after.proposals.find((p) => p.reasonCode === WIRING_FIX_REASON).undoVersion, null, 'undone: no Undo any more');
});

test('a fix the try-out does not prove is never applied: it becomes a repair its owner decides', async () => {
    const { item } = await itemWithPlan();
    const run = await runNow(item);
    const deps = { ...autoResolveDeps(), tryOut: async () => ({ tryId: null, status: 'error', passed: false, facts: [], summary: { reads: [], ai: 0, held: 0 }, problems: [] }), rerun: async () => assert.fail('no rerun') };
    let outcome = null;
    await checkAfterRun(item, run.id, async (it, judged, fact) => { outcome = await autoResolve(it, judged, fact, deps); }, checkDeps());
    assert.strictEqual(outcome, 'proposed');
    assert.strictEqual((await store.getApprovedPlan(item.id)).version, 1, 'the plan stays as approved');
    const { proposals: [repair] } = await proposalsOf(await store.getSchedule(item.id));
    assert.deepStrictEqual([repair.status, repair.reasonCode, repair.stepTitle], ['open', 'wiring_broken', 'Een week geleden']);
});
