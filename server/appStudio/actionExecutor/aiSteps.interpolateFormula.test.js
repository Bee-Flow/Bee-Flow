// @typecheck strict
/**
 * App Studio AI-step prompts: a placeholder that is not a plain path is a FORMULA, evaluated
 * with the shared engine against the server step scope. Plain paths keep their own reading
 * (aiSteps.interpolatePrompt.test.js, unchanged); a formula that does not parse, fails or gives
 * nothing stays verbatim, like an unresolved path.
 *
 * Run: cd server && node --test appStudio/actionExecutor/aiSteps.interpolateFormula.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { interpolatePrompt } = require('./aiSteps');

const ctx = {
    formValues: { name: 'Ada', qty: 3 },
    vars: { lines: [{ sku: 'A1' }, { sku: 'B2' }], order: { no: 'PO-7' } },
    item: { title: 'Ticket 7' },
    params: { lang: 'nl' },
    viewerName: 'Grace',
};

test('a formula placeholder is evaluated against the step scope', () => {
    assert.strictEqual(interpolatePrompt('Hi {{ upper(form.name) }}', ctx), 'Hi ADA');
    assert.strictEqual(interpolatePrompt('{{ form.qty + 1 }} of {{ len(vars.lines) }}', ctx), '4 of 2');
    assert.strictEqual(interpolatePrompt('Language: {{ params.lang + "" }}', ctx), 'Language: nl');
    assert.strictEqual(interpolatePrompt('By {{ "" + currentUser.name }}', ctx), 'By Grace');
});

test('a formula that gives a list or object is written as JSON, like a path', () => {
    assert.strictEqual(interpolatePrompt('{{ vars.order }} / {{ (vars.order) }}', ctx), '{"no":"PO-7"} / {"no":"PO-7"}');
});

test('a formula that does not parse, fails or gives nothing stays verbatim', () => {
    for (const raw of ['{{ not a path }}', '{{ 1 + }}', '{{ nosuchfunction(1) }}', '{{ }}', '{{ (form.missing) }}']) {
        assert.strictEqual(interpolatePrompt(`Keep ${raw}`, ctx), `Keep ${raw}`, raw);
    }
});

test('plain paths are untouched by the formula reading', () => {
    // currentUser is not one of the prompt roots: as a plain path it stays verbatim, as before.
    assert.strictEqual(interpolatePrompt('{{currentUser.name}} {{form.name}} {{name}}', ctx), '{{currentUser.name}} Ada Ada');
});
