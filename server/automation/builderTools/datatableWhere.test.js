/**
 * A datatable filter the model writes as a column-keyed object is kept, not dropped.
 *
 * The stored form is a LIST of {field, op, value}. The object form —
 * `{status: "open"}` — is what a model writes when the brief says "where status
 * equals open", and it is the shape the `values` map beside it really takes.
 * Anything that was not an array became `[]`: the condition vanished, nothing
 * was reported, and the step answered "replaced" / "already had exactly these
 * values" as though it had worked.
 *
 * That is unfixable from the model's side, and it looped twice on one build.
 * Measured 2026-09-16 on a live "Facturen goedkeuren" automation: three identical
 * builder_replace_step calls, each answered `replaced` with `where: []`, and
 * four identical builder_update_steps answered "Nothing changed". The model was
 * reading the draft, seeing the filter it had just sent was missing, and
 * sending it again.
 *
 * Run: cd server && node --test --test-force-exit automation/builderTools/datatableWhere.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { sanitizeDatatableBindings } = require('./stepBuilders');

const DRAFT = { steps: [] };
const sanitize = (raw) => sanitizeDatatableBindings({ values: {}, ...raw }, DRAFT);

test('the column-keyed object becomes one eq condition per column', () => {
    const out = sanitize({ where: { status: { kind: 'literal', value: 'open' } } });
    assert.strictEqual(out.where.length, 1);
    assert.strictEqual(out.where[0].field, 'status');
    assert.strictEqual(out.where[0].op, 'eq');
    assert.deepStrictEqual(out.where[0].value, { kind: 'literal', value: 'open' });
});

test('a bare value is wrapped the same way the values map wraps one', () => {
    const out = sanitize({ where: { status: 'open' } });
    assert.deepStrictEqual(out.where, [{ field: 'status', op: 'eq', value: { kind: 'literal', value: 'open' } }]);
});

test('an explicit operator is kept', () => {
    const out = sanitize({ where: { totaal: { op: 'gt', value: 1000 } } });
    assert.strictEqual(out.where[0].op, 'gt');
    assert.strictEqual(out.where[0].field, 'totaal');
});

test('several columns become several conditions', () => {
    const out = sanitize({ where: { status: 'open', leverancier: 'Acme' } });
    assert.deepStrictEqual(out.where.map((w) => w.field), ['status', 'leverancier']);
});

test('the model is told about the translation, so it learns the stored shape', () => {
    const out = sanitize({ where: { status: 'open' } });
    const note = (out.repairs || []).find((r) => r.startsWith('where:'));
    assert.ok(note, `no note in ${JSON.stringify(out.repairs)}`);
    assert.match(note, /LIST of \{field, op, value\}/);
});

test('the list form is untouched and reports no translation', () => {
    const out = sanitize({ where: [{ field: 'status', op: 'eq', value: 'open' }] });
    assert.strictEqual(out.where.length, 1);
    assert.strictEqual(out.where[0].field, 'status');
    assert.strictEqual((out.repairs || []).filter((r) => r.startsWith('where:')).length, 0);
});

test('no filter at all is still no filter', () => {
    assert.deepStrictEqual(sanitize({}).where, []);
    assert.deepStrictEqual(sanitize({ where: null }).where, []);
    assert.deepStrictEqual(sanitize({ where: 'nonsense' }).where, []);
});

test('a ref binding in the object form survives as a ref', () => {
    // The shape the second failing build used: filter on the id another step found.
    const out = sanitize({ where: { id: { kind: 'ref', path: 'steps.dt_0a9ab1.output.rows.0.id' } } });
    assert.strictEqual(out.where[0].field, 'id');
    assert.strictEqual(out.where[0].value.kind, 'ref');
    // Stored in the canonical spelling: `.0` is an index, written `[0]`
    // (the old `rows.0.id` did not resolve at run time).
    assert.strictEqual(out.where[0].value.path, 'steps.dt_0a9ab1.output.rows[0].id');
});
