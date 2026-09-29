/**
 * A reject needs a reason — except on the endpoint whose live clients cannot
 * send one.
 *
 * The rule itself is right: a rejection stops the run, and "why did this never
 * go out?" gets asked weeks later. But it was added server-side to a decide()
 * that ALL THREE callers share, and one of them is the legacy owner-scoped
 * POST /runs/:runId/approve-step (routes/automation/webhooksAndRunOps.js,
 * source 'builder'), which has accepted reason-less rejections since it
 * shipped.
 *
 * The clients of that endpoint are browsers that are already running. In the
 * previously released SPA, two of the three Reject controls pass no reason
 * argument at all (ExecutionsTable's ⋯ menu, ExecutionView) and the third
 * sends undefined when its optional box is empty. Enforcing the rule there
 * 400s all of them until the user happens to hard-reload — a breaking API
 * change dressed as a validation fix, and one that lands during exactly the
 * window when a rolling deploy has old assets in browsers.
 *
 * So: enforced for 'studio' (the Approvals panel, whose UI has always required
 * the field), not for 'builder'. 'nextcloud' only ever approves, so it never
 * reaches the check.
 *
 * Run: node --test --test-force-exit automation/approvalService.rejectReason.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const automationStore = require('../stores/automationStore');
const dispatchMod = require('./triggerBus/dispatch');
const { decide } = require('./approvalService');

const APPROVAL = {
    id: 'apr_reason', source: 'app', status: 'pending',
    organizationId: 'org1', ownerId: 'owner', runId: null, stepId: null,
    prompt: 'Ship it?', fields: null, expiresAt: null,
    stages: null, seats: null, decisionRule: null,
};

/** Same shape as approvalService.v2.test.js: patch the facade, restore after. */
async function withPatched(fn) {
    const saved = {};
    const patch = {
        decideApproval: async (id, p) => ({ ...APPROVAL, ...p, decidedAt: 'now' }),
        appendApprovalAudit: async () => {},
        getApproval: async () => APPROVAL,
        getRun: async () => null,
        updateRun: async () => {},
        getSubscriptionsForProvider: async () => [],
    };
    for (const [k, v] of Object.entries(patch)) { saved[k] = automationStore[k]; automationStore[k] = v; }
    const so = dispatchMod.dispatchOrgScopedEvent, su = dispatchMod.dispatchEvent;
    dispatchMod.dispatchOrgScopedEvent = () => Promise.resolve([]);
    dispatchMod.dispatchEvent = () => Promise.resolve([]);
    try { await fn(); } finally {
        for (const [k, v] of Object.entries(saved)) automationStore[k] = v;
        dispatchMod.dispatchOrgScopedEvent = so;
        dispatchMod.dispatchEvent = su;
    }
}

test('studio rejects without a reason are refused', async () => {
    await withPatched(async () => {
        const { code, body } = await decide({
            approval: APPROVAL, run: null, deciderId: 'owner',
            decision: 'reject', source: 'studio',
        });
        assert.strictEqual(code, 400);
        assert.strictEqual(body.field, 'reason');
    });
});

test('a whitespace-only reason does not satisfy the studio rule', async () => {
    await withPatched(async () => {
        const { code } = await decide({
            approval: APPROVAL, run: null, deciderId: 'owner',
            decision: 'reject', reason: '   \n ', source: 'studio',
        });
        assert.strictEqual(code, 400);
    });
});

test('the legacy builder path still accepts a reason-less reject', async () => {
    // The regression this file exists for. The previously-released SPA's
    // ⋯-menu Reject calls approveStep(id, 'reject') with no third argument;
    // this is the server side of that call.
    await withPatched(async () => {
        const { code, body } = await decide({
            approval: APPROVAL, run: null, deciderId: 'owner',
            decision: 'reject', source: 'builder',
        });
        assert.notStrictEqual(code, 400, `builder reject was refused: ${JSON.stringify(body)}`);
        assert.strictEqual(body.decision, 'reject');
    });
});

test('builder still records the reason when one IS supplied', async () => {
    // Relaxing the requirement must not mean discarding the field — the new
    // SPA's ApprovalActionBar posts through this same path.
    await withPatched(async () => {
        const { code, body } = await decide({
            approval: APPROVAL, run: null, deciderId: 'owner',
            decision: 'reject', reason: 'budget pulled', source: 'builder',
        });
        assert.notStrictEqual(code, 400);
        assert.strictEqual(body.decision, 'reject');
    });
});

test('approve never needs a reason on any source', async () => {
    for (const source of ['studio', 'builder', 'nextcloud']) {
        await withPatched(async () => {
            const { code } = await decide({
                approval: APPROVAL, run: null, deciderId: 'owner',
                decision: 'approve', source,
            });
            assert.notStrictEqual(code, 400, `approve was refused for source '${source}'`);
        });
    }
});
