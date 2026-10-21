const test = require('node:test');
const assert = require('node:assert');

const { validateDefinition, COMPLETENESS_CODES } = require('./validate');

const all = (res) => (res.errors || []).concat(res.warnings || []);
const codesOf = (res) => all(res).map(r => r.code);
const withCode = (res, code) => all(res).filter(r => r.code === code);

const FORM_TRIGGER = {
    id: 'trg', type: 'trigger', kind: 'form',
    form: { title: 'Start', fields: [{ name: 'name', type: 'text', label: 'Name', required: true }] },
};
const LOAD = { id: 'load', type: 'set', fields: { rows: { kind: 'literal', value: [{ id: 'a', name: 'A' }] } } };

const pageWith = (fields, extra = {}) => ({
    id: 'fp1', type: 'form_page', mode: 'input',
    form: { title: 'Pick', fields },
    ...extra,
});
const optionsField = (ref) => ({
    name: 'row', type: 'select', label: 'Row',
    optionsFrom: { ref, value: 'id', label: 'name' },
});

/** trigger → steps… → tail notification. */
function definition(steps, { trigger = FORM_TRIGGER } = {}) {
    const tail = { id: 'end', type: 'notification', channel: 'email', to: 'a@b.nl', subject: 'hi', body: 'hi' };
    const all = [...steps, tail];
    const edges = [{ from: trigger.id, to: all[0].id }];
    for (let i = 0; i < all.length - 1; i++) edges.push({ from: all[i].id, to: all[i + 1].id });
    return { trigger, steps: all, edges };
}

test('a form page may read its options from an earlier step', () => {
    const res = validateDefinition(definition([LOAD, pageWith([optionsField('steps.load.output.rows')])]));
    assert.deepEqual(codesOf(res).filter(c => c.startsWith('form_page.') || c.startsWith('ref.')), []);
});

test('the same field on the trigger form is refused: there is no run data yet', () => {
    const trigger = {
        ...FORM_TRIGGER,
        form: { title: 'Start', fields: [optionsField('steps.load.output.rows')] },
    };
    const res = validateDefinition(definition([LOAD], { trigger }));
    assert.ok(codesOf(res).includes('form.field_options_from_on_trigger'), codesOf(res).join(', '));
    assert.equal(res.ok, false);
});

test('optionsFrom.ref and fieldsFrom.ref are scoped like any reference', () => {
    const unknown = validateDefinition(definition([LOAD, pageWith([optionsField('steps.gone.output.rows')])]));
    assert.ok(codesOf(unknown).includes('ref.unknown_step'), codesOf(unknown).join(', '));

    // A step that runs AFTER the page has produced nothing yet.
    const later = validateDefinition(definition([pageWith([optionsField('steps.load.output.rows')]), LOAD]));
    assert.ok(all(later).some(r => r.code.startsWith('ref.') && /load/.test(r.message)),
        `later step not reported: ${codesOf(later).join(', ')}`);

    const perItem = validateDefinition(definition([LOAD, pageWith([{
        name: 'rate', type: 'number', label: 'Rate', fieldsFrom: { ref: 'steps.gone.output.rows' },
    }])]));
    assert.ok(codesOf(perItem).includes('ref.unknown_step'), codesOf(perItem).join(', '));
});

test('text inside an info block and an option hint is scoped', () => {
    const res = validateDefinition(definition([LOAD, pageWith([
        { name: 'about', type: 'info', label: 'About', content: 'See {{steps.gone.output.x}}' },
        { name: 'pick', type: 'select', label: 'Pick', options: [{ value: 'a', hint: '{{steps.gone2.output.y}}' }] },
    ])]));
    const msgs = withCode(res, 'ref.unknown_step').map(r => r.message).join('\n');
    assert.match(msgs, /"gone"/);
    assert.match(msgs, /"gone2"/);
});

test('showIf is not scanned: its form root belongs to the page', () => {
    const res = validateDefinition(definition([LOAD, pageWith([
        { name: 'kind', type: 'text', label: 'Kind' },
        { name: 'why', type: 'text', label: 'Why', showIf: 'form.kind == "other"' },
    ])]));
    assert.deepEqual(codesOf(res).filter(c => c.startsWith('ref.') || c.startsWith('expr.')), []);
});

test('the page condition must be an expression', () => {
    const numeric = validateDefinition(definition([LOAD, pageWith([{ name: 'a', type: 'text', label: 'A' }], { when: 5 })]));
    assert.ok(codesOf(numeric).includes('form_page.when_invalid'));
    assert.equal(numeric.ok, false);

    const template = validateDefinition(definition([LOAD, pageWith([{ name: 'a', type: 'text', label: 'A' }], { when: '{{x}}' })]));
    assert.ok(codesOf(template).includes('form_page.when_invalid'));

    const tooLong = validateDefinition(definition([LOAD, pageWith([{ name: 'a', type: 'text', label: 'A' }], { when: 'a == 1 || '.repeat(300) })]));
    assert.ok(codesOf(tooLong).includes('form_page.when_invalid'));

    const fine = validateDefinition(definition([LOAD, pageWith([{ name: 'a', type: 'text', label: 'A' }], { when: 'trigger.output.name == "x"' })]));
    assert.ok(!codesOf(fine).includes('form_page.when_invalid'), codesOf(fine).join(', '));
    assert.deepEqual(codesOf(fine).filter(c => c.startsWith('ref.') || c.startsWith('expr.')), []);

    const unset = validateDefinition(definition([LOAD, pageWith([{ name: 'a', type: 'text', label: 'A' }], { when: null })]));
    assert.ok(!codesOf(unset).includes('form_page.when_invalid'));
});

test('an unparsable or mis-scoped condition is reported by the expression scoping', () => {
    const broken = validateDefinition(definition([LOAD, pageWith([{ name: 'a', type: 'text', label: 'A' }], { when: 'steps.(' })]));
    assert.ok(all(broken).some(r => /^(expr|ref)\./.test(r.code)), `got ${codesOf(broken).join(', ')}`);

    const unknownStep = validateDefinition(definition([LOAD, pageWith([{ name: 'a', type: 'text', label: 'A' }], { when: 'steps.gone.output.x == 1' })]));
    assert.ok(codesOf(unknownStep).includes('ref.unknown_step'));
});

test('an unfinished dynamic field is a completeness matter: a warning on a draft, an error at activation', () => {
    for (const code of ['form_page.field_options_from_no_ref', 'form_page.field_info_empty', 'form.field_info_empty']) {
        assert.ok(COMPLETENESS_CODES.has(code), code);
    }
    const def = definition([LOAD, pageWith([{ name: 'row', type: 'select', label: 'Row', optionsFrom: { ref: '' } }])]);
    const draft = validateDefinition(def, { stage: 'draft' });
    const warned = (draft.warnings || []).find(r => r.code === 'form_page.field_options_from_no_ref');
    assert.ok(warned, `got ${codesOf(draft).join(', ')}`);
    assert.equal(warned.blockedAt, 'activate');
    assert.ok(!(draft.errors || []).some(r => r.code === 'form_page.field_options_from_no_ref'));

    const activate = validateDefinition(def);
    assert.ok((activate.errors || []).some(r => r.code === 'form_page.field_options_from_no_ref'));
});
