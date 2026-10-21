const test = require('node:test');
const assert = require('node:assert');

const {
    normalizeSourceSpec, validateSourceSpec, resolveOptions, expandFieldsFrom, foldGroups,
} = require('./formDynamicFields');

const list = (value) => () => value;

/** Run `fn` with env overrides, restoring the environment afterwards. */
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

const validate = (spec, opts = {}) => {
    const issues = [];
    validateSourceSpec(spec, 'form.fields[0].optionsFrom', (code, path, message, hint) => issues.push({ code, path, message, hint }),
        { allowRunData: true, kind: 'optionsFrom', ...opts });
    return issues;
};
const codes = (issues) => issues.map(i => i.code);

// ── normalizeSourceSpec ────────────────────────────────

test('normalizeSourceSpec trims, bounds and drops what is not valid', () => {
    assert.deepEqual(normalizeSourceSpec({ ref: '  steps.a.output.rows ', value: 'id', label: ' name ', hint: '', limit: 5 }),
        { ref: 'steps.a.output.rows', value: 'id', label: 'name', limit: 5 });
    assert.deepEqual(normalizeSourceSpec({ ref: 'steps.a.output.rows', limit: 0 }), { ref: 'steps.a.output.rows' });
    assert.deepEqual(normalizeSourceSpec({ ref: 'steps.a.output.rows', limit: 10001 }), { ref: 'steps.a.output.rows' });
    assert.deepEqual(normalizeSourceSpec({ ref: 'steps.a.output.rows', limit: 2.5 }), { ref: 'steps.a.output.rows' });
    assert.equal(normalizeSourceSpec({ ref: 'x'.repeat(900) }).ref.length, 500);
    assert.deepEqual(normalizeSourceSpec({}), { ref: '' });
    assert.equal(normalizeSourceSpec(null), null);
    assert.equal(normalizeSourceSpec('steps.a'), null);
    assert.equal(normalizeSourceSpec([]), null);
});

// ── validateSourceSpec ─────────────────────────────────

test('validateSourceSpec accepts a complete spec', () => {
    assert.deepEqual(validate({ ref: 'steps.load.output.rows', value: 'id', label: 'name', hint: 'note', limit: 10 }), []);
    assert.deepEqual(validate({ ref: 'steps.load.output.names' }), []);
    assert.deepEqual(validate({ ref: 'trigger.output.items[*].id' }), []);
});

test('validateSourceSpec refuses run data where no run exists yet', () => {
    const [issue, ...rest] = validate({ ref: 'steps.a.output.rows' }, { allowRunData: false });
    assert.equal(issue.code, 'field_options_from_on_trigger');
    assert.deepEqual(rest, []);
    assert.match(issue.message, /later Form page step/);
    assert.deepEqual(codes(validate({ ref: 'steps.a.output.rows' }, { allowRunData: false, kind: 'fieldsFrom' })), ['field_options_from_on_trigger']);
});

test('validateSourceSpec needs a ref that is a plain path into the run', () => {
    assert.deepEqual(codes(validate({})), ['field_options_from_no_ref']);
    assert.deepEqual(codes(validate({ ref: '   ' })), ['field_options_from_no_ref']);
    assert.deepEqual(codes(validate('steps.a.output.rows')), ['field_options_from_invalid']);
    assert.deepEqual(codes(validate({ ref: '{{steps.a.output.rows}}' })), ['field_options_from_invalid']);
    assert.deepEqual(codes(validate({ ref: 'secrets.token' })), ['field_options_from_invalid'], 'secrets are never a list source');
    assert.deepEqual(codes(validate({ ref: 'rows' })), ['field_options_from_invalid']);
    assert.deepEqual(codes(validate({ ref: 'steps.a[' })), ['field_options_from_invalid']);
    assert.deepEqual(codes(validate({ ref: `steps.${'a'.repeat(500)}` })), ['field_options_from_invalid']);
});

test('validateSourceSpec checks the item paths and the limit', () => {
    assert.deepEqual(codes(validate({ ref: 'steps.a.output.rows', value: '{{x}}' })), ['field_options_from_invalid']);
    assert.deepEqual(codes(validate({ ref: 'steps.a.output.rows', label: 7 })), ['field_options_from_invalid']);
    assert.deepEqual(codes(validate({ ref: 'steps.a.output.rows', limit: 0 })), ['field_options_from_invalid']);
    assert.deepEqual(codes(validate({ ref: 'steps.a.output.rows', limit: 10001 })), ['field_options_from_invalid']);
    assert.deepEqual(codes(validate({ ref: 'steps.a.output.rows', limit: 'many' })), ['field_options_from_invalid']);
});

test('validateSourceSpec checks the template of a fieldsFrom', () => {
    const spec = { ref: 'steps.a.output.rows' };
    const run = (field) => codes(validate(spec, { kind: 'fieldsFrom', field }));
    assert.deepEqual(run({ name: 'rate', type: 'number' }), []);
    assert.deepEqual(run({ name: 'rate', type: 'select' }), []);
    for (const type of ['file', 'app_pick', 'multiselect', 'info', 'download', 'email']) {
        assert.deepEqual(run({ name: 'rate', type }), ['field_fields_from_type'], type);
    }
    assert.deepEqual(run({ name: 'rate', type: 'select', optionsFrom: { ref: 'steps.b.output.x' } }), ['field_fields_from_type']);
    assert.deepEqual(run({ name: 'n'.repeat(55), type: 'text' }), ['field_rule_invalid']);
    assert.deepEqual(run({ name: 'n'.repeat(54), type: 'text' }), []);
});

// ── resolveOptions ─────────────────────────────────────

test('resolveOptions reads a list of plain values', () => {
    assert.deepEqual(resolveOptions({ ref: 'r' }, list(['Option A', 'Option B', 7])), [
        { value: 'Option A', label: 'Option A' },
        { value: 'Option B', label: 'Option B' },
        { value: '7', label: '7' },
    ]);
});

test('resolveOptions reads value, label and hint paths from objects', () => {
    const rows = [
        { id: 'item_1', meta: { title: 'First' }, note: 'Open', active: true },
        { id: 'item_2', meta: { title: 'Second' }, note: 3 },
        { id: 'item_3' },
    ];
    assert.deepEqual(resolveOptions({ ref: 'r', value: 'id', label: 'meta.title', hint: 'note' }, list(rows)), [
        { value: 'item_1', label: 'First', hint: 'Open' },
        { value: 'item_2', label: 'Second', hint: '3' },
        { value: 'item_3', label: 'item_3' },
    ]);
    assert.deepEqual(resolveOptions({ ref: 'r', value: 'id', label: 'active' }, list(rows.slice(0, 1))), [{ value: 'item_1', label: 'true' }]);
});

test('resolveOptions skips empty and non-scalar values and de-duplicates by value', () => {
    const rows = [{ id: '' }, { id: null }, { id: { x: 1 } }, { id: ['a'] }, {}, { id: 'a' }, { id: 'a', name: 'Again' }, { id: ' a ' }, { id: 'b' }, 'plain', null, undefined];
    assert.deepEqual(resolveOptions({ ref: 'r', value: 'id' }, list(rows)), [
        { value: 'a', label: 'a' },
        { value: 'b', label: 'b' },
    ]);
    // Without a value path an object item has no value of its own.
    assert.deepEqual(resolveOptions({ ref: 'r' }, list([{ id: 'a' }, 'z'])), [{ value: 'z', label: 'z' }]);
});

test('resolveOptions bounds value, label and hint', () => {
    const [o] = resolveOptions({ ref: 'r', value: 'v', label: 'l', hint: 'h' }, list([{ v: 'v'.repeat(300), l: 'l'.repeat(300), h: 'h'.repeat(300) }]));
    assert.equal(o.value.length, 120);
    assert.equal(o.label.length, 120);
    assert.equal(o.hint.length, 200);
});

test('resolveOptions honours the spec limit and the environment cap', () => {
    const many = Array.from({ length: 500 }, (_, i) => `v${i}`);
    assert.equal(resolveOptions({ ref: 'r' }, list(many)).length, 200, 'default cap');
    assert.equal(resolveOptions({ ref: 'r', limit: 7 }, list(many)).length, 7);
    withEnv({ AUTOMATION_FORM_MAX_OPTIONS: '3' }, () => {
        assert.equal(resolveOptions({ ref: 'r' }, list(many)).length, 3);
        assert.equal(resolveOptions({ ref: 'r', limit: 10 }, list(many)).length, 3);
        assert.equal(resolveOptions({ ref: 'r', limit: 2 }, list(many)).length, 2);
    });
    withEnv({ AUTOMATION_FORM_MAX_OPTIONS: '0' }, () => {
        assert.equal(resolveOptions({ ref: 'r' }, list(many)).length, 500, '0 = unlimited');
        assert.equal(resolveOptions({ ref: 'r', limit: 10 }, list(many)).length, 10);
    });
});

test('resolveOptions gives nothing without a list, a resolver or a ref', () => {
    assert.deepEqual(resolveOptions({ ref: 'r' }, undefined), []);
    assert.deepEqual(resolveOptions({ ref: 'r' }, list(undefined)), []);
    assert.deepEqual(resolveOptions({ ref: 'r' }, list('not a list')), []);
    assert.deepEqual(resolveOptions({ ref: 'r' }, list({ a: 1 })), []);
    assert.deepEqual(resolveOptions({ ref: '' }, () => { throw new Error('must not be called'); }), []);
    assert.deepEqual(resolveOptions({ ref: 'r' }, () => { throw new Error('boom'); }), [], 'a failing read shows no choices instead of a broken page');
    assert.deepEqual(resolveOptions(null, list(['a'])), []);
});

test('resolveOptions never interpolates what the run produced', () => {
    const rows = [{ id: '{{secrets.x}}', name: '{{secrets.x}}', note: '{{steps.a.output}}' }];
    assert.deepEqual(resolveOptions({ ref: 'r', value: 'id', label: 'name', hint: 'note' }, list(rows)), [
        { value: '{{secrets.x}}', label: '{{secrets.x}}', hint: '{{steps.a.output}}' },
    ]);
});

// ── expandFieldsFrom ───────────────────────────────────

const TEMPLATE = {
    name: 'rating', type: 'select', label: 'Rate it', required: true, placeholder: 'Pick', help: 'One per item',
    options: [{ value: 'good', label: 'Good' }, { value: 'poor', label: 'Poor' }],
    showIf: 'form.mode == "full"',
    fieldsFrom: { ref: 'r', value: 'id', label: 'title', hint: 'note' },
};
const ROWS = [{ id: 'item_1', title: 'First', note: 'Hint 1' }, { id: 'item_2', title: 'Second' }];

test('expandFieldsFrom writes a header and one question per item', () => {
    const out = expandFieldsFrom(TEMPLATE, TEMPLATE.fieldsFrom, list(ROWS));
    assert.equal(out.length, 3);
    assert.deepEqual(out[0], {
        name: 'rating__0', type: 'info', label: 'Rate it', required: false, placeholder: '', help: '',
        content: 'One per item', group: 'rating', groupHeader: true, showIf: 'form.mode == "full"',
    });
    assert.deepEqual(out[1], {
        type: 'select', required: true, placeholder: 'Pick',
        options: [{ value: 'good', label: 'Good' }, { value: 'poor', label: 'Poor' }],
        showIf: 'form.mode == "full"',
        name: 'rating__1', label: 'First', help: 'Hint 1', group: 'rating', groupKey: 'item_1',
    });
    assert.equal(out[2].name, 'rating__2');
    assert.equal(out[2].label, 'Second');
    assert.equal(out[2].help, '');
    assert.equal(out[2].groupKey, 'item_2');
    for (const f of out) {
        assert.equal('fieldsFrom' in f, false);
        assert.equal('optionsFrom' in f, false);
    }
    assert.notStrictEqual(out[1].options, out[2].options, 'questions do not share one options array');
});

test('expandFieldsFrom with an empty list is just the header', () => {
    const out = expandFieldsFrom({ ...TEMPLATE, showIf: undefined }, TEMPLATE.fieldsFrom, list([]));
    assert.equal(out.length, 1);
    assert.equal(out[0].groupHeader, true);
    assert.equal('showIf' in out[0], false);
    assert.equal(expandFieldsFrom(TEMPLATE, TEMPLATE.fieldsFrom, undefined).length, 1);
});

test('expandFieldsFrom is capped by the spec limit and AUTOMATION_FORM_MAX_FIELDS_FROM', () => {
    const rows = Array.from({ length: 80 }, (_, i) => ({ id: `i${i}`, title: `T${i}` }));
    const spec = { ref: 'r', value: 'id', label: 'title' };
    const count = (s) => expandFieldsFrom(TEMPLATE, s, list(rows)).length - 1;
    assert.equal(count(spec), 50, 'default cap');
    assert.equal(count({ ...spec, limit: 4 }), 4);
    withEnv({ AUTOMATION_FORM_MAX_FIELDS_FROM: '3' }, () => {
        assert.equal(count(spec), 3);
        assert.equal(count({ ...spec, limit: 10 }), 3);
    });
    withEnv({ AUTOMATION_FORM_MAX_FIELDS_FROM: '0' }, () => {
        assert.equal(count(spec), 80, '0 = unlimited');
    });
});

test('expandFieldsFrom keeps every name a valid field name', () => {
    const rows = Array.from({ length: 12000 }, (_, i) => `v${i}`);
    withEnv({ AUTOMATION_FORM_MAX_FIELDS_FROM: '0' }, () => {
        const out = expandFieldsFrom({ ...TEMPLATE, name: 'n'.repeat(54) }, { ref: 'r', limit: 10000 }, list(rows));
        assert.equal(out.length - 1, 9999);
        assert.ok(out.every(f => f.name.length <= 60));
    });
});

test('expandFieldsFrom keeps run strings literal', () => {
    const out = expandFieldsFrom(TEMPLATE, { ref: 'r', value: 'id', label: 'title' }, list([{ id: 'k', title: '{{secrets.x}}' }]));
    assert.equal(out[1].label, '{{secrets.x}}');
});

// ── foldGroups ─────────────────────────────────────────

test('foldGroups folds expanded answers into one list in item order', () => {
    const fields = [
        { name: 'before', type: 'text' },
        ...expandFieldsFrom({ ...TEMPLATE, showIf: undefined }, TEMPLATE.fieldsFrom, list(ROWS)),
        { name: 'after', type: 'text' },
    ];
    const values = Object.assign(Object.create(null), { before: 'x', rating__1: 'good', rating__2: '', after: 'y' });
    const folded = foldGroups(values, fields);
    assert.strictEqual(folded, values);
    assert.deepEqual(Object.keys(values), ['before', 'rating', 'after'], 'the group takes the template\'s place');
    assert.deepEqual(values.rating, [
        { key: 'item_1', label: 'First', answer: 'good' },
        { key: 'item_2', label: 'Second', answer: '' },
    ]);
});

test('foldGroups gives an empty list when the header has no questions', () => {
    const fields = expandFieldsFrom(TEMPLATE, TEMPLATE.fieldsFrom, list([]));
    const values = Object.create(null);
    foldGroups(values, fields);
    assert.deepEqual(values.rating, []);
});

test('foldGroups leaves a form without groups alone', () => {
    const values = Object.assign(Object.create(null), { a: 1 });
    foldGroups(values, [{ name: 'a', type: 'number' }]);
    assert.deepEqual({ ...values }, { a: 1 });
});
