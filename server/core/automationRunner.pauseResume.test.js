/**
 * Pausing and coming back — W5-14 and W5-16.
 *
 * W5-14  resumeFromStep seeded its replay state from 'success' and
 *        'handled_error' rows only. runDag records a pin-serving step as
 *        'pinned' and a disabled / unresolved-arrayRef step as 'skipped' —
 *        both carry a real recorded output, and the resume path never
 *        dispatches them again (it sets only skipUntilStepId, so
 *        fillMissingUpstream is false). They therefore vanished from runState
 *        entirely: downstream bindings resolved to nothing, and for a pinned
 *        BRANCHER the replay threw "Replay missing branch label" — which made
 *        the approval impossible to complete. Pinning is the documented escape
 *        hatch for a slow step, so this is a normal path, not a corner.
 *
 * W5-16  execWait extends the IN-PROCESS deadline and nothing tells the
 *        database. The automations row is reaped on a window that cannot exceed
 *        ~61 minutes while a Wait runs to 24 hours, so a long wait had the row
 *        reaped mid-sleep, the concurrency marker cleared, and the scheduler
 *        free to start a SECOND run of the same automation.
 *
 * Run: node --test core/automationRunner.pauseResume.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');

// ── In-memory automationStore stub ────────────────────────────────────────
const runs = new Map();
const runStepsByRun = new Map();
const markerTouches = [];   // [automationId, instanceId] per refresh
let AUTOMATION = null;      // what getAutomation hands back to resumeFromStep
let runSeq = 0;

function makeRun({ automationId, version, userId, triggerKind, triggerPayload, mode, parentRunId }) {
    const id = `run-${++runSeq}`;
    const row = {
        id, automationId, version, userId, triggerKind,
        triggerPayload: triggerPayload || null, mode, status: 'queued',
        startedAt: new Date().toISOString(), finishedAt: null, durationMs: null,
        error: null, summary: null, parentRunId: parentRunId ?? null,
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
    markRunning: async () => {},
    releaseAutomation: async () => {},
    resetAttempts: async () => {},
    updateAutomation: async () => {},
    requestCancelRun: async () => null,
    touchRunHeartbeat: async () => {},
    // The store function this fix depends on. Recording the calls is the whole
    // point: without a refresh the automations row goes stale mid-Wait.
    touchAutomationRunning: async (automationId, instanceId) => { markerTouches.push([automationId, instanceId]); },
};

function stub(modPath, exportsObj) {
    const resolved = require.resolve(modPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

stub('../stores/automationStore', storeStub);
stub('../stores/userStore', { getUser: async () => null, getOrganization: async () => null });
stub('../stores/configStore', { getConfig: async () => null, setConfig: async () => {} });
stub('../stores/notificationStore', { createNotification: async () => {} });
stub('../db', { pool: {} });
stub('./aiAgent', { getProviderForModel: async () => null });
stub('./providers', { getAdapter: () => ({}) });
stub('../automation/codeSandbox', { run: async () => ({}) });

process.env.AUTOMATION_AUTH_LEGACY = '0';
process.env.NODE_ENV = 'test';

// Approvals are gated on the Enterprise `approvals` capability, checked in
// execApproval before the run pauses. hasCapability fails closed without a
// real entitlements snapshot, so this harness grants it; the gate itself is
// covered by core/automationRunner/engine.approval.test.js.
require('./entitlements/entitlements').hasCapability = async () => true;
const runner = require('./automationRunner');

// execWait sleeps on UNREF'd timers on purpose (a pending Wait must never hold
// a draining worker open), so under `node --test` the event loop would run dry
// mid-await and cancel the wait cases. One ref'd ticker keeps them observable.
const keepEventLoopAlive = setInterval(() => {}, 250);
after(() => {
    clearInterval(keepEventLoopAlive);
});
// There used to be a `setImmediate(() => process.exit(...))` here as well. It
// forced the process down, which masked any OTHER handle this file might leave
// open and could truncate a failure reported after it fired. Clearing the
// ticker is enough to let the process exit on its own; if it ever does not,
// the runner names this file instead of quietly dropping results.

function reset() { runs.clear(); runStepsByRun.clear(); markerTouches.length = 0; runSeq = 0; AUTOMATION = null; }

/**
 * trigger → gate (pinned condition) → ap (approval) → tail.
 * The pinned brancher sits BEFORE the pause, so the resume has to replay it.
 */
function automationWithPinnedBrancher() {
    return {
        id: 'auto-1',
        version: 1,
        userId: 'user-1',
        organizationId: null,
        title: 'Pinned brancher before an approval',
        triggerType: 'manual',
        definition: {
            trigger: { id: 'trig', type: 'trigger', kind: 'manual' },
            steps: [
                { id: 'gate', type: 'condition', expr: 'true', pinnedOutput: { branch: 'then', ok: true } },
                { id: 'ap', type: 'approval', prompt: 'ok?' },
                { id: 'tail', type: 'set', fields: { decided: { kind: 'ref', path: 'steps.ap.output.approved' } } },
            ],
            edges: [
                { from: 'trig', to: 'gate' },
                { from: 'gate', to: 'ap', label: 'then' },
                { from: 'ap', to: 'tail' },
            ],
        },
    };
}

// ── W5-14 ─────────────────────────────────────────────────────────────────

test('an approval behind a PINNED brancher can actually be completed', async () => {
    reset();
    const automation = automationWithPinnedBrancher();
    AUTOMATION = automation;

    const paused = await runner.executeAutomation(automation, { triggerKind: 'manual' });
    assert.strictEqual(paused.status, 'awaiting_approval', `expected a pause, got ${paused.status} (${paused.error})`);
    // The pin was served and recorded as 'pinned' — the status the resume used
    // to throw away.
    const pausedSteps = await storeStub.getRunSteps(paused.id);
    assert.strictEqual(pausedSteps.find(s => s.stepId === 'gate')?.status, 'pinned');

    const resumed = await runner.resumeFromStep(paused.id, 'ap', { decision: { approved: true }, userId: 'user-1' });
    assert.strictEqual(resumed.status, 'success',
        `the resume must not die on "Replay missing branch label" (got ${resumed.status}: ${resumed.error})`);

    const byId = new Map((await storeStub.getRunSteps(resumed.id)).map(s => [s.stepId, s]));
    assert.deepStrictEqual(byId.get('tail')?.output, { decided: true }, 'the flow continued past the pause');
});

test('a SKIPPED step keeps its recorded output across a resume', async () => {
    reset();
    const automation = {
        id: 'auto-1', version: 1, userId: 'user-1', organizationId: null,
        title: 'Disabled step before an approval', triggerType: 'manual',
        definition: {
            trigger: { id: 'trig', type: 'trigger', kind: 'manual' },
            steps: [
                { id: 'off', type: 'set', disabled: true, fields: { a: { kind: 'literal', value: 1 } } },
                { id: 'ap', type: 'approval', prompt: 'ok?' },
                { id: 'tail', type: 'set', fields: { wasDisabled: { kind: 'ref', path: 'steps.off.output.disabled' } } },
            ],
            edges: [{ from: 'trig', to: 'off' }, { from: 'off', to: 'ap' }, { from: 'ap', to: 'tail' }],
        },
    };
    AUTOMATION = automation;

    const paused = await runner.executeAutomation(automation, { triggerKind: 'manual' });
    assert.strictEqual(paused.status, 'awaiting_approval');
    assert.strictEqual((await storeStub.getRunSteps(paused.id)).find(s => s.stepId === 'off')?.status, 'skipped');

    const resumed = await runner.resumeFromStep(paused.id, 'ap', { decision: { approved: true }, userId: 'user-1' });
    assert.strictEqual(resumed.status, 'success', `resume status (got ${resumed.status}: ${resumed.error})`);
    const byId = new Map((await storeStub.getRunSteps(resumed.id)).map(s => [s.stepId, s]));
    assert.deepStrictEqual(byId.get('tail')?.output, { wasDisabled: true },
        'the skipped step is still in runState — bindings to it resolve');
});

test('a pin added AFTER the pause is honoured on the resume', async () => {
    reset();
    const automation = automationWithPinnedBrancher();
    // No pin at all for the first leg: gate decides live.
    delete automation.definition.steps.find(s => s.id === 'gate').pinnedOutput;
    AUTOMATION = automation;

    const paused = await runner.executeAutomation(automation, { triggerKind: 'manual' });
    assert.strictEqual(paused.status, 'awaiting_approval');

    // The author pins a step while the approval is waiting. resumeFromStep
    // re-reads the definition, so the pin has to win over the recorded row.
    const pinned = automationWithPinnedBrancher();
    pinned.definition.steps.find(s => s.id === 'gate').pinnedOutput = { branch: 'then', ok: 'from-pin' };
    AUTOMATION = pinned;

    const resumed = await runner.resumeFromStep(paused.id, 'ap', { decision: { approved: true }, userId: 'user-1' });
    assert.strictEqual(resumed.status, 'success', `resume status (got ${resumed.status}: ${resumed.error})`);
});

// ── W5-16 ─────────────────────────────────────────────────────────────────

test('a Wait refreshes the automations-row running marker, not just the in-process deadline', async () => {
    reset();
    const automation = {
        id: 'auto-1', version: 1, userId: 'user-1', organizationId: null,
        title: 'Long wait', triggerType: 'schedule',
        definition: {
            trigger: { id: 'trig', type: 'trigger', kind: 'manual' },
            // 1 second here; in production this is the 24-hour case that
            // outlives the reaper's ~61-minute window on the automations row.
            steps: [{ id: 'w', type: 'wait', seconds: 1 }],
            edges: [{ from: 'trig', to: 'w' }],
        },
    };
    AUTOMATION = automation;

    const result = await runner.executeAutomation(automation, { triggerKind: 'manual' });
    assert.strictEqual(result.status, 'success', `run status (got ${result.status}: ${result.error})`);
    assert.ok(markerTouches.length > 0,
        'the deadline extension must also push the automations row forward — otherwise the reaper clears the '
        + 'concurrency marker mid-sleep and the scheduler starts a second run of the same automation');
    assert.strictEqual(markerTouches[0][0], 'auto-1');
    assert.strictEqual(markerTouches[0][1], runner.INSTANCE_ID);
});

test('a dry-run never touches the marker (it never took one)', async () => {
    reset();
    const automation = {
        id: 'auto-1', version: 1, userId: 'user-1', organizationId: null,
        title: 'Long wait', triggerType: 'manual',
        definition: {
            trigger: { id: 'trig', type: 'trigger', kind: 'manual' },
            steps: [{ id: 'w', type: 'wait', seconds: 3600 }],
            edges: [{ from: 'trig', to: 'w' }],
        },
    };
    AUTOMATION = automation;

    const result = await runner.executeAutomation(automation, { triggerKind: 'manual', mode: 'dry_run' });
    assert.strictEqual(result.status, 'success');
    assert.deepStrictEqual(markerTouches, [], 'a preview must not touch a concurrent live run\'s marker');
});
