/**
 * approvalService v2 — app-sourced decisions and withdraw.
 *
 * An app-sourced approval has NO run: decide() must neither demand one nor
 * try to resume one — the decided row is the outcome. withdraw() is the
 * requester's "never mind": conditional cancel, run closed only when the row
 * still owns its pause.
 *
 * The automationStore facade is monkey-patched per test (the store's own SQL
 * is covered in stores/automationStore/approvals.test.js); event fan-out is
 * silenced through the dispatch module the same way approvalEvents.test.js
 * does.
 *
 * Run: node --test automation/approvalService.v2.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const automationStore = require('../stores/automationStore');
const dispatchMod = require('./triggerBus/dispatch');
const { decide, withdraw } = require('./approvalService');

/** Patch store + dispatch, run fn, restore. Returns what was recorded. */
async function withPatched(overrides, fn) {
    const rec = { decided: [], audits: [], runUpdates: [], events: [] };
    const saved = {};
    const patch = {
        decideApproval: async (id, patch_) => {
            rec.decided.push({ id, ...patch_ });
            return overrides.decideResult !== undefined ? overrides.decideResult
                : { ...overrides.approval, ...patch_, decidedAt: 'now' };
        },
        appendApprovalAudit: async (ev) => { rec.audits.push(ev); },
        getApproval: async () => overrides.approval,
        getRun: async () => overrides.run ?? null,
        updateRun: async (id, patch_) => { rec.runUpdates.push({ id, ...patch_ }); },
        getSubscriptionsForProvider: async () => [],
    };
    for (const [k, v] of Object.entries(patch)) { saved[k] = automationStore[k]; automationStore[k] = v; }
    const savedOrg = dispatchMod.dispatchOrgScopedEvent;
    const savedUser = dispatchMod.dispatchEvent;
    dispatchMod.dispatchOrgScopedEvent = (provider, event, _payload) => { rec.events.push(event); return Promise.resolve([]); };
    dispatchMod.dispatchEvent = ({ event }) => { rec.events.push(event); return Promise.resolve([]); };
    try { await fn(rec); } finally {
        for (const [k, v] of Object.entries(saved)) automationStore[k] = v;
        dispatchMod.dispatchOrgScopedEvent = savedOrg;
        dispatchMod.dispatchEvent = savedUser;
    }
}

const APP_APPROVAL = {
    id: 'apr_app', source: 'app', status: 'pending',
    organizationId: 'org1', ownerId: 'owner', runId: null, stepId: null,
    prompt: 'Approve the quote?', fields: null, expiresAt: null,
    automationTitle: '', studioAppId: 'app_7',
};

test('an app-sourced approve needs no run and never resumes', async () => {
    await withPatched({ approval: APP_APPROVAL }, async (rec) => {
        const { code, body } = await decide({
            approval: APP_APPROVAL, run: null, deciderId: 'owner', decision: 'approve',
        });
        assert.strictEqual(code, 200);
        assert.strictEqual(body.accepted, true);
        assert.strictEqual(body.decision, 'approve');
        assert.strictEqual(body.approval.status, 'approved');
        // No run was touched — there is none.
        assert.strictEqual(rec.runUpdates.length, 0);
        // The decided event went out.
        assert.ok(rec.events.includes('approval.decided'));
    });
});

test('an app-sourced reject still demands its reason', async () => {
    await withPatched({ approval: APP_APPROVAL }, async () => {
        const { code, body } = await decide({
            approval: APP_APPROVAL, run: null, deciderId: 'owner', decision: 'reject', reason: '   ',
        });
        assert.strictEqual(code, 400);
        assert.strictEqual(body.field, 'reason');
    });
    await withPatched({ approval: APP_APPROVAL }, async (rec) => {
        const { code, body } = await decide({
            approval: APP_APPROVAL, run: null, deciderId: 'owner', decision: 'reject', reason: 'No budget',
        });
        assert.strictEqual(code, 200);
        assert.strictEqual(body.approval.status, 'rejected');
        assert.strictEqual(rec.runUpdates.length, 0);
    });
});

test('a RUN-sourced approval without its run still cancels (regression)', async () => {
    const runApproval = { ...APP_APPROVAL, id: 'apr_run', source: 'run', runId: 'r1', stepId: 's1' };
    await withPatched({ approval: runApproval }, async (rec) => {
        const { code } = await decide({
            approval: runApproval, run: null, deciderId: 'owner', decision: 'approve',
        });
        assert.strictEqual(code, 409);
        assert.strictEqual(rec.decided[0].status, 'cancelled');
    });
});

test('withdraw cancels the row, closes the paused run, and dispatches', async () => {
    const runApproval = { ...APP_APPROVAL, id: 'apr_run', source: 'run', runId: 'r1', stepId: 's1' };
    const run = { id: 'r1', status: 'awaiting_approval', awaitingStepId: 's1' };
    await withPatched({ approval: runApproval, run }, async (rec) => {
        const { code, body } = await withdraw({ approval: runApproval, deciderId: 'owner', reason: 'Wrong customer' });
        assert.strictEqual(code, 200);
        assert.strictEqual(body.approval.status, 'cancelled');
        assert.strictEqual(rec.decided[0].status, 'cancelled');
        assert.strictEqual(rec.decided[0].reason, 'Wrong customer');
        assert.strictEqual(rec.runUpdates.length, 1);
        assert.strictEqual(rec.runUpdates[0].status, 'cancelled');
        assert.strictEqual(rec.runUpdates[0].awaitingStepId, null);
        assert.ok(rec.events.includes('approval.decided'));
        assert.strictEqual(rec.audits[0].decision, 'cancelled');
    });
});

test('withdraw leaves a run alone when it moved on, and 409s a decided row', async () => {
    const runApproval = { ...APP_APPROVAL, id: 'apr_run', source: 'run', runId: 'r1', stepId: 's1' };
    // Run already resumed under a different step — do not clobber it.
    await withPatched({ approval: runApproval, run: { id: 'r1', status: 'running', awaitingStepId: null } }, async (rec) => {
        const { code } = await withdraw({ approval: runApproval, deciderId: 'owner' });
        assert.strictEqual(code, 200);
        assert.strictEqual(rec.runUpdates.length, 0);
    });
    // Conditional write lost the race → 409, nothing else happens.
    await withPatched({ approval: runApproval, decideResult: null }, async (rec) => {
        const { code } = await withdraw({ approval: runApproval, deciderId: 'owner' });
        assert.strictEqual(code, 409);
        assert.strictEqual(rec.runUpdates.length, 0);
        assert.ok(!rec.events.includes('approval.decided'));
    });
});

test('withdraw refuses a non-pending row outright', async () => {
    const { code } = await withdraw({ approval: { ...APP_APPROVAL, status: 'approved' }, deciderId: 'owner' });
    assert.strictEqual(code, 409);
});

test('an app-sourced withdraw is row-only', async () => {
    await withPatched({ approval: APP_APPROVAL }, async (rec) => {
        const { code } = await withdraw({ approval: APP_APPROVAL, deciderId: 'owner' });
        assert.strictEqual(code, 200);
        assert.strictEqual(rec.runUpdates.length, 0);
    });
});
