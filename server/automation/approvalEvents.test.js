/**
 * approvalEvents — payload assembly + tenancy routing.
 *
 * The dispatch module is monkey-patched through the require cache: what these
 * tests pin is WHICH path an approval routes through (org-scoped when the row
 * has an org, user-scoped to the OWNER when it doesn't) and that the payload
 * carries the recorded facts off the row — the contract every subscriber's
 * trigger.output.* bindings depend on.
 *
 * Run: node --test automation/approvalEvents.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const dispatchMod = require('./triggerBus/dispatch');
const { dispatchApprovalRequested, dispatchApprovalDecided } = require('./approvalEvents');

function capture(fn) {
    const calls = { org: [], user: [] };
    const origOrg = dispatchMod.dispatchOrgScopedEvent;
    const origUser = dispatchMod.dispatchEvent;
    dispatchMod.dispatchOrgScopedEvent = (provider, event, payload, orgId) => {
        calls.org.push({ provider, event, payload, orgId });
        return Promise.resolve([]);
    };
    dispatchMod.dispatchEvent = ({ provider, event, payload, userId }) => {
        calls.user.push({ provider, event, payload, userId });
        return Promise.resolve([]);
    };
    try { fn(); } finally {
        dispatchMod.dispatchOrgScopedEvent = origOrg;
        dispatchMod.dispatchEvent = origUser;
    }
    return calls;
}

const BASE = {
    id: 'apr_1', organizationId: 'org1', ownerId: 'u1', source: 'run',
    prompt: 'Send it?', automationId: 'a1', runId: 'r1', studioAppId: null,
    requestedBy: null, assigneeUserId: 'u2', assigneeGroupId: null,
    context: { recordId: 'rec_9' }, status: 'pending', expiresAt: 'X',
};

test('a row with an org dispatches org-scoped', () => {
    const calls = capture(() => dispatchApprovalRequested(BASE));
    assert.strictEqual(calls.user.length, 0);
    assert.strictEqual(calls.org.length, 1);
    const { provider, event, payload, orgId } = calls.org[0];
    assert.strictEqual(provider, 'approvals');
    assert.strictEqual(event, 'approval.requested');
    assert.strictEqual(orgId, 'org1');
    assert.strictEqual(payload.approvalId, 'apr_1');
    assert.strictEqual(payload.expiresAt, 'X');
    assert.deepStrictEqual(payload.context, { recordId: 'rec_9' });
});

test('a row with NO org falls back user-scoped to the OWNER', () => {
    const calls = capture(() => dispatchApprovalRequested({ ...BASE, organizationId: null }));
    assert.strictEqual(calls.org.length, 0);
    assert.strictEqual(calls.user.length, 1);
    assert.strictEqual(calls.user[0].userId, 'u1');
});

test('decided carries the FINAL status as decision, with the recorded facts', () => {
    const decided = {
        ...BASE, status: 'rejected', decidedBy: 'u2', decidedByName: 'Fleur',
        decisionReason: 'Too expensive', answers: { po: '4471' }, source: 'app', studioAppId: 'app_7',
    };
    const calls = capture(() => dispatchApprovalDecided(decided));
    const { payload } = calls.org[0];
    assert.strictEqual(calls.org[0].event, 'approval.decided');
    assert.strictEqual(payload.decision, 'rejected');
    assert.strictEqual(payload.reason, 'Too expensive');
    assert.deepStrictEqual(payload.answers, { po: '4471' });
    assert.strictEqual(payload.decidedBy, 'u2');
    assert.strictEqual(payload.decidedByName, 'Fleur');
    assert.strictEqual(payload.source, 'app');
    assert.strictEqual(payload.studioAppId, 'app_7');
});

test('a still-pending row never dispatches decided', () => {
    const calls = capture(() => dispatchApprovalDecided(BASE));
    assert.strictEqual(calls.org.length + calls.user.length, 0);
});

test('the payload fields match the declared trigger-source contract', () => {
    // The declaration is what the builder's variable picker offers; the
    // dispatch payload is what actually arrives. They must be the same set.
    const { TRIGGER_SOURCES } = require('./triggerSources/declared/approvals');
    const events = TRIGGER_SOURCES[0].events;
    const decidedFields = events.find(e => e.id === 'approval.decided').fields;
    const requestedFields = events.find(e => e.id === 'approval.requested').fields;

    const decided = capture(() => dispatchApprovalDecided({ ...BASE, status: 'approved', decidedBy: 'u2' })).org[0].payload;
    assert.deepStrictEqual(Object.keys(decided).sort(), [...decidedFields].sort());

    const requested = capture(() => dispatchApprovalRequested(BASE)).org[0].payload;
    assert.deepStrictEqual(Object.keys(requested).sort(), [...requestedFields].sort());
});
