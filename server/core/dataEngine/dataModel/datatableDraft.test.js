'use strict';

/**
 * dataModel/datatableDraft — the clamps between a model's answer and a
 * table's columns. What would cost someone their rows if it slipped:
 *
 *   - in REVISE mode a returned key is trusted only when the table already
 *     has it; a model that "renames" a column by returning a fresh key
 *     gets the fresh key ONLY for a new column — the old one is not dropped;
 *   - with the guard on (allowDestructive false, the default) a column the
 *     model left out comes back at its place, a retyped column keeps its
 *     type, select options only ever grow — and the notes say so;
 *   - with the guard off, removed and retyped columns pass through and are
 *     REPORTED in `changes` for the designer's own confirmation to price;
 *   - system column names, reserved prefixes, unknown types and empty
 *     selects are clamped; the whole list runs through normalizeFields.
 *
 * Run: cd server && node --test --test-force-exit core/dataEngine/dataModel/datatableDraft.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { parseDatatableDraft, buildDraftMessages, keyFromName, DRAFT_TOOL } = require('./datatableDraft');
const { DATATABLE_FIELD_TYPES } = require('./datatableFields');

const CURRENT = {
    name: 'Customers', description: 'Customers we onboarded.', rowCount: 412,
    fields: [
        { id: 'fld_a1', key: 'email', name: 'E-mail', type: 'text', required: true },
        { id: 'fld_a2', key: 'stage', name: 'Stage', type: 'select', options: ['lead', 'won'] },
        { id: 'fld_a3', key: 'notes', name: 'Notes', type: 'richtext' },
    ],
};

test('the tool speaks the datatable vocabulary, without relation and computed', () => {
    const types = DRAFT_TOOL.function.parameters.properties.fields.items.properties.type.enum;
    assert.deepStrictEqual(types, DATATABLE_FIELD_TYPES);
    assert.ok(!types.includes('relation') && !types.includes('computed'));
});

test('create: keys come from names, never from the model; system names and unknown types are clamped', () => {
    const out = parseDatatableDraft({
        name: 'Invoices',
        description: 'One row per supplier invoice, kept for the audit.',
        fields: [
            { key: 'DROP TABLE', name: 'Supplier', type: 'text', required: true },
            { name: 'Amount excl. VAT', type: 'number' },
            { name: 'id', type: 'text' },
            { name: 'Status', type: 'select', options: ['New', 'New', 'Approved'] },
            { name: 'Department', type: 'select', options: [] },
            { name: 'Weird', type: 'relation' },
            { name: 'Supplier', type: 'text' },
        ],
    }, { mode: 'create' });
    assert.ok(out);
    assert.deepStrictEqual(out.fields.map(f => f.key), ['supplier', 'amount_excl_vat', 'c_id', 'status', 'department', 'weird', 'supplier_2']);
    assert.deepStrictEqual(out.fields[3].options, ['New', 'Approved']);
    assert.strictEqual(out.fields[4].type, 'text');
    assert.strictEqual(out.fields[5].type, 'text');
    assert.strictEqual(out.fields[0].required, true);
    assert.strictEqual(out.key, 'invoices');
    assert.deepStrictEqual(out.changes, { added: out.fields.map(f => f.key), renamed: [], retyped: [], removed: [] });
});

test('revise, guard ON: a kept key survives a rename; a fresh key never replaces an old column; the left-out column comes back at its place; a retype is refused', () => {
    const out = parseDatatableDraft({
        fields: [
            { key: 'email', name: 'E-mail address', type: 'text' },
            { key: 'stage_v2', name: 'Stage', type: 'text' },
            { name: 'Phone', type: 'text' },
            // notes left out on purpose
        ],
    }, { mode: 'revise', current: CURRENT });
    assert.ok(out);
    // `stage_v2` is not a key the table has, so the column is keyed from its
    // name — which IS the existing `stage`: the "renamed key" lands back on
    // the real column, whose type the guard then keeps. `notes` was left
    // out and comes back at its place, after `stage`.
    assert.deepStrictEqual(out.fields.map(f => f.key), ['email', 'stage', 'notes', 'phone']);
    assert.strictEqual(out.fields[0].name, 'E-mail address');
    assert.strictEqual(out.fields[0].required, true, 'required is not dropped by a guard-on revise');
    assert.strictEqual(out.fields[1].type, 'select');
    assert.deepStrictEqual(out.fields[1].options, ['lead', 'won']);
    assert.strictEqual(out.fields[2].type, 'richtext');
    assert.deepStrictEqual(out.changes.removed, []);
    assert.deepStrictEqual(out.changes.retyped, []);
    assert.deepStrictEqual(out.changes.renamed, [{ key: 'email', from: 'E-mail', to: 'E-mail address' }]);
    assert.deepStrictEqual(out.changes.added, ['phone']);
    assert.match(out.notes, /Kept the type of “Stage” \(select\)/);
    assert.match(out.notes, /Kept a column the draft left out \(Notes\)/);
});

test('revise, guard ON: a retype keeps the type and says so; select options only grow', () => {
    const out = parseDatatableDraft({
        fields: [
            { key: 'email', name: 'E-mail', type: 'number' },
            { key: 'stage', name: 'Stage', type: 'select', options: ['won'] },
            { key: 'notes', name: 'Notes', type: 'richtext' },
        ],
    }, { mode: 'revise', current: CURRENT });
    assert.strictEqual(out.fields[0].type, 'text');
    assert.match(out.notes, /Kept the type of “E-mail” \(text\)/);
    assert.deepStrictEqual(out.fields[1].options, ['lead', 'won'], 'an option a row may hold is never dropped');
    assert.deepStrictEqual(out.changes.retyped, []);
});

test('revise, guard OFF: removed and retyped pass through and are reported for the designer’s confirmation', () => {
    const out = parseDatatableDraft({
        fields: [
            { key: 'email', name: 'E-mail', type: 'text' },
            { key: 'stage', name: 'Stage', type: 'text' },
        ],
    }, { mode: 'revise', current: CURRENT, allowDestructive: true });
    assert.deepStrictEqual(out.fields.map(f => f.key), ['email', 'stage']);
    assert.strictEqual(out.fields[1].type, 'text');
    assert.deepStrictEqual(out.changes.removed, ['notes']);
    assert.deepStrictEqual(out.changes.retyped, [{ key: 'stage', from: 'select', to: 'text' }]);
    assert.strictEqual(out.notes, null);
});

test('nothing usable, or a list the normaliser refuses, is null', () => {
    assert.strictEqual(parseDatatableDraft(null), null);
    assert.strictEqual(parseDatatableDraft({ name: 'x', fields: [] }), null);
    assert.strictEqual(parseDatatableDraft({ fields: [{ type: 'text' }] }), null);
});

test('keyFromName is the client’s rule', () => {
    assert.strictEqual(keyFromName('Bedrag excl. BTW'), 'bedrag_excl_btw');
    assert.strictEqual(keyFromName('123 abc'), 'c_123_abc');
    assert.strictEqual(keyFromName('Ärger über Café'), 'arger_uber_cafe');
});

test('messages: the brief is fenced; the current table is quoted by key with the guard stated', () => {
    const create = buildDraftMessages({ mode: 'create', brief: 'Track supplier invoices\r\nwith amount and status' });
    assert.match(create[1].content, /<brief>\nTrack supplier invoices\nwith amount and status\n<\/brief>/);
    assert.match(create[0].content, /draft_datatable/);
    const on = buildDraftMessages({ mode: 'revise', note: 'add a phone', current: CURRENT });
    assert.match(on[0].content, /Never remove or retype a column/);
    assert.match(on[1].content, /\[key: stage\] Stage \(select\)/);
    assert.match(on[1].content, /options: lead \| won/);
    assert.match(on[1].content, /Rows: 412/);
    const off = buildDraftMessages({ mode: 'revise', note: 'drop notes', current: CURRENT, allowDestructive: true });
    assert.match(off[0].content, /only when the request asks for it/);
});
