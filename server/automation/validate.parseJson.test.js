/**
 * Unit tests for parse_json validation rules in validate.js.
 *
 * Run: node --test automation/validate.parseJson.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const { validateDefinition } = require('./validate');

function defWith(step, { edges = null, extraSteps = [] } = {}) {
    const steps = [{ id: 'h', type: 'http_request', url: 'https://api.example.com/x' }, ...extraSteps, step];
    return {
        trigger: { id: 'trg', kind: 'manual' },
        steps,
        edges: edges || [{ from: 'trg', to: 'h' }, { from: 'h', to: step.id }],
    };
}

const codes = (recs) => recs.map(r => r.code);

test('a well-formed paths-mode step validates clean (plus the source_defaulted warning rule)', () => {
    const v = validateDefinition(defWith({
        id: 'p1', type: 'parse_json', sourceRef: 'steps.h.output.body',
        fields: [{ name: 'email', path: 'order.customer.email' }, { name: 'skus', path: 'items[*].sku' }, { name: 'whole', path: '' }],
    }));
    assert.deepStrictEqual(v.errors, []);
    assert.ok(!codes(v.warnings).includes('parse_json.source_defaulted'));
});

test('parse_json is a known step type (no step.unknown_type)', () => {
    const v = validateDefinition(defWith({ id: 'p1', type: 'parse_json', fields: [{ name: 'a', path: 'x' }] }));
    assert.ok(!codes(v.errors).includes('step.unknown_type'));
});

test('empty/absent fields → WARNING parse_json.no_fields, never an error', () => {
    for (const fields of [undefined, []]) {
        const v = validateDefinition(defWith({ id: 'p1', type: 'parse_json', sourceRef: 'steps.h.output.body', fields }));
        assert.deepStrictEqual(v.errors, [], 'a freshly-dropped node must save');
        assert.ok(codes(v.warnings).includes('parse_json.no_fields'));
    }
});

test('non-array fields → parse_json.fields_shape error', () => {
    const v = validateDefinition(defWith({ id: 'p1', type: 'parse_json', sourceRef: 'steps.h.output.body', fields: { name: 'x' } }));
    assert.ok(codes(v.errors).includes('parse_json.fields_shape'));
});

test('more than 50 fields → parse_json.too_many_fields error', () => {
    const fields = Array.from({ length: 51 }, (_, i) => ({ name: `f_${i}`, path: 'a' }));
    const v = validateDefinition(defWith({ id: 'p1', type: 'parse_json', sourceRef: 'steps.h.output.body', fields }));
    assert.ok(codes(v.errors).includes('parse_json.too_many_fields'));
});

test('invalid mode → parse_json.mode_invalid error', () => {
    const v = validateDefinition(defWith({ id: 'p1', type: 'parse_json', mode: 'magic', sourceRef: 'steps.h.output.body', fields: [{ name: 'a', path: 'x' }] }));
    assert.ok(codes(v.errors).includes('parse_json.mode_invalid'));
});

test('bad / missing / duplicate field names', () => {
    const bad = validateDefinition(defWith({ id: 'p1', type: 'parse_json', sourceRef: 'steps.h.output.body', fields: [{ name: '9lives', path: 'x' }] }));
    assert.ok(codes(bad.errors).includes('parse_json.field_name_invalid'));

    const missing = validateDefinition(defWith({ id: 'p1', type: 'parse_json', sourceRef: 'steps.h.output.body', fields: [{ path: 'x' }] }));
    assert.ok(codes(missing.errors).includes('parse_json.field_name_invalid'));

    const tooLong = validateDefinition(defWith({ id: 'p1', type: 'parse_json', sourceRef: 'steps.h.output.body', fields: [{ name: 'a'.repeat(65), path: 'x' }] }));
    assert.ok(codes(tooLong.errors).includes('parse_json.field_name_invalid'));

    const dup = validateDefinition(defWith({
        id: 'p1', type: 'parse_json', sourceRef: 'steps.h.output.body',
        fields: [{ name: 'a', path: 'x' }, { name: 'a', path: 'y' }],
    }));
    assert.ok(codes(dup.errors).includes('parse_json.field_name_duplicate'));
});

test('paths mode: path syntax is enforced (leading bracket + quoted keys allowed)', () => {
    const ok = validateDefinition(defWith({
        id: 'p1', type: 'parse_json', sourceRef: 'steps.h.output.body',
        fields: [
            { name: 'root_arr', path: '[0].id' },
            { name: 'flat', path: '[*].id' },
            { name: 'quoted', path: 'obj["key with spaces"].v' },
            { name: 'dollar', path: '$' },
        ],
    }));
    assert.deepStrictEqual(ok.errors, []);

    const bad = validateDefinition(defWith({
        id: 'p1', type: 'parse_json', sourceRef: 'steps.h.output.body',
        fields: [{ name: 'a', path: 'items[' }, { name: 'b', path: '.leading.dot' }, { name: 'c', path: 42 }],
    }));
    const errs = codes(bad.errors).filter(c => c === 'parse_json.field_path_invalid');
    assert.strictEqual(errs.length, 3);
});

test('ai mode: every field needs a description; paths are not required', () => {
    const bad = validateDefinition(defWith({
        id: 'p1', type: 'parse_json', mode: 'ai', sourceRef: 'steps.h.output.body',
        fields: [{ name: 'a', description: 'ok' }, { name: 'b' }, { name: 'c', description: '   ' }],
    }));
    const errs = codes(bad.errors).filter(c => c === 'parse_json.field_description_missing');
    assert.strictEqual(errs.length, 2);

    const ok = validateDefinition(defWith({
        id: 'p1', type: 'parse_json', mode: 'ai', sourceRef: 'steps.h.output.body',
        fields: [{ name: 'a', description: 'The a value' }],
    }));
    assert.deepStrictEqual(ok.errors, []);
});

test('absent sourceRef → parse_json.source_defaulted warning; non-string → error', () => {
    const warn = validateDefinition(defWith({ id: 'p1', type: 'parse_json', fields: [{ name: 'a', path: 'x' }] }));
    assert.ok(codes(warn.warnings).includes('parse_json.source_defaulted'));

    const err = validateDefinition(defWith({ id: 'p1', type: 'parse_json', sourceRef: 42, fields: [{ name: 'a', path: 'x' }] }));
    assert.ok(codes(err.errors).includes('parse_json.source_ref_shape'));
});

test('sourceRef participates in ref checks: unknown step → error, forward ref → warning', () => {
    const unknown = validateDefinition(defWith({
        id: 'p1', type: 'parse_json', sourceRef: 'steps.ghost.output.body', fields: [{ name: 'a', path: 'x' }],
    }));
    assert.ok(codes(unknown.errors).includes('ref.unknown_step'));

    // p1 references a step wired AFTER it → forward-ref warning.
    const fwd = validateDefinition({
        trigger: { id: 'trg', kind: 'manual' },
        steps: [
            { id: 'p1', type: 'parse_json', sourceRef: 'steps.late.output.body', fields: [{ name: 'a', path: 'x' }] },
            { id: 'late', type: 'http_request', url: 'https://api.example.com/x' },
        ],
        edges: [{ from: 'trg', to: 'p1' }, { from: 'p1', to: 'late' }],
    });
    assert.ok(codes(fwd.warnings).includes('ref.forward'));
});

test('an on_error edge FROM a parse_json step is accepted (no error, no unlikely warning)', () => {
    const step = { id: 'p1', type: 'parse_json', sourceRef: 'steps.h.output.body', fields: [{ name: 'a', path: 'x' }] };
    const v = validateDefinition({
        trigger: { id: 'trg', kind: 'manual' },
        steps: [
            { id: 'h', type: 'http_request', url: 'https://api.example.com/x' },
            step,
            { id: 'n1', type: 'notification', title: 'failed' },
        ],
        edges: [{ from: 'trg', to: 'h' }, { from: 'h', to: 'p1' }, { from: 'p1', to: 'n1', label: 'on_error' }],
    });
    assert.ok(!codes(v.errors).includes('edge.error_label_invalid'));
    assert.ok(!codes(v.warnings).includes('edge.error_label_unlikely'));
});

test('parse_json nested in a loop body passes the child-type check', () => {
    const v = validateDefinition(defWith({
        id: 'loop1', type: 'loop', overRef: 'steps.h.output.body', itemVar: 'item', maxIterations: 100,
        body: [{ id: 'p1', type: 'parse_json', sourceRef: 'loop.item.payload', fields: [{ name: 'a', path: 'x' }] }],
    }, { edges: [{ from: 'trg', to: 'h' }, { from: 'h', to: 'loop1' }] }));
    assert.ok(!codes(v.errors).includes('loop.body_item_type'));
});

// ── itemsRef ("group by list") ───────────────────────────────────────
test('parse_json: a valid itemsRef passes; a malformed one errors', () => {
    const ok = validateDefinition(defWith({
        id: 'p1', type: 'parse_json', sourceRef: 'steps.h.output.body', itemsRef: 'results',
        fields: [{ name: 'title', path: 'title' }],
    }));
    assert.ok(!ok.errors.some(e => e.code === 'parse_json.items_ref_invalid'), 'plain path accepted');

    const nested = validateDefinition(defWith({
        id: 'p1', type: 'parse_json', sourceRef: 'steps.h.output.body', itemsRef: 'data.orders',
        fields: [{ name: 'title', path: 'title' }],
    }));
    assert.ok(!nested.errors.some(e => e.code === 'parse_json.items_ref_invalid'), 'dotted path accepted');

    const bad = validateDefinition(defWith({
        id: 'p1', type: 'parse_json', sourceRef: 'steps.h.output.body', itemsRef: 'results[',
        fields: [{ name: 'title', path: 'title' }],
    }));
    assert.ok(bad.errors.some(e => e.code === 'parse_json.items_ref_invalid'), 'malformed path rejected');

    const wrongType = validateDefinition(defWith({
        id: 'p1', type: 'parse_json', sourceRef: 'steps.h.output.body', itemsRef: 42,
        fields: [{ name: 'title', path: 'title' }],
    }));
    assert.ok(wrongType.errors.some(e => e.code === 'parse_json.items_ref_invalid'), 'non-string rejected');

    const empty = validateDefinition(defWith({
        id: 'p1', type: 'parse_json', sourceRef: 'steps.h.output.body', itemsRef: '',
        fields: [{ name: 'title', path: 'title' }],
    }));
    assert.ok(!empty.errors.some(e => e.code === 'parse_json.items_ref_invalid'), 'empty = ungrouped, not an error');
});
