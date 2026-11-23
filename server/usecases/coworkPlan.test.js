/**
 * The plan of a Cowork item from the routes' side (./coworkPlan.mts): looking at it, naming its automation, approving
 * it and taking it off. The store, the automation lookup and the owner gate are handed in, so nothing is mocked.
 *
 * Run: cd server && node --test usecases/coworkPlan.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { planStateOf, attachPlan, approvePlan, removePlan } = require('./coworkPlan.mts');
const { planFingerprint, permissionsOf } = require('../core/cowork/plan/planPermissions.mts');
const { fakeLookups, planOf, supplierRadar, literal } = require('../core/cowork/plan/plan.testkit');

const lookups = fakeLookups();
const ITEM = { id: 's1', userId: 'u1', triggerKind: 'schedule', planAutomationId: 'auto-1', planId: null };

/** A world with the automations given by id, and an in-memory plan store. */
function world({ automations = { 'auto-1': { id: 'auto-1', userId: 'u1', organizationId: 'org-1', kind: 'automation', definition: supplierRadar() } }, refusal = null } = {}) {
    const state = { approved: /** @type {any} */ (null), attached: /** @type {string | null} */ (null), detached: 0, approvals: /** @type {any[]} */ ([]) };
    const deps = {
        store: {
            attachPlanAutomation: async (scheduleId, automationId) => { state.attached = automationId; },
            detachPlan: async () => { state.detached += 1; state.approved = null; },
            approvePlan: async (input) => {
                state.approvals.push(input);
                state.approved = { id: `plan-${state.approvals.length}`, version: state.approvals.length, fingerprint: input.fingerprint, approvedAt: '2026-11-23T09:14:00.000Z', permissions: input.permissions };
                return state.approved;
            },
            getApprovedPlan: async () => state.approved,
        },
        getAutomation: async (id) => automations[id] ?? null,
        isManaged: async (a) => a.projectId === 'stage-project',
        ownerRefusal: async () => refusal,
        lookups,
    };
    return { deps, state };
}

const httpError = (status, code) => (err) => err.status === status && err.code === code;

test('an item without a plan shows nothing to approve', async () => {
    const { deps } = world();
    assert.deepStrictEqual(await planStateOf({ ...ITEM, planAutomationId: null }, deps), { automationId: null, draft: null, approved: null, widens: [], upToDate: false });
});

test('looking at a plan shows its steps, what it may do, no findings, and that it was never approved', async () => {
    const { deps } = world();
    const state = await planStateOf(ITEM, deps);
    assert.strictEqual(state.automationId, 'auto-1');
    assert.strictEqual(state.draft?.view.steps.length, 7);
    assert.deepStrictEqual(state.draft?.view.makeUp, { fixed: 4, ai: 2, ask: 0, deliver: 1 });
    assert.deepStrictEqual(state.draft?.permissions, permissionsOf(supplierRadar(), lookups));
    assert.deepStrictEqual(state.draft?.findings, []);
    assert.strictEqual(state.draft?.fingerprint, planFingerprint(supplierRadar()));
    assert.strictEqual(state.approved, null);
    assert.deepStrictEqual(state.widens, ['This plan has not been approved yet.']);
    assert.strictEqual(state.upToDate, false);
});

test('an automation that is gone, or someone else\'s now, shows no draft: its steps are not this owner\'s to read', async () => {
    for (const automations of [{}, { 'auto-1': { id: 'auto-1', userId: 'someone-else', definition: supplierRadar() } }]) {
        const { deps } = world({ automations });
        const state = await planStateOf(ITEM, deps);
        assert.deepStrictEqual([state.automationId, state.draft, state.upToDate], ['auto-1', null, false]);
    }
});

test('naming an automation needs one the caller owns; a missing one and someone else\'s answer alike', async () => {
    const { deps, state } = world({ automations: { mine: { id: 'mine', userId: 'u1', kind: 'automation', definition: supplierRadar() }, theirs: { id: 'theirs', userId: 'u2', kind: 'automation', definition: supplierRadar() } } });
    const item = { ...ITEM, planAutomationId: null };
    await assert.rejects(attachPlan({ item, automationId: 'theirs' }, deps), httpError(404, 'cowork_plan_refused'));
    await assert.rejects(attachPlan({ item, automationId: 'nothing' }, deps), httpError(404, 'cowork_plan_refused'));
    assert.strictEqual(state.attached, null);
    const after = await attachPlan({ item, automationId: 'mine' }, deps);
    assert.strictEqual(state.attached, 'mine');
    assert.strictEqual(after.automationId, 'mine');
    assert.strictEqual(after.approved, null, 'naming it approves nothing');
});

test('an automation a Solution stage manages is no plan: it cannot be named, and one that became managed reads as gone', async () => {
    const managed = { id: 'auto-1', userId: 'u1', kind: 'automation', projectId: 'stage-project', definition: supplierRadar() };
    const { deps } = world({ automations: { 'auto-1': managed } });
    await assert.rejects(attachPlan({ item: ITEM, automationId: 'auto-1' }, deps), httpError(404, 'cowork_plan_refused'));
    const state = await planStateOf({ ...ITEM, planAutomationId: 'auto-1' }, deps);
    assert.deepStrictEqual([state.automationId, state.draft], ['auto-1', null]);
    await assert.rejects(approvePlan({ item: { ...ITEM, planAutomationId: 'auto-1' }, fingerprint: 'f'.repeat(64) }, deps), httpError(409, 'cowork_plan_refused'));
});

test('a building block is no plan, and an item that starts on a mail carries none yet', async () => {
    const { deps } = world({ automations: { block: { id: 'block', userId: 'u1', kind: 'block', definition: supplierRadar() }, 'auto-1': { id: 'auto-1', userId: 'u1', kind: 'automation', definition: supplierRadar() } } });
    await assert.rejects(attachPlan({ item: ITEM, automationId: 'block' }, deps), httpError(404, 'cowork_plan_refused'));
    await assert.rejects(attachPlan({ item: { ...ITEM, triggerKind: 'app_event' }, automationId: 'auto-1' }, deps), httpError(409, 'cowork_plan_refused'));
});

test('approving stores the plan as it is now, with what it may do, and the item is then up to date', async () => {
    const { deps, state } = world();
    const fingerprint = planFingerprint(supplierRadar());
    const after = await approvePlan({ item: ITEM, fingerprint }, deps);
    assert.strictEqual(state.approvals.length, 1);
    assert.deepStrictEqual(state.approvals[0].definition, supplierRadar());
    assert.deepStrictEqual([state.approvals[0].scheduleId, state.approvals[0].automationId, state.approvals[0].approvedBy, state.approvals[0].fingerprint], ['s1', 'auto-1', 'u1', fingerprint]);
    assert.deepStrictEqual([after.approved?.version, after.upToDate, after.widens], [1, true, []]);
});

test('nobody approves a plan they did not see: a fingerprint of another plan is a conflict, and nothing is stored', async () => {
    const { deps, state } = world();
    await assert.rejects(approvePlan({ item: ITEM, fingerprint: 'a'.repeat(64) }, deps), httpError(409, 'cowork_plan_changed'));
    assert.strictEqual(state.approvals.length, 0);
});

test('a plan with a finding cannot be approved, and the answer says which', async () => {
    const definition = planOf([{ id: 'c', type: 'code', code: 'function main() {}' }]);
    const { deps, state } = world({ automations: { 'auto-1': { id: 'auto-1', userId: 'u1', kind: 'automation', definition } } });
    await assert.rejects(approvePlan({ item: ITEM, fingerprint: planFingerprint(definition) }, deps),
        (err) => err.status === 422 && err.code === 'cowork_plan_not_allowed' && /cannot run a script yet/.test(err.message));
    assert.strictEqual(state.approvals.length, 0);
});

test('an owner the automation runner would refuse cannot approve: the plan could never run', async () => {
    for (const [refusal, text] of [['not_entitled', /does not have automations/], ['inactive', /can no longer run a plan/]]) {
        const { deps, state } = world({ refusal });
        await assert.rejects(approvePlan({ item: ITEM, fingerprint: planFingerprint(supplierRadar()) }, deps),
            (err) => err.status === 403 && err.code === 'cowork_plan_refused' && text.test(err.message));
        assert.strictEqual(state.approvals.length, 0, refusal);
    }
});

test('approving an item without a plan, or whose automation is gone, is refused', async () => {
    const { deps } = world();
    await assert.rejects(approvePlan({ item: { ...ITEM, planAutomationId: null }, fingerprint: 'a'.repeat(64) }, deps), httpError(409, 'cowork_plan_refused'));
    const gone = world({ automations: {} });
    await assert.rejects(approvePlan({ item: ITEM, fingerprint: 'a'.repeat(64) }, gone.deps), httpError(409, 'cowork_plan_refused'));
});

test('after the automation changes, the item still runs the approved plan and shows what the new one adds', async () => {
    const automations = { 'auto-1': { id: 'auto-1', userId: 'u1', kind: 'automation', definition: supplierRadar() } };
    const { deps } = world({ automations });
    await approvePlan({ item: ITEM, fingerprint: planFingerprint(supplierRadar()) }, deps);

    const changed = supplierRadar();
    changed.steps.push({ id: 'send', type: 'integration_action', tool: 'outlook_compose', inputs: { to: literal('orders@hoekstra-staal.example') } });
    automations['auto-1'] = { ...automations['auto-1'], definition: changed };

    const state = await planStateOf(ITEM, deps);
    assert.strictEqual(state.upToDate, false);
    assert.strictEqual(state.approved?.fingerprint, planFingerprint(supplierRadar()), 'the approved plan did not move');
    assert.deepStrictEqual(state.widens, ['outlook: sends (outlook_compose)', 'It can now send to other people.']);
});

test('a change that does less does not widen, but the plan is still not the approved one until approved', async () => {
    const automations = { 'auto-1': { id: 'auto-1', userId: 'u1', kind: 'automation', definition: supplierRadar() } };
    const { deps } = world({ automations });
    await approvePlan({ item: ITEM, fingerprint: planFingerprint(supplierRadar()) }, deps);
    const less = supplierRadar();
    less.steps = less.steps.slice(0, 4);
    less.edges = less.edges.slice(0, 4);
    automations['auto-1'] = { ...automations['auto-1'], definition: less };
    const state = await planStateOf(ITEM, deps);
    assert.deepStrictEqual([state.widens, state.upToDate], [[], false]);
});

test('taking the plan off leaves the item without one', async () => {
    const { deps, state } = world();
    await approvePlan({ item: ITEM, fingerprint: planFingerprint(supplierRadar()) }, deps);
    const after = await removePlan({ item: ITEM }, deps);
    assert.strictEqual(state.detached, 1);
    assert.deepStrictEqual(after, { automationId: null, draft: null, approved: null, widens: [], upToDate: false });
});
