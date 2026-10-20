/**
 * executeAutomation({ harness }): the test harness lands on the run only in a
 * dry run. A dry run with saved answers plays a form page from them and the
 * steps after it bind those answers; a live run ignores the harness and pauses
 * for a person as it always did. Synthetic data only.
 *
 * Heavy deps pre-mocked via the require cache. No DB / external services.
 * Run: node --test core/automationRunner/execution.harness.test.js
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const { installRunnerStoreStubs, stub } = require('../automationRunner.testkit');

const stepsByRun = new Map();
const { storeStub, resetRuns } = installRunnerStoreStubs();
storeStub.getRunSteps = async (id) => (stepsByRun.get(id) || []).map((s) => ({ ...s }));
storeStub.recordRunStep = async (row) => {
    const rows = stepsByRun.get(row.runId) || [];
    const i = rows.findIndex((r) => r.stepId === row.stepId && r.attempts === row.attempts);
    if (i >= 0) rows[i] = { ...row }; else rows.push({ ...row });
    stepsByRun.set(row.runId, rows);
};
storeStub.getRunFullOutput = async () => null;
stub(require.resolve('../../stores/automationStore'), storeStub);

const runner = require('../automationRunner');
const { normalizeHarness, harnessFor, pageAnswersFor } = require('./testHarness');

after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });
beforeEach(() => { resetRuns(); stepsByRun.clear(); });

const outputOf = (runId, stepId) => (stepsByRun.get(runId) || []).find((s) => s.stepId === stepId)?.output;

/** trigger -> fp1 (form page) -> echo (binds the answer). */
function automation() {
    return {
        id: 'auto-h', version: 1, userId: 'user-1', organizationId: null, title: 'Harness form', triggerType: 'form',
        definition: {
            trigger: { id: 'trig', type: 'trigger', kind: 'form', form: { title: 'Start', fields: [{ name: 'name', type: 'text' }] } },
            steps: [
                { id: 'fp1', type: 'form_page', mode: 'input', title: 'Page', form: { title: 'Page', fields: [{ name: 'answer1', type: 'text', label: 'Answer one', required: true }] } },
                { id: 'echo', type: 'set', fields: { got: { kind: 'ref', path: 'steps.fp1.output.answer1' } } },
            ],
            edges: [{ from: 'trig', to: 'fp1' }, { from: 'fp1', to: 'echo' }],
        },
    };
}

const harness = (answer) => ({ source: { kind: 'scenario', id: 'fsc_1' }, formAnswers: { pages: { fp1: { answer1: answer } } }, aiAnswers: 'live' });

test('a dry run with a harness plays the form page from the saved answers', async () => {
    const run = await runner.executeAutomation(automation(), { triggerKind: 'dry_run', mode: 'dry_run', triggerPayload: { name: 'Ada' }, harness: harness('Main Street 1') });
    assert.strictEqual(run.status, 'success');
    assert.strictEqual(outputOf(run.id, 'fp1')._fromScenario, true);
    assert.deepStrictEqual(outputOf(run.id, 'echo'), { got: 'Main Street 1' });
});

test('a dry run without a harness hands blanks downstream, as before', async () => {
    const run = await runner.executeAutomation(automation(), { triggerKind: 'dry_run', mode: 'dry_run', triggerPayload: { name: 'Ada' } });
    assert.strictEqual(run.status, 'success');
    assert.strictEqual(outputOf(run.id, 'fp1')._fromScenario, undefined);
    assert.deepStrictEqual(outputOf(run.id, 'echo'), { got: '' });
});

test('answers that no longer fit the page fail the run with scenario_answers_invalid', async () => {
    const run = await runner.executeAutomation(automation(), { triggerKind: 'dry_run', mode: 'dry_run', triggerPayload: { name: 'Ada' }, harness: harness('') });
    assert.strictEqual(run.status, 'error');
    const row = (stepsByRun.get(run.id) || []).find((s) => s.stepId === 'fp1');
    assert.strictEqual(row.status, 'error');
    assert.ok(String(row.error).includes('Answer one'));
    assert.strictEqual(row.errorClass, 'scenario_answers_invalid');
});

test('a live run ignores the harness and pauses for a person', async () => {
    const run = await runner.executeAutomation(automation(), { triggerKind: 'form', mode: 'live', triggerPayload: { name: 'Ada' }, harness: harness('Main Street 1') });
    assert.strictEqual(run.status, 'awaiting_form');
    assert.strictEqual(outputOf(run.id, 'echo'), undefined);
});

test('harnessFor: only a dry run has a harness, and it is frozen', () => {
    assert.strictEqual(harnessFor('live', harness('x')), null);
    assert.strictEqual(harnessFor('dry_run', null), null);
    const h = harnessFor('dry_run', harness('x'));
    assert.ok(Object.isFrozen(h) && Object.isFrozen(h.formAnswers.pages.fp1));
    assert.throws(() => { 'use strict'; h.aiAnswers = 'cache'; }, TypeError);
});

test('normalizeHarness: unknown values fall back to the defaults and the caller object is untouched', () => {
    const input = { source: { kind: 'nope', id: 5 }, formAnswers: { pages: { a: { x: 1 }, b: 'not an object' } }, aiAnswers: 'sometimes' };
    const h = normalizeHarness(input);
    assert.deepStrictEqual(h.source, { kind: 'scenario', id: null });
    assert.strictEqual(h.aiAnswers, 'live');
    assert.deepStrictEqual(Object.keys(h.formAnswers.pages), ['a']);
    assert.ok(!Object.isFrozen(input.formAnswers.pages.a), 'the caller keeps a mutable object');
    assert.strictEqual(normalizeHarness('x'), null);
    assert.strictEqual(normalizeHarness({ aiAnswers: 'cache' }).formAnswers, null);
    assert.strictEqual(pageAnswersFor({ testHarness: h }, 'a').x, 1);
    assert.strictEqual(pageAnswersFor({ testHarness: h }, 'toString'), null, 'own properties only');
    assert.strictEqual(pageAnswersFor({}, 'a'), null);
});
