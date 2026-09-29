/**
 * Pure-logic tests for the approvals store — the scope WHERE builder and the
 * row mapper, which together decide WHO SEES WHAT. The SQL paths themselves
 * are exercised against a live DB in staging; what must never regress silently
 * is the shape of the visibility rules.
 *
 * Run: node --test stores/automationStore/approvals.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { _approvalsTest, APPROVAL_STATUSES } = require('./approvals');
const { buildApprovalWhere, rowToApproval, encodeApprovalCursor, decodeApprovalCursor } = _approvalsTest;

test('the mine scope is owner OR assignee OR requester OR group member', () => {
    const params = [];
    const where = buildApprovalWhere({ viewer: { userId: 'u1', groupIds: ['g1', 'g2'] } }, params);
    assert.match(where, /owner_id = \$1 OR assignee_user_id = \$1 OR requested_by = \$1 OR assignee_group_id = ANY\(\$2\)/);
    assert.deepStrictEqual(params, ['u1', ['g1', 'g2']]);
});

test('a viewer with no groups still sees owned and assigned rows', () => {
    const params = [];
    const where = buildApprovalWhere({ viewer: { userId: 'u1', groupIds: [] } }, params);
    assert.match(where, /owner_id = \$1 OR assignee_user_id = \$1/);
    assert.ok(!where.includes('assignee_group_id'), 'no group clause without groups');
});

test('the org scope filters on organization_id alone', () => {
    const params = [];
    const where = buildApprovalWhere({ org: { orgId: 'org1' } }, params);
    assert.match(where, /organization_id = \$1/);
    assert.ok(!where.includes('owner_id'), 'org scope must not also narrow to a person');
    assert.deepStrictEqual(params, ['org1']);
});

test('no scope at all fails CLOSED', () => {
    // A filter that scopes to nobody must return nothing, never everything.
    const params = [];
    const where = buildApprovalWhere({}, params);
    assert.ok(where.includes('FALSE'), `expected FALSE in: ${where}`);
});

test('unknown statuses are dropped rather than passed to SQL', () => {
    const params = [];
    buildApprovalWhere({ viewer: { userId: 'u1', groupIds: [] }, status: ['pending', 'nonsense'] }, params);
    const statusParam = params.find(Array.isArray);
    assert.deepStrictEqual(statusParam, ['pending']);
});

test('every advertised status is a real one', () => {
    assert.deepStrictEqual(
        [...APPROVAL_STATUSES].sort(),
        ['approved', 'cancelled', 'expired', 'pending', 'rejected'],
    );
});

test('the cursor round-trips', () => {
    const c = decodeApprovalCursor(encodeApprovalCursor({ createdAt: '2026-08-22T10:00:00Z', id: 'apr_x' }));
    assert.deepStrictEqual(c, { createdAt: '2026-08-22T10:00:00Z', id: 'apr_x' });
    assert.strictEqual(decodeApprovalCursor('garbage'), null);
});

test('rowToApproval maps every column an API consumer relies on', () => {
    const row = rowToApproval({
        id: 'apr_1', organization_id: 'org1', automation_id: 'a1', automation_title: 'T',
        run_id: 'r1', root_run_id: 'r0', step_id: 's1', owner_id: 'u1',
        assignee_user_id: null, assignee_group_id: 'g1', status: 'pending',
        prompt: 'Q?', details_md: '**why**', fields: [{ name: 'po' }],
        attachments: [{ fileId: 'f1' }], answers: null,
        decided_by: null, decided_by_name: null, decision_reason: null, decided_at: null,
        expires_at: 'X', created_at: 'C', updated_at: 'U',
    });
    assert.strictEqual(row.assigneeGroupId, 'g1');
    assert.strictEqual(row.detailsMd, '**why**');
    assert.deepStrictEqual(row.fields, [{ name: 'po' }]);
    assert.deepStrictEqual(row.attachments, [{ fileId: 'f1' }]);
    assert.strictEqual(row.rootRunId, 'r0');
});

// ── v2: the source-agnostic record ───────────────────────────────────────

test('v2 columns map through, and a legacy row defaults to source "run"', () => {
    const legacy = rowToApproval({ id: 'apr_1', owner_id: 'u1', status: 'pending' });
    assert.strictEqual(legacy.source, 'run');
    assert.strictEqual(legacy.studioAppId, null);
    assert.strictEqual(legacy.stepId, null);

    const app = rowToApproval({
        id: 'apr_2', owner_id: 'u1', status: 'pending', source: 'app',
        requested_by: 'anon:ab12', studio_app_id: 'app_7', action_id: 'act_1',
        context: { recordId: 'rec_9' }, on_decided: { tableId: 't1' },
        remind_at: 'R', reminder_sent_at: null, escalate_at: 'E', escalated_at: null,
    });
    assert.strictEqual(app.source, 'app');
    assert.strictEqual(app.requestedBy, 'anon:ab12');
    assert.strictEqual(app.studioAppId, 'app_7');
    assert.strictEqual(app.actionId, 'act_1');
    assert.deepStrictEqual(app.context, { recordId: 'rec_9' });
    assert.deepStrictEqual(app.onDecided, { tableId: 't1' });
    assert.strictEqual(app.remindAt, 'R');
    assert.strictEqual(app.escalateAt, 'E');
});

test('appId/automationId narrow but never replace the scope', () => {
    const params = [];
    const where = buildApprovalWhere(
        { viewer: { userId: 'u1', groupIds: [] }, appId: 'app_7', automationId: 'a1' }, params);
    // Scope condition still present…
    assert.match(where, /owner_id = \$1 OR assignee_user_id = \$1/);
    // …ANDed with the narrowing filters.
    assert.match(where, /studio_app_id = \$2/);
    assert.match(where, /automation_id = \$3/);
    assert.deepStrictEqual(params, ['u1', 'app_7', 'a1']);
});

test('the q search matches prompt OR title, with LIKE metacharacters escaped', () => {
    const params = [];
    const where = buildApprovalWhere({ viewer: { userId: 'u1', groupIds: [] }, q: '50%_off' }, params);
    assert.match(where, /prompt ILIKE \$2 OR automation_title ILIKE \$2/);
    assert.strictEqual(params[1], '%50\\%\\_off%');
});

test('a filter with NO scope still fails closed, filters or not', () => {
    const params = [];
    const where = buildApprovalWhere({ appId: 'app_7', q: 'quote' }, params);
    assert.match(where, /FALSE/);
});

test('the escalation target reaches the list only once escalated_at is stamped', () => {
    const params = [];
    const where = buildApprovalWhere({ viewer: { userId: 'u1', groupIds: ['g1'] } }, params);
    assert.match(where, /escalated_at IS NOT NULL AND \(escalate_to_user_id = \$1 OR escalate_to_group_id = ANY\(\$2\)\)/);
    const noGroups = [];
    const w2 = buildApprovalWhere({ viewer: { userId: 'u1', groupIds: [] } }, noGroups);
    assert.match(w2, /escalated_at IS NOT NULL AND escalate_to_user_id = \$1/);
});

test('v2 clock columns round-trip through the mapper', () => {
    const row = rowToApproval({
        id: 'apr_1', owner_id: 'u1', status: 'pending',
        remind_at: 'R', escalate_at: 'E', escalated_at: null,
        escalate_to_user_id: 'u9', escalate_to_group_id: null,
    });
    assert.strictEqual(row.escalateToUserId, 'u9');
    assert.strictEqual(row.escalateToGroupId, null);
    assert.strictEqual(row.remindAt, 'R');
});

test('panel seats and the final approver reach the viewer scope', () => {
    const params = [];
    const where = buildApprovalWhere({ viewer: { userId: 'u1', groupIds: ['g1'] } }, params);
    assert.match(where, /jsonb_array_elements\(approvers\) seat/);
    assert.match(where, /seat->>'userId' = \$1 OR seat->>'groupId' = ANY\(\$2\)/);
    assert.match(where, /final_approver_user_id = \$1 OR final_approver_group_id = ANY\(\$2\)/);
    const solo = [];
    const w2 = buildApprovalWhere({ viewer: { userId: 'u1', groupIds: [] } }, solo);
    assert.match(w2, /seat->>'userId' = \$1/);
    assert.ok(!w2.includes("seat->>'groupId'"), 'no group clause without groups');
});

test('panel columns round-trip through the mapper', () => {
    const row = rowToApproval({
        id: 'apr_1', owner_id: 'u1', status: 'pending',
        approvers: [{ userId: 'a' }, { groupId: 'g1' }], approval_rule: 'quorum',
        quorum_count: 2, stage: 'panel', final_approver_user_id: 'cfo', final_approver_group_id: null,
    });
    assert.deepStrictEqual(row.approvers, [{ userId: 'a' }, { groupId: 'g1' }]);
    assert.strictEqual(row.approvalRule, 'quorum');
    assert.strictEqual(row.quorumCount, 2);
    assert.strictEqual(row.stage, 'panel');
    assert.strictEqual(row.finalApproverUserId, 'cfo');
    // Legacy rows: everything null, so nothing anywhere flips into panel mode.
    const legacy = rowToApproval({ id: 'apr_2', owner_id: 'u1', status: 'pending' });
    assert.strictEqual(legacy.approvers, null);
    assert.strictEqual(legacy.stage, null);
});
