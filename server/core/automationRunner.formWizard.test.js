/**
 * Form wizard pages inside a whole run: a page that is skipped by its
 * condition, and a page whose options come from an earlier step.
 *
 * Same in-memory store harness as core/automationRunner.formPause.test.js.
 * No DB / external services.
 *
 * Run: node --test core/automationRunner.formWizard.test.js
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
// The stores are stubbed by the shared test kit (it also registers the feature
// ports and sets the test env); this suite replaces the run/step methods below
// with a richer in-memory version.
const { storeStub } = require('./automationRunner.testkit').installRunnerStoreStubs();

// ── In-memory store stub ───────────────────────────────────────────────────
const runs = new Map();
const stepsByRun = new Map();   // runId → [recordRunStep args]
let runSeq = 0;
const updateRunCalls = [];
let AUTOMATION = null;          // what getAutomation hands back to resumeFromStep
// The kept full copies of truncated outputs (automation_run_full_outputs),
// keyed `runId|stepId|attempts`.
const FULL_COPIES = new Map();

function makeRun({ automationId, version, userId, triggerKind, triggerPayload, mode, parentRunId, rootRunId }) {
    const id = `run-${++runSeq}`;
    const row = {
        id, automationId, version, userId, triggerKind,
        triggerPayload: triggerPayload || null, mode, status: 'queued',
        startedAt: new Date().toISOString(), finishedAt: null, durationMs: null,
        // The journey: a run is its own root unless it CONTINUES a paused one.
        // Mirrors createRun's COALESCE($rootRunId, id).
        error: null, summary: null, parentRunId: parentRunId ?? null, rootRunId: rootRunId ?? id,
        cancelRequested: false, awaitingStepId: null, approvalToken: null,
        awaitingStepExpiresAt: null, errorClass: null, handledErrorCount: 0,
    };
    runs.set(id, row);
    stepsByRun.set(id, []);
    return row;
}

Object.assign(storeStub, {
    initDB: async () => {},
    createRun: async (args) => makeRun(args),
    getRun: async (id) => runs.get(id) || null,
    updateRun: async (id, updates) => {
        updateRunCalls.push({ id, updates: { ...updates } });
        const r = runs.get(id);
        if (!r) return false;
        Object.assign(r, updates);
        return true;
    },
    getRunsForAutomation: async () => [],
    getRunSteps: async (id) => (stepsByRun.get(id) || []).map(s => ({ ...s })),
    // Upsert on (runId, stepId, attempts), exactly like the real store's
    // ON CONFLICT clause. The runner writes a 'running' row when a step starts
    // and the real row when it lands; a stub that merely appended kept both,
    // so a lookup by stepId found the placeholder instead of the result.
    recordRunStep: async (row) => {
        const rows = stepsByRun.get(row.runId) || [];
        const i = rows.findIndex(r => r.stepId === row.stepId && r.attempts === row.attempts);
        if (i >= 0) rows[i] = { ...row }; else rows.push({ ...row });
    },
    markRunning: async () => true,
    releaseAutomation: async () => {},
    resetAttempts: async () => {},
    updateAutomation: async () => true,
    touchRunHeartbeat: async () => {},
    requestCancelRun: async () => null,
    getAutomation: async () => AUTOMATION,
    getRunFullOutput: async (runId, stepId, attempts = 1) => FULL_COPIES.get(`${runId}|${stepId}|${attempts}`) ?? null,
});

const runner = require('./automationRunner');

after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });

beforeEach(() => {
    runs.clear();
    stepsByRun.clear();
    runSeq = 0;
    updateRunCalls.length = 0;
    AUTOMATION = null;
    FULL_COPIES.clear();
});


/** trigger → page (optionally conditional) → set (binds the page's answer). */
function wizardAutomation({ pageExtra = {}, fields, steps = [] } = {}) {
    return {
        id: 'auto-wizard', version: 1, userId: 'user-1', organizationId: null,
        title: 'Wizard', triggerType: 'form',
        definition: {
            trigger: {
                id: 'trig', type: 'trigger', kind: 'form',
                form: { title: 'Start', fields: [{ name: 'request_type', type: 'text' }] },
            },
            steps: [
                ...steps,
                {
                    id: 'fp1', type: 'form_page', mode: 'input',
                    form: { title: 'Details', fields },
                    ...pageExtra,
                },
                {
                    id: 'echo', type: 'set',
                    fields: { got: { kind: 'ref', path: 'steps.fp1.output.choice' } },
                },
            ],
            edges: [
                ...(steps.length
                    ? [{ from: 'trig', to: steps[0].id }, { from: steps[steps.length - 1].id, to: 'fp1' }]
                    : [{ from: 'trig', to: 'fp1' }]),
                { from: 'fp1', to: 'echo' },
            ],
        },
    };
}

const outputOf = (runId, stepId) => (stepsByRun.get(runId) || []).find(s => s.stepId === stepId)?.output;

test('a page whose condition is not met is skipped: the run finishes, the answer reads blank', async () => {
    AUTOMATION = wizardAutomation({
        pageExtra: { when: 'trigger.output.request_type == "b"' },
        fields: [{ name: 'choice', type: 'text', label: 'Choice' }],
    });
    const run = await runner.executeAutomation(AUTOMATION, {
        triggerKind: 'form', triggerPayload: { request_type: 'a' }, mode: 'live',
    });
    assert.strictEqual(run.status, 'success');
    assert.ok(!updateRunCalls.some(c => c.updates.status === 'awaiting_form'), 'never paused');
    assert.strictEqual(outputOf(run.id, 'fp1')._skipped, true);
    assert.deepEqual(outputOf(run.id, 'echo'), { got: '' });
});

test('the same page pauses when its condition is met', async () => {
    AUTOMATION = wizardAutomation({
        pageExtra: { when: 'trigger.output.request_type == "b"' },
        fields: [{ name: 'choice', type: 'text', label: 'Choice' }],
    });
    const run = await runner.executeAutomation(AUTOMATION, {
        triggerKind: 'form', triggerPayload: { request_type: 'b' }, mode: 'live',
    });
    assert.strictEqual(run.status, 'awaiting_form');
    assert.strictEqual(updateRunCalls.find(c => c.updates.status === 'awaiting_form').updates.awaitingStepId, 'fp1');
});

test('options read from an earlier step are persisted resolved, and the answer is the VALUE', async () => {
    AUTOMATION = wizardAutomation({
        steps: [{
            id: 'load', type: 'set',
            fields: {
                rows: { kind: 'literal', value: [{ id: 'r1', name: 'First row' }, { id: 'r2', name: 'Second row' }] },
            },
        }],
        fields: [{
            name: 'choice', type: 'select', label: 'Row', required: true,
            optionsFrom: { ref: 'steps.load.output.rows', value: 'id', label: 'name' },
        }],
    });
    const paused = await runner.executeAutomation(AUTOMATION, {
        triggerKind: 'form', triggerPayload: { request_type: 'a' }, mode: 'live',
    });
    assert.strictEqual(paused.status, 'awaiting_form');

    // The awaiting row is what the public page serves and what the submit route
    // coerces against after a restart.
    const row = (stepsByRun.get(paused.id) || []).find(s => s.stepId === 'fp1');
    const field = row.output.form.fields.find(f => f.name === 'choice');
    assert.deepEqual(field.options.map(o => [o.value, o.label]), [['r1', 'First row'], ['r2', 'Second row']]);
    assert.ok(!('optionsFrom' in field));

    const resumed = await runner.resumeFromStep(paused.id, 'fp1', { decision: { choice: 'r2' } });
    assert.strictEqual(resumed.status, 'success');
    assert.deepEqual(outputOf(resumed.id, 'echo'), { got: 'r2' });
});
