/**
 * "Edit data" (set) list-mode + operations validation rules.
 *
 * Run: node --test automation/validate.setList.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const { validateDefinition } = require('./validate');

function defWith(step) {
    return {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [{ id: 'g', type: 'integration_action', tool: 'gmail_search', inputs: {} }, step],
        edges: [{ from: 'trg', to: 'g' }, { from: 'g', to: step.id }],
    };
}

const codes = (recs) => recs.map(r => r.code);
const LIST = 'steps.g.output.results';

test('a well-formed list-mode step with fields + every op validates clean', () => {
    const v = validateDefinition(defWith({
        id: 's1', type: 'set', arrayRef: LIST,
        fields: { norm: { kind: 'expr', value: 'lower(item.email)' }, raw: { kind: 'ref', path: 'item.subject' } },
        operations: [
            { op: 'rowId', target: 'id', start: 10 },
            { op: 'groupId', target: 'thread', keys: ['to', 'subject'] },
            { op: 'rename', from: 'subject', to: 'title' },
            { op: 'keep', keys: ['id', 'thread', 'title'] },
            { op: 'remove', keys: ['internal'] },
            { op: 'sort', key: 'id', direction: 'desc' },
        ],
    }));
    assert.deepStrictEqual(v.errors, []);
    // item.* refs must NOT warn ref.invalid / ref.unknown_root in list mode.
    assert.ok(!codes(v.warnings).some(c => c === 'ref.invalid' || c === 'ref.unknown_root'), `warnings: ${JSON.stringify(v.warnings)}`);
});

test('single mode is untouched: item refs still warn, no new codes appear', () => {
    const v = validateDefinition(defWith({
        id: 's1', type: 'set',
        fields: { x: { kind: 'ref', path: 'item.subject' } },
    }));
    assert.deepStrictEqual(v.errors, []);
    assert.ok(codes(v.warnings).includes('ref.unknown_root'), 'single mode has no item scope');
});

test('arrayRef must be a string; a blank one is a completeness error', () => {
    const bad = validateDefinition(defWith({ id: 's1', type: 'set', arrayRef: 42, fields: {} }));
    assert.ok(codes(bad.errors).includes('set.arrayRef_type'));

    const blank = validateDefinition(defWith({ id: 's1', type: 'set', arrayRef: '', fields: {} }));
    assert.ok(codes(blank.errors).includes('set.arrayRef_missing'));
    // Draft stage: saveable, tagged as activation-blocking.
    const draft = validateDefinition(defWith({ id: 's1', type: 'set', arrayRef: '', fields: {} }), { stage: 'draft' });
    assert.deepStrictEqual(draft.errors, []);
    const rec = draft.warnings.find(w => w.code === 'set.arrayRef_missing');
    assert.equal(rec?.blockedAt, 'activate');
});

test('forEach + arrayRef is an integrity error (never draft-saveable)', () => {
    const def = defWith({
        id: 's1', type: 'set', arrayRef: LIST, fields: {},
        forEach: { overRef: LIST, itemVar: 'item' },
    });
    assert.ok(codes(validateDefinition(def).errors).includes('set.foreach_conflict'));
    assert.ok(codes(validateDefinition(def, { stage: 'draft' }).errors).includes('set.foreach_conflict'), 'integrity, not completeness');
});

test('forEach on a single-mode set stays legal', () => {
    const v = validateDefinition(defWith({
        id: 's1', type: 'set', fields: {},
        forEach: { overRef: LIST, itemVar: 'item', maxIterations: 50 },
    }));
    assert.deepStrictEqual(v.errors, []);
});

test('maxItems rules mirror the collection ops', () => {
    const bad = validateDefinition(defWith({ id: 's1', type: 'set', arrayRef: LIST, maxItems: 0, fields: {} }));
    assert.ok(codes(bad.errors).includes('set.maxItems_invalid'));
    const high = validateDefinition(defWith({ id: 's1', type: 'set', arrayRef: LIST, maxItems: 99999, fields: {} }));
    assert.ok(codes(high.warnings).includes('set.maxItems_exceeds_cap'));
});

test('operations: shape, without-list, too-many', () => {
    const shape = validateDefinition(defWith({ id: 's1', type: 'set', arrayRef: LIST, operations: 'nope' }));
    assert.ok(codes(shape.errors).includes('set.operations_shape'));

    const noList = validateDefinition(defWith({ id: 's1', type: 'set', operations: [{ op: 'rowId', target: 'id' }] }));
    assert.ok(codes(noList.errors).includes('set.operations_without_list'));

    const many = validateDefinition(defWith({
        id: 's1', type: 'set', arrayRef: LIST,
        operations: Array.from({ length: 21 }, () => ({ op: 'rowId', target: 'id' })),
    }));
    assert.ok(codes(many.errors).includes('set.operations_too_many'));
});

test('per-op rules: unknown op, shapes, targets, keys, sort, rowId start', () => {
    const v = validateDefinition(defWith({
        id: 's1', type: 'set', arrayRef: LIST,
        operations: [
            'not-an-object',                                  // op_shape
            { op: 'explode' },                                // op_unknown
            { op: 'rowId', target: '', start: 1.5 },          // target_missing + start_invalid
            { op: 'groupId', target: 'g', keys: [] },         // keys_missing
            { op: 'rename', from: 'a' },                      // rename_incomplete
            { op: 'rename', from: 'a', to: 'a' },             // rename_noop (warning)
            { op: 'keep', keys: null },                       // keys_missing
            { op: 'sort' },                                   // sort_key_missing
            { op: 'sort', key: 'a', direction: 'sideways' },  // sort_direction_invalid
            { op: 'rowId', target: '__proto__' },             // target_reserved
        ],
    }));
    const e = codes(v.errors);
    for (const expected of [
        'set.op_shape', 'set.op_unknown', 'set.op_target_missing', 'set.op_rowid_start_invalid',
        'set.op_keys_missing', 'set.op_rename_incomplete', 'set.op_sort_key_missing',
        'set.op_sort_direction_invalid', 'set.op_target_reserved',
    ]) assert.ok(e.includes(expected), `${expected} missing from ${JSON.stringify(e)}`);
    assert.ok(codes(v.warnings).includes('set.op_rename_noop'));
});

test('half-configured ops are draft-saveable; reserved target is not', () => {
    const draft = validateDefinition(defWith({
        id: 's1', type: 'set', arrayRef: LIST,
        operations: [{ op: 'groupId', target: '', keys: [] }, { op: 'sort' }, { op: 'rename' }],
    }), { stage: 'draft' });
    assert.deepStrictEqual(codes(draft.errors), []);

    const reserved = validateDefinition(defWith({
        id: 's1', type: 'set', arrayRef: LIST,
        operations: [{ op: 'rowId', target: 'constructor' }],
    }), { stage: 'draft' });
    assert.ok(codes(reserved.errors).includes('set.op_target_reserved'));
});

test('set.field_expr_parse fires in BOTH modes and is draft-saveable', () => {
    for (const extra of [{}, { arrayRef: LIST }]) {
        const def = defWith({ id: 's1', type: 'set', ...extra, fields: { broken: { kind: 'expr', value: 'item.amount >' } } });
        assert.ok(codes(validateDefinition(def).errors).includes('set.field_expr_parse'));
        const draft = validateDefinition(def, { stage: 'draft' });
        assert.ok(!codes(draft.errors).includes('set.field_expr_parse'));
        assert.ok(codes(draft.warnings).includes('set.field_expr_parse'));
    }
});

test('the list source itself goes through ref checks (unknown step id errors)', () => {
    const v = validateDefinition(defWith({ id: 's1', type: 'set', arrayRef: 'steps.ghost.output.items', fields: {} }));
    assert.ok(codes(v.errors).includes('ref.unknown_step'));
});

test('legacy plain set steps still validate exactly clean (regression)', () => {
    const v = validateDefinition(defWith({
        id: 's1', type: 'set',
        fields: { a: { kind: 'literal', value: 1 }, b: { kind: 'ref', path: 'steps.g.output.results' } },
    }));
    assert.deepStrictEqual(v.errors, []);
    assert.deepStrictEqual(v.warnings.filter(w => w.code.startsWith('set.')), []);
});
