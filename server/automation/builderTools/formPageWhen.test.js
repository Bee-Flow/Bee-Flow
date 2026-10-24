// @typecheck
'use strict';

/**
 * The page condition (`when`) on a form_page step through the builder: the add
 * helper, the patch normaliser and builder_update_step.
 *
 * Run: node --test automation/builderTools/formPageWhen.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { applyToolCall, emptyDefinition } = require('../builderTools');
const { applyAddFormPage } = require('./stepBuilders/flowSteps');
const { normalizePatchField } = require('./stepEditing/normalizePatchField');
const { PATCHABLE_FIELDS } = require('./stepEditing');

const FORM = { title: 'More', fields: [{ name: 'note', type: 'text', label: 'Note' }] };

function draftWithPage(extra = {}) {
    const def = emptyDefinition();
    def.steps = [{ id: 'fp', type: 'form_page', mode: 'input', form: FORM, waitSeconds: 3600, label: 'Ask', ...extra }];
    def.edges = [{ from: 'trg', to: 'fp' }];
    return { userId: 'u_test', def, _inspectedTools: new Set() };
}

test('when is a patchable form_page field', () => {
    assert.ok(PATCHABLE_FIELDS.form_page.includes('when'));
});

test('applyAddFormPage stores a trimmed, capped condition and leaves it out when blank', () => {
    const withWhen = emptyDefinition();
    const { added } = applyAddFormPage(withWhen, { form: FORM, when: '  trigger.output.kind == "b"  ' });
    assert.strictEqual(added.when, 'trigger.output.kind == "b"');

    const long = applyAddFormPage(emptyDefinition(), { form: FORM, when: 'x'.repeat(3000) });
    assert.strictEqual(long.added.when.length, 2000);

    for (const blank of [undefined, '', '   ', 5, null]) {
        const r = applyAddFormPage(emptyDefinition(), { form: FORM, when: blank });
        assert.ok(!('when' in r.added), `no when for ${JSON.stringify(blank)}`);
    }
});

test('normalizePatchField: when is a trimmed string up to 2000 characters, or null', () => {
    assert.strictEqual(normalizePatchField('form_page', 'when', '  a == 1 '), 'a == 1');
    assert.strictEqual(normalizePatchField('form_page', 'when', 'y'.repeat(2500)).length, 2000);
    for (const empty of ['', '   ', null, undefined, 7, {}, []]) {
        assert.strictEqual(normalizePatchField('form_page', 'when', empty), null, JSON.stringify(empty));
    }
    // Other step types keep their own handling of a key called `when`.
    assert.notStrictEqual(normalizePatchField('wait', 'seconds', 5), null);
});

test('builder_update_step sets, changes and clears the condition', async () => {
    const dw = draftWithPage();
    const set = await applyToolCall('builder_update_step', { stepId: 'fp', patch: { when: ' trigger.output.kind == "b" ' } }, dw);
    assert.ok(!set.error, JSON.stringify(set));
    assert.strictEqual(dw.def.steps[0].when, 'trigger.output.kind == "b"');

    const cleared = await applyToolCall('builder_update_step', { stepId: 'fp', patch: { when: '' } }, dw);
    assert.ok(!cleared.error, JSON.stringify(cleared));
    assert.ok(dw.def.steps[0].when == null, 'cleared');
});
