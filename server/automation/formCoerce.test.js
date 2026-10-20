const test = require('node:test');
const assert = require('node:assert');

const { coerceSubmission, coerceFieldValue, isBlank, emptyValue } = require('./formCoerce');
const { normalizeFields, renderFormConfig, validateFormDeclaration, emptyFormValues } = require('./formTriggerContract');

const fieldsOf = (fields) => normalizeFields({ fields });
const run = (fields, body) => coerceSubmission(fieldsOf(fields), body);
const plain = (values) => ({ ...values });
const fileDesc = (fileId) => ({ kind: 'form_upload', fileId });

const CHOICES = ['Option A', 'Option B', 'Option C'];

// ── radio ──────────────────────────────────────────────

test('radio is a closed vocabulary like select', () => {
    const f = { name: 'pick', type: 'radio', label: 'Pick', options: CHOICES };
    assert.deepEqual(plain(run([f], { pick: 'Option B' }).values), { pick: 'Option B' });
    assert.deepEqual(plain(run([f], { pick: ' Option B ' }).values), { pick: 'Option B' });
    const bad = run([f], { pick: 'Option Z' });
    assert.deepEqual(bad.errors, [{ field: 'pick', message: 'Pick is not one of the offered choices.' }]);
    assert.equal(bad.values.pick, '');
    assert.equal(run([f], { pick: ['Option A'] }).errors.length, 1, 'a list is not one choice');
    assert.equal(run([{ ...f, required: true }], {}).errors[0].message, 'Pick is required.');
});

// ── multiselect ────────────────────────────────────────

const MULTI = { name: 'topics', type: 'multiselect', label: 'Topics', options: CHOICES };

test('multiselect takes an array, or one string as a one-item array', () => {
    assert.deepEqual(run([MULTI], { topics: ['Option A', 'Option C'] }).values.topics, ['Option A', 'Option C']);
    assert.deepEqual(run([MULTI], { topics: 'Option B' }).values.topics, ['Option B']);
    assert.deepEqual(run([MULTI], { topics: [] }).values.topics, []);
    assert.deepEqual(run([MULTI], { topics: '' }).values.topics, []);
    assert.deepEqual(run([MULTI], {}).values.topics, []);
    assert.deepEqual(run([MULTI], { topics: ['Option A', ''] }).values.topics, ['Option A']);
});

test('multiselect refuses anything off the list', () => {
    const r = run([MULTI], { topics: ['Option A', 'Option Z'] });
    assert.deepEqual(r.errors, [{ field: 'topics', message: 'Topics is not one of the offered choices.' }]);
    assert.deepEqual(r.values.topics, [], 'a failed answer carries the empty value');
    assert.equal(run([MULTI], { topics: [1] }).errors.length, 1);
    assert.equal(run([MULTI], { topics: { a: 1 } }).errors.length, 1);
});

test('multiselect is de-duplicated and kept in the order the question lists its choices', () => {
    assert.deepEqual(run([MULTI], { topics: ['Option C', 'Option A', 'Option C'] }).values.topics, ['Option A', 'Option C']);
});

test('multiselect bounds and required', () => {
    const bounded = { ...MULTI, minSelected: 2, maxSelected: 2 };
    assert.equal(run([bounded], { topics: ['Option A'] }).errors[0].message, 'Topics must have at least 2 choices.');
    assert.equal(run([bounded], { topics: CHOICES }).errors[0].message, 'Topics must have at most 2 choices.');
    assert.deepEqual(run([bounded], { topics: ['Option A', 'Option B'] }).errors, []);
    assert.deepEqual(run([bounded], {}).errors, [], 'optional and empty: the bounds do not apply');
    const required = { ...MULTI, required: true };
    assert.equal(run([required], { topics: [] }).errors[0].message, 'Topics is required.');
    assert.equal(run([required], {}).errors[0].message, 'Topics is required.');
    assert.deepEqual(run([required], { topics: ['Option A'] }).errors, []);
});

test('isBlank and emptyValue know the new types', () => {
    assert.equal(isBlank({ type: 'multiselect' }, []), true);
    assert.equal(isBlank({ type: 'multiselect' }, ['a']), false);
    assert.deepEqual(emptyValue({ type: 'multiselect' }), []);
    assert.deepEqual(emptyValue({ type: 'text', fieldsFrom: { ref: 'r' } }), []);
    assert.equal(emptyValue({ type: 'radio' }), '');
    assert.equal(emptyValue({ type: 'checkbox' }), false);
    assert.equal(coerceFieldValue({ type: 'colour' }, 'x').ok, false);
});

// ── rules ──────────────────────────────────────────────

test('rules run on non-blank values only, with the label in front', () => {
    const fields = [
        { name: 'qty', type: 'number', label: 'Quantity', min: 1, max: 5 },
        { name: 'code', type: 'text', label: 'Code', pattern: '[A-Z]{2}\\d', patternMessage: 'Use two letters and a digit.' },
        { name: 'note', type: 'textarea', label: 'Note', minLength: 3, maxLength: 5 },
        { name: 'day', type: 'date', label: 'Day', min: '2026-01-01' },
    ];
    assert.deepEqual(run(fields, {}).errors, []);
    const r = run(fields, { qty: 9, code: 'ab1', note: 'ab', day: '2025-12-31' });
    assert.deepEqual(r.errors.map(e => e.message), [
        'Quantity must be at most 5.',
        'Use two letters and a digit.',
        'Note must be at least 3 characters.',
        'Day must be on or after 2026-01-01.',
    ]);
    assert.deepEqual(run(fields, { qty: '3', code: 'AB1', note: 'abcd', day: '2026-02-01' }).errors, []);
});

test('a required blank answer reports required, not a rule', () => {
    const r = run([{ name: 'note', type: 'text', label: 'Note', required: true, minLength: 3 }], { note: '' });
    assert.deepEqual(r.errors.map(e => e.message), ['Note is required.']);
});

// ── showIf ─────────────────────────────────────────────

const CONTACT = [
    { name: 'contact', type: 'select', label: 'Contact by', options: ['email', 'phone'] },
    { name: 'address', type: 'email', label: 'Address', required: true, showIf: 'form.contact == "email"' },
    { name: 'number', type: 'text', label: 'Number', required: true, showIf: 'form.contact == "phone"' },
];

test('a hidden required question does not block, and a visible one still does', () => {
    const phone = run(CONTACT, { contact: 'phone', number: '123' });
    assert.deepEqual(phone.errors, []);
    const email = run(CONTACT, { contact: 'email' });
    assert.deepEqual(email.errors, [{ field: 'address', message: 'Address is required.' }]);
});

test('a hidden question carries its empty value, whatever the body says', () => {
    const r = run(CONTACT, { contact: 'phone', number: '123', address: 'someone@example.com' });
    assert.deepEqual(plain(r.values), { contact: 'phone', address: '', number: '123' });
});

test('a hidden question reports no coercion error either', () => {
    const r = run(CONTACT, { contact: 'phone', number: '123', address: 'not an email' });
    assert.deepEqual(r.errors, []);
});

test('a hidden file and a hidden pick are not listed', () => {
    const fields = [
        { name: 'extra', type: 'checkbox', label: 'Extra' },
        { name: 'proof', type: 'file', label: 'Proof', showIf: 'form.extra == true' },
        { name: 'ref', type: 'app_pick', label: 'Record', source: 'fireflies', showIf: 'form.extra == true' },
    ];
    const hidden = run(fields, { extra: false, proof: fileDesc('f1'), ref: { kind: 'app_pick', recordId: 'r1' } });
    assert.deepEqual(hidden.files, []);
    assert.deepEqual(hidden.picks, []);
    assert.equal(hidden.values.proof, null);
    assert.equal(hidden.values.ref, null);
    const shown = run(fields, { extra: true, proof: fileDesc('f1') });
    assert.deepEqual(shown.files, [{ field: 'proof', fileId: 'f1' }]);
});

test('showIf chains: a hidden question reads as empty for the ones below it', () => {
    const fields = [
        { name: 'a', type: 'select', label: 'A', options: ['yes', 'no'] },
        { name: 'b', type: 'text', label: 'B', showIf: 'form.a == "yes"' },
        { name: 'c', type: 'text', label: 'C', required: true, showIf: '!isEmpty(form.b)' },
    ];
    assert.deepEqual(run(fields, { a: 'no', b: 'typed anyway' }).errors, [], 'b is hidden, so c is hidden');
    assert.deepEqual(run(fields, { a: 'yes', b: 'typed' }).errors.map(e => e.field), ['c']);
    assert.deepEqual(run(fields, { a: 'yes', b: '' }).errors, []);
});

test('a showIf that cannot run leaves the question visible', () => {
    const fields = [{ name: 'a', type: 'text', label: 'A', required: true, showIf: 'form.' }];
    assert.equal(run(fields, {}).errors.length, 1);
});

test('showIf reads a multiselect answer', () => {
    const fields = [MULTI, { name: 'invoice', type: 'text', label: 'Invoice', required: true, showIf: 'contains(form.topics, "Option B")' }];
    assert.deepEqual(run(fields, { topics: ['Option A'] }).errors, []);
    assert.deepEqual(run(fields, { topics: ['Option B'] }).errors.map(e => e.field), ['invoice']);
});

// ── groups ─────────────────────────────────────────────

const PAGE = {
    title: 'Review',
    fields: [
        { name: 'mode', type: 'select', label: 'Mode', options: ['full', 'short'] },
        { name: 'rating', type: 'select', label: 'Rate it', required: true, options: ['good', 'poor'], fieldsFrom: { ref: 'steps.load.output.rows', value: 'id', label: 'title' } },
        { name: 'closing', type: 'textarea', label: 'Closing remark' },
    ],
};
const ROWS = [{ id: 'item_1', title: 'First' }, { id: 'item_2', title: 'Second' }];
const resolverFor = (rows) => (ref) => (ref === 'steps.load.output.rows' ? rows : undefined);
const renderedFields = (rows) => renderFormConfig(PAGE, { resolveList: resolverFor(rows) }).fields;

test('group answers fold into one list in item order, and the expanded keys are gone', () => {
    const r = coerceSubmission(renderedFields(ROWS), { mode: 'full', rating__1: 'good', rating__2: 'poor', closing: 'Done' });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(Object.keys(r.values), ['mode', 'rating', 'closing']);
    assert.deepEqual(r.values.rating, [
        { key: 'item_1', label: 'First', answer: 'good' },
        { key: 'item_2', label: 'Second', answer: 'poor' },
    ]);
});

test('an empty list still gives an empty group, through the header', () => {
    const r = coerceSubmission(renderedFields([]), { mode: 'short' });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.values.rating, []);
});

test('errors keep the expanded name so they show inline', () => {
    const r = coerceSubmission(renderedFields(ROWS), { mode: 'full', rating__1: 'good', rating__2: 'meh' });
    assert.deepEqual(r.errors, [{ field: 'rating__2', message: 'Second is not one of the offered choices.' }]);
    const missing = coerceSubmission(renderedFields(ROWS), { mode: 'full', rating__1: 'good' });
    assert.deepEqual(missing.errors, [{ field: 'rating__2', message: 'Second is required.' }]);
});

test('a body cannot name a question the list did not produce', () => {
    const r = coerceSubmission(renderedFields(ROWS), { mode: 'full', rating__1: 'good', rating__2: 'good', rating__3: 'good', rating: [{ key: 'x', answer: 'y' }] });
    assert.deepEqual(r.values.rating.map(x => x.key), ['item_1', 'item_2']);
    assert.equal('rating__3' in r.values, false);
});

test('a template with a showIf hides every question it expanded into', () => {
    const page = { fields: [
        { name: 'mode', type: 'select', label: 'Mode', options: ['full', 'short'] },
        { name: 'rating', type: 'select', label: 'Rate it', required: true, options: ['good'], showIf: 'form.mode == "full"', fieldsFrom: { ref: 'steps.load.output.rows', value: 'id' } },
    ] };
    const fields = renderFormConfig(page, { resolveList: resolverFor(ROWS) }).fields;
    const r = coerceSubmission(fields, { mode: 'short' });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.values.rating.map(x => x.answer), ['', '']);
});

test('the empty sample of a form with a template holds an empty list', () => {
    assert.deepEqual(plain(emptyFormValues(PAGE)), { mode: '', rating: [], closing: '' });
});

// ── safety ─────────────────────────────────────────────

test('__proto__ and constructor in the body cannot reach the values', () => {
    const body = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1},"topics":["Option A"]}');
    const r = run([MULTI], body);
    assert.equal(Object.getPrototypeOf(r.values), null);
    assert.deepEqual(Object.keys(r.values), ['topics']);
    assert.equal({}.polluted, undefined);
});

test('an inherited property cannot answer a question', () => {
    Object.prototype.topics = ['Option A'];  
    try {
        assert.deepEqual(run([MULTI], {}).values.topics, []);
    } finally {
        delete Object.prototype.topics;
    }
});

// ── the rendered vocabulary survives a restart ─────────

test('rendering never leaves optionsFrom or fieldsFrom behind', () => {
    const page = { fields: [
        { name: 'which', type: 'radio', label: 'Which', options: ['x'], optionsFrom: { ref: 'steps.load.output.rows', value: 'id' } },
        ...PAGE.fields,
    ] };
    const rendered = renderFormConfig(page, { resolveList: resolverFor(ROWS) });
    for (const f of rendered.fields) {
        assert.equal('optionsFrom' in f, false, f.name);
        assert.equal('fieldsFrom' in f, false, f.name);
    }
    assert.deepEqual(rendered.fields[0].options.map(o => o.value), ['item_1', 'item_2']);
    assert.ok(!JSON.stringify(rendered).includes('steps.load.output.rows'));
});

test('re-normalizing a stored rendered config gives the same fields (a restarted pod)', () => {
    const page = { title: 'Review', fields: [
        { name: 'mode', type: 'select', label: 'Mode', options: [{ value: 'full', label: 'Full', hint: 'Everything' }, 'short'] },
        { name: 'which', type: 'radio', label: 'Which', required: true, optionsFrom: { ref: 'steps.load.output.rows', value: 'id', label: 'title', hint: 'note' }, showIf: 'form.mode == "full"' },
        { name: 'topics', type: 'multiselect', label: 'Topics', options: CHOICES, minSelected: 1, maxSelected: 2 },
        { name: 'code', type: 'text', label: 'Code', minLength: 2, maxLength: 9, pattern: '[A-Z]+', patternMessage: 'Capitals only' },
        { name: 'qty', type: 'number', label: 'Qty', min: 1, max: 9 },
        { name: 'day', type: 'date', label: 'Day', min: '2026-01-01' },
        { name: 'about', type: 'info', label: 'About', content: 'Some **text**.' },
        { name: 'rating', type: 'select', label: 'Rate it', required: true, placeholder: 'Pick', help: 'Per item', options: ['good', 'poor'], showIf: 'form.mode == "full"', fieldsFrom: { ref: 'steps.load.output.rows', value: 'id', label: 'title', hint: 'note' } },
        { name: 'score', type: 'number', label: 'Score', min: 0, max: 10, fieldsFrom: { ref: 'steps.load.output.rows', value: 'id', label: 'title' } },
        { name: 'closing', type: 'textarea', label: 'Closing remark' },
    ] };
    const rows = [{ id: 'item_1', title: 'First', note: 'Hint' }, { id: 'item_2', title: 'Second' }];
    const rendered = renderFormConfig(page, { resolveList: resolverFor(rows) });
    const stored = JSON.parse(JSON.stringify(rendered));
    assert.deepEqual(normalizeFields(stored), rendered.fields);
    assert.deepEqual(normalizeFields({ fields: normalizeFields(stored) }), rendered.fields, 'and again');

    // The empty-result shape is stable too.
    const empty = renderFormConfig(page, { resolveList: resolverFor([]) });
    assert.deepEqual(normalizeFields(JSON.parse(JSON.stringify(empty))), empty.fields);
    const which = empty.fields.find(f => f.name === 'which');
    assert.deepEqual({ options: which.options, noOptions: which.noOptions, required: which.required }, { options: [], noOptions: true, required: false });
});

test('a run whose list is empty can still be submitted', () => {
    const page = { fields: [{ name: 'which', type: 'radio', label: 'Which', required: true, optionsFrom: { ref: 'steps.load.output.rows' } }] };
    const rendered = renderFormConfig(page, { resolveList: resolverFor([]) });
    const r = coerceSubmission(normalizeFields(JSON.parse(JSON.stringify(rendered))), {});
    assert.deepEqual(r.errors, []);
});

test('the group cap lives per group and the 40-field cap leaves groups out', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `i${i}`, title: `T${i}` }));
    const page = { fields: [
        ...Array.from({ length: 39 }, (_, i) => ({ name: `q${i}`, type: 'text', label: `Q${i}` })),
        { name: 'rating', type: 'text', label: 'Rate it', fieldsFrom: { ref: 'steps.load.output.rows', value: 'id', label: 'title' } },
    ] };
    const fields = renderFormConfig(page, { resolveList: resolverFor(many) }).fields;
    assert.equal(fields.filter(f => f.group && !f.groupHeader).length, 50);
    assert.equal(fields.filter(f => !f.group).length, 39);
    assert.equal(normalizeFields({ fields }).length, fields.length, 'a stored config is not cut again');
});

test('the declaration checks of a page with dynamic fields', () => {
    const issues = validateFormDeclaration(PAGE, { allowRunData: true });
    assert.deepEqual(issues, []);
});
