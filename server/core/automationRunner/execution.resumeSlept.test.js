/**
 * A resumed leg starts with the durable cross-run cache SHUT.
 *
 * The asymmetry this pins: a 30-second `Wait` calls memo.clear(), which latches
 * `slept` and closes the durable tier for the rest of the run — but an approval
 * or a form page ENDS the run and continues through executeAutomation with a
 * brand-new memo, so the pause that can last seven days reopened the very cache
 * the half-minute Wait had closed. Backwards from the intent.
 *
 * executeAutomation therefore builds the memo with `startSlept: isResume`.
 * `isResume` is `!!skipUntilStepId`, and resumeFromStep is the only thing that
 * passes it — so an automation that pauses three times stays shut for all three
 * later legs without anything having to be remembered on the run row.
 *
 * Run: node --test --test-force-exit core/automationRunner/execution.resumeSlept.test.js
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');

// ── In-memory automationStore stub ────────────────────────────────────────
const runs = new Map();
const runStepsByRun = new Map();
let AUTOMATION = null;
let runSeq = 0;

function makeRun({ automationId, version, userId, triggerKind, triggerPayload, mode, parentRunId, rootRunId }) {
    const id = `run-${++runSeq}`;
    const row = {
        id, automationId, version, userId, triggerKind,
        triggerPayload: triggerPayload || null, mode, status: 'queued',
        startedAt: new Date().toISOString(), finishedAt: null, durationMs: null,
        error: null, summary: null, parentRunId: parentRunId ?? null,
        rootRunId: rootRunId ?? null,
        cancelRequested: false, awaitingStepId: null, approvalToken: null,
        awaitingStepExpiresAt: null, errorClass: null, handledErrorCount: 0,
    };
    runs.set(id, row);
    runStepsByRun.set(id, []);
    return row;
}

const storeStub = {
    initDB: async () => {},
    createRun: async (args) => makeRun(args),
    getRun: async (id) => runs.get(id) || null,
    getAutomation: async () => AUTOMATION,
    updateRun: async (id, updates) => {
        const r = runs.get(id);
        if (!r) return false;
        Object.assign(r, updates);
        return true;
    },
    getRunsForAutomation: async () => [],
    getRunSteps: async (runId) => (runStepsByRun.get(runId) || []).slice(),
    recordRunStep: async (rec) => {
        const list = runStepsByRun.get(rec.runId);
        if (!list) return;
        const existing = list.find(s => s.stepId === rec.stepId && s.attempts === (rec.attempts ?? 1));
        const row = {
            runId: rec.runId, stepId: rec.stepId, parentStepId: rec.parentStepId ?? null,
            stepType: rec.stepType, attempts: rec.attempts ?? 1, status: rec.status,
            startedAt: rec.startedAt ?? null, finishedAt: rec.finishedAt ?? null,
            input: rec.input ?? null, output: rec.output ?? null,
            error: rec.error ?? null, errorClass: rec.errorClass ?? null, branchIndex: rec.branchIndex ?? null,
        };
        if (existing) Object.assign(existing, row);
        else list.push(row);
    },
    markRunning: async () => true,
    releaseAutomation: async () => {},
    resetAttempts: async () => {},
    updateAutomation: async () => {},
    requestCancelRun: async () => null,
    touchRunHeartbeat: async () => {},
    touchAutomationRunning: async () => {},
};

function stub(modPath, exportsObj) {
    const resolved = require.resolve(modPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

stub('../../stores/automationStore', storeStub);
stub('../../stores/userStore', { getUser: async () => null, getOrganization: async () => null });
stub('../../stores/configStore', { getConfig: async () => null, setConfig: async () => {} });
stub('../../stores/notificationStore', { createNotification: async () => {} });
stub('../../db', { pool: {} });
stub('../aiAgent', { getProviderForModel: async () => null });
stub('../providers', { getAdapter: () => ({}) });
stub('../../automation/codeSandbox', { run: async () => ({}) });

process.env.AUTOMATION_AUTH_LEGACY = '0';
process.env.NODE_ENV = 'test';

// The seam. execution.js DESTRUCTURES createToolMemo at load time, so the wrap
// has to be installed before the runner is required — and it delegates to the
// real factory rather than replacing it, because the assertion is about the
// memo the runner actually gets.
const toolMemo = require('./toolMemo');
const realCreate = toolMemo.createToolMemo;
const created = [];   // { opts, memo } per ctx built
toolMemo.createToolMemo = (opts = {}) => {
    const memo = realCreate(opts);
    created.push({ opts, memo });
    return memo;
};

// Approvals are gated on the Enterprise `approvals` capability; hasCapability
// fails closed without an entitlements snapshot. The gate itself is covered by
// engine.approval.test.js.
require('../entitlements/entitlements').hasCapability = async () => true;
const runner = require('../automationRunner');

after(() => { toolMemo.createToolMemo = realCreate; });

beforeEach(() => {
    runs.clear();
    runStepsByRun.clear();
    runSeq = 0;
    AUTOMATION = null;
    created.length = 0;
});

/** trigger → ap (approval) → tail. */
function automationWithApproval() {
    return {
        id: 'auto-slept', version: 1, userId: 'user-1', organizationId: 'org-a',
        title: 'Approval then a look-up', triggerType: 'manual',
        definition: {
            trigger: { id: 'trig', type: 'trigger', kind: 'manual' },
            steps: [
                { id: 'ap', type: 'approval', prompt: 'ok?' },
                { id: 'tail', type: 'set', fields: { decided: { kind: 'ref', path: 'steps.ap.output.approved' } } },
            ],
            edges: [{ from: 'trig', to: 'ap' }, { from: 'ap', to: 'tail' }],
        },
    };
}

test('the leg that resumes an approval starts already slept', async () => {
    const automation = automationWithApproval();
    AUTOMATION = automation;

    const paused = await runner.executeAutomation(automation, { triggerKind: 'manual' });
    assert.strictEqual(paused.status, 'awaiting_approval',
        `expected a pause, got ${paused.status} (${paused.error})`);
    assert.strictEqual(created.length, 1);
    assert.notStrictEqual(created[0].opts.startSlept, true, 'a fresh run is not asleep');
    assert.strictEqual(created[0].memo.hasSlept(), false);

    const resumed = await runner.resumeFromStep(paused.id, 'ap', { decision: { approved: true }, userId: 'user-1' });
    assert.strictEqual(resumed.status, 'success', `resume status (got ${resumed.status}: ${resumed.error})`);

    assert.strictEqual(created.length, 2, 'the resume builds its own ctx, and its own memo');
    assert.strictEqual(created[1].opts.startSlept, true,
        'an approval can sit for a week — the cross-run cache must not answer from before it');
    assert.strictEqual(created[1].memo.hasSlept(), true,
        'execAi reads hasSlept(), so this is what actually closes the durable tier');
});

test('an ordinary run is never marked slept by accident', async () => {
    // The flag closes a real optimisation, so it must not latch on a plain run
    // — that would quietly turn the durable cache off for everyone.
    AUTOMATION = null;
    const automation = {
        id: 'auto-plain', version: 1, userId: 'user-1', organizationId: 'org-a',
        title: 'No pause at all', triggerType: 'manual',
        definition: {
            trigger: { id: 'trig', type: 'trigger', kind: 'manual' },
            steps: [{ id: 'first', type: 'set', fields: { a: { kind: 'literal', value: 1 } } }],
            edges: [{ from: 'trig', to: 'first' }],
        },
    };
    const r = await runner.executeAutomation(automation, { triggerKind: 'manual' });
    assert.strictEqual(r.status, 'success', `${r.status}: ${r.error}`);
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].memo.hasSlept(), false);
});
