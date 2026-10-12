/**
 * What a partial run is allowed to REPLAY, and what it must re-execute (W3).
 *
 * runPartial rebuilds a target step's upstream inputs from the last ten runs.
 * Each assumption in that reconstruction was wrong in its own way, and each one
 * produced a run that looked green while feeding the target something that was
 * never real:
 *
 *   W3-1  a DRY-RUN row is model-synthesized, and the window filtered on
 *         automation_id alone — a live send step resolved its recipient to a
 *         fabricated "fake-sample@example.com".
 *   W3-2  the merge only ever WROTE on success and never deleted, so a newer
 *         run in which the step errored left the older success in place and
 *         that stale output kept winning for the whole window (BFSF-360's
 *         "Limit node returns 10 stale records, green").
 *   W3-3  the 256 KB truncation SENTINEL passes `status === 'success' &&
 *         output != null`, so it was replayed verbatim and every downstream
 *         binding resolved against a marker ("arrayRef did not resolve to an
 *         array (resolved to nothing)").
 *   W3-4  the "execute a missing prerequisite live" rule had NO ancestry test,
 *         so any replay-less node the FIFO walk happened to dequeue before the
 *         target was dispatched for real — clicking ▶ Execute on one node sent
 *         an email from a sibling branch.
 *   W3-7  a target the walk never reaches ended as a SUCCESS that executed
 *         nothing at all.
 *
 * Pure in-process `set` steps (binding resolution only) keep this
 * deterministic — no LLM / tool / sandbox / DB.
 *
 * Run: node --test core/automationRunner.partial.replay.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');

// ── In-memory automationStore stub ────────────────────────────────────────
const runs = new Map();          // runId -> run row
const runStepsByRun = new Map(); // runId -> [step row]
let priorRuns = [];              // what getRunsForAutomation returns, NEWEST first
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
    updateRun: async (id, updates) => {
        const r = runs.get(id);
        if (!r) return false;
        Object.assign(r, updates);
        return true;
    },
    getRunsForAutomation: async (automationId, { limit = 50 } = {}) =>
        priorRuns.filter(r => r.automationId === automationId).slice(0, limit),
    getRunSteps: async (runId) => (runStepsByRun.get(runId) || []).slice(),
    recordRunStep: async (rec) => {
        const list = runStepsByRun.get(rec.runId);
        if (!list) return;
        const existing = list.find(s => s.stepId === rec.stepId && s.attempts === (rec.attempts ?? 1));
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
    markRunning: async () => {},
    releaseAutomation: async () => {},
    resetAttempts: async () => {},
    updateAutomation: async () => {},
    requestCancelRun: async () => null,
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

const runner = require('./automationRunner');

after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });

// ── The automation ────────────────────────────────────────────────────────
// trigger → A → B, plus a SIBLING branch trigger → S that B does not depend on.
// A emits { value: 21 } live; B doubles A's value; S is the stand-in for any
// node with a side effect that must never fire because of someone else's run.
function freshAutomation({ version = 1 } = {}) {
    return {
        id: 'auto-1',
        version,
        userId: 'user-1',
        organizationId: null,
        title: 'Partial replay regression',
        triggerType: 'manual',
        definition: {
            trigger: { id: 'trig', type: 'trigger' },
            steps: [
                { id: 'A', type: 'set', fields: { value: { kind: 'literal', value: 21 } } },
                { id: 'B', type: 'set', fields: { doubled: { kind: 'expr', value: 'steps.A.output.value * 2' } } },
                { id: 'S', type: 'set', fields: { sent: { kind: 'literal', value: true } } },
            ],
            edges: [
                { from: 'trig', to: 'A' },
                { from: 'A', to: 'B' },
                { from: 'trig', to: 'S' },
            ],
        },
    };
}

function reset() { runs.clear(); runStepsByRun.clear(); priorRuns = []; runSeq = 0; }

/** A finished prior run of auto-1 with the given recorded step rows. */
function seedPriorRun({ mode = 'live', version = 1, steps = [] }) {
    const row = makeRun({ automationId: 'auto-1', version, userId: 'user-1', triggerKind: 'manual', mode });
    row.status = 'success';
    for (const s of steps) {
        runStepsByRun.get(row.id).push({
            runId: row.id, parentStepId: null, attempts: 1, stepType: 'set',
            startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
            input: null, output: null, error: null, errorClass: null, branchIndex: null,
            ...s,
        });
    }
    priorRuns.unshift(row); // newest first, like the real ORDER BY started_at DESC
    return row;
}

const stepsOf = async (runId) => new Map((await storeStub.getRunSteps(runId)).map(s => [s.stepId, s]));

// ── W3-1: dry-run rows are not upstream data ──────────────────────────────

test('a DRY-RUN row is never replayed into a live partial run', async () => {
    reset();
    // What a dry-run records: synthesized output, tagged as such.
    seedPriorRun({
        mode: 'dry_run',
        steps: [{ stepId: 'A', status: 'success', output: { value: 999, _dryRunSynthesised: true } }],
    });

    const result = await runner.runPartial(freshAutomation(), 'B', { mode: 'only' });
    assert.strictEqual(result.status, 'success', `run status (got ${result.status}, error: ${result.error})`);

    const byId = await stepsOf(result.id);
    assert.strictEqual(byId.get('A')?.status, 'success', 'A was re-executed live rather than replayed from the dry-run');
    assert.deepStrictEqual(byId.get('A')?.output, { value: 21 }, 'A produced its REAL output');
    assert.deepStrictEqual(byId.get('B')?.output, { doubled: 42 }, 'B used real data, not the synthesized 999');
});

// ── W3-2: the newest run that mentions a step decides it ──────────────────

test('a newer FAILED row supersedes an older success instead of leaving it to win', async () => {
    reset();
    seedPriorRun({ steps: [{ stepId: 'A', status: 'success', output: { value: 7 } }] });          // older
    seedPriorRun({ steps: [{ stepId: 'A', status: 'error', output: null, error: 'upstream 500' }] }); // newer

    const result = await runner.runPartial(freshAutomation(), 'B', { mode: 'only' });
    assert.strictEqual(result.status, 'success', `run status (got ${result.status}, error: ${result.error})`);

    const byId = await stepsOf(result.id);
    assert.strictEqual(byId.get('A')?.status, 'success', 'A re-executed live — the stale success no longer wins');
    assert.deepStrictEqual(byId.get('B')?.output, { doubled: 42 }, 'B saw 21 (live), not 7 (stale)');
});

test('a newer CANCELLED/skipped row also supersedes an older success', async () => {
    reset();
    seedPriorRun({ steps: [{ stepId: 'A', status: 'success', output: { value: 7 } }] });
    seedPriorRun({ steps: [{ stepId: 'A', status: 'skipped', output: { skipped: 'arrayRef did not resolve' } }] });

    const result = await runner.runPartial(freshAutomation(), 'B', { mode: 'only' });
    const byId = await stepsOf(result.id);
    assert.strictEqual(byId.get('A')?.status, 'success', 'A re-executed live');
    assert.deepStrictEqual(byId.get('B')?.output, { doubled: 42 });
});

test('an older row still wins when the newer run says nothing about that step', async () => {
    reset();
    seedPriorRun({ steps: [{ stepId: 'A', status: 'success', output: { value: 7 } }] });
    seedPriorRun({ steps: [{ stepId: 'S', status: 'success', output: { sent: true } }] }); // no A row at all

    const result = await runner.runPartial(freshAutomation(), 'B', { mode: 'only' });
    const byId = await stepsOf(result.id);
    assert.ok(!byId.has('A'), 'A was replayed from the older run (build-one-node-at-a-time context survives)');
    assert.deepStrictEqual(byId.get('B')?.output, { doubled: 14 }, 'B used the replayed 7');
});

// ── W3-3: the truncation sentinel is not data ─────────────────────────────

test('a truncated output row is treated as ABSENT so the step re-executes', async () => {
    reset();
    seedPriorRun({
        steps: [{
            stepId: 'A',
            status: 'success',
            // Exactly what payloadTruncation.js persists past 256 KB.
            output: { __truncated__: true, originalBytes: 1_500_000, headSample: '{"value":' },
        }],
    });

    const result = await runner.runPartial(freshAutomation(), 'B', { mode: 'only' });
    assert.strictEqual(result.status, 'success', `run status (got ${result.status}, error: ${result.error})`);

    const byId = await stepsOf(result.id);
    assert.strictEqual(byId.get('A')?.status, 'success', 'A re-executed instead of replaying the sentinel');
    assert.deepStrictEqual(byId.get('B')?.output, { doubled: 42 },
        'B bound against real data — replaying the sentinel is what made collection nodes report "resolved to nothing"');
});

// ── W3-4: only ANCESTORS of the target may be filled in live ──────────────

test('a sibling branch is never dispatched by a single-node partial run', async () => {
    reset();
    // No prior runs at all, so every node is "missing upstream" — which is
    // exactly the state in which the sibling used to be dispatched for real.
    const result = await runner.runPartial(freshAutomation(), 'B', { mode: 'only' });
    assert.strictEqual(result.status, 'success', `run status (got ${result.status}, error: ${result.error})`);

    const byId = await stepsOf(result.id);
    assert.strictEqual(byId.get('A')?.status, 'success', 'the PREREQUISITE still runs live — that is the point of filling');
    assert.strictEqual(byId.get('B')?.status, 'success', 'the target ran');
    assert.ok(!byId.has('S'), 'the sibling branch must not execute: it is not a prerequisite of B');
});

test('retry-from-step also leaves non-ancestor branches alone', async () => {
    reset();
    const result = await runner.runPartial(freshAutomation(), 'B', { mode: 'from' });
    assert.strictEqual(result.status, 'success', `run status (got ${result.status}, error: ${result.error})`);

    const byId = await stepsOf(result.id);
    assert.strictEqual(byId.get('B')?.status, 'success', 'the target ran');
    assert.ok(!byId.has('S'), 'sibling branch untouched');
});

// ── W3-4, downstream half: the LIVE TAIL is descendants, not "everything the
// walk still holds" ───────────────────────────────────────────────────────
//
// The ancestry test above only constrained the phase BEFORE the target. Once
// the target dispatched, the temporal flag flipped off and every node the FIFO
// queue still yielded took the live branch — so a sibling branch sitting at or
// below the target's depth (S2 here, and S itself whenever the edges happened
// to be persisted target-first) re-fired its side effects on every "retry from
// step", with replay data sitting right there unused.
function deepSiblingAutomation() {
    const a = freshAutomation();
    // trigger → A → B → B2, and the sibling branch trigger → S → S2.
    a.definition.steps.push({ id: 'B2', type: 'set', fields: { after: { kind: 'literal', value: true } } });
    a.definition.steps.push({ id: 'S2', type: 'set', fields: { alsoSent: { kind: 'literal', value: true } } });
    a.definition.edges.push({ from: 'B', to: 'B2' });
    a.definition.edges.push({ from: 'S', to: 'S2' });
    return a;
}

test('retry-from-step runs the target and its DESCENDANTS — not a deeper sibling branch', async () => {
    reset();
    // The whole graph ran once already, so every node has replay data: the
    // sibling has nothing left to do and no reason to be dispatched.
    seedPriorRun({
        steps: [
            { stepId: 'A', status: 'success', output: { value: 21 } },
            { stepId: 'B', status: 'success', output: { doubled: 42 } },
            { stepId: 'B2', status: 'success', output: { after: true } },
            { stepId: 'S', status: 'success', output: { sent: true } },
            { stepId: 'S2', status: 'success', output: { alsoSent: true } },
        ],
    });

    const result = await runner.runPartial(deepSiblingAutomation(), 'B', { mode: 'from' });
    assert.strictEqual(result.status, 'success', `run status (got ${result.status}, error: ${result.error})`);

    const byId = await stepsOf(result.id);
    assert.strictEqual(byId.get('B')?.status, 'success', 'the target ran');
    assert.strictEqual(byId.get('B2')?.status, 'success', 'and everything downstream of it — that is the promise of the button');
    assert.ok(!byId.has('S'), 'the shallow sibling stays replayed');
    assert.ok(!byId.has('S2'), 'the DEEPER sibling stays replayed too — it is not downstream of B');
});

test('retry-from-step is not decided by the order the edges were persisted', async () => {
    reset();
    seedPriorRun({
        steps: [
            { stepId: 'A', status: 'success', output: { value: 21 } },
            { stepId: 'S', status: 'success', output: { sent: true } },
            { stepId: 'S2', status: 'success', output: { alsoSent: true } },
        ],
    });

    // Same graph, target-first edge order — which used to be the difference
    // between the shallow sibling running and not running.
    const automation = deepSiblingAutomation();
    automation.definition.edges = [
        { from: 'trig', to: 'A' },
        { from: 'A', to: 'B' },
        { from: 'B', to: 'B2' },
        { from: 'trig', to: 'S' },
        { from: 'S', to: 'S2' },
    ];

    const result = await runner.runPartial(automation, 'B', { mode: 'from' });
    assert.strictEqual(result.status, 'success', `run status (got ${result.status}, error: ${result.error})`);

    const byId = await stepsOf(result.id);
    assert.strictEqual(byId.get('B2')?.status, 'success', 'the descendant still ran');
    assert.ok(!byId.has('S'), 'sibling untouched regardless of edge order');
    assert.ok(!byId.has('S2'), 'deeper sibling untouched regardless of edge order');
});

// ── W3-7: a target the walk never reaches must not report success ─────────

test('a target the trigger cannot reach fails loudly instead of a green no-op', async () => {
    reset();
    const automation = freshAutomation();
    // A freshly-added, not-yet-wired node — the everyday version of this.
    automation.definition.steps.push({ id: 'Z', type: 'set', fields: { z: { kind: 'literal', value: 1 } } });

    const result = await runner.runPartial(automation, 'Z', { mode: 'only' });
    assert.strictEqual(result.status, 'error', 'the run reports the failure rather than a success that did nothing');
    assert.match(result.error || '', /never reached/i);

    const byId = await stepsOf(result.id);
    assert.ok(!byId.has('Z'), 'nothing was executed for the unreachable target');
});

// ── Definition-version drift is reported, not silently replayed ───────────

test('replayed data from an older definition version is kept but flagged stale', async () => {
    reset();
    seedPriorRun({ version: 1, steps: [{ stepId: 'A', status: 'success', output: { value: 7 } }] });

    // The canvas has been edited since, so the automation is on version 2.
    const result = await runner.runPartial(freshAutomation({ version: 2 }), 'B', { mode: 'only' });
    assert.strictEqual(result.status, 'success', `run status (got ${result.status}, error: ${result.error})`);

    const byId = await stepsOf(result.id);
    assert.deepStrictEqual(byId.get('B')?.output, { doubled: 14 },
        'the data is still used — dropping it would wipe the working context on every canvas edit');
    assert.deepStrictEqual(result.replayStale, [{ stepId: 'A', version: 1 }],
        '…and the response says which steps came from another version');
});

test('same-version replay carries no stale marker', async () => {
    reset();
    seedPriorRun({ version: 2, steps: [{ stepId: 'A', status: 'success', output: { value: 7 } }] });
    const result = await runner.runPartial(freshAutomation({ version: 2 }), 'B', { mode: 'only' });
    assert.strictEqual(result.replayStale, undefined);
});

test('a pinned output clears the stale marker for its step', async () => {
    reset();
    seedPriorRun({ version: 1, steps: [{ stepId: 'A', status: 'success', output: { value: 7 } }] });
    const automation = freshAutomation({ version: 2 });
    automation.definition.steps.find(s => s.id === 'A').pinnedOutput = { value: 100 };

    const result = await runner.runPartial(automation, 'B', { mode: 'only' });
    const byId = await stepsOf(result.id);
    assert.deepStrictEqual(byId.get('B')?.output, { doubled: 200 }, 'the pin wins over history');
    assert.strictEqual(result.replayStale, undefined, 'a pin is current data, not stale replay');
});
