/**
 * Regression test for runPartial(..., { mode: 'only' }) — the "Execute step"
 * single-node run in the builder.
 *
 * Behaviour under test (runDag fillMissingUpstream, ~lines 1585-1622):
 *   When a partial run targets one step, an UPSTREAM prerequisite that has NO
 *   replay data (no prior run, no pinned output) is now EXECUTED LIVE instead
 *   of being skipped — so the target step receives the upstream's real output
 *   rather than `undefined`. Approval-resume (skipUntilStepId) keeps strict
 *   replay and is NOT exercised here.
 *
 * Uses pure in-process `set` steps (execSet just resolves bindings) so there's
 * no LLM / tool / sandbox / DB dependency — fully deterministic.
 *
 * Run: node --test core/automationRunner.partial.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');

// ── In-memory automationStore stub ────────────────────────────────────────
// Records runs + steps into plain arrays. getRunSteps() returns the recorded
// rows in the camelCase shape the runner reads (rowToRunStep). For the key
// case getRunsForAutomation() returns [] so there's no prior run to replay.
const runs = new Map();        // runId -> run row
const runStepsByRun = new Map(); // runId -> [step row]
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
    // ── run lifecycle ──
    createRun: async (args) => makeRun(args),
    getRun: async (id) => runs.get(id) || null,
    updateRun: async (id, updates) => {
        const r = runs.get(id);
        if (!r) return false;
        Object.assign(r, updates);
        return true;
    },
    // No prior run → forces fillMissingUpstream to execute the upstream live.
    getRunsForAutomation: async () => [],
    getRunSteps: async (runId) => (runStepsByRun.get(runId) || []).slice(),
    recordRunStep: async (rec) => {
        const list = runStepsByRun.get(rec.runId);
        if (!list) return;
        // Upsert on (stepId, attempts) to mirror the real PK semantics so a
        // retry/handled-error flip overwrites rather than duplicates.
        const existing = list.find(s => s.stepId === rec.stepId && s.attempts === rec.attempts);
        const row = {
            runId: rec.runId,
            stepId: rec.stepId,
            parentStepId: rec.parentStepId ?? null,
            stepType: rec.stepType,
            attempts: rec.attempts ?? 1,
            status: rec.status,
            startedAt: rec.startedAt ?? null,
            finishedAt: rec.finishedAt ?? null,
            input: rec.input ?? null,
            output: rec.output ?? null,
            error: rec.error ?? null,
            errorClass: rec.errorClass ?? null,
            branchIndex: rec.branchIndex ?? null,
        };
        if (existing) Object.assign(existing, row);
        else list.push(row);
    },
    // ── automation row bookkeeping (best-effort in the runner) ──
    markRunning: async () => {},
    releaseAutomation: async () => {},
    resetAttempts: async () => {},
    updateAutomation: async () => {},
    // Cancellation flag is read between steps — never cancelled here.
    getRun_noop: undefined,
    requestCancelRun: async () => null,
};

// ── Stub modules that touch the DB / external services BEFORE requiring the
// runner, so it loads without booting a pool or hitting integrations. ────────
function stub(modPath, exportsObj) {
    const resolved = require.resolve(modPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

stub('../stores/automationStore', storeStub);
// resolveUserSession() reads these; all are tolerant of nulls/throws. Stub so
// the session resolves to null without hitting the DB pool.
stub('../stores/userStore', {
    getUser: async () => null,
    getOrganization: async () => null,
});
stub('../stores/configStore', {
    getConfig: async () => null,
    setConfig: async () => {},
});
stub('../stores/notificationStore', {
    createNotification: async () => {},
});

// Skip the legacy user_sessions pool query in resolveUserSession.
process.env.ROUTINE_AUTH_LEGACY = '0';
// Block the boot tick / setIntervals.
process.env.NODE_ENV = 'test';

const runner = require('./automationRunner');

// Requiring the runner pulls in app modules (stores / pricing service) that
// register non-unref'd timers and a DB pool during their init side-effects.
// They have nothing to do with these tests, but they keep the event loop
// alive so `node --test` never exits. Force a clean exit once all tests have
// reported. (The existing automationRunner.test.js does the same via an
// explicit process.exit(0) at the end of its IIFE.)
after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });

// ── The automation: trigger → A → B, B binds A's output ───────────────────
// A (set): emits { value: 21 }
// B (set): emits { doubled: <A.value> * 2 } via an expr binding on A's output.
function freshAutomation() {
    return {
        id: 'auto-1',
        version: 1,
        userId: 'user-1',
        organizationId: null,
        title: 'Partial run regression',
        triggerType: 'manual',
        definition: {
            trigger: { id: 'trig', type: 'trigger' },
            steps: [
                {
                    id: 'A',
                    type: 'set',
                    fields: { value: { kind: 'literal', value: 21 } },
                },
                {
                    id: 'B',
                    type: 'set',
                    fields: { doubled: { kind: 'expr', value: 'steps.A.output.value * 2' } },
                },
            ],
            edges: [
                { from: 'trig', to: 'A' },
                { from: 'A', to: 'B' },
            ],
        },
    };
}

test('runPartial(only) executes a missing upstream live so the target gets real inputs', async () => {
    runs.clear();
    runStepsByRun.clear();
    runSeq = 0;

    const automation = freshAutomation();
    // No prior run (getRunsForAutomation → []), no pinned outputs.
    const result = await runner.runPartial(automation, 'B', { mode: 'only' });

    // The run finished successfully.
    assert.ok(result, 'runPartial returns the finished run row');
    assert.strictEqual(result.status, 'success', `run status (got ${result.status}, error: ${result.error})`);

    // Inspect the recorded step rows for this run.
    const steps = await storeStub.getRunSteps(result.id);
    const byId = new Map(steps.map(s => [s.stepId, s]));

    // A was EXECUTED LIVE (the regression): it has a recorded success row with
    // its real output, even though it was never the target and had no replay.
    const a = byId.get('A');
    assert.ok(a, 'upstream step A was recorded (executed live, not skipped)');
    assert.strictEqual(a.status, 'success', 'A recorded as success');
    assert.deepStrictEqual(a.output, { value: 21 }, 'A produced its real output');

    // B (the target) received A's real output rather than undefined.
    const b = byId.get('B');
    assert.ok(b, 'target step B was recorded');
    assert.strictEqual(b.status, 'success', 'B recorded as success');
    assert.deepStrictEqual(b.output, { doubled: 42 }, 'B doubled A\'s live output (21 * 2)');
});

test('runPartial(only) on the target reuses a PINNED upstream output instead of executing it', async () => {
    runs.clear();
    runStepsByRun.clear();
    runSeq = 0;

    const automation = freshAutomation();
    // Pin A's output → replayState gets it → A is replayed, NOT executed live.
    automation.definition.steps.find(s => s.id === 'A').pinnedOutput = { value: 100 };

    const result = await runner.runPartial(automation, 'B', { mode: 'only' });
    assert.strictEqual(result.status, 'success', `run status (got ${result.status}, error: ${result.error})`);

    const steps = await storeStub.getRunSteps(result.id);
    const byId = new Map(steps.map(s => [s.stepId, s]));

    // A is in the replayState (pinned), so runDag replays it: no recorded step
    // row is written for A during this partial run (replay path doesn't record).
    assert.ok(!byId.has('A'), 'pinned upstream A is replayed, not re-executed/recorded');

    // B still resolves against the pinned A output: 100 * 2 = 200.
    const b = byId.get('B');
    assert.ok(b, 'target step B was recorded');
    assert.deepStrictEqual(b.output, { doubled: 200 }, 'B used the pinned A output (100 * 2)');
});

// ── mode:'upTo' — the canvas "run up to here" ─────────────────────────────
//
// Distinct from 'only' on purpose: the author asking to run up to a step
// wants the steps BEFORE it to actually execute, not to be replayed from an
// old run. Pinning is the escape hatch for the one you don't want re-run.

/** trigger → A → B → C, so there is something downstream of the target. */
function threeStepAutomation() {
    const a = freshAutomation();
    a.definition.steps.push({
        id: 'C',
        type: 'set',
        fields: { tripled: { kind: 'expr', value: 'steps.A.output.value * 3' } },
    });
    a.definition.edges.push({ from: 'B', to: 'C' });
    return a;
}

test('runPartial(upTo) runs everything before the target and stops after it', async () => {
    runs.clear();
    runStepsByRun.clear();
    runSeq = 0;

    const result = await runner.runPartial(threeStepAutomation(), 'B', { mode: 'upTo' });
    assert.strictEqual(result.status, 'success', `run status (got ${result.status}, error: ${result.error})`);

    const byId = new Map((await storeStub.getRunSteps(result.id)).map(s => [s.stepId, s]));
    assert.strictEqual(byId.get('A')?.status, 'success', 'A ran');
    assert.deepStrictEqual(byId.get('A')?.output, { value: 21 }, 'A produced its real output');
    assert.strictEqual(byId.get('B')?.status, 'success', 'B — the target — ran');
    assert.deepStrictEqual(byId.get('B')?.output, { doubled: 42 }, 'B used A\'s live output');
    assert.ok(!byId.has('C'), 'the walk stopped after the target — C never ran');
});

test('runPartial(upTo) re-runs upstream steps rather than replaying a prior run', async () => {
    runs.clear();
    runStepsByRun.clear();
    runSeq = 0;

    // A prior run exists and would satisfy A on the 'only' path. 'upTo' must
    // ignore it: a mix of fresh and stale data looks like a real run and isn't.
    const priorRuns = [];
    const originalGetRuns = storeStub.getRunsForAutomation;
    storeStub.getRunsForAutomation = async () => priorRuns;
    try {
        const seed = await runner.runPartial(threeStepAutomation(), 'A', { mode: 'only' });
        priorRuns.unshift(runs.get(seed.id));

        const result = await runner.runPartial(threeStepAutomation(), 'B', { mode: 'upTo' });
        const byId = new Map((await storeStub.getRunSteps(result.id)).map(s => [s.stepId, s]));
        assert.strictEqual(byId.get('A')?.status, 'success', 'A executed again in THIS run');
    } finally {
        storeStub.getRunsForAutomation = originalGetRuns;
    }
});

test('runPartial(upTo) still honours a pinned step instead of re-running it', async () => {
    runs.clear();
    runStepsByRun.clear();
    runSeq = 0;

    const automation = threeStepAutomation();
    automation.definition.steps.find(s => s.id === 'A').pinnedOutput = { value: 100 };

    const result = await runner.runPartial(automation, 'B', { mode: 'upTo' });
    assert.strictEqual(result.status, 'success', `run status (got ${result.status}, error: ${result.error})`);

    const byId = new Map((await storeStub.getRunSteps(result.id)).map(s => [s.stepId, s]));
    assert.strictEqual(byId.get('A')?.status, 'pinned', 'A served its pin');
    assert.deepStrictEqual(byId.get('B')?.output, { doubled: 200 }, 'B used the pinned value (100 * 2)');
});

// ══════════════════════════════════════════════════════════════════════════
// BFSF-408/409/434 — the TRIGGER's pinned sample
//
// A manual run enters at `def.trigger.id` with `trigger.output === {}` no
// matter what, so every `{{trigger.output.*}}` in the flow stayed undefined and
// "test this step against a payload" was impossible. A trigger can now carry a
// pinned sample, and BUILDER runs enter with it. The gate is deliberately
// narrow: `triggerKind: 'manual_step'` (every partial run) plus dry-run mode,
// and nothing else — 'manual' is what the Run button and an AI agent's skill
// send for a real LIVE run.
// ══════════════════════════════════════════════════════════════════════════

const SAMPLE = { who: 'Ada', amount: 7 };

/** trigger (pinned) → E, where E reads trigger.output.who. */
function pinnedTriggerAutomation({ pin = SAMPLE, triggers = null } = {}) {
    const def = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual', pinnedOutput: pin },
        steps: [{ id: 'E', type: 'set', fields: { echo: { kind: 'ref', path: 'trigger.output.who' } } }],
        edges: [{ from: 'trg', to: 'E' }],
    };
    if (triggers) {
        def.triggers = triggers;
        for (const t of triggers) def.edges.push({ from: t.id, to: 'E' });
    }
    return { id: 'auto-pin', version: 1, userId: 'user-1', organizationId: null, title: 'Pinned trigger', triggerType: 'manual', definition: def };
}

const echoOf = async (result) => (await storeStub.getRunSteps(result.id)).find(s => s.stepId === 'E')?.output;

function resetRuns() { runs.clear(); runStepsByRun.clear(); runSeq = 0; }

test('a manual-step run with no payload picks up definition.trigger.pinnedOutput', async () => {
    resetRuns();
    const result = await runner.runPartial(pinnedTriggerAutomation(), 'E', { mode: 'upTo', triggerKind: 'manual_step' });
    assert.strictEqual(result.status, 'success', `run status (got ${result.status}, error: ${result.error})`);
    assert.deepStrictEqual(await echoOf(result), { echo: 'Ada' }, 'the step resolved trigger.output.who from the pin');
    // The run ROW records it too, so the inspector and every later replay-seed
    // read the same payload the run actually used.
    assert.deepStrictEqual(runs.get(result.id).triggerPayload, SAMPLE);
});

test('"Run up to here" is covered — the gesture builderRun excludes', async () => {
    // builderRun is `dry_run || onlyStepId || fromStepId` and so is FALSE for
    // untilStepId. Gating the sample on it would have missed exactly this call:
    // runPartial(mode:'upTo') passes untilStepId and nothing else.
    resetRuns();
    const result = await runner.runPartial(pinnedTriggerAutomation(), 'E', { mode: 'upTo', triggerKind: 'manual_step' });
    assert.deepStrictEqual(await echoOf(result), { echo: 'Ada' });
});

test('runPartial(only) ON THE TRIGGER returns the pin — the synthetic-run path', async () => {
    // This branch builds its own run row and never calls executeAutomation. It
    // IS the ▶-on-the-trigger gesture; missing it leaves the headline case
    // showing {} while every other entry point has data.
    resetRuns();
    const result = await runner.runPartial(pinnedTriggerAutomation(), 'trg', { mode: 'only', triggerKind: 'manual_step' });
    assert.strictEqual(result.status, 'success');
    assert.deepStrictEqual(result.output, SAMPLE, 'the run output IS the sample');
    const row = (await storeStub.getRunSteps(result.id)).find(s => s.stepId === 'trg');
    assert.deepStrictEqual(row?.output, SAMPLE, 'the recorded trigger row carries the sample');
    assert.deepStrictEqual(runs.get(result.id).triggerPayload, SAMPLE);
});

test('mode upTo on the trigger routes into that same branch and gets the pin', async () => {
    resetRuns();
    const result = await runner.runPartial(pinnedTriggerAutomation(), 'trg', { mode: 'upTo', triggerKind: 'manual_step' });
    assert.deepStrictEqual(result.output, SAMPLE);
});

test('a run entered via rootStepId picks up THAT trigger pin, not the primary one', async () => {
    resetRuns();
    const automation = pinnedTriggerAutomation({
        triggers: [{ id: 'trg2', type: 'trigger', kind: 'webhook', pinnedOutput: { who: 'Grace' } }],
    });
    const result = await runner.executeAutomation(automation, {
        triggerKind: 'manual_step', mode: 'live', rootStepId: 'trg2',
    });
    assert.strictEqual(result.status, 'success', `run status (got ${result.status}, error: ${result.error})`);
    assert.deepStrictEqual(await echoOf(result), { echo: 'Grace' }, 'the SECOND trigger sample, not the primary one');
});

test('a LIVE form submission with a real payload ignores the pin', async () => {
    resetRuns();
    const result = await runner.executeAutomation(pinnedTriggerAutomation(), {
        triggerKind: 'form', mode: 'live', triggerPayload: { who: 'a-real-visitor' },
    });
    assert.deepStrictEqual(await echoOf(result), { echo: 'a-real-visitor' }, 'the visitor answers win');
});

test('a form fire with NO payload is still not seeded — only builder runs are', async () => {
    resetRuns();
    const result = await runner.executeAutomation(pinnedTriggerAutomation(), { triggerKind: 'form', mode: 'live' });
    assert.deepStrictEqual(await echoOf(result), { echo: undefined }, 'trigger.output stayed empty');
});

test('a webhook POST ignores the pin', async () => {
    resetRuns();
    const live = await runner.executeAutomation(pinnedTriggerAutomation(), {
        triggerKind: 'webhook', mode: 'live', triggerPayload: { who: 'from-the-wire' },
    });
    assert.deepStrictEqual(await echoOf(live), { echo: 'from-the-wire' });

    // …and an EMPTY webhook body does not fall back to the sample either: a
    // real fire is a real fire.
    resetRuns();
    const empty = await runner.executeAutomation(pinnedTriggerAutomation(), { triggerKind: 'webhook', mode: 'live' });
    assert.deepStrictEqual(await echoOf(empty), { echo: undefined });
});

test('triggerKind manual is NOT seeded — the Run button and skillInjection live run', async () => {
    // core/tools/skillInjection.js fires a LIVE production run with
    // triggerKind:'manual' from an AI agent's skill, and 'manual' is also the
    // default value of the parameter. Seeding it would feed saved sample data
    // to production side effects.
    resetRuns();
    const result = await runner.executeAutomation(pinnedTriggerAutomation(), { triggerKind: 'manual', mode: 'live' });
    assert.deepStrictEqual(await echoOf(result), { echo: undefined });

    resetRuns();
    const defaulted = await runner.executeAutomation(pinnedTriggerAutomation(), { mode: 'live' });
    assert.deepStrictEqual(await echoOf(defaulted), { echo: undefined }, 'the parameter default is not a back door either');
});

test('a dry-run IS seeded — it is a preview', async () => {
    resetRuns();
    const result = await runner.executeAutomation(pinnedTriggerAutomation(), { triggerKind: 'dry_run', mode: 'dry_run' });
    assert.deepStrictEqual(await echoOf(result), { echo: 'Ada' });
});

test('a trigger with no pin behaves exactly as before', async () => {
    resetRuns();
    const automation = pinnedTriggerAutomation();
    delete automation.definition.trigger.pinnedOutput;
    const result = await runner.runPartial(automation, 'E', { mode: 'upTo', triggerKind: 'manual_step' });
    assert.deepStrictEqual(await echoOf(result), { echo: undefined });
});

test('the pin is CLONED — a step handler cannot mutate the saved definition', async () => {
    resetRuns();
    const automation = pinnedTriggerAutomation({ pin: { who: 'Ada', nested: { n: 1 } } });
    const before = JSON.stringify(automation.definition.trigger.pinnedOutput);
    await runner.runPartial(automation, 'E', { mode: 'upTo', triggerKind: 'manual_step' });
    assert.strictEqual(JSON.stringify(automation.definition.trigger.pinnedOutput), before);
});

// ── The sample goes through the Privacy Shield ────────────────────────────
//
// The trigger payload is the one input to a routine nobody in this org typed,
// and executeAutomation scans it with safety.guardToolInput before step 1 runs
// — an audit row, a stable placeholder for every value, and a `block` policy
// that can stop the run. That scan keys off the LOCAL triggerPayload, so
// seeding runState.trigger.output alone would have let a sample skip it
// entirely. Resolving the sample INTO triggerPayload is what keeps one gate.

const safety = require('./automationRunner/safety');

test('a pinned sample is scanned by guardToolInput like any other trigger payload', async () => {
    resetRuns();
    const original = {
        resolveAutomationPolicy: safety.resolveAutomationPolicy,
        buildAuditBase: safety.buildAuditBase,
        guardToolInput: safety.guardToolInput,
        restoreForRunState: safety.restoreForRunState,
    };
    const guarded = [];
    safety.resolveAutomationPolicy = async () => ({ piiEnabled: true, regexRules: [] });
    safety.buildAuditBase = (ctx, step) => ({ stepId: step && step.id ? step.id : null });
    safety.guardToolInput = async (value, _policy, audit) => { guarded.push({ audit, value }); return { value }; };
    safety.restoreForRunState = (value) => value;
    try {
        await runner.runPartial(pinnedTriggerAutomation(), 'E', { mode: 'upTo', triggerKind: 'manual_step' });
    } finally {
        Object.assign(safety, original);
    }
    const triggerScan = guarded.find(g => String((g.audit && g.audit.stepId) || '').startsWith('trigger:'));
    assert.ok(triggerScan, `the sample reached the trigger-level scan (saw ${JSON.stringify(guarded.map(g => g.audit))})`);
    assert.deepStrictEqual(triggerScan.value, SAMPLE, 'and it was the sample that was scanned');
});

test('a block policy on the sample kills the run before step 1', async () => {
    resetRuns();
    const original = {
        resolveAutomationPolicy: safety.resolveAutomationPolicy,
        buildAuditBase: safety.buildAuditBase,
        guardToolInput: safety.guardToolInput,
    };
    safety.resolveAutomationPolicy = async () => ({ piiEnabled: true, regexRules: [] });
    safety.buildAuditBase = (ctx, step) => ({ stepId: step && step.id ? step.id : null });
    safety.guardToolInput = async () => {
        const e = new Error('Blocked by the organisation privacy policy');
        e.guardrailBlocked = true;
        throw e;
    };
    let result;
    try {
        result = await runner.runPartial(pinnedTriggerAutomation(), 'E', { mode: 'upTo', triggerKind: 'manual_step' });
    } finally {
        Object.assign(safety, original);
    }
    assert.strictEqual(result.status, 'error');
    assert.strictEqual(result.errorClass, 'guardrail_blocked');
    assert.strictEqual((await storeStub.getRunSteps(result.id)).length, 0, 'no step ran');
});
