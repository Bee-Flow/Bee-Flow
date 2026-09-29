'use strict';

/**
 * "Send reminder" (handoff 5): who may press it, what a decided or recently
 * reminded approval answers, and that the reminder goes out once per claim.
 * Every lookup is injected (makeApprovalReminder's deps); no module mocking.
 *
 * Run: cd server && node --test automation/approvalRemind.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeApprovalReminder } = require('./approvalRemind');

const APPROVALS = {
    ap1: { id: 'ap1', status: 'pending', ownerId: 'owner', organizationId: 'org1', automationId: 'a1', runId: 'leg2', assigneeUserId: 'boer' },
    done: { id: 'done', status: 'approved', ownerId: 'owner', organizationId: 'org1', automationId: 'a1', runId: 'leg2' },
};
const RUNS = {
    head: { id: 'head', rootRunId: 'head', startedByUserId: 'ron' },
    leg2: { id: 'leg2', rootRunId: 'head', startedByUserId: null },
};
const ROLES = { vic: 'view', ron: 'run', rita: 'run', owner: 'owner' };

function harness({ claim } = {}) {
    const sent = [];
    const claims = [];
    const reminder = makeApprovalReminder({
        store: {
            getApproval: async (id) => APPROVALS[id] || null,
            getRun: async (id) => RUNS[id] || null,
            getAutomation: async (id) => (id === 'a1' ? { id: 'a1', userId: 'owner' } : null),
            claimApprovalReminder: async (id, opts) => {
                claims.push({ id, ...opts });
                return claim ? claim(id) : { claimed: true, at: '2026-09-28T10:00:00.000Z' };
            },
        },
        // canView: owner, assignee, org admin (approvalService's rule, simplified).
        canView: (ap, viewer) => [ap.ownerId, ap.assigneeUserId].includes(viewer.userId) || viewer.userId === 'adm',
        roleFor: async (_a, userId) => ({ role: ROLES[userId] || null }),
        sendReminder: async (ap) => { sent.push(ap.id); return ['boer']; },
    });
    const viewer = (userId) => ({ userId, isOrgAdminOfOrg: (org) => userId === 'adm' && org === 'org1' });
    return { reminder, sent, claims, viewer };
}

async function refusal(promise) {
    try { await promise; } catch (e) { return { status: e.status, code: e.code, details: e.details }; }
    assert.fail('expected a refusal');
}

test('the owner reminds: the claim is taken under their id and the reminder goes out once', async () => {
    const h = harness();
    const body = await h.reminder.remind({ approvalId: 'ap1', viewer: h.viewer('owner') });
    assert.deepEqual(body, {
        reminded: true,
        remindedAt: '2026-09-28T10:00:00.000Z',
        nextAllowedAt: '2026-09-28T10:10:00.000Z',
        recipients: 1,
    });
    assert.deepEqual(h.claims, [{ id: 'ap1', byUserId: 'owner', windowMinutes: 10 }]);
    assert.deepEqual(h.sent, ['ap1']);
});

test('the asking side may remind: org admin, a viewer of the routine, a run-only member for their own run', async () => {
    for (const who of ['adm', 'vic', 'ron']) {
        const h = harness();
        await h.reminder.remind({ approvalId: 'ap1', viewer: h.viewer(who) });
        assert.deepEqual(h.sent, ['ap1'], who);
    }
});

test('the assignee gets 403; a stranger and a run-only member of somebody else\'s run get 404', async () => {
    const h = harness();
    assert.deepEqual(await refusal(h.reminder.remind({ approvalId: 'ap1', viewer: h.viewer('boer') })),
        { status: 403, code: 'approval_remind_forbidden', details: undefined });
    assert.equal((await refusal(h.reminder.remind({ approvalId: 'ap1', viewer: h.viewer('stranger') }))).status, 404);
    assert.equal((await refusal(h.reminder.remind({ approvalId: 'ap1', viewer: h.viewer('rita') }))).status, 404);
    assert.equal((await refusal(h.reminder.remind({ approvalId: 'nope', viewer: h.viewer('owner') }))).code, 'approval_not_found');
    assert.deepEqual(h.sent, [], 'nothing was sent');
});

test('a decided approval answers 409 without claiming', async () => {
    const h = harness();
    assert.equal((await refusal(h.reminder.remind({ approvalId: 'done', viewer: h.viewer('owner') }))).code, 'approval_not_pending');
    assert.deepEqual(h.claims, []);
});

test('rate limit: a refused claim is a 429 with when the next reminder may go, and nothing is sent', async () => {
    const nextAt = new Date(Date.now() + 4 * 60_000).toISOString();
    const h = harness({ claim: () => ({ claimed: false, reason: 'rate_limited', lastAt: '2026-09-28T09:59:00.000Z', nextAt }) });
    const r = await refusal(h.reminder.remind({ approvalId: 'ap1', viewer: h.viewer('owner') }));
    assert.equal(r.status, 429);
    assert.equal(r.code, 'remind_rate_limited');
    assert.equal(r.details.nextAllowedAt, nextAt);
    assert.equal(r.details.lastRemindedAt, '2026-09-28T09:59:00.000Z');
    assert.ok(r.details.retryAfterSec > 200 && r.details.retryAfterSec <= 240);
    assert.deepEqual(h.sent, []);
});

test('a decision that lands between the read and the claim is a 409 too', async () => {
    const h = harness({ claim: () => ({ claimed: false, reason: 'not_pending' }) });
    assert.equal((await refusal(h.reminder.remind({ approvalId: 'ap1', viewer: h.viewer('owner') }))).code, 'approval_not_pending');
    assert.deepEqual(h.sent, []);
});
