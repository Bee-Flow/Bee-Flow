/**
 * The decision-auth matrix — WHO may decide an approval. Pure: canDecide
 * reads only the row and what the route proved about the caller, so the
 * whole matrix tests without a database.
 *
 * Run: node --test automation/approvalService.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { canDecide, canView } = require('./approvalService');

const approval = (over = {}) => ({
    id: 'apr_1', ownerId: 'owner', organizationId: 'org1',
    assigneeUserId: null, assigneeGroupId: null, status: 'pending',
    ...over,
});
const viewer = (over = {}) => ({
    userId: 'someone', groupIds: [], isOrgAdminOfOrg: () => false, ...over,
});

test('the owner can always decide', () => {
    assert.ok(canDecide(approval(), viewer({ userId: 'owner' })));
    // …including when the approval is assigned to someone else: the owner is
    // the fallback approver, never locked out of their own automation.
    assert.ok(canDecide(approval({ assigneeUserId: 'colleague' }), viewer({ userId: 'owner' })));
});

test('the assignee can decide; a random colleague cannot', () => {
    const ap = approval({ assigneeUserId: 'colleague' });
    assert.ok(canDecide(ap, viewer({ userId: 'colleague' })));
    assert.ok(!canDecide(ap, viewer({ userId: 'stranger' })));
});

test('a member of the assigned group can decide; membership is string-compared', () => {
    const ap = approval({ assigneeGroupId: '42' });
    assert.ok(canDecide(ap, viewer({ userId: 'member', groupIds: ['42'] })));
    // Group ids arrive as numbers from some stores — the comparison must not
    // let 42 !== '42' lock a legitimate member out.
    assert.ok(canDecide(ap, viewer({ userId: 'member', groupIds: [42] })));
    assert.ok(!canDecide(ap, viewer({ userId: 'other', groupIds: ['7'] })));
});

test('an org admin decides only within their own org', () => {
    const admin = viewer({ userId: 'admin', isOrgAdminOfOrg: (orgId) => orgId === 'org1' });
    assert.ok(canDecide(approval(), admin));
    assert.ok(!canDecide(approval({ organizationId: 'org2' }), admin));
    // An approval with NO org (consumer account) is not decidable via the
    // admin path at all.
    assert.ok(!canDecide(approval({ organizationId: null }), admin));
});

test('nobody decides a null approval or with no session', () => {
    assert.ok(!canDecide(null, viewer()));
    assert.ok(!canDecide(approval(), { userId: null }));
});

test('view rights are decide rights plus the requester — and nothing more', () => {
    // v2: the requester of an app-sourced approval may WATCH their own ask
    // (they wrote its contents); they still cannot decide it.
    const approval = { ownerId: 'owner', organizationId: null, requestedBy: 'req-1' };
    const requester = { userId: 'req-1', groupIds: [] };
    assert.strictEqual(canView(approval, requester), true, 'requester sees their own request');
    assert.strictEqual(canDecide(approval, requester), false, 'requester never decides');
    const stranger = { userId: 'someone-else', groupIds: [] };
    assert.strictEqual(canView(approval, stranger), false);
    // Everyone canDecide admits, canView admits too.
    assert.strictEqual(canView(approval, { userId: 'owner', groupIds: [] }), true);
});

// ── v2: escalation widens the decider set ────────────────────────────────

test('the escalation target decides only AFTER escalated_at is stamped', () => {
    const base = {
        ownerId: 'owner', assigneeUserId: 'u-original', organizationId: null,
        escalateToUserId: 'u-fallback', escalatedAt: null,
    };
    const fallback = { userId: 'u-fallback', groupIds: [] };
    assert.strictEqual(canDecide(base, fallback), false, 'before the stamp: no rights');
    const escalated = { ...base, escalatedAt: '2026-08-22T12:00:00Z' };
    assert.strictEqual(canDecide(escalated, fallback), true, 'the stamp IS the grant');
    // Widening, not replacement: the original assignee keeps their rights.
    assert.strictEqual(canDecide(escalated, { userId: 'u-original', groupIds: [] }), true);
});

test('a group escalation admits its members, string-compared', () => {
    const ap = { ownerId: 'owner', organizationId: null, escalateToGroupId: 7, escalatedAt: 'X' };
    assert.strictEqual(canDecide(ap, { userId: 'm1', groupIds: ['7'] }), true);
    assert.strictEqual(canDecide(ap, { userId: 'm2', groupIds: ['8'] }), false);
});
