/**
 * A dry run that answers a form page from saved answers (form scenario, golden
 * replay): coerced like a real submission, flagged _fromScenario, and a failure
 * that names question labels and never an answer. Synthetic data only.
 *
 * Run: node --test core/automationRunner/execFormPage.scenario.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

// Ports are registered at boot; tests that call the executor directly do it here.
require('../../automation/runnerPorts');
require('../../integrations/runnerPorts');
require('../../services/runnerPorts');

process.env.NODE_ENV = 'test';

const { execFormPage, FormInputRequiredError } = require('./execApproval');
const { normalizeHarness } = require('./testHarness');

const page = (extra = {}) => ({
    id: 'fp1', type: 'form_page', mode: 'input', title: 'Details',
    form: {
        title: 'Details',
        fields: [
            { name: 'name', type: 'text', label: 'Full name', required: true },
            { name: 'age', type: 'number', label: 'Age in years' },
            { name: 'plan', type: 'select', label: 'Plan', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
            { name: 'agree', type: 'checkbox', label: 'Agree' },
            { name: 'doc', type: 'file', label: 'Upload', required: true },
            { name: 'rec', type: 'app_pick', label: 'Record', required: true, source: 'none' },
        ],
    },
    ...extra,
});

const state = () => ({ trigger: { output: {} }, steps: {}, vars: {}, secrets: {} });
const ctxWith = (pages, extra = {}) => ({
    layerStack: [],
    testHarness: normalizeHarness({ source: { kind: 'scenario', id: 'fsc_1' }, formAnswers: pages ? { pages } : null }),
    ...extra,
});

test('dry run with saved answers: coerced values plus _fromScenario', async () => {
    const out = await execFormPage(page(), ctxWith({ fp1: { name: 'Ada Example', age: '41', plan: 'b', agree: 'true' } }), state(), 'dry_run');
    assert.strictEqual(out.output.name, 'Ada Example');
    assert.strictEqual(out.output.age, 41, 'coerced like a submission');
    assert.strictEqual(out.output.plan, 'b');
    assert.strictEqual(out.output.agree, true);
    assert.strictEqual(out.output._fromScenario, true);
    assert.strictEqual(out.output._dryRun, true);
});

test('file and app_pick questions stay empty and do not fail a required one', async () => {
    const out = await execFormPage(page(), ctxWith({ fp1: { name: 'Ada Example', doc: { kind: 'form_upload', fileId: 'f9' }, rec: { kind: 'app_pick', source: 'none' } } }), state(), 'dry_run');
    assert.strictEqual(out.output.doc, null);
    assert.strictEqual(out.output.rec, null);
    assert.ok(!JSON.stringify(out).includes('f9'));
});

test('invalid answers fail with scenario_answers_invalid, naming labels and no answer value', async () => {
    const secret = 'SYNTHETIC-SECRET-VALUE-17';
    await assert.rejects(
        execFormPage(page(), ctxWith({ fp1: { name: 'Ada Example', age: secret, plan: secret } }), state(), 'dry_run'),
        (e) => {
            assert.strictEqual(e.errorClass, 'scenario_answers_invalid');
            assert.ok(e.message.includes('Age in years') && e.message.includes('Plan'), e.message);
            assert.ok(!e.message.includes(secret), 'the message carries no answer');
            assert.ok(!e.message.includes('Full name'), 'only the questions that failed');
            return true;
        },
    );
});

test('a missing required answer fails the step by label', async () => {
    await assert.rejects(
        execFormPage(page(), ctxWith({ fp1: { age: 3 } }), state(), 'dry_run'),
        (e) => e.errorClass === 'scenario_answers_invalid' && e.message.includes('Full name'),
    );
});

test('no harness: a dry run returns the empty values, unchanged', async () => {
    const out = await execFormPage(page(), { layerStack: [] }, state(), 'dry_run');
    assert.strictEqual(out.output._dryRun, true);
    assert.strictEqual(out.output._fromScenario, undefined);
    assert.strictEqual(out.output.name, '');
});

test('a harness without answers for this page falls back to the empty values', async () => {
    const out = await execFormPage(page(), ctxWith({ other: { name: 'x' } }), state(), 'dry_run');
    assert.strictEqual(out.output._fromScenario, undefined);
    assert.strictEqual(out.output.name, '');
});

test('live mode ignores the harness and pauses for a person', async () => {
    await assert.rejects(
        execFormPage(page(), ctxWith({ fp1: { name: 'Ada Example' } }), state(), 'live'),
        (e) => e instanceof FormInputRequiredError,
    );
});

test('the page condition still skips the page', async () => {
    const out = await execFormPage(page({ when: 'false' }), ctxWith({ fp1: { name: 'Ada Example' } }), state(), 'dry_run');
    assert.strictEqual(out.output._skipped, true);
    assert.strictEqual(out.output._fromScenario, undefined);
});

test('an ending page is shown, not answered', async () => {
    const out = await execFormPage(page({ mode: 'ending' }), ctxWith({ fp1: { name: 'Ada Example' } }), state(), 'dry_run');
    assert.strictEqual(out.output.mode, 'ending');
});
