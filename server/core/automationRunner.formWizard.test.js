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
const { makeMemoryRunStore } = require('../testUtils/memoryRunStore');
const assert = require('node:assert');
// The stores are stubbed by the shared test kit (it also registers the feature
// ports and sets the test env); this suite replaces the run/step methods below
// with a richer in-memory version.
const { storeStub } = require('./automationRunner.testkit').installRunnerStoreStubs();

// ── In-memory store stub ───────────────────────────────────────────────────
const memory = makeMemoryRunStore();
const { stepsByRun, updateRunCalls } = memory;

Object.assign(storeStub, memory.methods);

const runner = require('./automationRunner');

after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });

beforeEach(memory.reset);


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
    memory.automation = wizardAutomation({
        pageExtra: { when: 'trigger.output.request_type == "b"' },
        fields: [{ name: 'choice', type: 'text', label: 'Choice' }],
    });
    const run = await runner.executeAutomation(memory.automation, {
        triggerKind: 'form', triggerPayload: { request_type: 'a' }, mode: 'live',
    });
    assert.strictEqual(run.status, 'success');
    assert.ok(!updateRunCalls.some(c => c.updates.status === 'awaiting_form'), 'never paused');
    assert.strictEqual(outputOf(run.id, 'fp1')._skipped, true);
    assert.deepEqual(outputOf(run.id, 'echo'), { got: '' });
});

test('the same page pauses when its condition is met', async () => {
    memory.automation = wizardAutomation({
        pageExtra: { when: 'trigger.output.request_type == "b"' },
        fields: [{ name: 'choice', type: 'text', label: 'Choice' }],
    });
    const run = await runner.executeAutomation(memory.automation, {
        triggerKind: 'form', triggerPayload: { request_type: 'b' }, mode: 'live',
    });
    assert.strictEqual(run.status, 'awaiting_form');
    assert.strictEqual(updateRunCalls.find(c => c.updates.status === 'awaiting_form').updates.awaitingStepId, 'fp1');
});

test('options read from an earlier step are persisted resolved, and the answer is the VALUE', async () => {
    memory.automation = wizardAutomation({
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
    const paused = await runner.executeAutomation(memory.automation, {
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
