/**
 * Cowork fixes the WIRING of a plan that is not approved yet (./coworkPlanWiringRepair.mts), on the REAL automation
 * engine and the real stores (PGlite behind db.js); only Fireflies and the model are stood in for
 * (core/cowork/firefliesWorld.testkit.js). The case is the owner's Fireflies item on dev:
 *
 *   - the plan lists the meetings, gets their summaries and has the AI step write the overview, but "Notification"
 *     reads `{{steps.ai_1.output}}` and starts from the trigger: it does not wait for the AI step. The card says "This
 *     plan cannot run as it is" and offers no Approve;
 *   - Cowork fixes it by itself: "Notification" waits for "AI step", with exactly the same permissions; the plan is
 *     stored and still NOT approved, the trail says Cowork did it (step ids, no proof needed), and a try-out of exactly
 *     that plan ran, so the card shows how it went and Approve is possible;
 *   - a fix that would reach more, an approved plan, a read-only organisation and an item of someone else are refused,
 *     and the plan stays as it was; a spent budget leaves the wiring fixed but untried, and says so;
 *   - a marker planted in the meeting titles appears in no trail row, try-out record or plan.
 *
 * Run: cd server && node --require ./testUtils/registerFeatures.js --test usecases/coworkPlanWiringRepair.engine.pg.test.js
 */

'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert');

const { pg, store } = require('../core/cowork/coworkEngine.testkit').coworkOnEngine();
const world = require('../core/cowork/firefliesWorld.testkit').firefliesWorld();

const automationStore = require('../stores/automationStore');
const { repairDraftWiring, repairDeps, fixDraftWiring } = require('./coworkPlanWiringRepair.mts');
const { attachPlan, approvePlan, planStateOf } = require('./coworkPlan.mts');
const { trailOf } = require('./coworkAudit.mts');
const { permissionsOf, planFingerprint } = require('../core/cowork/plan/planPermissions.mts');
const { toolLookups } = require('../core/cowork/plan/planLookups.mts');
const { HttpError } = require('../core/http/errors');

const OWNER = 'u-draft-wiring';
const ref = (path) => ({ kind: 'ref', path });

before(async () => { await automationStore.initDB(); });

/** The owner's plan: everything in order, except that "Notification" starts from the trigger. */
function ownersPlan() {
    const steps = [
        { id: 'ff_list', type: 'integration_action', label: 'fireflies_list_transcripts', tool: 'fireflies_list_transcripts', inputs: {} },
        { id: 'ff_sum', type: 'integration_action', tool: 'fireflies_get_summary', inputs: { transcriptId: ref('loop.t.id') }, forEach: { overRef: 'steps.ff_list.output.results', itemVar: 't' } },
        { id: 'ai_1', type: 'ai_step', label: 'AI step', prompt: 'Write a short overview of these meetings: {{steps.ff_sum.output.results}}' },
        { id: 'tell', type: 'notification', label: 'Notification', title: 'Meetings', body: '{{steps.ai_1.output}}', channels: ['notification'] },
    ];
    const edges = [{ from: 'trg', to: 'ff_list' }, { from: 'ff_list', to: 'ff_sum' }, { from: 'ff_sum', to: 'ai_1' }, { from: 'trg', to: 'tell' }];
    return { schemaVersion: 1, trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} }, steps, edges, vars: {} };
}

/** A plan whose fix would also change a step's own words (it names the step it reads in a note): more than the wiring. */
function wordyPlan() {
    const steps = [
        { id: 'dt_now', type: 'datetime', label: 'Now', op: 'now' },
        { id: 'dt_week', type: 'datetime', label: 'A week ago', op: 'addDays', amount: -7, input: 'steps.dt_old.output.iso', note: 'Counts back from steps.dt_old.output.iso as it was.' },
        { id: 'tell', type: 'notification', label: 'Notification', title: 'Since', body: 'Since {{steps.dt_week.output.iso}}', channels: ['notification'] },
    ];
    const edges = [{ from: 'trg', to: 'dt_now' }, { from: 'dt_now', to: 'dt_week' }, { from: 'dt_week', to: 'tell' }];
    return { schemaVersion: 1, trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} }, steps, edges, vars: {} };
}

/** An item of the owner with `definition` named as its plan, not approved. */
async function itemWithDraft(definition = ownersPlan()) {
    const automation = await automationStore.createAutomation({ userId: OWNER, title: 'Fireflies', definition, triggerType: 'manual' });
    const schedule = await store.createSchedule({ userId: OWNER, title: 'Fireflies', prompt: 'Summarise my Fireflies meetings and send me the overview.', repeatInterval: 'weekly', nextRunAt: new Date(Date.now() + 86_400_000).toISOString() });
    const state = await attachPlan({ item: await store.getSchedule(schedule.id), automationId: automation.id });
    return { item: await store.getSchedule(schedule.id), automation, state };
}

/** The real wiring, with the owner the runner runs for and the try-out waited for. */
const deps = (extra = {}) => ({ ...repairDeps(), ownerRefusal: async () => null, waitForTry: true, ...extra });
const definitionOf = async (automationId) => (await automationStore.getAutomation(automationId)).definition;
const tryRecord = async (itemId) => JSON.parse((await pg.query('SELECT plan_try_json FROM cowork_schedules WHERE id = $1', [itemId])).rows[0].plan_try_json ?? 'null');

let owner = null;
test('the owner\'s plan cannot run as it is: "Notification" does not wait for "AI step", and Cowork says it can fix that', async () => {
    const { item, automation, state } = await itemWithDraft();
    assert.deepStrictEqual(state.draft.findings.map((f) => [f.code, f.stepId]), [['wiring.ref_not_upstream', 'tell']]);
    assert.match(state.draft.findings[0].message, /^'Notification' reads from 'AI step', but does not wait for it/);
    assert.strictEqual(state.wiringFixable, true);
    assert.deepStrictEqual(state.draft.view.steps.map((s) => s.title), ['Fireflies: list transcripts', 'Fireflies: get summary', 'AI step', 'Notification'], 'a tool name is no title');
    owner = { item, automation, before: state };
});

test('Cowork fixes it by itself: it waits now, the same permissions, still not approved, tried once, and the trail says so', async () => {
    const { item, automation, before } = owner;
    const calls = world.calls.length;
    const repaired = await repairDraftWiring(item.id, OWNER, deps());
    assert.deepStrictEqual(repaired, { outcome: 'fixed', changes: [{ kind: 'waits', stepId: 'tell', otherId: 'ai_1' }], tried: 'passed', notTried: null });

    const fixed = await definitionOf(automation.id);
    assert.ok(fixed.edges.some((e) => e.from === 'ai_1' && e.to === 'tell'), 'Notification waits for the AI step');
    assert.ok(!fixed.edges.some((e) => e.from === 'trg' && e.to === 'tell'), 'and no longer starts from the trigger');
    assert.deepStrictEqual(permissionsOf(fixed, toolLookups()), permissionsOf(ownersPlan(), toolLookups()), 'exactly the same permissions');
    assert.deepStrictEqual(before.draft.permissions, permissionsOf(fixed, toolLookups()));

    const state = await planStateOf(await store.getSchedule(item.id));
    const fingerprint = planFingerprint(fixed);
    assert.strictEqual(state.draft.fingerprint, fingerprint);
    assert.deepStrictEqual([state.approved, await store.getApprovedPlan(item.id)], [null, null], 'nothing is approved');
    assert.deepStrictEqual([state.draft.findings, state.wiringFixable], [[], false]);
    assert.deepStrictEqual(
        { status: state.tried.status, current: state.tried.current, blocksApproval: state.tried.blocksApproval, rounds: state.tried.rounds, wiringFixed: state.tried.wiringFixed },
        { status: 'passed', current: true, blocksApproval: false, rounds: 1, wiringFixed: [{ kind: 'waits', step: 'Notification', other: 'AI step' }] },
    );
    assert.deepStrictEqual(state.tried.summary.reads.map((r) => r.items), [2, 2]);
    assert.ok(world.calls.length > calls && world.calls.slice(calls).some((c) => c.tool === 'fireflies_get_summary'), 'the try-out read Fireflies');

    const record = await tryRecord(item.id);
    assert.deepStrictEqual([record.status, record.fingerprint, record.wiring], ['passed', fingerprint, [{ kind: 'waits', stepId: 'tell', otherId: 'ai_1' }]]);
    const entry = (await trailOf(item.id, OWNER)).find((t) => t.action === 'cowork.plan_wiring_fixed');
    assert.ok(entry && entry.byCowork && !entry.byYou);
    assert.deepStrictEqual(entry.values, { stepId: 'tell', fingerprint, proof: 'none', wiring: [{ kind: 'waits', stepId: 'tell', otherId: 'ai_1' }] });

    // Approve is its owner's, and it works now.
    const approved = await approvePlan({ item: await store.getSchedule(item.id), fingerprint });
    assert.strictEqual(approved.upToDate, true);
});

test('an approved plan is refused, and so is a second fix of a plan that needs none', async () => {
    const { item, automation } = owner;
    const was = await definitionOf(automation.id);
    assert.deepStrictEqual((await repairDraftWiring(item.id, OWNER, deps())).outcome, 'approved');
    assert.deepStrictEqual(await definitionOf(automation.id), was);
    await assert.rejects(fixDraftWiring({ item: await store.getSchedule(item.id) }, deps()), (e) => e instanceof HttpError && e.status === 409 && e.code === 'cowork_wiring_approved');
});

test('a fix that would reach more than the wiring is refused, and the plan stays as it was', async () => {
    const { item, automation, state } = await itemWithDraft(wordyPlan());
    assert.strictEqual(state.wiringFixable, false);
    const repaired = await repairDraftWiring(item.id, OWNER, deps());
    assert.deepStrictEqual(repaired, { outcome: 'reach_differs', changes: [], tried: null, notTried: null });
    assert.deepStrictEqual(await definitionOf(automation.id), wordyPlan());
    assert.strictEqual(await tryRecord(item.id), null, 'nothing was tried');
    await assert.rejects(fixDraftWiring({ item }, deps()), (e) => e.status === 422 && e.code === 'cowork_wiring_reach');
});

test('a read-only organisation and someone else\'s item are refused, and the plan stays as it was', async () => {
    const { item, automation } = await itemWithDraft();
    const readOnly = await repairDraftWiring(item.id, OWNER, deps({ policyOf: async () => ({ ceiling: 'on_its_own', readOnly: true, unattendedApps: null, monthlyBudget: null, habitsAllowed: true, autoFix: true }) }));
    assert.strictEqual(readOnly.outcome, 'read_only');
    await assert.rejects(repairDraftWiring(item.id, 'u-someone-else', deps()), (e) => e.status === 403);
    await assert.rejects(repairDraftWiring('cw-no-such-item', OWNER, deps()), (e) => e.status === 404);
    assert.deepStrictEqual(await definitionOf(automation.id), ownersPlan());
});

test('a spent budget leaves the wiring fixed but untried, says so, and the owner\'s "Fix it for me" tries it later', async () => {
    const { item, automation } = await itemWithDraft();
    const spent = () => { throw new HttpError(409, 'cowork_budget_used', 'This cowork has used its AI budget for this month.'); };
    const calls = world.calls.length;
    const repaired = await repairDraftWiring(item.id, OWNER, deps({ spendLeft: async () => spent() }));
    assert.deepStrictEqual(repaired, { outcome: 'fixed', changes: [{ kind: 'waits', stepId: 'tell', otherId: 'ai_1' }], tried: 'untried', notTried: 'Not tried: This cowork has used its AI budget for this month.' });
    assert.strictEqual(world.calls.length, calls, 'nothing was read');
    const state = await planStateOf(await store.getSchedule(item.id));
    assert.deepStrictEqual([state.draft.findings, state.tried.status, state.tried.problems, state.tried.wiringFixed], [[], 'untried', ['Not tried: This cowork has used its AI budget for this month.'], [{ kind: 'waits', step: 'Notification', other: 'AI step' }]]);
    assert.ok((await definitionOf(automation.id)).edges.some((e) => e.from === 'ai_1' && e.to === 'tell'));

    const again = await fixDraftWiring({ item: await store.getSchedule(item.id) }, deps());
    assert.deepStrictEqual([again.outcome, again.tried, again.state.tried.status, again.state.tried.wiringFixed.length], ['tried', 'passed', 'passed', 1]);
    await assert.rejects(fixDraftWiring({ item: await store.getSchedule(item.id) }, deps()), (e) => e.status === 409 && e.code === 'cowork_wiring_nothing');
});

test('no meeting text reached the trail, the try-out records or the plans', async () => {
    const rows = await pg.query('SELECT id FROM cowork_schedules WHERE user_id = $1', [OWNER]);
    const ids = rows.rows.map((r) => r.id);
    const kept = JSON.stringify([
        (await pg.query('SELECT * FROM access_audit_log WHERE target_id = ANY($1)', [ids])).rows,
        (await pg.query('SELECT plan_try_json FROM cowork_schedules WHERE id = ANY($1)', [ids])).rows,
        (await pg.query('SELECT definition_json, permissions_json FROM cowork_plans WHERE schedule_id = ANY($1)', [ids])).rows,
    ]);
    assert.ok(world.calls.some((c) => c.tool === 'fireflies_get_summary'), 'the try-outs did read the meetings');
    assert.ok(!kept.includes(world.MARKER), 'the marker in the meetings is nowhere');
    assert.ok(!kept.includes('example.com'), 'nor a participant');
});
