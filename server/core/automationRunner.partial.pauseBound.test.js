/**
 * A partial run that pauses keeps its bound across the pause (RM-1, F3,
 * tests-and-docs F1).
 *
 * ▶ Execute (mode 'only') on an approval, or "Run up to here" past a form page,
 * pauses the run for a person. The answer resumes it through resumeFromStep,
 * which used to start a fresh live run with only the resumption point: the
 * partial bound was never stored, so every step after the pause ran for real.
 * The run profile stores the bound (stopAfterStepId) and the resume passes it
 * back as untilStepId; runDag stops after a REPLAYED target as well as a live one.
 *
 * Stores replaced through automationRunner.testkit. No DB / external services.
 * Run: cd server && node --test core/automationRunner.partial.pauseBound.test.js
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { makeMemoryRunStore } = require('../testUtils/memoryRunStore');
const { installRunnerStoreStubs } = require('./automationRunner.testkit');

// The kit puts its store in place of stores/automationStore; this suite fills
// it with the in-memory run store, which keeps step rows for the resume.
const { storeStub } = installRunnerStoreStubs();
const memory = makeMemoryRunStore();
const { runs, stepsByRun } = memory;
Object.assign(storeStub, memory.methods, {
    // The real store keeps the profile, the test flag and the starter on the row.
    createRun: async (args) => Object.assign(await memory.methods.createRun(args), {
        isTest: !!args.isTest, startedByUserId: args.startedByUserId ?? null, profile: args.runProfile ?? null,
    }),
});

// Approvals are an Enterprise capability, checked before the run pauses.
require('./entitlements/entitlements').hasCapability = async () => true;
const runner = require('./automationRunner');

after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });
beforeEach(memory.reset);

const stepIdsOf = (runId) => (stepsByRun.get(runId) || []).map((s) => s.stepId);
const set = (id, fields = { done: { kind: 'literal', value: true } }) => ({ id, type: 'set', fields });

/** trigger → appr (approval) → after1 → after2. */
function approvalFlow() {
    return {
        id: 'auto-pb', version: 1, userId: 'owner-1', organizationId: null, title: 'Bound', triggerType: 'manual',
        definition: {
            trigger: { id: 'trig', type: 'trigger', kind: 'manual' },
            steps: [
                { id: 'appr', type: 'approval', prompt: 'OK to send?' },
                set('after1'),
                set('after2'),
            ],
            edges: [{ from: 'trig', to: 'appr' }, { from: 'appr', to: 'after1' }, { from: 'after1', to: 'after2' }],
        },
    };
}

/** trigger → fp (form page) → mid (binds the answer) → target → beyond. */
function formFlow() {
    return {
        id: 'auto-fp', version: 1, userId: 'owner-1', organizationId: null, title: 'Form bound', triggerType: 'manual',
        definition: {
            trigger: { id: 'trig', type: 'trigger', kind: 'manual' },
            steps: [
                { id: 'fp', type: 'form_page', mode: 'input', form: { title: 'Page', fields: [{ name: 'answer', type: 'text' }] } },
                set('mid', { got: { kind: 'ref', path: 'steps.fp.output.answer' } }),
                set('target'),
                set('beyond'),
            ],
            edges: [
                { from: 'trig', to: 'fp' }, { from: 'fp', to: 'mid' },
                { from: 'mid', to: 'target' }, { from: 'target', to: 'beyond' },
            ],
        },
    };
}

test("▶ Execute (mode 'only') on an approval: paused, and the approved resume dispatches nothing downstream", async () => {
    memory.automation = approvalFlow();
    const paused = await runner.runPartial(memory.automation, 'appr', { mode: 'only', triggerKind: 'manual_step', startedByUserId: 'tester-1' });
    assert.strictEqual(paused.status, 'awaiting_approval');
    const pausedRow = runs.get(paused.id);
    assert.strictEqual(pausedRow.profile.kind, 'test');
    assert.strictEqual(pausedRow.profile.stopAfterStepId, 'appr', 'the bound is stored on the run');
    assert.deepStrictEqual(stepIdsOf(paused.id), ['appr']);

    const resumed = await runner.resumeFromStep(paused.id, 'appr', { userId: 'tester-1' });
    assert.strictEqual(resumed.status, 'success');
    assert.strictEqual(resumed.mode, 'live');
    const ids = stepIdsOf(resumed.id);
    assert.ok(!ids.includes('after1') && !ids.includes('after2'), `nothing after the approval ran, got ${JSON.stringify(ids)}`);
    // The resumed leg keeps the profile: still a test, still bounded.
    assert.strictEqual(runs.get(resumed.id).profile.kind, 'test');
    assert.strictEqual(runs.get(resumed.id).profile.stopAfterStepId, 'appr');
    assert.strictEqual(runs.get(resumed.id).isTest, true);
    // The default decision has the one approval output shape.
    const boundary = (stepsByRun.get(resumed.id) || []).find((s) => s.stepId === 'appr');
    assert.deepStrictEqual(Object.keys(boundary.output).sort(), ['answers', 'approved', 'by', 'decidedAt', 'reason', 'votes']);
    assert.strictEqual(boundary.output.approved, true);
    assert.strictEqual(boundary.output.by, 'tester-1');
});

test('"Run up to here" across a form page: after the answer it runs up to the target and stops there', async () => {
    memory.automation = formFlow();
    const paused = await runner.runPartial(memory.automation, 'target', { mode: 'upTo', triggerKind: 'manual_step', startedByUserId: 'tester-1' });
    assert.strictEqual(paused.status, 'awaiting_form');
    assert.strictEqual(runs.get(paused.id).profile.stopAfterStepId, 'target');

    const resumed = await runner.resumeFromStep(paused.id, 'fp', { decision: { answer: 'Main Street 1' }, userId: 'tester-1' });
    assert.strictEqual(resumed.status, 'success');
    const ids = stepIdsOf(resumed.id);
    assert.ok(ids.includes('mid') && ids.includes('target'), `the steps up to the target ran, got ${JSON.stringify(ids)}`);
    assert.ok(!ids.includes('beyond'), 'nothing after the target ran');
    const mid = (stepsByRun.get(resumed.id) || []).find((s) => s.stepId === 'mid');
    assert.deepStrictEqual(mid.output, { got: 'Main Street 1' });
});

test('"Run up to here" ON the form page stops right after the answer', async () => {
    memory.automation = formFlow();
    const paused = await runner.runPartial(memory.automation, 'fp', { mode: 'upTo', triggerKind: 'manual_step', startedByUserId: 'tester-1' });
    assert.strictEqual(paused.status, 'awaiting_form');
    const resumed = await runner.resumeFromStep(paused.id, 'fp', { decision: { answer: 'x' }, userId: 'tester-1' });
    assert.strictEqual(resumed.status, 'success');
    assert.deepStrictEqual(stepIdsOf(resumed.id).filter((id) => id !== 'fp'), []);
});

test('a production run paused on an approval still runs the whole rest of the flow after it', async () => {
    memory.automation = approvalFlow();
    const paused = await runner.executeAutomation(memory.automation, { triggerKind: 'manual', mode: 'live' });
    assert.strictEqual(paused.status, 'awaiting_approval');
    assert.strictEqual(runs.get(paused.id).profile.kind, 'production');
    assert.strictEqual(runs.get(paused.id).profile.stopAfterStepId, null);
    const resumed = await runner.resumeFromStep(paused.id, 'appr', { userId: 'approver-1' });
    assert.strictEqual(resumed.status, 'success');
    assert.ok(stepIdsOf(resumed.id).includes('after2'));
});

test('a legacy paused row (no stored profile) resumes exactly as before: live, unbounded', async () => {
    memory.automation = approvalFlow();
    const paused = await runner.executeAutomation(memory.automation, { triggerKind: 'manual_step', mode: 'live', onlyStepId: 'appr' });
    assert.strictEqual(paused.status, 'awaiting_approval');
    // As a row written before run_profile existed.
    runs.get(paused.id).profile = null;
    const resumed = await runner.resumeFromStep(paused.id, 'appr', { userId: 'u' });
    assert.strictEqual(resumed.status, 'success');
    assert.ok(stepIdsOf(resumed.id).includes('after2'), 'no bound was ever recorded for it');
});
