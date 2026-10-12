/**
 * Validator rules for the `datatable` step.
 *
 * Two of these are safety rather than tidiness:
 *   - `update_rows` / `delete_rows` refuse to save without a condition, because
 *     the unbounded version silently touches every row;
 *   - a free-text `sql` key is rejected by name and is NEVER downgraded at
 *     draft stage, because the whole design rests on the query compiler being
 *     the only producer of SQL.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { validateDefinition } = require('./validate');
const { VALID_STEP_TYPES, ON_ERROR_SOURCE_TYPES, BRANCHER_TYPES, NESTED_FORBIDDEN_RULES } = require('./validate/constants');

const TRIGGER = { id: 'trg', kind: 'manual' };

function def(step, extra = {}) {
    return {
        trigger: TRIGGER,
        steps: [{ id: 's1', ...step }],
        edges: [{ from: 'trg', to: 's1' }],
        ...extra,
    };
}

function codesOf(definition, stage) {
    const res = validateDefinition(definition, stage ? { stage } : undefined);
    const all = [...(res.errors || []), ...(res.warnings || [])];
    return all.map(e => e.code);
}
function errorCodes(definition, stage) {
    const res = validateDefinition(definition, stage ? { stage } : undefined);
    return (res.errors || []).map(e => e.code);
}

const OK = {
    type: 'datatable', op: 'find_rows', datatableId: 'tbl_aaaaaa', label: 'Find customers',
};

// ── vocabulary ──────────────────────────────────────────────────────────────

test('datatable is a known step type — no step.unknown_type', () => {
    assert.ok(VALID_STEP_TYPES.has('datatable'));
    assert.ok(!codesOf(def(OK)).includes('step.unknown_type'));
});

test('it can fail, is not a brancher, and does not pause', () => {
    assert.ok(ON_ERROR_SOURCE_TYPES.has('datatable'),
        'a missing table, a revoked grant and a quota are all things an author may route around');
    assert.ok(!BRANCHER_TYPES.has('datatable'), 'it has one continuation, not labelled branches');
    assert.ok(!NESTED_FORBIDDEN_RULES.has('datatable'));
});

test('an on_error edge out of a datatable step is legal', () => {
    const d = def(OK);
    d.steps.push({ id: 's2', type: 'set', fields: { note: { kind: 'literal', value: 'x' } } });
    d.edges.push({ from: 's1', to: 's2', label: 'on_error' });
    assert.ok(!codesOf(d).some(c => /on_error/.test(c)), 'an error branch must be accepted here');
});

// ── required fields ─────────────────────────────────────────────────────────

test('a step with no table is incomplete', () => {
    assert.ok(errorCodes(def({ type: 'datatable', op: 'find_rows' })).includes('datatable.table_missing'));
});

test('a step with no operation is incomplete', () => {
    assert.ok(errorCodes(def({ type: 'datatable', datatableId: 'tbl_a' })).includes('datatable.op_missing'));
});

test('an operation outside the closed vocabulary is refused', () => {
    const codes = errorCodes(def({ ...OK, op: 'truncate_table' }));
    assert.ok(codes.includes('datatable.op_unknown'));
});

test('a write with no values is incomplete', () => {
    for (const op of ['add_row', 'save_row']) {
        const codes = errorCodes(def({ ...OK, op, matchColumn: 'email' }));
        assert.ok(codes.includes('datatable.values_missing'), `${op} must demand values`);
    }
});

test('save_row demands the column that decides insert-vs-update', () => {
    const codes = errorCodes(def({ ...OK, op: 'save_row', values: { name: 'x' } }));
    assert.ok(codes.includes('datatable.match_column_missing'));
});

test('save_row must WRITE the column it matches on, or it only ever appends', () => {
    // A match column the step does not write cannot identify the row it wrote
    // last time, so "add or update" degrades to "always add" — one duplicate
    // per run, and bumpAfterWrite faithfully counts them.
    const codes = errorCodes(def({
        ...OK, op: 'save_row', matchColumn: 'email',
        values: { status: { kind: 'literal', value: 'new' } },
    }));
    assert.ok(codes.includes('datatable.match_column_unmapped'));
});

test('the match column being mapped is enough — any binding kind counts', () => {
    for (const v of [{ kind: 'literal', value: 'a@b.c' }, { kind: 'ref', path: 'trigger.output.email' }, '']) {
        const codes = errorCodes(def({
            ...OK, op: 'save_row', matchColumn: 'email', values: { email: v },
        }));
        assert.ok(!codes.includes('datatable.match_column_unmapped'));
    }
});

test('a delete needs no values — only a condition', () => {
    const codes = errorCodes(def({
        ...OK, op: 'delete_rows', where: [{ field: 'email', op: 'eq', value: 'a@b.c' }],
    }));
    assert.ok(!codes.includes('datatable.values_missing'));
    assert.ok(!codes.includes('datatable.filter_missing'));
});

// ── the unbounded-write refusal ─────────────────────────────────────────────

test('update_rows and delete_rows refuse to save without a condition', () => {
    for (const op of ['update_rows', 'delete_rows']) {
        const codes = errorCodes(def({ ...OK, op, values: { status: 'done' } }));
        assert.ok(codes.includes('datatable.filter_missing'),
            `${op} without a condition would change every row in the table`);
    }
});

test('an empty condition list is not a condition', () => {
    const codes = errorCodes(def({ ...OK, op: 'delete_rows', where: [] }));
    assert.ok(codes.includes('datatable.filter_missing'));
});

test('find_rows and add_row are legitimately unconditional', () => {
    assert.ok(!errorCodes(def(OK)).includes('datatable.filter_missing'));
    assert.ok(!errorCodes(def({ ...OK, op: 'add_row', values: { a: 1 } })).includes('datatable.filter_missing'));
});

// ── conditions ──────────────────────────────────────────────────────────────

test('a condition needs both a column and a test', () => {
    const codes = errorCodes(def({ ...OK, where: [{ value: 'x' }] }));
    assert.ok(codes.includes('datatable.where_field_missing'));
    assert.ok(codes.includes('datatable.where_op_missing'));
});

test('conditions must be a list, not an object', () => {
    assert.ok(errorCodes(def({ ...OK, where: { email: 'a' } })).includes('datatable.where_invalid'));
});

test('a test the query compiler has never heard of is refused at save time', () => {
    // Only PRESENCE was checked, so `op: 'like'` saved clean and surfaced at
    // run time as a raw `unknown filter op` string from the compiler.
    const codes = errorCodes(def({ ...OK, where: [{ field: 'email', op: 'like', value: 'a' }] }));
    assert.ok(codes.includes('datatable.where_op_unknown'));
    // …and it is NOT a "still typing" problem, so it blocks at draft too.
    const draft = validateDefinition(def({ ...OK, where: [{ field: 'email', op: 'like', value: 'a' }] }), { stage: 'draft' });
    assert.ok((draft.errors || []).map(e => e.code).includes('datatable.where_op_unknown'));
});

test('every op the picker offers is accepted', () => {
    // Read off the compiler's own list rather than restated: a hand-copied copy
    // here is exactly what drifts into telling the author their step is fine
    // right up to the point the compiler throws at run time.
    const { FILTER_OPS } = require('../core/dataEngine/dataModel/vocabulary');
    assert.ok(FILTER_OPS.includes('notContains') && FILTER_OPS.includes('endsWith') && FILTER_OPS.includes('notIn'),
        'the negations exist — writing the inverse as a second step is what they replace');
    for (const op of FILTER_OPS) {
        const codes = errorCodes(def({ ...OK, where: [{ field: 'email', op, value: 'a' }] }));
        assert.ok(!codes.includes('datatable.where_op_unknown'), `${op} must be accepted`);
    }
});

// ── count_rows, the combinator, the sort and the cursor ─────────────────────

test('count_rows needs neither values nor a condition — it only counts', () => {
    const codes = errorCodes(def({ ...OK, op: 'count_rows' })).filter(c => c.startsWith('datatable.'));
    assert.deepStrictEqual(codes, []);
});

test('a combinator outside {all, any} is refused, never defaulted', () => {
    assert.ok(errorCodes(def({ ...OK, match: 'either' })).includes('datatable.match_unknown'));
    for (const match of ['all', 'any']) {
        assert.ok(!errorCodes(def({ ...OK, match })).includes('datatable.match_unknown'));
    }
});

test('"any" on a destructive op warns — one broad condition then decides the write', () => {
    const codes = codesOf(def({
        ...OK, op: 'delete_rows', match: 'any',
        where: [
            { field: 'status', op: 'eq', value: 'new' },
            { field: 'email', op: 'contains', value: '@' },
        ],
    }));
    assert.ok(codes.includes('datatable.match_any_on_write'));
    // …and it is a warning, not a refusal: the union IS sometimes what the
    // author means.
    assert.ok(!errorCodes(def({
        ...OK, op: 'delete_rows', match: 'any',
        where: [{ field: 'status', op: 'eq', value: 'new' }],
    })).includes('datatable.match_any_on_write'));
});

test('a sort is validated, and a second sort column is reported as ignored', () => {
    assert.ok(errorCodes(def({ ...OK, sort: { field: 'email' } })).includes('datatable.sort_invalid'));
    assert.ok(errorCodes(def({ ...OK, sort: [{ dir: 'asc' }] })).includes('datatable.sort_field_missing'));
    assert.ok(errorCodes(def({ ...OK, sort: [{ field: 'email', dir: 'sideways' }] })).includes('datatable.sort_dir_unknown'));
    // compileRecordList honours sort[0] ONLY, so a second entry reads as
    // "sorted by two columns" in the editor and is not.
    assert.ok(codesOf(def({ ...OK, sort: [{ field: 'email' }, { field: 'status' }] }))
        .includes('datatable.sort_extra_ignored'));
    assert.deepStrictEqual(
        errorCodes(def({ ...OK, sort: [{ field: 'email', dir: 'asc' }] })).filter(c => c.startsWith('datatable.')),
        []);
});

test('a cursor binding is ref-checked like every other binding', () => {
    // `{{steps.page1.output.nextCursor}}` is how a loop walks a table bigger
    // than one page; a typo there silently restarts at page 1 every iteration.
    const codes = errorCodes(def({
        ...OK, cursor: { kind: 'ref', path: 'steps.does_not_exist.output.nextCursor' },
    }));
    assert.ok(codes.includes('ref.unknown_step'));
});

test('binding to a find_rows step\'s `count` is warned about, and still works', () => {
    // `count` was rows.length CLAMPED BY THE PAGE SIZE, so `count > 100` after
    // a default page of 50 could never fire. It is `returned` now, with `count`
    // kept as an alias for one release.
    const d = {
        trigger: TRIGGER,
        steps: [
            { id: 's1', ...OK, op: 'find_rows' },
            { id: 's2', type: 'set', fields: { n: { kind: 'ref', path: 'steps.s1.output.count' } } },
        ],
        edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 's2' }],
    };
    const res = validateDefinition(d);
    assert.ok((res.warnings || []).map(w => w.code).includes('datatable.count_deprecated'));
    assert.deepStrictEqual((res.errors || []).map(e => e.code), [], 'the alias still works — this is a soft break');
    // `returned` is the new name and carries no notice.
    d.steps[1].fields.n.path = 'steps.s1.output.returned';
    assert.ok(!(validateDefinition(d).warnings || []).map(w => w.code).includes('datatable.count_deprecated'));
});

// ── the bindings the step actually carries ──────────────────────────────────

test('a values binding pointing at a step that does not exist is an error', () => {
    // `values` and `where[].value` are not `inputs`, so the ref-scoping pass
    // never saw them: a renamed upstream step wrote NULL into the column at run
    // time and nothing said so at save time.
    const codes = errorCodes(def({
        ...OK, op: 'add_row',
        values: { email: { kind: 'ref', path: 'steps.gone.output.email' } },
    }));
    assert.ok(codes.includes('ref.unknown_step'));
});

test('a where value pointing at a step that does not exist is an error too', () => {
    const codes = errorCodes(def({
        ...OK, op: 'find_rows',
        where: [{ field: 'email', op: 'eq', value: { kind: 'ref', path: 'steps.gone.output.email' } }],
    }));
    assert.ok(codes.includes('ref.unknown_step'));
});

test('a literal carrying {{…}} in values is linted — it ships the braces verbatim', () => {
    const codes = codesOf(def({
        ...OK, op: 'add_row',
        values: { email: { kind: 'literal', value: '{{trigger.output.email}}' } },
    }));
    assert.ok(codes.includes('literal.uninterpolated'),
        'only kind:template interpolates, so this writes the braces into the row');
});

test('there is a ceiling on conditions', () => {
    const where = Array.from({ length: 25 }, (_, i) => ({ field: 'f' + i, op: 'eq', value: 1 }));
    assert.ok(errorCodes(def({ ...OK, where })).includes('datatable.where_too_many'));
});

test('the row limit is bounded', () => {
    assert.ok(errorCodes(def({ ...OK, limit: 0 })).includes('datatable.limit_range'));
    assert.ok(errorCodes(def({ ...OK, limit: 5000 })).includes('datatable.limit_range'));
    assert.ok(!errorCodes(def({ ...OK, limit: 100 })).includes('datatable.limit_range'));
});

// ── no SQL, ever ────────────────────────────────────────────────────────────

test('a free-text sql field is rejected by name', () => {
    for (const key of ['sql', 'query', 'rawSql', 'rawQuery']) {
        const codes = errorCodes(def({ ...OK, [key]: 'SELECT 1' }));
        assert.ok(codes.includes('datatable.sql_field_forbidden'), `${key} must be refused`);
    }
});

test('the sql refusal is NOT downgraded at draft stage', () => {
    // Every other datatable code softens while the author is still typing.
    // This one means the definition is wrong, not unfinished.
    const d = def({ ...OK, sql: 'DROP TABLE customers' });
    const draft = validateDefinition(d, { stage: 'draft' });
    const codes = (draft.errors || []).map(e => e.code);
    assert.ok(codes.includes('datatable.sql_field_forbidden'),
        'a draft may be incomplete; it may not be dangerous');
});

// ── a table that was only proposed ──────────────────────────────────────────

test('a pending table id gives datatable.table_pending with the ref, and blocks even at draft stage', () => {
    const d = def({ ...OK, datatableId: 'pending:1', datatableKey: 'facturen' });
    const res = validateDefinition(d, { stage: 'draft' });
    const hit = (res.errors || []).find(e => e.code === 'datatable.table_pending');
    assert.ok(hit, 'a never-created table must not pass a save');
    assert.strictEqual(hit.ref, 'pending:1');
    assert.match(hit.path, /datatableId$/);
    assert.ok(errorCodes(d).includes('datatable.table_pending'));
});

test('a real table id does not give datatable.table_pending', () => {
    assert.ok(!errorCodes(def(OK)).includes('datatable.table_pending'));
    assert.ok(!errorCodes(def({ ...OK, datatableId: 'pending:' })).includes('datatable.table_pending'), 'only the pending:<n> grammar counts');
});

// ── draft-stage downgrading ─────────────────────────────────────────────────

test('the "not finished yet" codes downgrade at draft stage', () => {
    const d = def({ type: 'datatable' });   // no table, no op
    const draft = validateDefinition(d, { stage: 'draft' });
    const draftErrors = (draft.errors || []).map(e => e.code);
    for (const code of ['datatable.table_missing', 'datatable.op_missing']) {
        assert.ok(!draftErrors.includes(code),
            `${code} must not 400 the canvas autosave mid-keystroke`);
    }
    // …and still block at the activate stage
    const activate = validateDefinition(d);
    const codes = (activate.errors || []).map(e => e.code);
    assert.ok(codes.includes('datatable.table_missing'));
});

// ── a well-formed step is clean ─────────────────────────────────────────────

test('a fully-configured step of each operation validates clean', () => {
    const cases = [
        { ...OK, op: 'find_rows', limit: 25 },
        { ...OK, op: 'add_row', values: { email: { kind: 'literal', value: 'a@b.c' } } },
        { ...OK, op: 'save_row', matchColumn: 'email', values: { email: { kind: 'literal', value: 'a@b.c' } } },
        { ...OK, op: 'update_rows', where: [{ field: 'email', op: 'eq', value: 'a@b.c' }], values: { status: { kind: 'literal', value: 'done' } } },
        { ...OK, op: 'delete_rows', where: [{ field: 'email', op: 'eq', value: 'a@b.c' }] },
        { ...OK, op: 'count_rows', where: [{ field: 'status', op: 'eq', value: 'new' }], match: 'all' },
        { ...OK, op: 'find_rows', sort: [{ field: 'created_at', dir: 'desc' }], cursor: '' },
    ];
    for (const step of cases) {
        const codes = errorCodes(def(step)).filter(c => c.startsWith('datatable.'));
        assert.deepStrictEqual(codes, [], `${step.op} should be clean, got ${codes.join(', ')}`);
    }
});
