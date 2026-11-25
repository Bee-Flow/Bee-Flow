/**
 * Cowork's own proposals (./coworkProposals.mts): making one changes nothing but its own row, a proposal with findings
 * is dropped, a fixed step is offered only on a replay that is the same in 95% of at least ten past runs, approving
 * goes through the approval of a definition with the fingerprint looked at, and a proposal made on another plan is
 * stale and refused. The store, the amend mode, the replay and the approval are handed in (each has its own tests).
 *
 * Run: cd server && node --test usecases/coworkProposals.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { propose, proposalsOf, approveProposal, dismissProposal, proposeRepair, offerFixedStep, openRepairOf, replayPasses } = require('./coworkProposals.mts');
const { planFingerprint, permissionsOf } = require('../core/cowork/plan/planPermissions.mts');
const { fakeLookups, planOf, literal } = require('../core/cowork/plan/plan.testkit');

const lookups = fakeLookups();
const ITEM = { id: 'cw-1', userId: 'u1', title: 'Order radar', planAutomationId: 'auto-1', planId: 'p-1' };
const BASE = planOf([
    { id: 'orders', type: 'integration_action', label: 'Read the order table', tool: 'drive_search', inputs: { query: literal('orders') } },
    { id: 'sum', type: 'ai_step', label: 'Count the late orders', prompt: 'How many of {{steps.orders.output}} are late?' },
    { id: 'tell', type: 'notification', label: 'Tell me', title: 'Orders', body: '{{steps.sum.output.text}}', channels: ['notification'] },
]);
const REPAIRED = { ...BASE, steps: BASE.steps.map((s) => (s.id === 'orders' ? { ...s, inputs: { query: literal('open orders') } } : s)) };
const FIXED = { ...BASE, steps: BASE.steps.map((s) => (s.id === 'sum' ? { id: 'sum', type: 'set', label: 'Count the late orders', fields: { text: literal('2') } } : s)) };
const approvedOf = (definition) => ({ id: 'p-1', version: 3, definition, permissions: permissionsOf(definition, lookups), fingerprint: planFingerprint(definition) });
const replayOf = (same, differs = 0) => ({ replayId: 'rp-1', status: 'done', done: true, fingerprint: 'x', total: same + differs, same, differs, partial: 0, notReplayable: 0, runs: [] });

function memoryStore() {
    const rows = new Map();
    return {
        rows,
        createProposal: async (p) => {
            if ([...rows.values()].some((r) => r.scheduleId === p.scheduleId && r.kind === p.kind && r.status === 'open')) return null;
            const row = { ...structuredClone(p), status: 'open', createdAt: new Date().toISOString(), decidedAt: null };
            rows.set(p.id, row);
            return row;
        },
        getProposal: async (scheduleId, id) => (rows.get(id)?.scheduleId === scheduleId ? rows.get(id) : null),
        listProposals: async (scheduleId) => [...rows.values()].filter((r) => r.scheduleId === scheduleId).reverse(),
        openProposalOf: async (scheduleId, kind) => [...rows.values()].find((r) => r.scheduleId === scheduleId && r.kind === kind && r.status === 'open') ?? null,
        decideProposal: async (scheduleId, id, status) => {
            const r = rows.get(id);
            if (!r || r.scheduleId !== scheduleId || r.status !== 'open') return null;
            Object.assign(r, { status, decidedAt: new Date().toISOString() });
            return r;
        },
        markStale: async (scheduleId, fp) => {
            let n = 0;
            for (const r of rows.values()) if (r.scheduleId === scheduleId && r.status === 'open' && r.baseFingerprint !== fp) { r.status = 'stale'; n += 1; }
            return n;
        },
    };
}

function world({ amended = REPAIRED, findings = [], replay = replayOf(18, 2), approved = approvedOf(BASE) } = {}) {
    const seen = { amend: [], replays: [], approvals: [] };
    const plans = { approved, getApprovedPlan: async () => plans.approved, versionWithFingerprint: async (_id, fp) => (fp === planFingerprint(BASE) ? 3 : null) };
    const deps = {
        store: memoryStore(),
        plans,
        getAutomation: async (id) => (id === 'auto-1' ? { id, userId: 'u1', organizationId: 'org-1', definition: BASE } : null),
        isManaged: async () => false,
        judge: async (automation) => ({ view: {}, permissions: permissionsOf(automation.definition, lookups), findings: typeof findings === 'function' ? findings(automation.definition) : findings, fingerprint: planFingerprint(automation.definition) }),
        amend: async (input) => { seen.amend.push(input); return { definition: structuredClone(amended), summary: 'Changed it.', rounds: 2 }; },
        replay: { run: async (input) => { seen.replays.push(input); if (!replay) throw new Error('no past runs'); return replay; }, stateOf: async () => replay },
        approveDefinition: async (input) => { seen.approvals.push(input); plans.approved = approvedOf(input.definition); return {}; },
        lookups,
    };
    return { deps, seen };
}

const REPAIR = { kind: 'repair', reasonCode: 'step_failed_twice', stepId: 'orders', stepTitle: 'Read the order table', facts: { kind: 'step_failed', stepId: 'orders', stepTitle: 'Read the order table', errorClass: 'IntegrationError', runs: 2 }, bookOn: 'run-2' };

test('making a proposal keeps a row of its own and changes nothing else', async () => {
    const { deps, seen } = world();
    assert.strictEqual(await propose(ITEM, REPAIR, deps), 'proposed');
    const [row] = deps.store.rows.values();
    assert.deepStrictEqual([row.kind, row.status, row.baseFingerprint, row.fingerprint, row.replayId], ['repair', 'open', planFingerprint(BASE), planFingerprint(REPAIRED), 'rp-1']);
    assert.deepStrictEqual(seen.approvals, [], 'nothing is approved');
    assert.strictEqual(deps.plans.approved.fingerprint, planFingerprint(BASE), 'the approved plan is the same');
    assert.deepStrictEqual(seen.amend[0].approved, BASE);
    assert.deepStrictEqual([seen.amend[0].bookOn, seen.replays[0].definition], ['run-2', REPAIRED]);
    assert.strictEqual(await propose(ITEM, REPAIR, deps), 'open_exists', 'one open repair per item');
});

test('a proposal with findings is dropped, never stored; one that changes nothing too', async () => {
    const withFindings = world({ findings: [{ code: 'x', stepId: 'orders', message: 'Not allowed.' }] });
    assert.strictEqual(await propose(ITEM, REPAIR, withFindings.deps), 'findings');
    assert.strictEqual(withFindings.deps.store.rows.size, 0);
    assert.deepStrictEqual(withFindings.seen.replays, [], 'not even replayed');
    const same = world({ amended: BASE });
    assert.strictEqual(await propose(ITEM, REPAIR, same.deps), 'unchanged');
    assert.strictEqual(same.deps.store.rows.size, 0);
});

test('a repair is kept without a replay when there is nothing to replay it on', async () => {
    const { deps } = world({ replay: null });
    assert.strictEqual(await propose(ITEM, REPAIR, deps), 'proposed');
    assert.strictEqual([...deps.store.rows.values()][0].replayId, null);
});

test('a fixed step is offered only on a replay of that change that is the same in 95% of at least ten runs', async () => {
    const step = { stepId: 'sum', stepTitle: 'Count the late orders', runs: 12, bookOn: 'run-2' };
    const orgOf = async () => 'org-1';
    const below = world({ amended: FIXED, replay: replayOf(18, 2) });
    assert.strictEqual(await offerFixedStep(ITEM, step, below.deps, orgOf), 'below_threshold');
    assert.strictEqual(below.deps.store.rows.size, 0, 'below the threshold nothing surfaces');
    assert.deepStrictEqual([below.seen.replays[0].onlyPlan, below.seen.replays[0].outputOnly], [planFingerprint(BASE), ['sum']], 'replayed only on that change, on runs of the approved plan');

    const passes = world({ amended: FIXED, replay: replayOf(20) });
    assert.strictEqual(await offerFixedStep(ITEM, step, passes.deps, orgOf), 'proposed');
    assert.strictEqual([...passes.deps.store.rows.values()][0].kind, 'fixed_step');

    const otherSteps = world({ amended: REPAIRED, replay: replayOf(20) });
    assert.strictEqual(await offerFixedStep(ITEM, step, otherSteps.deps, orgOf), 'not_fixed', 'a change elsewhere is not the offer');
    assert.deepStrictEqual([replayPasses(replayOf(19, 1)), replayPasses(replayOf(9)), replayPasses({ ...replayOf(20), done: false }), replayPasses(null)], [true, false, false, false]);
});

test('approving: the fingerprint looked at, the plan it was made on, then through the approval of a definition', async () => {
    const { deps, seen } = world();
    await propose(ITEM, REPAIR, deps);
    const [row] = deps.store.rows.values();
    await assert.rejects(approveProposal({ item: ITEM, proposalId: row.id, fingerprint: 'a'.repeat(64) }, deps), (e) => e.status === 409 && e.code === 'cowork_proposal_changed');
    await assert.rejects(approveProposal({ item: ITEM, proposalId: 'nope', fingerprint: row.fingerprint }, deps), (e) => e.status === 404);
    const { proposals } = await approveProposal({ item: ITEM, proposalId: row.id, fingerprint: row.fingerprint }, deps);
    assert.deepStrictEqual(seen.approvals.map((a) => a.definition), [REPAIRED]);
    assert.strictEqual(proposals[0].status, 'approved');
    await assert.rejects(approveProposal({ item: ITEM, proposalId: row.id, fingerprint: row.fingerprint }, deps), (e) => e.code === 'cowork_proposal_closed');
});

test('approving a stale proposal is refused, and it is marked stale', async () => {
    const { deps, seen } = world();
    await propose(ITEM, REPAIR, deps);
    const [row] = deps.store.rows.values();
    deps.plans.approved = approvedOf(FIXED);
    await assert.rejects(approveProposal({ item: ITEM, proposalId: row.id, fingerprint: row.fingerprint }, deps), (e) => e.status === 409 && e.code === 'cowork_proposal_stale');
    assert.deepStrictEqual([row.status, seen.approvals.length], ['stale', 0]);
});

test('the list: the steps that change, what it may newly do, the replay; one that now has findings is not shown', async () => {
    const { deps } = world();
    await propose(ITEM, REPAIR, deps);
    const { proposals: [shown] } = await proposalsOf(ITEM, deps);
    assert.deepStrictEqual(shown.changes, [{ id: 'orders', title: 'Read the order table', kind: 'fixed', change: 'changed' }]);
    assert.deepStrictEqual([shown.replay.same, shown.replay.differs, shown.undoVersion], [18, 2, null]);

    const later = world({ findings: (def) => (planFingerprint(def) === planFingerprint(REPAIRED) ? [{ code: 'policy', stepId: null, message: 'No.' }] : []) });
    later.deps.store.rows.set('pr-x', { id: 'pr-x', scheduleId: ITEM.id, kind: 'repair', status: 'open', baseFingerprint: planFingerprint(BASE), definition: REPAIRED, fingerprint: planFingerprint(REPAIRED), widens: [], replayId: null });
    assert.deepStrictEqual((await proposalsOf(ITEM, later.deps)).proposals, []);
    assert.strictEqual(later.deps.store.rows.get('pr-x').status, 'stale');
});

test('an approved fixed step that is still the plan can be undone to the version it was made on', async () => {
    const { deps } = world({ amended: FIXED, replay: replayOf(20) });
    await offerFixedStep(ITEM, { stepId: 'sum', stepTitle: 'Count the late orders', runs: 12, bookOn: null }, deps, async () => null);
    const [row] = deps.store.rows.values();
    const { proposals: [made] } = await approveProposal({ item: ITEM, proposalId: row.id, fingerprint: row.fingerprint }, deps);
    assert.deepStrictEqual([made.status, made.undoVersion], ['approved', 3]);
});

test('dismissing changes nothing; the open repair shows in Needs you only while it fits the approved plan', async () => {
    const { deps, seen } = world();
    await proposeRepair(ITEM, { reasonCode: 'step_failed_twice', runId: 'run-2', stepId: 'orders', stepTitle: 'Read the order table', errorClass: 'IntegrationError', runs: 2 }, deps, async () => 'org-1');
    assert.deepStrictEqual(seen.amend[0].facts, { kind: 'step_failed', stepId: 'orders', stepTitle: 'Read the order table', errorClass: 'IntegrationError', runs: 2 });
    const [row] = deps.store.rows.values();
    assert.deepStrictEqual(await openRepairOf(ITEM, planFingerprint(BASE), deps), { proposalId: row.id, reasonCode: 'step_failed_twice', stepTitle: 'Read the order table' });
    assert.strictEqual(await openRepairOf(ITEM, planFingerprint(FIXED), deps), null);
    await dismissProposal({ item: ITEM, proposalId: row.id }, deps);
    assert.deepStrictEqual([row.status, seen.approvals.length], ['dismissed', 0]);
    assert.strictEqual(await openRepairOf(ITEM, planFingerprint(BASE), deps), null);
    await proposeRepair(ITEM, { reasonCode: 'goal_under_target', runId: 'run-3', targetPercent: 95, percents: [70, 71, 72] }, deps, async () => null);
    assert.deepStrictEqual(seen.amend[1].facts, { kind: 'goal_under', targetPercent: 95, percents: [70, 71, 72] });
});

test('an owner edit is tested on the amended copy before it is offered for approval', async () => {
    const { deps, seen } = world();
    const request = { kind: 'repair', reasonCode: 'owner_request', facts: { kind: 'owner_request' }, ownerRequest: 'Read open orders', stepId: null, stepTitle: null };
    const tested = [];
    const testCopy = async ({ definition }) => { tested.push(definition); return { passed: true }; };
    await assert.rejects(propose(ITEM, request, { ...deps, tryDefinition: async () => ({ passed: false, problems: ['No order table'] }) }), /No order table/);
    assert.equal(deps.store.rows.size, 0);
    assert.equal(await propose(ITEM, request, { ...deps, tryDefinition: testCopy }), 'proposed');
    assert.deepEqual(tested, [REPAIRED]);
    assert.equal(seen.amend[0].ownerRequest, 'Read open orders');
    assert.equal(await openRepairOf(ITEM, planFingerprint(BASE), deps), null);
    assert.deepEqual(seen.approvals, []);
});

test('editing a known parameter tests exactly the changed literal and shows the old and new values', async () => {
    const { deps, seen } = world();
    const request = { ...REPAIR, reasonCode: 'owner_request', parameter: { stepId: 'orders', field: 'query', before: 'orders', value: 'open orders' } };
    const withTry = { ...deps, tryDefinition: async ({ definition }) => { assert.deepEqual(definition, REPAIRED); return { passed: true }; } };
    assert.equal(await propose(ITEM, { ...request, parameter: { ...request.parameter, before: 'stale' } }, withTry), 'unchanged');
    assert.equal(await propose(ITEM, request, withTry), 'proposed');
    const { proposals: [proposal] } = await proposalsOf(ITEM, deps);
    assert.deepEqual(proposal.parameterChanges, [request.parameter]);
    assert.equal(seen.amend.length, 0);
    assert.equal(deps.plans.approved.fingerprint, planFingerprint(BASE));
});
