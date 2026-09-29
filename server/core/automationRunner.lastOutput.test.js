/**
 * `executeAutomation` returns the run's final step output as `lastOutput`.
 *
 * It used to return `automationStore.getRun(run.id)` verbatim — a run ROW, and
 * `lastOutput` is not a column (see rowToRun in stores/automationStore/rowMappers.js).
 * Only runDag produces it. So the three callers that hand a routine's result
 * back to an AI agent all read `result?.lastOutput` off that row and always got
 * `null`:
 *   - runStepAsTool (core/automationRunner.js) — a Reusable Step as a chat tool
 *   - automation/agentCallableTools.js — an agent-callable routine
 *   - routes/automation/webhooksAndRunOps.js — POST /:id/agent-invoke
 * The agent ran the routine and was told nothing came back.
 *
 * The store stub below returns a PLAIN ROW with no `lastOutput` key, exactly
 * like the real `rowToRun` — that is what makes this a regression test and not
 * a tautology.
 *
 * Heavy deps pre-mocked via the require cache (same approach as the approval /
 * foreach suites). No DB, no external services.
 *
 * Run: node --test core/automationRunner.lastOutput.test.js
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');

// ── In-memory automationStore stub ──────────────────────────────────────────
const runs = new Map();
let runSeq = 0;

function makeRun({ automationId, version, userId, triggerKind, triggerPayload, mode, parentRunId }) {
    const id = `run-${++runSeq}`;
    // Deliberately mirrors rowToRun's shape: NO lastOutput key.
    const row = {
        id, automationId, version, userId, triggerKind,
        triggerPayload: triggerPayload || null, mode, status: 'queued',
        startedAt: new Date().toISOString(), finishedAt: null, durationMs: null,
        error: null, summary: null, parentRunId: parentRunId ?? null,
        cancelRequested: false, awaitingStepId: null, approvalToken: null,
        awaitingStepExpiresAt: null, errorClass: null, handledErrorCount: 0,
    };
    runs.set(id, row);
    return row;
}

const storeStub = {
    initDB: async () => {},
    createRun: async (args) => makeRun(args),
    getRun: async (id) => (runs.has(id) ? { ...runs.get(id) } : null),
    updateRun: async (id, updates) => {
        const r = runs.get(id);
        if (!r) return false;
        Object.assign(r, updates);
        return true;
    },
    getRunsForAutomation: async () => [],
    getRunSteps: async () => [],
    recordRunStep: async () => {},
    markRunning: async () => true,
    releaseAutomation: async () => {},
    resetAttempts: async () => {},
    updateAutomation: async () => true,
    touchRunHeartbeat: async () => {},
    requestCancelRun: async () => null,
    getAutomation: async () => null,
};

function stub(modPath, exportsObj) {
    const resolved = require.resolve(modPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

stub('../stores/automationStore', storeStub);
stub('../stores/userStore', { getUser: async () => null, getOrganization: async () => null });
stub('../stores/configStore', { getConfig: async () => null, setConfig: async () => {} });
stub('../stores/notificationStore', { createNotification: async () => {} });

process.env.ROUTINE_AUTH_LEGACY = '0';
process.env.NODE_ENV = 'test';

const runner = require('./automationRunner');

after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });

beforeEach(() => { runs.clear(); runSeq = 0; });

/** manual trigger → set → set. The SECOND set is what `lastOutput` must carry. */
function twoStepAutomation() {
    return {
        id: 'auto-lastout',
        version: 1,
        userId: 'user-1',
        organizationId: null,
        title: 'lastOutput regression',
        triggerType: 'manual',
        definition: {
            trigger: { id: 'trig', type: 'trigger' },
            steps: [
                { id: 'first', type: 'set', fields: { stage: { kind: 'literal', value: 'one' } } },
                { id: 'second', type: 'set', fields: { stage: { kind: 'literal', value: 'two' } } },
            ],
            edges: [{ from: 'trig', to: 'first' }, { from: 'first', to: 'second' }],
        },
    };
}

test('executeAutomation returns the last step output as lastOutput', async () => {
    const result = await runner.executeAutomation(twoStepAutomation(), { triggerKind: 'manual', mode: 'live' });

    assert.strictEqual(result.status, 'success', `run succeeded (got ${result.status}: ${result.error})`);
    assert.ok(Object.prototype.hasOwnProperty.call(result, 'lastOutput'), 'the key exists at all');
    assert.notStrictEqual(result.lastOutput, null, 'this was null for every agent-callable routine');
    assert.strictEqual(result.lastOutput.stage, 'two', 'carries the LAST step, not the first');
});

test('the run row itself is still returned intact alongside it', async () => {
    const result = await runner.executeAutomation(twoStepAutomation(), { triggerKind: 'manual', mode: 'live' });

    // lastOutput is additive — callers reading the row must be unaffected.
    assert.strictEqual(result.id, 'run-1');
    assert.strictEqual(result.triggerKind, 'manual');
    assert.strictEqual(result.handledErrorCount, 0);
    assert.ok(result.finishedAt, 'terminal fields still populated');
});

test('a routine with no steps reports lastOutput null rather than undefined', async () => {
    const empty = {
        ...twoStepAutomation(),
        definition: { trigger: { id: 'trig', type: 'trigger' }, steps: [], edges: [] },
    };
    const result = await runner.executeAutomation(empty, { triggerKind: 'manual', mode: 'live' });

    // Callers do `result?.lastOutput ?? null` — but the key must be present and
    // explicitly null on every exit path so nobody has to test for it.
    assert.ok(Object.prototype.hasOwnProperty.call(result, 'lastOutput'));
    assert.strictEqual(result.lastOutput, null);
});
