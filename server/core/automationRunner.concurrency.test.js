/**
 * §WS2.4 — concurrency guard + dry-run marker gating in executeAutomation
 * (core/automationRunner.js, ~lines 2007-2035 + 2452-2472).
 *
 *  - A LIVE non-schedule run whose automationStore.markRunning() returns FALSE
 *    must NOT walk the DAG: it cancels the just-created run ('cancelled',
 *    summary mentions "already running") and returns without dispatching any
 *    step.
 *  - markRunning() returning TRUE lets the DAG run normally.
 *  - Schedule-trigger runs and dry-runs (mode:'dry_run') skip the marker
 *    entirely, so a FALSE marker can never block them.
 *  - A dry-run never owns the marker → it must NOT call releaseAutomation /
 *    updateAutomation(lastStatus); a live run does call them.
 *
 * Uses pure in-process `set` steps (execSet just resolves bindings) so there's
 * no LLM / tool / sandbox / DB dependency — fully deterministic. The store is a
 * spy-instrumented in-memory stub (mirrors automationRunner.partial.test.js).
 *
 * Run: node --test core/automationRunner.concurrency.test.js
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');

// ── Spy-instrumented in-memory automationStore stub ────────────────────────
const runs = new Map();          // runId -> run row
const runStepsByRun = new Map(); // runId -> [step row]
let runSeq = 0;

// Spy counters / control knobs reset in beforeEach.
const spies = {
    markRunning: 0,
    releaseAutomation: 0,
    updateAutomationLastStatus: 0,
    recordRunStep: 0,
    resetAttempts: 0,
    // null = fail open (catch → true); the runner only blocks on an explicit false.
    markRunningResult: true,
};

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
    updateRun: async (id, updates) => {
        const r = runs.get(id);
        if (!r) return false;
        Object.assign(r, updates);
        return true;
    },
    getRunsForAutomation: async () => [],
    getRunSteps: async (runId) => (runStepsByRun.get(runId) || []).slice(),
    // Upsert on (runId, stepId, attempts) like the real store: the runner
    // writes a 'running' row when a step starts and the real row when it
    // lands, and an append-only stub would leave the placeholder in front.
    recordRunStep: async (rec) => {
        spies.recordRunStep += 1;
        const list = runStepsByRun.get(rec.runId);
        if (!list) return;
        const row = { ...rec, attempts: rec.attempts ?? 1 };
        const i = list.findIndex(r => r.stepId === row.stepId && r.attempts === row.attempts);
        if (i >= 0) list[i] = row; else list.push(row);
    },
    // §WS2.4 marker. The runner treats an explicit `false` as "already running";
    // a throw is caught and treated as fail-open (true).
    markRunning: async () => {
        spies.markRunning += 1;
        if (spies.markRunningResult === 'throw') throw new Error('infra blip');
        return spies.markRunningResult;
    },
    releaseAutomation: async () => { spies.releaseAutomation += 1; },
    resetAttempts: async () => { spies.resetAttempts += 1; },
    updateAutomation: async (id, updates) => {
        if (updates && Object.prototype.hasOwnProperty.call(updates, 'lastStatus')) {
            spies.updateAutomationLastStatus += 1;
        }
        return true;
    },
    touchRunHeartbeat: async () => {},
    requestCancelRun: async () => null,
    // Only the resume tests need this: resumeFromStep re-loads the automation row.
    getAutomation: async (id) => (currentAutomation?.id === id ? currentAutomation : null),
};
let currentAutomation = null;

// ── Stub DB-/service-touching modules BEFORE requiring the runner. ──────────
function stub(modPath, exportsObj) {
    const resolved = require.resolve(modPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

stub('../stores/automationStore', storeStub);
stub('../stores/userStore', { getUser: async () => null, getOrganization: async () => null });
stub('../stores/configStore', { getConfig: async () => null, setConfig: async () => {} });
stub('../stores/notificationStore', { createNotification: async () => {} });

process.env.AUTOMATION_AUTH_LEGACY = '0';
process.env.NODE_ENV = 'test';
// A webhook- or event-started run WAITS for a held marker before it gives up
// (execution.js: CONCURRENT_WAIT_MS, five minutes by default, polled on
// unref'd timers). This suite pins the give-up, not the wait: with the default
// window the "fresh trigger is still blocked" case took exactly 300 s, and it
// only got there because an unrelated ref'd interval happened to keep the
// process alive. Once that interval was unref'd the loop drained mid-wait and
// node cancelled the test. Read at require time, so set before the runner loads.
process.env.AUTOMATION_CONCURRENT_WAIT_MS = '0';

// Approvals are gated on the Enterprise `approvals` capability, checked in
// execApproval before the run pauses. hasCapability fails closed without a
// real entitlements snapshot, so this harness grants it; the gate itself is
// covered by core/automationRunner/engine.approval.test.js.
require('./entitlements/entitlements').hasCapability = async () => true;
const runner = require('./automationRunner');

// Requiring the runner registers timers / a DB pool via init side-effects of
// other stores; force a clean exit once all tests report (same as the partial
// suite).
after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });

beforeEach(() => {
    runs.clear();
    runStepsByRun.clear();
    runSeq = 0;
    spies.markRunning = 0;
    spies.releaseAutomation = 0;
    spies.updateAutomationLastStatus = 0;
    spies.recordRunStep = 0;
    spies.resetAttempts = 0;
    spies.markRunningResult = true;
    currentAutomation = null;
});

// ── The automation: trigger → A (set) ──────────────────────────────────────
// A single deterministic `set` step. If it runs we see a recorded step row
// with output { ran: true }; if the guard fires it never executes.
function freshAutomation() {
    return {
        id: 'auto-1',
        version: 1,
        userId: 'user-1',
        organizationId: null,
        title: 'Concurrency guard regression',
        triggerType: 'manual',
        definition: {
            trigger: { id: 'trig', type: 'trigger' },
            steps: [
                { id: 'A', type: 'set', fields: { ran: { kind: 'literal', value: true } } },
            ],
            edges: [{ from: 'trig', to: 'A' }],
        },
    };
}

test('§WS2.4 — live run with markRunning=false is cancelled and skips the DAG', async () => {
    spies.markRunningResult = false;

    const result = await runner.executeAutomation(freshAutomation(), { triggerKind: 'manual', mode: 'live' });

    assert.strictEqual(spies.markRunning, 1, 'markRunning was consulted');
    assert.strictEqual(result.status, 'cancelled', 'run ended cancelled');
    assert.match(result.summary || '', /already running/i, 'summary cites the concurrent run');

    // No step dispatched, no step row recorded.
    assert.strictEqual(spies.recordRunStep, 0, 'no step was recorded');
    const steps = await storeStub.getRunSteps(result.id);
    assert.strictEqual(steps.length, 0, 'no step ran');

    // A blocked run never owned the marker, so it must not release it.
    assert.strictEqual(spies.releaseAutomation, 0, 'blocked run did not release the marker');
    assert.strictEqual(spies.updateAutomationLastStatus, 0, 'blocked run did not write lastStatus');
});

test('§WS2.4 — live run with markRunning=true walks the DAG normally', async () => {
    spies.markRunningResult = true;

    const result = await runner.executeAutomation(freshAutomation(), { triggerKind: 'manual', mode: 'live' });

    assert.strictEqual(spies.markRunning, 1, 'markRunning was consulted');
    assert.strictEqual(result.status, 'success', `run succeeded (got ${result.status}, error: ${result.error})`);

    const steps = await storeStub.getRunSteps(result.id);
    const a = steps.find(s => s.stepId === 'A');
    assert.ok(a, 'step A was recorded (DAG ran)');
    assert.strictEqual(a.status, 'success', 'step A succeeded');
    assert.deepStrictEqual(a.output, { ran: true }, 'step A produced its real output');

    // A live success owns the marker → releases it + writes lastStatus.
    assert.strictEqual(spies.releaseAutomation, 1, 'live run released the marker');
    assert.strictEqual(spies.updateAutomationLastStatus, 1, 'live run wrote lastStatus');
});

test('§WS2.4 — markRunning that THROWS fails open (run proceeds)', async () => {
    // An infra error on the marker must not block the run: catch → true.
    spies.markRunningResult = 'throw';

    const result = await runner.executeAutomation(freshAutomation(), { triggerKind: 'manual', mode: 'live' });

    assert.strictEqual(result.status, 'success', `fail-open run succeeded (got ${result.status})`);
    const steps = await storeStub.getRunSteps(result.id);
    assert.ok(steps.some(s => s.stepId === 'A'), 'DAG ran despite marker throwing');
});

test('§WS2.4 — a SCHEDULE trigger is never blocked by markRunning (marker skipped)', async () => {
    // Schedule runs are already claimed atomically upstream; executeAutomation
    // must NOT consult the marker for them, so even a false marker cannot block.
    spies.markRunningResult = false;

    const result = await runner.executeAutomation(freshAutomation(), { triggerKind: 'schedule', mode: 'live' });

    assert.strictEqual(spies.markRunning, 0, 'markRunning was NOT consulted for a schedule run');
    assert.strictEqual(result.status, 'success', `schedule run succeeded (got ${result.status})`);
    const steps = await storeStub.getRunSteps(result.id);
    assert.ok(steps.some(s => s.stepId === 'A'), 'schedule DAG ran');
});

test('§WS2.4 — a DRY-RUN is never blocked by markRunning (marker skipped)', async () => {
    spies.markRunningResult = false;

    const result = await runner.executeAutomation(freshAutomation(), { triggerKind: 'manual', mode: 'dry_run' });

    assert.strictEqual(spies.markRunning, 0, 'markRunning was NOT consulted for a dry-run');
    assert.strictEqual(result.status, 'success', `dry-run succeeded (got ${result.status})`);
});

test('§WS2.4 — a DRY-RUN never releases the marker nor writes lastStatus', async () => {
    spies.markRunningResult = true; // irrelevant — marker is skipped for dry-runs

    const result = await runner.executeAutomation(freshAutomation(), { triggerKind: 'manual', mode: 'dry_run' });

    assert.strictEqual(result.status, 'success', `dry-run succeeded (got ${result.status})`);
    assert.strictEqual(spies.markRunning, 0, 'dry-run never marks the row running');
    assert.strictEqual(spies.releaseAutomation, 0, 'dry-run did NOT release the marker');
    assert.strictEqual(spies.updateAutomationLastStatus, 0, 'dry-run did NOT overwrite lastStatus');
    assert.strictEqual(spies.resetAttempts, 0, 'dry-run did NOT reset attempts');
});

test('§WS2.4 — a LIVE run DOES release the marker + write lastStatus (contrast)', async () => {
    spies.markRunningResult = true;

    const result = await runner.executeAutomation(freshAutomation(), { triggerKind: 'manual', mode: 'live' });

    assert.strictEqual(result.status, 'success', `live run succeeded (got ${result.status})`);
    assert.strictEqual(spies.releaseAutomation, 1, 'live run released the marker exactly once');
    assert.strictEqual(spies.updateAutomationLastStatus, 1, 'live run wrote lastStatus exactly once');
    assert.strictEqual(spies.resetAttempts, 1, 'live success reset attempts');
});

// ── A RESUME is a continuation, not a new trigger ─────────────────────────
//
// resumeFromStep re-enters executeAutomation with the ORIGINAL run's
// triggerKind, so an approval decision was indistinguishable from a fresh
// webhook at the guard above. Whenever another live run of the same automation
// held the marker at that instant, the approved continuation was finalised
// 'cancelled' having dispatched nothing — while the approve endpoint had
// already consumed the single-use token and stamped the parent 'success'. No
// endpoint re-issues that token, so the approved work was gone for good.

/** trigger → ap (approval gate) → after (set). */
function approvalAutomation() {
    return {
        id: 'auto-1',
        version: 1,
        userId: 'user-1',
        organizationId: null,
        title: 'Approval resume vs the concurrency guard',
        triggerType: 'webhook',
        definition: {
            trigger: { id: 'trig', type: 'trigger' },
            steps: [
                { id: 'ap', type: 'approval', title: 'Approve me' },
                { id: 'after', type: 'set', fields: { done: { kind: 'literal', value: true } } },
            ],
            edges: [{ from: 'trig', to: 'ap' }, { from: 'ap', to: 'after' }],
        },
    };
}

test('§WS2.4 — a RESUME with markRunning=false still runs the approved continuation', async () => {
    currentAutomation = approvalAutomation();

    // Run 1 (webhook) pauses at the gate and releases the marker.
    const paused = await runner.executeAutomation(currentAutomation, { triggerKind: 'webhook', mode: 'live' });
    assert.strictEqual(paused.status, 'awaiting_approval', `run 1 paused (got ${paused.status})`);

    // A second live run of the same automation now holds the marker.
    spies.markRunningResult = false;
    const releasesBeforeResume = spies.releaseAutomation;
    const lastStatusBeforeResume = spies.updateAutomationLastStatus;

    const resumed = await runner.resumeFromStep(paused.id, 'ap', {
        decision: { approved: true }, userId: 'user-1',
    });

    assert.strictEqual(resumed.status, 'success', `the resume ran (got ${resumed.status}, error: ${resumed.error})`);
    const steps = await storeStub.getRunSteps(resumed.id);
    assert.ok(
        steps.some(s => s.stepId === 'after' && s.status === 'success'),
        'the step after the approval gate actually executed',
    );

    // It borrowed no marker: clearing the in-flight run's marker is the hazard
    // the guard exists to prevent, so a resume that could not claim one must
    // not release one either.
    assert.strictEqual(spies.releaseAutomation, releasesBeforeResume,
        'the resume did not release a marker it does not own');
    assert.strictEqual(spies.updateAutomationLastStatus, lastStatusBeforeResume,
        'nor did it overwrite lastStatus on behalf of the run that owns it');
});

test('§WS2.4 — a RESUME that DOES claim the marker still releases it (exemption is narrow)', async () => {
    currentAutomation = approvalAutomation();

    const paused = await runner.executeAutomation(currentAutomation, { triggerKind: 'webhook', mode: 'live' });
    assert.strictEqual(paused.status, 'awaiting_approval', `run 1 paused (got ${paused.status})`);

    const releasesBeforeResume = spies.releaseAutomation;
    const resumed = await runner.resumeFromStep(paused.id, 'ap', {
        decision: { approved: true }, userId: 'user-1',
    });

    assert.strictEqual(resumed.status, 'success', `the resume ran (got ${resumed.status}, error: ${resumed.error})`);
    assert.strictEqual(spies.releaseAutomation, releasesBeforeResume + 1,
        'the ordinary resume owns the marker it claimed and releases it at the end');
});

test('§WS2.4 — a fresh trigger is STILL blocked while a resume is exempt', async () => {
    // The exemption must not become a hole in the guard: only a resume
    // (skipUntilStepId) may proceed past a false marker.
    spies.markRunningResult = false;

    const result = await runner.executeAutomation(freshAutomation(), { triggerKind: 'webhook', mode: 'live' });

    assert.strictEqual(result.status, 'cancelled', 'a plain webhook run is still skipped');
    assert.strictEqual(spies.recordRunStep, 0, 'and dispatched nothing');
});
