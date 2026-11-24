/**
 * Approving a definition that is not in the plan automation yet (./coworkPlanVersions.mts): it is written there and
 * approved through approvePlan, a refusal puts the automation back, an automation with unapproved changes is not
 * written over, and "Undo" approves exactly the earlier version's fingerprint. The stores and approvePlan are handed in
 * (approvePlan has its own tests, ./coworkPlan.test.js).
 *
 * Run: cd server && node --test usecases/coworkPlanVersions.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { approveDefinition, restoreVersion } = require('./coworkPlanVersions.mts');
const { planFingerprint } = require('../core/cowork/plan/planPermissions.mts');
const { planOf, literal } = require('../core/cowork/plan/plan.testkit');

const ITEM = { id: 'cw-1', userId: 'u1', planAutomationId: 'auto-1' };
const V1 = planOf([{ id: 'facts', type: 'set', label: 'The figures', fields: { n: literal(1) } }]);
const V2 = planOf([{ id: 'facts', type: 'set', label: 'The figures', fields: { n: literal(2) } }]);

function world({ refuse = null, draft = V2 } = {}) {
    const automation = { id: 'auto-1', userId: 'u1', organizationId: 'org-1', definition: structuredClone(draft) };
    const versions = [{ version: 1, definition: V1, fingerprint: planFingerprint(V1) }, { version: 2, definition: V2, fingerprint: planFingerprint(V2) }];
    const seen = { writes: [], approvals: [] };
    let approved = versions[1];
    const deps = {
        store: { getApprovedPlan: async () => approved, getPlanVersion: async (_id, v) => versions.find((x) => x.version === v) ?? null },
        getAutomation: async (id) => (id === 'auto-1' ? automation : null),
        isManaged: async () => false,
        writeDefinition: async (_id, definition) => { seen.writes.push(planFingerprint(definition)); automation.definition = structuredClone(definition); },
        approve: async ({ fingerprint }) => {
            seen.approvals.push(fingerprint);
            if (refuse) throw refuse;
            if (planFingerprint(automation.definition) !== fingerprint) throw Object.assign(new Error('changed'), { status: 409 });
            approved = { version: 3, definition: automation.definition, fingerprint };
            return { approved };
        },
    };
    return { deps, seen, automation };
}

test('Undo approves exactly the earlier version, through the approval', async () => {
    const { deps, seen } = world();
    const state = await restoreVersion({ item: ITEM, version: 1 }, deps);
    assert.strictEqual(state.approved.fingerprint, planFingerprint(V1));
    assert.deepStrictEqual([seen.writes, seen.approvals], [[planFingerprint(V1)], [planFingerprint(V1)]]);
});

test('an unknown version is 404; the version that is the plan already is 409', async () => {
    const { deps, seen } = world();
    await assert.rejects(restoreVersion({ item: ITEM, version: 9 }, deps), (e) => e.status === 404 && e.code === 'cowork_plan_version_not_found');
    await assert.rejects(restoreVersion({ item: ITEM, version: 2 }, deps), (e) => e.status === 409 && e.code === 'cowork_plan_version_current');
    assert.deepStrictEqual(seen.writes, []);
});

test('a refused approval puts the automation back as it was', async () => {
    const refusal = Object.assign(new Error('This plan cannot be approved yet.'), { status: 422 });
    const { deps, seen, automation } = world({ refuse: refusal });
    await assert.rejects(approveDefinition({ item: ITEM, definition: V1 }, deps), (e) => e === refusal);
    assert.deepStrictEqual(seen.writes, [planFingerprint(V1), planFingerprint(V2)]);
    assert.strictEqual(planFingerprint(automation.definition), planFingerprint(V2));
});

test('changes the owner has not approved are not written over', async () => {
    const edited = planOf([{ id: 'facts', type: 'set', label: 'Being edited', fields: { n: literal(7) } }]);
    const { deps, seen } = world({ draft: edited });
    await assert.rejects(approveDefinition({ item: ITEM, definition: V1 }, deps), (e) => e.status === 409 && e.code === 'cowork_plan_draft_open');
    assert.deepStrictEqual(seen.writes, []);
    await assert.rejects(approveDefinition({ item: { ...ITEM, planAutomationId: null }, definition: V1 }, deps), (e) => e.status === 409 && e.code === 'cowork_plan_refused');
});
