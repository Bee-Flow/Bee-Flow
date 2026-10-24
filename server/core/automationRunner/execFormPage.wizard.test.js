// @typecheck
/**
 * Form wizard pages at run time: dynamic options and per-item questions read
 * from the run, the page condition (`when`), and the blanks a dry run hands to
 * the steps downstream. Synthetic data only.
 *
 * Run: node --test core/automationRunner/execFormPage.wizard.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

// Ports are registered at boot; tests that call the executor directly do it here.
require('../../automation/runnerPorts');
require('../../integrations/runnerPorts');
require('../../services/runnerPorts');

process.env.NODE_ENV = 'test';

const { execFormPage, FormInputRequiredError, conditionMet } = require('./execApproval');
const { normalizeFields, coerceSubmission } = require('../../automation/formTriggerContract');

const noLayers = { layerStack: [] };
const state = (extra = {}) => ({
    trigger: { output: { request_type: 'a' } },
    steps: {
        load: {
            output: {
                rows: [
                    { id: 'r1', name: 'First row', note: 'the first' },
                    { id: 'r2', name: 'Second row', note: 'the second' },
                    { id: 'r3', name: 'Third row', note: 'the third' },
                ],
            },
        },
    },
    vars: {}, secrets: { list: ['x', 'y'] },
    ...extra,
});

const page = (fields, extra = {}) => ({
    id: 'fp1', type: 'form_page', mode: 'input',
    form: { title: 'Pick', fields },
    ...extra,
});

/** Run the page and hand back the form the runner persists on the awaiting row. */
async function pausedForm(step, runState = state(), mode = 'live') {
    try {
        await execFormPage(step, noLayers, runState, mode);
    } catch (e) {
        assert.ok(e instanceof FormInputRequiredError, `expected a pause, got ${e && e.message}`);
        return e.form;
    }
    throw new Error('expected the page to pause');
}

const withEnv = async (name, value, fn) => {
    const before = process.env[name];
    process.env[name] = value;
    try { return await fn(); } finally {
        if (before === undefined) delete process.env[name]; else process.env[name] = before;
    }
};

test('optionsFrom resolves to concrete options on the persisted page, and survives a JSON round trip', async () => {
    const form = await pausedForm(page([{
        name: 'row', type: 'select', label: 'Row', required: true,
        optionsFrom: { ref: 'steps.load.output.rows', value: 'id', label: 'name', hint: 'note' },
    }]));
    const field = form.fields.find(f => f.name === 'row');
    assert.deepEqual(field.options, [
        { value: 'r1', label: 'First row', hint: 'the first' },
        { value: 'r2', label: 'Second row', hint: 'the second' },
        { value: 'r3', label: 'Third row', hint: 'the third' },
    ]);
    assert.ok(!('optionsFrom' in field), 'the stored page holds the answer, not the source');

    // What the submit route does after a restart: read the stored page back.
    const stored = JSON.parse(JSON.stringify(form));
    const fields = normalizeFields(stored);
    assert.deepEqual(coerceSubmission(fields, { row: 'r2' }).errors, []);
    assert.equal(coerceSubmission(fields, { row: 'r2' }).values.row, 'r2');
    assert.ok(coerceSubmission(fields, { row: 'zzz' }).errors.length > 0, 'an off-list value is refused');
    assert.ok(coerceSubmission(fields, { row: 'First row' }).errors.length > 0, 'a label is not a value');
});

test('a list of plain values needs no value path', async () => {
    const s = state({ steps: { load: { output: { tags: ['red', 'green'] } } } });
    const form = await pausedForm(page([{
        name: 'tag', type: 'radio', label: 'Tag', optionsFrom: { ref: 'steps.load.output.tags' },
    }]), s);
    assert.deepEqual(form.fields[0].options.map(o => o.value), ['red', 'green']);
});

test('a secrets.* ref resolves to nothing: the page is served to an anonymous visitor', async () => {
    const form = await pausedForm(page([{
        name: 'row', type: 'select', label: 'Row', optionsFrom: { ref: 'secrets.list' },
    }]));
    const field = form.fields[0];
    assert.deepEqual(field.options, []);
    assert.equal(field.noOptions, true);
    assert.equal(field.required, false);
});

test('AUTOMATION_FORM_MAX_OPTIONS caps the resolved options', async () => {
    const form = await withEnv('AUTOMATION_FORM_MAX_OPTIONS', '2', () => pausedForm(page([{
        name: 'row', type: 'select', label: 'Row',
        optionsFrom: { ref: 'steps.load.output.rows', value: 'id', label: 'name' },
    }])));
    assert.deepEqual(form.fields[0].options.map(o => o.value), ['r1', 'r2']);
});

test('fieldsFrom expands to a header plus one question per item', async () => {
    const form = await pausedForm(page([{
        name: 'rate', type: 'number', label: 'Rate {{trigger.output.request_type}}',
        fieldsFrom: { ref: 'steps.load.output.rows', value: 'id', label: 'name' },
    }]));
    assert.deepEqual(form.fields.map(f => f.name), ['rate__0', 'rate__1', 'rate__2', 'rate__3']);
    assert.equal(form.fields[0].type, 'info');
    assert.equal(form.fields[0].groupHeader, true);
    assert.deepEqual(form.fields.slice(1).map(f => f.label), ['First row', 'Second row', 'Third row']);
    assert.ok(form.fields.every(f => !('fieldsFrom' in f)));

    // The expanded names fold back into one list under the authored name.
    const fields = normalizeFields(JSON.parse(JSON.stringify(form)));
    const { values, errors } = coerceSubmission(fields, { rate__1: '3', rate__2: '5' });
    assert.deepEqual(errors, []);
    assert.deepEqual(values.rate.map(r => r.key), ['r1', 'r2', 'r3']);
    assert.equal('rate__1' in values, false, 'expanded keys are folded away');
});

test('a false `when` skips an input page: blanks, _skipped, no pause', async () => {
    const step = page([
        { name: 'note', type: 'text', label: 'Note' },
        { name: 'topics', type: 'multiselect', label: 'Topics', options: ['a', 'b'] },
    ], { when: 'trigger.output.request_type == "b"' });
    const r = await execFormPage(step, noLayers, state(), 'live');
    assert.deepEqual(r.output, { note: '', topics: [], _skipped: true });
    // The same condition in a preview: the preview takes the path a real run takes.
    const preview = await execFormPage(step, noLayers, state(), 'dry_run');
    assert.equal(preview.output._skipped, true);
});

test('a true `when` shows the page', async () => {
    const form = await pausedForm(page([{ name: 'note', type: 'text', label: 'Note' }],
        { when: 'trigger.output.request_type == "a"' }));
    assert.equal(form.fields[0].name, 'note');
});

test('a false `when` on an ending page returns shown:false and no form', async () => {
    const step = {
        id: 'bye', type: 'form_page', mode: 'ending',
        form: { title: 'Done' }, when: 'trigger.output.request_type == "b"',
    };
    const r = await execFormPage(step, noLayers, state(), 'live');
    assert.deepEqual(r.output, { shown: false, mode: 'ending', skipped: true });
    assert.ok(!('form' in r.output));
});

test('a broken `when` fails open: the page is shown', async () => {
    const form = await pausedForm(page([{ name: 'note', type: 'text', label: 'Note' }], { when: 'steps.(' }));
    assert.equal(form.fields[0].name, 'note');
    assert.equal(conditionMet('steps.(', state()), true);
});

test('a blank `when` is ignored', async () => {
    const form = await pausedForm(page([{ name: 'note', type: 'text', label: 'Note' }], { when: '   ' }));
    assert.equal(form.fields[0].name, 'note');
});

test('the layer guard comes before the condition', async () => {
    await assert.rejects(
        () => execFormPage(page([{ name: 'n', type: 'text', label: 'N' }], { when: 'false' }), { layerStack: ['l'] }, state(), 'live'),
        /not supported inside layers/,
    );
});

test('dry run blanks are keyed by the authored names', async () => {
    const step = page([
        { name: 'title', type: 'text', label: 'T' },
        { name: 'agree', type: 'checkbox', label: 'A' },
        { name: 'topics', type: 'multiselect', label: 'Topics', options: ['a', 'b'] },
        { name: 'rate', type: 'number', label: 'Rate', fieldsFrom: { ref: 'steps.load.output.rows', value: 'id' } },
    ]);
    const r = await execFormPage(step, noLayers, state(), 'dry_run');
    assert.deepEqual(r.output, { title: '', agree: false, topics: [], rate: [], _dryRun: true });
});
