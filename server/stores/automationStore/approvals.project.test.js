/**
 * Solution membership on approvals.
 *
 * Two rules carry weight here, and both are easy to break by accident:
 *
 *   1. `project_id` is a NARROWING filter, never a scope. It is intersected
 *      with the viewer scope (owner / assignee / requester / panel seat /
 *      escalation target), so it can only ever shrink what the caller could
 *      already see. If it ever became a scope, filing an automation into a
 *      shared project would hand every member the questions, details and
 *      attachments of decisions addressed to other people.
 *
 *   2. The stamp is frozen. project_id and project_title are written at INSERT
 *      and never updated or cleared, so an approval still says where the
 *      decision was made after the automation — or the project — is gone.
 *
 * Pure: exercises the WHERE builder and the row mapper, no database.
 *
 * Run: cd server && node --test stores/automationStore/approvals.project.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { _approvalsTest } = require('./approvals');
const { buildApprovalWhere, rowToApproval } = _approvalsTest;

const VIEWER = { userId: 'u1', groupIds: [] };

test('the row mapper exposes the frozen membership', () => {
    const a = rowToApproval({
        id: 'apr1', owner_id: 'u1', status: 'pending',
        project_id: 'p1', project_title: 'Onboarding',
        created_at: 'now', updated_at: 'now',
    });
    assert.strictEqual(a.projectId, 'p1');
    assert.strictEqual(a.projectTitle, 'Onboarding');
});

test('a standalone approval reports no project rather than undefined', () => {
    const a = rowToApproval({ id: 'apr1', owner_id: 'u1', status: 'pending', created_at: 'n', updated_at: 'n' });
    assert.strictEqual(a.projectId, null);
    assert.strictEqual(a.projectTitle, '');
});

test('projectId narrows a viewer scope, it does not replace it', () => {
    const params = [];
    const where = buildApprovalWhere({ viewer: VIEWER, projectId: 'p1' }, params);

    assert.ok(where.includes('project_id ='), 'the project filter is applied');
    assert.ok(where.includes('owner_id ='), 'and the viewer scope is still there');
    assert.ok(where.includes(' AND '), 'intersected, not substituted');
    assert.ok(params.includes('p1'), 'bound as a parameter, never interpolated');
});

test('projectId alone is NOT a scope — no viewer still means nothing', () => {
    const params = [];
    const where = buildApprovalWhere({ viewer: null, org: null, projectId: 'p1' }, params);

    // Fails closed. A project id is not permission to read the decisions inside
    // that project; it only ever narrows permission the caller already had.
    assert.ok(where.includes('FALSE'), 'a filter that scopes to nobody returns nothing');
});

test('an org scope is narrowed by the project too', () => {
    const params = [];
    const where = buildApprovalWhere({ org: { orgId: 'org1' }, projectId: 'p1' }, params);

    assert.ok(where.includes('organization_id ='), 'org scope intact');
    assert.ok(where.includes('project_id ='), 'and narrowed to the project');
    assert.ok(params.includes('org1') && params.includes('p1'));
});

test('omitting projectId leaves every existing query untouched', () => {
    const params = [];
    const where = buildApprovalWhere({ viewer: VIEWER }, params);
    assert.ok(!where.includes('project_id'), 'no filter appears when none was asked for');
});

test('a non-string project id is coerced, never interpolated', () => {
    const params = [];
    const where = buildApprovalWhere({ viewer: VIEWER, projectId: 12345 }, params);
    assert.ok(where.includes('project_id ='));
    assert.ok(params.includes('12345'), 'stringified into the parameter list');
    assert.ok(!where.includes('12345'), 'and never into the SQL text');
});
