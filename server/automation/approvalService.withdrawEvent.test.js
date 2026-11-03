// @typecheck
/**
 * Ending an approval pause changes the run AND says so (run-watch F10):
 *
 *   withdraw  the run is cancelled, its paused step row 'cancelled', run.finished
 *   reject    the run fails, its paused step row 'rejected', run.failed
 *   approve   with respond "created" the answer is 202 { runId } as soon as the
 *             continuation exists (core/automationRunner/startCapped.mts)
 *
 * Every event carries the journey's rootRunId, so a list keyed on the journey
 * updates instead of listing a closed run as "waiting".
 *
 * Run: node --test automation/approvalService.withdrawEvent.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');

const automationStore = require('../stores/automationStore');
const dispatchMod = require('./triggerBus/dispatch');
const runner = require('../core/automationRunner');
const { onAny } = require('../core/runEventBus');
const { decide, withdraw } = require('./approvalService');

after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });

const later = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const APPROVAL = {
    id: 'apr_1', source: 'run', status: 'pending',
    organizationId: 'org1', ownerId: 'owner', runId: 'leg2', rootRunId: 'head', stepId: 'ap_1',
    prompt: 'Ship it?', fields: null, expiresAt: null, approvers: null, stages: null,
    assigneeUserId: null, assigneeGroupId: null, automationTitle: 'Orders',
};
const RUN = {
    id: 'leg2', userId: 'owner', automationId: 'a1', status: 'awaiting_approval', awaitingStepId: 'ap_1',
    rootRunId: 'head', mode: 'live', startedByUserId: 'editor3',
};

/** @type {{ updateRun: any[], closeStep: any[], resume: any[] }} */
const calls = { updateRun: [], closeStep: [], resume: [] };

/** @param {() => Promise<void>} fn */
async function withPatched(fn) {
    for (const k of Object.keys(calls)) calls[/** @type {keyof typeof calls} */ (k)].length = 0;
    /** @type {Record<string, any>} */
    const saved = {};
    /** @type {Record<string, any>} */
    const patch = {
        decideApproval: async (/** @type {string} */ _id, /** @type {any} */ p) => ({ ...APPROVAL, ...p }),
        appendApprovalAudit: async () => {},
        getApproval: async () => APPROVAL,
        getRun: async () => ({ ...RUN }),
        updateRun: async (/** @type {string} */ id, /** @type {any} */ u) => { calls.updateRun.push({ id, u }); return true; },
        closeAwaitingStepRow: async (/** @type {any[]} */ ...a) => { calls.closeStep.push(a); return 1; },
        getSubscriptionsForProvider: async () => [],
    };
    const store = /** @type {Record<string, any>} */ (automationStore);
    for (const [k, v] of Object.entries(patch)) { saved[k] = store[k]; store[k] = v; }
    const d = /** @type {Record<string, any>} */ (dispatchMod);
    const so = d.dispatchOrgScopedEvent, su = d.dispatchEvent;
    d.dispatchOrgScopedEvent = () => Promise.resolve([]);
    d.dispatchEvent = () => Promise.resolve([]);
    const r = /** @type {Record<string, any>} */ (runner);
    const savedResume = r.resumeFromStep;
    r.resumeFromStep = async (/** @type {string} */ runId, /** @type {string} */ stepId, /** @type {any} */ opts) => {
        calls.resume.push({ runId, stepId, opts });
        await opts.onRunCreated?.({ id: 'leg3' });
        await later(200);
        return { id: 'leg3', status: 'success' };
    };
    /** @type {any[]} */
    const events = [];
    const off = onAny((/** @type {any} */ e) => events.push(e));
    try { await fn.call(null, /** @type {any} */ (events)); } finally {
        off();
        for (const [k, v] of Object.entries(saved)) store[k] = v;
        d.dispatchOrgScopedEvent = so;
        d.dispatchEvent = su;
        r.resumeFromStep = savedResume;
    }
}

test('withdraw cancels the run, closes its paused step row and emits run.finished with the journey root', async () => {
    await withPatched(/** @type {any} */ (async (/** @type {any[]} */ events) => {
        const { code } = await withdraw({ approval: APPROVAL, deciderId: 'owner', source: 'builder' });
        assert.strictEqual(code, 200);
        const write = calls.updateRun.find((c) => c.id === 'leg2');
        assert.strictEqual(write.u.status, 'cancelled');
        assert.deepStrictEqual(calls.closeStep, [['leg2', 'ap_1', 'awaiting_approval', 'cancelled']]);
        const finished = events.filter((e) => e.type === 'run.finished' && e.runId === 'leg2');
        assert.strictEqual(finished.length, 1);
        assert.strictEqual(finished[0].status, 'cancelled');
        assert.strictEqual(finished[0].rootRunId, 'head');
        assert.strictEqual(finished[0].startedByUserId, 'editor3');
    }));
});

test('reject fails the run, marks its paused step row rejected and emits run.failed', async () => {
    await withPatched(/** @type {any} */ (async (/** @type {any[]} */ events) => {
        const { code, body } = await decide({ approval: APPROVAL, run: { ...RUN }, deciderId: 'owner', decision: 'reject', reason: 'Too expensive', source: 'builder' });
        assert.strictEqual(code, 200, JSON.stringify(body));
        const write = calls.updateRun.find((c) => c.id === 'leg2');
        assert.strictEqual(write.u.status, 'error');
        assert.strictEqual(write.u.errorClass, 'ApprovalRejected');
        assert.deepStrictEqual(calls.closeStep, [['leg2', 'ap_1', 'awaiting_approval', 'rejected']]);
        const failed = events.filter((e) => e.type === 'run.failed' && e.runId === 'leg2');
        assert.strictEqual(failed.length, 1);
        assert.strictEqual(failed[0].errorClass, 'ApprovalRejected');
        assert.strictEqual(failed[0].rootRunId, 'head');
        assert.match(failed[0].error, /Too expensive/);
    }));
});

test('approve with respond "created" answers 202 with the continuation\'s id at once', async () => {
    await withPatched(async () => {
        const started = Date.now();
        const { code, body } = await decide({ approval: APPROVAL, run: { ...RUN }, deciderId: 'owner', decision: 'approve', source: 'builder', respond: 'created' });
        assert.strictEqual(code, 202, JSON.stringify(body));
        assert.strictEqual(body.runId, 'leg3');
        assert.strictEqual(body.pending, true);
        assert.ok(Date.now() - started < 150, 'did not wait for the continuation');
        const parent = calls.updateRun.filter((c) => c.id === 'leg2').at(-1);
        assert.strictEqual(parent.u.status, 'success');
        assert.match(parent.u.summary, /leg3/);
        await later(250);
    });
});

test('approve without respond answers with the finished continuation, as before', async () => {
    await withPatched(async () => {
        const { code, body } = await decide({ approval: APPROVAL, run: { ...RUN }, deciderId: 'owner', decision: 'approve', source: 'builder' });
        assert.strictEqual(code, 200, JSON.stringify(body));
        assert.strictEqual(body.run.id, 'leg3');
        assert.strictEqual(calls.resume[0].opts.decision.approved, true);
    });
});
