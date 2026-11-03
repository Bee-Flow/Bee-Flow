/**
 * A rejected approval continues on its 'on_rejected' branch when the flow
 * wires one (D4a), and ends the run as before when it does not.
 *
 *   - reject + on_rejected edge → the decision resumes the run like an approve
 *     does; the continuation runs ONLY the rejected branch, the approval's
 *     output is the contract's shape with approved:false, and the paused run
 *     is closed 'success' with the rejected-branch summary.
 *   - reject without that edge → ApprovalRejected, unchanged.
 *   - approve with both edges wired → only the plain branch runs.
 *   - a continuation that cannot start → the paused run ends in error
 *     `resume_failed` instead of "success — continuation running".
 *
 * Real runner (executeAutomation / resumeFromStep / runDag) over the
 * testkit's in-memory store; the decision fan-out (events, hooks) is patched out.
 *
 * Run: node --test automation/approvalDecision.rejectBranch.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');

// The runner over an in-memory store (core/automationRunner.testkit.js); what
// a decision needs on top of it is added to that same store object below.
// Anything below that still reaches the database gets a recording pool.
require('../testUtils/routeHarness').recordDb();
const { installRunnerStoreStubs } = require('../core/automationRunner.testkit');
const { runs, resetRuns, storeStub } = installRunnerStoreStubs();
const runStepsByRun = new Map();
const closedRows = [];
let AUTOMATION = null;

Object.assign(storeStub, {
    getAutomation: async () => AUTOMATION,
    getRun: async (id) => runs.get(id) || null,
    getRunSteps: async (runId) => (runStepsByRun.get(runId) || []).slice(),
    recordRunStep: async (rec) => {
        const list = runStepsByRun.get(rec.runId) || [];
        runStepsByRun.set(rec.runId, list);
        const existing = list.find(s => s.stepId === rec.stepId && s.attempts === (rec.attempts ?? 1));
        const row = {
            runId: rec.runId, stepId: rec.stepId, parentStepId: rec.parentStepId ?? null,
            stepType: rec.stepType, attempts: rec.attempts ?? 1, status: rec.status,
            input: rec.input ?? null, output: rec.output ?? null, error: rec.error ?? null,
        };
        if (existing) Object.assign(existing, row);
        else list.push(row);
    },
    touchAutomationRunning: async () => {},
    // The decision write and its audit.
    decideApproval: async (id, p) => ({ ...APPROVAL, ...p, id, decidedAt: new Date().toISOString() }),
    appendApprovalAudit: async () => {},
    getApproval: async () => APPROVAL,
    closeAwaitingStepRow: async (runId, stepId, from, to) => { closedRows.push({ runId, stepId, from, to }); return 1; },
});

// The decision's fan-out is not what this file is about.
require('./approvalEvents').dispatchApprovalDecided = () => {};
require('./approvalHooks').runOnDecidedHook = async () => ({ ran: false });
require('../core/entitlements/entitlements').hasCapability = async () => true;
const runner = require('../core/automationRunner');
const { finalizeDecision } = require('./approvalDecision');

const keepEventLoopAlive = setInterval(() => {}, 250);
after(() => clearInterval(keepEventLoopAlive));

let APPROVAL = null;

function reset() {
    resetRuns(); runStepsByRun.clear(); closedRows.length = 0; AUTOMATION = null; APPROVAL = null;
}

/** trigger → ap (approval) → yes (plain) / no (on_rejected, when wired). */
function automation({ rejectedBranch = true } = {}) {
    const edges = [{ from: 'trig', to: 'ap' }, { from: 'ap', to: 'yes' }];
    if (rejectedBranch) edges.push({ from: 'ap', to: 'no', label: 'on_rejected' });
    return {
        id: 'auto-1', version: 1, userId: 'user-1', organizationId: null,
        title: 'Approve or reject', triggerType: 'manual',
        definition: {
            trigger: { id: 'trig', type: 'trigger', kind: 'manual' },
            steps: [
                { id: 'ap', type: 'approval', prompt: 'Ship it?' },
                { id: 'yes', type: 'set', fields: { went: { kind: 'literal', value: 'approved path' } } },
                { id: 'no', type: 'set', fields: {
                    approved: { kind: 'ref', path: 'steps.ap.output.approved' },
                    reason: { kind: 'ref', path: 'steps.ap.output.reason' },
                } },
            ],
            edges,
        },
    };
}

async function pausedRun(opts) {
    AUTOMATION = automation(opts);
    const paused = await runner.executeAutomation(AUTOMATION, { triggerKind: 'manual' });
    assert.strictEqual(paused.status, 'awaiting_approval', `expected a pause, got ${paused.status} (${paused.error})`);
    APPROVAL = {
        id: 'apr-1', source: 'run', status: 'pending', organizationId: null,
        ownerId: 'user-1', runId: paused.id, stepId: 'ap', prompt: 'Ship it?',
        fields: null, expiresAt: null, stages: null, seats: null, decisionRule: null,
    };
    return runs.get(paused.id);
}

function decide(run, decision, reason) {
    return finalizeDecision({
        approval: APPROVAL, run, deciderId: 'user-1', decision,
        trimmedReason: reason, coercedAnswers: null, source: 'studio', respond: 'finished',
    });
}

async function stepsOf(runId) {
    return new Map((await storeStub.getRunSteps(runId)).map(s => [s.stepId, s]));
}

test('reject with an on_rejected edge continues on the rejected branch only', async () => {
    reset();
    const run = await pausedRun();
    const { code, body } = await decide(run, 'reject', 'No budget this quarter');

    assert.strictEqual(code, 200, `answer ${code}: ${JSON.stringify(body)}`);
    assert.strictEqual(body.decision, 'reject');
    const child = body.run;
    assert.ok(child?.id && child.id !== run.id, 'a continuation run answered');
    assert.strictEqual(child.status, 'success', `continuation status ${child.status}: ${child.error}`);

    const steps = await stepsOf(child.id);
    assert.ok(!steps.has('yes'), 'the approve branch must not run on a reject');
    assert.deepStrictEqual(steps.get('no')?.output, { approved: false, reason: 'No budget this quarter' });

    const parent = runs.get(run.id);
    assert.strictEqual(parent.status, 'success');
    assert.strictEqual(parent.summary, 'Rejected — continued on the rejected branch');
    assert.strictEqual(parent.errorClass, null, 'no ApprovalRejected on a reject that continued');
    assert.deepStrictEqual(closedRows, [{ runId: run.id, stepId: 'ap', from: 'awaiting_approval', to: 'rejected' }]);
});

test('reject WITHOUT an on_rejected edge still ends the run as ApprovalRejected', async () => {
    reset();
    const run = await pausedRun({ rejectedBranch: false });
    const { code, body } = await decide(run, 'reject', 'Not now');

    assert.strictEqual(code, 200);
    assert.strictEqual(body.decision, 'reject');
    const parent = runs.get(run.id);
    assert.strictEqual(parent.status, 'error');
    assert.strictEqual(parent.errorClass, 'ApprovalRejected');
    assert.strictEqual(parent.error, 'Approval rejected: Not now');
    assert.strictEqual(runs.size, 1, 'no continuation run was started');
});

test('approve with both edges wired runs only the plain branch', async () => {
    reset();
    const run = await pausedRun();
    const { code, body } = await decide(run, 'approve', 'Fine');

    assert.strictEqual(code, 200, `answer ${code}: ${JSON.stringify(body)}`);
    const steps = await stepsOf(body.run.id);
    assert.ok(steps.has('yes'), 'the approve branch runs');
    assert.ok(!steps.has('no'), 'an approve never follows on_rejected');
    assert.strictEqual(runs.get(run.id).summary, `Resumed via approval — see child run ${body.run.id}`);
});

test('a continuation that cannot start flips the paused run to error resume_failed', async () => {
    reset();
    const run = await pausedRun();
    const realResume = runner.resumeFromStep;
    runner.resumeFromStep = async () => { throw new Error('boom'); };
    try {
        const { code, body } = await decide(run, 'approve', '');
        assert.strictEqual(code, 500);
        assert.strictEqual(body.code, 'resume_failed');
        const parent = runs.get(run.id);
        assert.strictEqual(parent.status, 'error');
        assert.strictEqual(parent.errorClass, 'resume_failed');
        assert.notStrictEqual(parent.summary, 'Resumed via approval — continuation running (see run history).');
    } finally {
        runner.resumeFromStep = realResume;
    }
});
