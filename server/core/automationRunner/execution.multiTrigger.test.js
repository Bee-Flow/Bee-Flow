/**
 * Multi-trigger runs: the root a run entered through survives on the run row,
 * an approval under a SECONDARY trigger resumes on that same root, a step can
 * read `trigger.kind` / `trigger.event`, and an event that finds the routine
 * busy WAITS for the marker instead of being dropped.
 *
 * Same in-memory store stub idiom as execution.resumeSlept.test.js.
 *
 * Run: node --test --test-force-exit core/automationRunner/execution.multiTrigger.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

// Make the concurrency wait fast enough to test (read at module load).
process.env.AUTOMATION_CONCURRENT_WAIT_MS = '400';
process.env.AUTOMATION_CONCURRENT_POLL_MS = '20';

// ── In-memory automationStore stub ────────────────────────────────────────
const runs = new Map();
const runStepsByRun = new Map();
let AUTOMATION = null;
let runSeq = 0;
let markRunningAnswers = [];   // queue of answers; empty → true
let markRunningCalls = 0;

function makeRun({ automationId, version, userId, triggerKind, triggerPayload, mode, parentRunId, rootRunId, rootStepId }) {
    const id = `run-${++runSeq}`;
    const row = {
        id, automationId, version, userId, triggerKind,
        triggerPayload: triggerPayload || null, mode, status: 'queued',
        startedAt: new Date().toISOString(), finishedAt: null, durationMs: null,
        error: null, summary: null, parentRunId: parentRunId ?? null,
        rootRunId: rootRunId ?? null, rootStepId: rootStepId ?? null,
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
    markRunning: async () => {
        markRunningCalls++;
        return markRunningAnswers.length ? markRunningAnswers.shift() : true;
    },
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

process.env.ROUTINE_AUTH_LEGACY = '0';
process.env.NODE_ENV = 'test';

// Approvals are gated on the Enterprise `approvals` capability; the gate
// itself is covered by engine.approval.test.js.
require('../entitlements/entitlements').hasCapability = async () => true;
const runner = require('../automationRunner');

// acquireRunMarker polls on UNREF'd timers by design — a bounded concurrency
// wait must never hold a draining worker open. Under `node --test` such a
// sleep can find the event loop otherwise empty (once the module-load-time
// pricing fetch resolves), and the runner then cancels the pending test and
// everything after it as "Promise resolution is still pending but the event
// loop has already resolved". One ref'd ticker for the duration of the file
// keeps the sleeps observable — same idiom and rationale as execWait.test.js;
// it says nothing about the code under test.
const keepEventLoopAlive = setInterval(() => {}, 250);
test.after(() => clearInterval(keepEventLoopAlive));

beforeEach(() => {
    runs.clear();
    runStepsByRun.clear();
    runSeq = 0;
    AUTOMATION = null;
    markRunningAnswers = [];
    markRunningCalls = 0;
});

const stepsOf = (runId) => runStepsByRun.get(runId) || [];
const stepOutput = (runId, stepId) => stepsOf(runId).find(s => s.stepId === stepId)?.output;

/** primary manual trigger (no steps) + secondary Gmail trigger → ap → tail. */
function twoRootAutomation() {
    return {
        id: 'auto-mt', version: 1, userId: 'user-1', organizationId: 'org-a',
        title: 'Two roots', triggerType: 'manual',
        definition: {
            trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
            triggers: [
                { id: 'trig_mail', type: 'trigger', kind: 'app_event', label: 'Mail', appEvent: { provider: 'gmail', event: 'mail.new', filter: {} } },
            ],
            steps: [
                { id: 'who', type: 'set', fields: {
                    kind: { kind: 'ref', path: 'trigger.kind' },
                    source: { kind: 'ref', path: 'trigger.source' },
                    event: { kind: 'template', value: '{{trigger.provider}}.{{trigger.event}}' },
                    root: { kind: 'ref', path: 'trigger.id' },
                    subject: { kind: 'ref', path: 'trigger.output.subject' },
                } },
                { id: 'ap', type: 'approval', prompt: 'ok?' },
                { id: 'tail', type: 'set', fields: { decided: { kind: 'ref', path: 'steps.ap.output.approved' } } },
            ],
            edges: [
                { from: 'trig_mail', to: 'who' },
                { from: 'who', to: 'ap' },
                { from: 'ap', to: 'tail' },
            ],
        },
    };
}

test('a run records the trigger it entered through and every step can read trigger.kind / .event', async () => {
    const automation = twoRootAutomation();
    AUTOMATION = automation;
    const paused = await runner.executeAutomation(automation, {
        triggerKind: 'app_event', rootStepId: 'trig_mail',
        triggerPayload: { provider: 'gmail', event: 'mail.new', subject: 'Hello' },
    });
    assert.strictEqual(paused.status, 'awaiting_approval', `expected a pause, got ${paused.status} (${paused.error})`);
    assert.strictEqual(paused.rootStepId, 'trig_mail', 'createRun received the entered trigger id');
    assert.deepStrictEqual(stepOutput(paused.id, 'who'), {
        kind: 'app_event', source: 'app_event', event: 'gmail.mail.new', root: 'trig_mail', subject: 'Hello',
    });
});

test('a primary-trigger run records the primary id, and a manual test of an event root reads source=manual', async () => {
    const automation = twoRootAutomation();
    AUTOMATION = automation;
    const primary = await runner.executeAutomation(automation, { triggerKind: 'manual' });
    assert.strictEqual(primary.rootStepId, 'trg');
    assert.strictEqual(primary.status, 'success', 'the primary root has no steps, so the run just ends');

    const test2 = await runner.executeAutomation(automation, { triggerKind: 'manual', rootStepId: 'trig_mail', triggerPayload: { subject: 'x' } });
    assert.strictEqual(stepOutput(test2.id, 'who').kind, 'app_event');
    assert.strictEqual(stepOutput(test2.id, 'who').source, 'manual');
});

test('an approval under a secondary trigger resumes on that root — the tail step actually runs', async () => {
    const automation = twoRootAutomation();
    AUTOMATION = automation;
    const paused = await runner.executeAutomation(automation, {
        triggerKind: 'app_event', rootStepId: 'trig_mail', triggerPayload: { subject: 'Hello' },
    });
    assert.strictEqual(paused.status, 'awaiting_approval');

    // The approval service resumes WITHOUT a rootStepId — it must come off the run row.
    const resumed = await runner.resumeFromStep(paused.id, 'ap', { decision: { approved: true, by: 'user-1' }, userId: 'user-1' });
    assert.strictEqual(resumed.status, 'success', `resume status (got ${resumed.status}: ${resumed.error})`);
    assert.strictEqual(resumed.rootStepId, 'trig_mail', 'the continuation is recorded on the same root');
    assert.deepStrictEqual(stepOutput(resumed.id, 'tail'), { decided: true }, 'the step after the approval ran on the secondary root');
});

test('an event run waits for a busy routine and then runs; a manual run never waits', async () => {
    const automation = twoRootAutomation();
    AUTOMATION = automation;
    markRunningAnswers = [false, false, false, true];
    const res = await runner.executeAutomation(automation, {
        triggerKind: 'app_event', rootStepId: 'trig_mail', triggerPayload: { subject: 'late' },
    });
    assert.strictEqual(res.status, 'awaiting_approval', `the waited run went on to execute (got ${res.status}: ${res.error})`);
    assert.strictEqual(markRunningCalls, 4, 'polled until the marker was free');

    markRunningCalls = 0;
    markRunningAnswers = [false, true];
    const manual = await runner.executeAutomation(automation, { triggerKind: 'manual' });
    assert.strictEqual(manual.status, 'cancelled', 'a manual click on a busy routine is still refused on the spot');
    assert.strictEqual(markRunningCalls, 1);
});

test('an event run that never gets the marker is cancelled after the window, as before', async () => {
    const automation = twoRootAutomation();
    AUTOMATION = automation;
    markRunningAnswers = new Array(1000).fill(false);
    const started = Date.now();
    const res = await runner.executeAutomation(automation, {
        triggerKind: 'app_event', rootStepId: 'trig_mail', triggerPayload: { subject: 'never' },
    });
    const elapsed = Date.now() - started;
    assert.strictEqual(res.status, 'cancelled');
    assert.strictEqual(res.error, 'Skipped: automation already running');
    assert.ok(elapsed >= 350, `it did wait for the configured window (waited ${elapsed}ms)`);

    // The wait is governed by a DEADLINE, not by a number of attempts, so the
    // poll count is a property of the machine rather than a promise of the
    // code: a loaded box fits fewer 20ms sleeps into the 400ms window than an
    // idle one. This assertion used to read `> 3` and duly went red in a
    // full-suite run with three other suites on the same box.
    //
    // What the code does promise is bounded either way, and both bounds are
    // worth holding. It must RETRY rather than give up on the first refusal;
    // and it must SLEEP between attempts — drop the sleep and the loop spins
    // the CPU for the whole window, which the old `> 3` would have called a
    // pass.
    assert.ok(markRunningCalls > 1, `it retried rather than giving up on the first refusal (${markRunningCalls} attempts)`);
    const ceiling = Math.ceil(elapsed / 20) + 2;
    assert.ok(markRunningCalls <= ceiling, `it slept between attempts: ${markRunningCalls} attempts in ${elapsed}ms is a busy loop`);
});

test('▶ on a secondary trigger node records a trigger-only run on that root', async () => {
    const automation = twoRootAutomation();
    AUTOMATION = automation;
    const run = await runner.runPartial(automation, 'trig_mail', { mode: 'only', triggerKind: 'manual_step', triggerPayload: { subject: 'pinned' } });
    assert.strictEqual(run.status, 'success');
    assert.strictEqual(run.rootStepId, 'trig_mail');
    const row = stepsOf(run.id).find(s => s.stepId === 'trig_mail');
    assert.ok(row, 'the trigger row is recorded under the secondary trigger id');
    assert.deepStrictEqual(row.output, { subject: 'pinned' });
});

test('"Run up to here" on a step only reachable from a secondary trigger enters through that root', async () => {
    const automation = twoRootAutomation();
    AUTOMATION = automation;
    const run = await runner.runPartial(automation, 'who', { mode: 'upTo', triggerKind: 'manual_step', triggerPayload: { subject: 'via-root' } });
    assert.strictEqual(run.status, 'success', `${run.status}: ${run.error}`);
    assert.strictEqual(run.rootStepId, 'trig_mail', 'the reachability lookup picked the secondary root');
    const out = stepOutput(run.id, 'who');
    assert.ok(out, 'the step actually executed');
    assert.strictEqual(out.kind, 'app_event');
    assert.strictEqual(out.root, 'trig_mail');
    assert.strictEqual(out.subject, 'via-root');
    assert.strictEqual(stepOutput(run.id, 'ap'), undefined, 'the run stopped after the target');
});

test('a single-step ▶ under a secondary root carries that root\'s trigger meta', async () => {
    const automation = twoRootAutomation();
    AUTOMATION = automation;
    const run = await runner.runPartial(automation, 'who', { mode: 'only', triggerKind: 'manual_step', triggerPayload: { subject: 'solo' } });
    assert.strictEqual(run.status, 'success', `${run.status}: ${run.error}`);
    assert.strictEqual(run.rootStepId, 'trig_mail');
    assert.strictEqual(stepOutput(run.id, 'who').event, 'gmail.mail.new');
});

// ── Handoff 5: live/working split and the run policy ──────────────────────

/** A routine the way the store hands it out: working v3, live v2 (non-enumerable). */
function splitAutomation({ runPolicy = undefined } = {}) {
    const working = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [{ id: 'mark', type: 'set', fields: { copy: { kind: 'literal', value: 'working' } } }],
        edges: [{ from: 'trg', to: 'mark' }],
        ...(runPolicy ? { runPolicy } : {}),
    };
    const live = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [{ id: 'mark', type: 'set', fields: { copy: { kind: 'literal', value: 'live' } } }],
        edges: [{ from: 'trg', to: 'mark' }],
        ...(runPolicy ? { runPolicy } : {}),
    };
    const a = {
        id: 'auto-split', version: 3, userId: 'user-1', organizationId: 'org-a', kind: 'automation',
        title: 'Split', triggerType: 'manual', definition: working, liveVersion: 2,
    };
    Object.defineProperty(a, 'liveDefinition', { value: live, enumerable: false, writable: true });
    return a;
}

test('handoff 5: a live run executes the LIVE copy and records the live version', async () => {
    const automation = splitAutomation();
    AUTOMATION = automation;
    const seen = [];
    const orig = storeStub.createRun;
    storeStub.createRun = async (args) => { seen.push(args); return orig(args); };
    try {
        const run = await runner.executeAutomation(automation, { triggerKind: 'schedule' });
        assert.strictEqual(run.status, 'success', `${run.status}: ${run.error}`);
        assert.deepStrictEqual(stepOutput(run.id, 'mark'), { copy: 'live' });
        assert.strictEqual(seen[0].version, 2, 'the run row records the version that ran');
        assert.strictEqual(seen[0].isTest, false);

        const tested = await runner.executeAutomation(automation, { triggerKind: 'manual', isTest: true, startedByUserId: 'user-1' });
        assert.deepStrictEqual(stepOutput(tested.id, 'mark'), { copy: 'working' }, 'the Test button runs the working copy');
        assert.strictEqual(seen[1].version, 3);
        assert.strictEqual(seen[1].isTest, true);
        assert.strictEqual(seen[1].startedByUserId, 'user-1');

        const dry = await runner.executeAutomation(automation, { triggerKind: 'dry_run', mode: 'dry_run' });
        assert.deepStrictEqual(stepOutput(dry.id, 'mark'), { copy: 'working' }, 'a dry run previews the working copy');
    } finally {
        storeStub.createRun = orig;
    }
});

test('handoff 5: a resumed run finishes on the version it started on, even after a publish', async () => {
    const automation = twoRootAutomation();
    automation.version = 1;
    AUTOMATION = automation;
    const paused = await runner.executeAutomation(automation, {
        triggerKind: 'app_event', rootStepId: 'trig_mail', triggerPayload: { subject: 'Hello' },
    });
    assert.strictEqual(paused.status, 'awaiting_approval');
    // While it waits, v2 goes live with a different tail step.
    const v1 = automation.definition;
    const v2 = JSON.parse(JSON.stringify(v1));
    v2.steps[2] = { id: 'tail', type: 'set', fields: { decided: { kind: 'literal', value: 'v2 tail' } } };
    const published = { ...automation, version: 2, liveVersion: 2, definition: v2 };
    Object.defineProperty(published, 'liveDefinition', { value: v2, enumerable: false });
    AUTOMATION = published;
    storeStub.getVersionDefinition = async (id, version) => (version === 1 ? v1 : v2);
    try {
        const resumed = await runner.resumeFromStep(paused.id, 'ap', { decision: { approved: true }, userId: 'user-1' });
        assert.strictEqual(resumed.status, 'success', `${resumed.status}: ${resumed.error}`);
        assert.deepStrictEqual(stepOutput(resumed.id, 'tail'), { decided: true }, 'v1\'s tail ran, not v2\'s');
        assert.strictEqual(resumed.version, 1);
    } finally {
        delete storeStub.getVersionDefinition;
    }
});

test('handoff 5: runPolicy.concurrency parallel runs alongside a busy routine instead of being refused', async () => {
    const automation = splitAutomation({ runPolicy: { concurrency: 'parallel' } });
    AUTOMATION = automation;
    markRunningAnswers = [false];
    const run = await runner.executeAutomation(automation, { triggerKind: 'manual' });
    assert.strictEqual(run.status, 'success', `${run.status}: ${run.error}`);
    assert.strictEqual(markRunningCalls, 1, 'tried the marker once, did not wait for it');
});

test('settings apply immediately: a live run takes runPolicy from the WORKING copy, steps from the live one', async () => {
    const automation = splitAutomation();
    automation.definition = { ...automation.definition, runPolicy: { concurrency: 'parallel' } };
    AUTOMATION = automation;
    markRunningAnswers = [false];
    const run = await runner.executeAutomation(automation, { triggerKind: 'webhook' });
    assert.strictEqual(run.status, 'success', `${run.status}: ${run.error}`);
    assert.deepStrictEqual(stepOutput(run.id, 'mark'), { copy: 'live' }, 'the live steps ran');
    assert.strictEqual(markRunningCalls, 1, 'the working copy\'s parallel policy applied without a publish');
});

test('handoff 5: runPolicy.retry — the default retry count, then continue past the failure', async () => {
    const def = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [
            { id: 'boom', type: 'code', code: 'return 1' },
            { id: 'after', type: 'set', fields: { reached: { kind: 'literal', value: true } } },
        ],
        edges: [{ from: 'trg', to: 'boom' }, { from: 'boom', to: 'after' }],
        runPolicy: { retry: { max: 2, then: 'continue' } },
    };
    const automation = { id: 'auto-retry', version: 1, userId: 'user-1', organizationId: 'org-a', title: 'Retry', triggerType: 'manual', definition: def };
    AUTOMATION = automation;
    const run = await runner.executeAutomation(automation, { triggerKind: 'manual' });
    assert.strictEqual(run.status, 'success', `${run.status}: ${run.error}`);
    const attempts = stepsOf(run.id).filter(s => s.stepId === 'boom').map(s => s.attempts).sort();
    assert.deepStrictEqual(attempts, [1, 2, 3], 'one try plus the routine\'s two retries');
    assert.strictEqual(stepsOf(run.id).find(s => s.stepId === 'boom' && s.attempts === 3).status, 'handled_error');
    assert.deepStrictEqual(stepOutput(run.id, 'after'), { reached: true }, 'the run carried on down the normal path');

    // Same routine, default 'stop_notify': the run fails at the step.
    automation.definition = { ...def, runPolicy: { retry: { max: 1 } } };
    const stopped = await runner.executeAutomation(automation, { triggerKind: 'manual' });
    assert.strictEqual(stopped.status, 'error');
    assert.strictEqual(stepOutput(stopped.id, 'after'), undefined);
});
