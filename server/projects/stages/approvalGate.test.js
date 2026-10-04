/**
 * The PRD approval gate (design 6.6): the approval row, the audit row, the
 * feed event, the first stage's notification, and the deadlock guard on the
 * policy. Every store and side effect is an injected double.
 *
 * Run: cd server && node --test projects/stages/approvalGate.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { request, approvalStateFor, validatePolicy, titleFor, detailsFor, STEP_ID } = require('./approvalGate');

const POLICY = {
    stages: [
        { key: 'ops', name: 'Operations', approvers: [{ userId: 'bob' }, { groupId: 'g-ops' }], rule: 'first' },
        { key: 'cfo', name: 'Finance', approvers: [{ userId: 'carol' }], rule: 'all' },
    ],
};
const stage = {
    projectId: 'prd-1', solutionId: 'sol-1', stage: 'prd', organizationId: 'acme', runAsUserId: 'alice',
    requiresApproval: true, approvalPolicy: POLICY,
};
const deployment = {
    id: 'dep_1', solutionId: 'sol-1', stage: 'prd', kind: 'deploy', releaseSeq: 7, status: 'awaiting_approval',
    planHash: 'sha256:abc', requestedBy: 'alice',
};
const plan = {
    release: { id: 'rel_7', seq: 7 },
    parts: [{ ref: 'aut_1', kind: 'automation', name: 'Invoices', action: 'replace' }, { ref: 'dt_1', kind: 'datatable', name: 'Prices', action: 'unchanged' }],
    data: [{ ref: 'dt_1', retire: [{ key: 'old' }] }],
    acknowledgementsRequired: [{ code: 'schema.retire_column', ref: 'dt_1' }],
};

function doubles() {
    const calls = { create: null, audit: [], setApproval: [], dispatched: [], notified: [] };
    const deps = {
        now: () => Date.parse('2026-10-03T10:00:00Z'),
        projectStore: { getProject: async (id) => ({ id, name: 'Orders', ownerId: 'alice' }) },
        automationStore: {
            createApproval: async (args) => { calls.create = args; return { id: 'apr_1', status: 'pending', source: args.source, deploymentId: args.deploymentId }; },
            appendApprovalAudit: async (row) => { calls.audit.push(row); },
            getApproval: async (id) => (id === 'apr_1' ? { id, status: 'approved', decidedBy: 'bob', decidedAt: '2026-10-03T11:00:00Z' } : null),
        },
        solutionStageStore: { setApprovalId: async (id, approvalId) => { calls.setApproval.push([id, approvalId]); return true; } },
        approvalEvents: { dispatchApprovalRequested: (approval) => { calls.dispatched.push(approval.id); } },
        panelRecipientIds: async (approvers) => approvers.flatMap(s => (s.userId ? [s.userId] : ['ops-1', 'ops-2'])),
        notifyApproval: async (args) => { calls.notified.push(args); return { bells: args.recipientIds.length }; },
        validateStages: async (stages) => stages,
        groupMemberIds: async (groupId) => ({ ids: groupId === 'g-ops' ? ['alice', 'ops-1'] : ['alice'], total: 2 }),
    };
    return { calls, deps };
}

test('request opens the approval: deployment source, sentinel step, the chain, audit, feed, first stage notified', async () => {
    const { calls, deps } = doubles();
    const approval = await request({ deployment, stage, plan, actor: { id: 'alice' } }, deps);
    assert.strictEqual(approval.id, 'apr_1');
    const c = calls.create;
    assert.strictEqual(c.source, 'deployment');
    assert.strictEqual(c.stepId, STEP_ID);
    assert.strictEqual(c.stepId, 'stage.prd');
    assert.strictEqual(c.deploymentId, 'dep_1');
    assert.strictEqual(c.projectId, 'prd-1');
    assert.strictEqual(c.organizationId, 'acme');
    assert.strictEqual(c.ownerId, 'alice');
    assert.strictEqual(c.requestedBy, 'alice');
    assert.strictEqual(c.automationTitle, 'Deploy release 7 of Orders to Production');
    assert.deepStrictEqual(c.context, { deploymentId: 'dep_1', planHash: 'sha256:abc', releaseSeq: 7, stageProjectId: 'prd-1', solutionId: 'sol-1' });
    assert.deepStrictEqual(c.stages.map(s => s.key), ['ops', 'cfo']);
    assert.strictEqual(c.stageKey, 'ops');
    assert.deepStrictEqual(c.approvers, [{ userId: 'bob' }, { groupId: 'g-ops' }]);
    assert.strictEqual(c.approvalRule, 'first');
    assert.deepStrictEqual(c.stageParticipants, [{ userId: 'bob' }, { groupId: 'g-ops' }, { userId: 'carol' }]);
    assert.strictEqual(c.expiresAt, '2026-10-10T10:00:00.000Z');
    assert.match(c.detailsMd, /replace: 1/);
    assert.match(c.detailsMd, /Columns retired: 1/);
    assert.ok(!/rel_7|sol-1/.test(c.detailsMd), 'details are counts and names only');

    assert.deepStrictEqual(calls.setApproval, [['dep_1', 'apr_1']]);
    assert.deepStrictEqual(calls.audit, [{ approvalId: 'apr_1', runId: null, stepId: 'stage.prd', decidedBy: 'alice', decision: 'requested', source: 'deployment' }]);
    assert.deepStrictEqual(calls.dispatched, ['apr_1']);
    assert.strictEqual(calls.notified.length, 1);
    assert.deepStrictEqual(calls.notified[0].recipientIds, ['bob', 'ops-1', 'ops-2'], 'only the first stage is notified');
    assert.ok(!calls.notified[0].recipientIds.includes('carol'));
});

test('a failing side effect after the row is written does not undo the request', async () => {
    const { calls, deps } = doubles();
    deps.automationStore.appendApprovalAudit = async () => { throw new Error('audit down'); };
    deps.notifyApproval = async () => { throw new Error('bell down'); };
    const approval = await request({ deployment: { ...deployment, kind: 'settings' }, stage, actor: { id: 'alice' } }, deps);
    assert.strictEqual(approval.id, 'apr_1');
    assert.strictEqual(calls.create.automationTitle, 'Change the approval gate of Orders in Production');
    assert.deepStrictEqual(calls.setApproval, [['dep_1', 'apr_1']]);
});

test('validatePolicy refuses a stage with only the owner; a group with another member counts', async () => {
    const { deps } = doubles();
    await assert.rejects(
        validatePolicy({ stages: [{ key: 's1', approvers: [{ userId: 'alice' }] }] }, { orgId: 'acme', ownerId: 'alice' }, deps),
        (e) => e.status === 400 && e.code === 'approval_policy_needs_approver' && e.details.stageKey === 's1',
    );
    await assert.rejects(
        validatePolicy({ stages: [{ key: 'ok', approvers: [{ userId: 'bob' }] }, { key: 'solo', approvers: [{ groupId: 'g-solo' }] }] }, { orgId: 'acme', ownerId: 'alice' }, deps),
        (e) => e.code === 'approval_policy_needs_approver' && e.details.stageKey === 'solo',
    );
    await assert.rejects(validatePolicy(null, { orgId: 'acme', ownerId: 'alice' }, deps), (e) => e.code === 'approval_policy_needs_approver');
    const ok = await validatePolicy({ stages: [{ key: 's1', approvers: [{ groupId: 'g-ops' }] }] }, { orgId: 'acme', ownerId: 'alice' }, deps);
    assert.strictEqual(ok.length, 1);
    // A stranger dropped by the org gate leaves the owner fallback: refused.
    const orgGate = { ...deps, validateStages: async (stages, orgId, owner) => stages.map(s => ({ ...s, approvers: [{ userId: owner }] })) };
    await assert.rejects(validatePolicy({ stages: [{ key: 's1', approvers: [{ userId: 'stranger' }] }] }, { orgId: 'acme', ownerId: 'alice' }, orgGate),
        (e) => e.code === 'approval_policy_needs_approver');
});

test('request refuses an owner-only policy before writing anything', async () => {
    const { calls, deps } = doubles();
    await assert.rejects(
        request({ deployment, stage: { ...stage, approvalPolicy: { stages: [{ key: 's', approvers: [{ userId: 'alice' }] }] } }, actor: { id: 'alice' } }, deps),
        (e) => e.code === 'approval_policy_needs_approver',
    );
    assert.strictEqual(calls.create, null);
});

test('approvalStateFor', async () => {
    const { deps } = doubles();
    assert.deepStrictEqual(await approvalStateFor({ status: 'queued', approvalId: null }, deps), { state: 'not_required', approvalId: null });
    assert.deepStrictEqual(await approvalStateFor({ status: 'awaiting_approval', approvalId: null }, deps), { state: 'requested', approvalId: null });
    assert.deepStrictEqual(await approvalStateFor({ status: 'approved', approvalId: 'apr_1' }, deps),
        { state: 'approved', approvalId: 'apr_1', decidedBy: 'bob', decidedAt: '2026-10-03T11:00:00Z' });
    assert.deepStrictEqual(await approvalStateFor({ status: 'approved', approvalId: 'apr_gone' }, deps), { state: 'missing', approvalId: 'apr_gone' });
});

test('a remove with deleteData says the tables and knowledge bases go with their data', async () => {
    const base = { kind: 'remove', parts: [{ ref: 'dt_1', kind: 'datatable', action: 'remove', name: 'Prices' }], acknowledgementsRequired: [{ code: 'stage.remove' }] };
    assert.strictEqual(titleFor({ kind: 'remove', solutionName: 'Orders', stage: 'prd' }), 'Remove Orders from Production');
    assert.strictEqual(titleFor({ kind: 'remove', solutionName: 'Orders', stage: 'prd', deleteData: false }), 'Remove Orders from Production');
    assert.strictEqual(titleFor({ kind: 'remove', solutionName: 'Orders', stage: 'prd', deleteData: true }), 'Remove Orders from Production and delete its data');
    assert.ok(!/deleted with their data/.test(detailsFor({ ...base, deleteData: false })));
    assert.match(detailsFor({ ...base, deleteData: true }), /tables and knowledge bases are deleted with their data/);
    assert.ok(!/deleted with their data/.test(detailsFor({ kind: 'deploy', deleteData: true, parts: [] }) || ''), 'only a removal carries the wording');

    const { calls, deps } = doubles();
    await request({ deployment: { ...deployment, kind: 'remove' }, stage, plan: { ...base, deleteData: true }, actor: { id: 'alice' } }, deps);
    assert.strictEqual(calls.create.automationTitle, 'Remove Orders from Production and delete its data');
    assert.match(calls.create.detailsMd, /deleted with their data/);
});
