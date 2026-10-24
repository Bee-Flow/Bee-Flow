// @typecheck
const test = require('node:test');
const assert = require('node:assert');

const contract = require('./formTriggerContract');
const {
    FIELD_TYPES, DISPLAY_FIELD_TYPES, FILE_FIELD_TYPES, CHOICE_FIELD_TYPES, RESERVED_NAME_RE,
    formOptionsCap, formFieldsFromCap, isDynamicField, isDisplayField,
    validateFormDeclaration, validateFormTrigger, normalizeFields, renderFormConfig, renderConfig, emptyFormValues,
} = contract;

const codes = (issues) => issues.map(i => i.code);
const page = (...fields) => ({ title: 'Page', fields });
const onPage = (...fields) => validateFormDeclaration(page(...fields), { allowRunData: true });
const SOURCE = { ref: 'steps.load.output.rows', value: 'id' };

function withEnv(env, fn) {
    const before = {};
    for (const k of Object.keys(env)) before[k] = process.env[k];
    try {
        Object.assign(process.env, env);
        return fn();
    } finally {
        for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
}

test('the facade keeps its exports and adds the wizard vocabulary', () => {
    assert.deepEqual(FIELD_TYPES, ['text', 'textarea', 'email', 'number', 'date', 'select', 'radio', 'multiselect', 'checkbox', 'file', 'app_pick', 'download', 'notebook', 'info']);
    assert.deepEqual(DISPLAY_FIELD_TYPES, ['download', 'notebook', 'info']);
    assert.deepEqual(FILE_FIELD_TYPES, ['download', 'notebook']);
    assert.deepEqual(CHOICE_FIELD_TYPES, ['select', 'radio', 'multiselect']);
    assert.equal(RESERVED_NAME_RE.test('rating__3'), true);
    assert.equal(RESERVED_NAME_RE.test('rating_3'), false);
    assert.equal(formOptionsCap(), 200);
    assert.equal(formFieldsFromCap(), 50);
    assert.equal(isDynamicField({ optionsFrom: { ref: 'a' } }), true);
    assert.equal(isDynamicField({ fieldsFrom: { ref: 'a' } }), true);
    assert.equal(isDynamicField({ type: 'text' }), false);
    assert.equal(isDisplayField({ type: 'info' }), true);
    for (const name of ['coerceFieldValue', 'coerceSubmission', 'isFileField', 'isPickField', 'MAX_FIELDS', 'MAX_UPLOAD_MB', 'DEFAULT_UPLOAD_MB', 'MAX_RENDERED_DESCRIPTION_LEN', 'formTriggerFields', 'renderConfig', 'isFormTriggerDefinition']) {
        assert.ok(name in contract, name);
    }
});

test('the caps read the environment at call time; 0 means unlimited', () => {
    withEnv({ AUTOMATION_FORM_MAX_OPTIONS: '5', AUTOMATION_FORM_MAX_FIELDS_FROM: '7' }, () => {
        assert.equal(formOptionsCap(), 5);
        assert.equal(formFieldsFromCap(), 7);
    });
    withEnv({ AUTOMATION_FORM_MAX_OPTIONS: '0' }, () => assert.equal(formOptionsCap(), 0));
    withEnv({ AUTOMATION_FORM_MAX_OPTIONS: 'lots' }, () => assert.equal(formOptionsCap(), 200));
});

// ── options ────────────────────────────────────────────

test('choice options keep value, label and hint, and radio and multiselect carry them like select', () => {
    const options = ['Plain', { value: 'with_hint', label: 'With hint', hint: 'Shown under it' }, { value: 'x', hint: 5 }, { nope: 1 }, ''];
    for (const type of CHOICE_FIELD_TYPES) {
        const [f] = normalizeFields({ fields: [{ name: 'q', type, options }] });
        assert.deepEqual(f.options, [
            { value: 'Plain', label: 'Plain' },
            { value: 'with_hint', label: 'With hint', hint: 'Shown under it' },
            { value: 'x', label: 'x' },
        ], type);
    }
});

test('an authored list may be longer than the old fifty, up to the cap', () => {
    const options = Array.from({ length: 120 }, (_, i) => `v${i}`);
    const [f] = normalizeFields({ fields: [{ name: 'q', type: 'select', options }] });
    assert.equal(f.options.length, 120);
    withEnv({ AUTOMATION_FORM_MAX_OPTIONS: '10' }, () => {
        assert.equal(normalizeFields({ fields: [{ name: 'q', type: 'select', options }] })[0].options.length, 10);
        assert.deepEqual(codes(validateFormDeclaration(page({ name: 'q', type: 'select', options }))), ['field_options_too_many']);
    });
    withEnv({ AUTOMATION_FORM_MAX_OPTIONS: '0' }, () => {
        assert.equal(normalizeFields({ fields: [{ name: 'q', type: 'select', options: Array.from({ length: 900 }, (_, i) => `v${i}`) }] })[0].options.length, 900);
    });
});

test('option labels are interpolated, values and hints are not', () => {
    const [f] = normalizeFields({ fields: [{ name: 'q', type: 'select', options: [{ value: '{{raw}}', label: 'L {{x}}', hint: 'H {{x}}' }] }] }, { interpolate: s => s.replace('{{x}}', 'X') });
    assert.deepEqual(f.options, [{ value: '{{raw}}', label: 'L X', hint: 'H {{x}}' }]);
});

test('radio and multiselect need options or an optionsFrom', () => {
    assert.deepEqual(codes(validateFormDeclaration(page({ name: 'q', type: 'radio' }))), ['field_options']);
    assert.deepEqual(codes(validateFormDeclaration(page({ name: 'q', type: 'multiselect', options: [] }))), ['field_options']);
    assert.deepEqual(codes(validateFormDeclaration(page({ name: 'q', type: 'select' }))), ['field_options']);
    assert.deepEqual(onPage({ name: 'q', type: 'radio', optionsFrom: SOURCE }), []);
    assert.deepEqual(validateFormDeclaration(page({ name: 'q', type: 'multiselect', options: ['a'] })), []);
});

// ── info ───────────────────────────────────────────────

test('an info block is display only', () => {
    const [f] = normalizeFields({ fields: [{ name: 'about', type: 'info', label: 'About', required: true, content: 'Hello {{x}}' }] }, { interpolate: s => s.replace('{{x}}', 'there') });
    assert.equal(f.type, 'info');
    assert.equal(f.required, false);
    assert.equal(f.content, 'Hello there');
    assert.deepEqual(Object.keys(emptyFormValues(page({ name: 'about', type: 'info', content: 'x' }, { name: 'a', type: 'text' }))), ['a']);
});

test('rendered info content is bounded by the rendered limit', () => {
    const [f] = normalizeFields({ fields: [{ name: 'about', type: 'info', content: 'x' }] }, { interpolate: () => 'y'.repeat(30000) });
    assert.equal(f.content.length, 20000);
});

test('info needs text within the authored limit', () => {
    assert.deepEqual(codes(validateFormDeclaration(page({ name: 'about', type: 'info' }, { name: 'a', type: 'text' }))), ['field_info_empty']);
    assert.deepEqual(codes(validateFormDeclaration(page({ name: 'about', type: 'info', content: '  ' }, { name: 'a', type: 'text' }))), ['field_info_empty']);
    assert.deepEqual(codes(validateFormDeclaration(page({ name: 'about', type: 'info', content: 'x'.repeat(4001) }, { name: 'a', type: 'text' }))), ['field_info_too_long']);
    assert.deepEqual(validateFormDeclaration(page({ name: 'about', type: 'info', content: 'x'.repeat(4000) }, { name: 'a', type: 'text' })), []);
});

test('the trigger accepts info but not file buttons; an approval form accepts neither', () => {
    const info = { name: 'about', type: 'info', content: 'Read this first.' };
    const text = { name: 'a', type: 'text' };
    assert.deepEqual(validateFormTrigger(page(info, text)), []);
    assert.deepEqual(codes(validateFormTrigger(page({ name: 'dl', type: 'download', fileId: 'f' }, text))), ['field_download_on_trigger']);
    assert.deepEqual(codes(validateFormDeclaration(page(info, text), { requireFields: false, allowDisplayFields: false })), ['field_type']);
    assert.deepEqual(validateFormDeclaration(page(info, text), { requireFields: false }), []);
});

// ── rules and showIf in the declaration ────────────────

test('the declaration reports rule and pattern problems', () => {
    const issues = validateFormDeclaration(page(
        { name: 'qty', type: 'number', min: 9, max: 1 },
        { name: 'code', type: 'text', pattern: '(' },
        { name: 'flag', type: 'checkbox', minLength: 1 },
    ));
    assert.deepEqual(codes(issues), ['field_rule_invalid', 'field_pattern_invalid', 'field_rule_invalid']);
    assert.deepEqual(issues.map(i => i.path), ['form.fields[0].max', 'form.fields[1].pattern', 'form.fields[2].minLength']);
    for (const i of issues) assert.ok(i.message && i.hint);
});

test('showIf may only look at input questions above it', () => {
    const ok = validateFormDeclaration(page(
        { name: 'contact', type: 'select', options: ['email'] },
        { name: 'address', type: 'email', showIf: 'form.contact == "email"' },
    ));
    assert.deepEqual(ok, []);
    const issues = validateFormDeclaration(page(
        { name: 'first', type: 'text', showIf: 'form.second == "x"' },
        { name: 'second', type: 'text' },
        { name: 'about', type: 'info', content: 'Hi' },
        { name: 'third', type: 'text', showIf: 'form.about == "x"' },
        { name: 'fourth', type: 'text', showIf: 'steps.a.output.b' },
    ));
    assert.deepEqual(codes(issues), ['field_show_if_invalid', 'field_show_if_invalid', 'field_show_if_invalid']);
    assert.deepEqual(issues.map(i => i.path), ['form.fields[0].showIf', 'form.fields[3].showIf', 'form.fields[4].showIf']);
});

test('an info block may have a showIf too', () => {
    assert.deepEqual(validateFormDeclaration(page(
        { name: 'a', type: 'checkbox' },
        { name: 'note', type: 'info', content: 'Only if ticked', showIf: 'form.a' },
    )), []);
});

// ── reserved names ─────────────────────────────────────

test('an authored name that looks like an expansion is refused', () => {
    assert.deepEqual(codes(validateFormDeclaration(page({ name: 'rating__2', type: 'text' }))), ['field_name_reserved']);
    assert.deepEqual(codes(validateFormDeclaration(page({ name: 'rating__x', type: 'text' }))), []);
});

// ── dynamic fields ─────────────────────────────────────

test('optionsFrom and fieldsFrom only exist on a page that runs after something', () => {
    const f = { name: 'q', type: 'select', optionsFrom: SOURCE };
    assert.deepEqual(codes(validateFormTrigger(page(f))), ['field_options_from_on_trigger']);
    assert.deepEqual(codes(validateFormDeclaration(page(f))), ['field_options_from_on_trigger']);
    assert.deepEqual(onPage(f), []);
    assert.deepEqual(codes(validateFormTrigger(page({ name: 'q', type: 'text', fieldsFrom: SOURCE }))), ['field_options_from_on_trigger']);
    assert.deepEqual(onPage({ name: 'q', type: 'text', fieldsFrom: SOURCE }), []);
});

test('fieldsFrom checks its template', () => {
    assert.deepEqual(codes(onPage({ name: 'q', type: 'file', fieldsFrom: SOURCE })), ['field_fields_from_type']);
    assert.deepEqual(codes(onPage({ name: 'q', type: 'multiselect', options: ['a'], fieldsFrom: SOURCE })), ['field_fields_from_type']);
    assert.deepEqual(codes(onPage({ name: 'q', type: 'select', optionsFrom: SOURCE, fieldsFrom: SOURCE })), ['field_fields_from_type']);
    assert.deepEqual(codes(onPage({ name: 'n'.repeat(55), type: 'text', fieldsFrom: SOURCE })), ['field_rule_invalid']);
    assert.deepEqual(codes(onPage({ name: 'q', type: 'text', fieldsFrom: {} })), ['field_options_from_no_ref']);
});

test('optionsFrom on a type that has no choices is refused', () => {
    assert.deepEqual(codes(onPage({ name: 'q', type: 'text', optionsFrom: SOURCE })), ['field_options_from_invalid']);
});

test('every issue is a record with a code, a path, a message and a hint', () => {
    const issues = onPage(
        { name: 'rating__2', type: 'text' },
        { name: 'a', type: 'text', fieldsFrom: { ref: '{{x}}' } },
        { name: 'b', type: 'info' },
        { name: 'c', type: 'radio' },
    );
    assert.ok(issues.length >= 4);
    for (const i of issues) {
        assert.ok(typeof i.code === 'string' && i.code);
        assert.ok(typeof i.path === 'string' && i.path.startsWith('form.fields['));
        assert.ok(typeof i.message === 'string' && i.message.length > 10);
        assert.ok(typeof i.hint === 'string' && i.hint.length > 5);
    }
});

// ── normalize and render ───────────────────────────────

test('an authored field keeps its source spec; the rendered one never does', () => {
    const form = page(
        { name: 'which', type: 'radio', label: 'Which', optionsFrom: { ref: ' steps.load.output.rows ', value: 'id', limit: 5 } },
        { name: 'rating', type: 'number', label: 'Rate', fieldsFrom: SOURCE },
    );
    const [which, rating] = normalizeFields(form);
    assert.deepEqual(which.optionsFrom, { ref: 'steps.load.output.rows', value: 'id', limit: 5 });
    assert.deepEqual(rating.fieldsFrom, SOURCE);
    const rendered = renderFormConfig(form);
    assert.ok(!JSON.stringify(rendered).includes('steps.load.output.rows'));
    assert.deepEqual(rendered.fields.map(f => f.name), ['which', 'rating__0']);
    assert.equal(rendered.fields[0].noOptions, true);
    assert.equal(rendered.fields[0].required, false);
});

test('the trigger page renders without ever carrying a spec', () => {
    const definition = { trigger: { kind: 'form', form: page({ name: 'which', type: 'select', label: 'Which', required: true, optionsFrom: SOURCE }) } };
    const [f] = renderConfig(definition).fields;
    assert.equal('optionsFrom' in f, false);
    assert.deepEqual(f.options, []);
});

test('rendering passes the page text through the interpolator but not the data lists', () => {
    const form = page({ name: 'which', type: 'radio', label: 'Pick for {{who}}', optionsFrom: { ref: 'steps.a.output.rows', value: 'id', label: 'name' } });
    const rendered = renderFormConfig(form, {
        interpolate: s => s.replace('{{who}}', 'them'),
        resolveList: () => [{ id: 'k', name: '{{who}}' }],
    });
    assert.equal(rendered.fields[0].label, 'Pick for them');
    assert.deepEqual(rendered.fields[0].options, [{ value: 'k', label: '{{who}}' }]);
});

test('rendered fields carry rules, showIf, bounds and group attributes', () => {
    const form = page(
        { name: 'qty', type: 'number', label: 'Qty', min: 1, max: 9, showIf: 'form.x' },
        { name: 'x', type: 'checkbox' },
    );
    const [qty] = renderFormConfig(form).fields;
    assert.deepEqual({ min: qty.min, max: qty.max, showIf: qty.showIf }, { min: 1, max: 9, showIf: 'form.x' });
});

test('a malformed group attribute is bounded', () => {
    const [f] = normalizeFields({ fields: [{ name: 'a__1', type: 'text', group: 'g'.repeat(100), groupKey: 'k'.repeat(300), groupHeader: 'yes' }] });
    assert.equal(f.group.length, 60);
    assert.equal(f.groupKey.length, 120);
    assert.equal('groupHeader' in f, false);
});

test('an info block without a label stays blank instead of showing its internal name', () => {
    const [note, plain] = normalizeFields({ fields: [{ name: 'note_k3f9', type: 'info', content: 'Read this first.' }, { name: 'city', type: 'text' }] });
    assert.equal(note.label, '');
    assert.equal(plain.label, 'city');
});
