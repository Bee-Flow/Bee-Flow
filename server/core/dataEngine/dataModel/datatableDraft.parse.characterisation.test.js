// @typecheck
'use strict';

/**
 * Characterisation (golden) test for parseDatatableDraft: the whole draft
 * (name, key, description, fields, notes, changes) or null, for model answers
 * that reach every branch that changes a column, a note or a change line:
 * junk and nameless columns, the column cap, a revise key that is unknown or
 * repeated, a retype with the guard on and off, options that only grow, a
 * select that ends without options, required and unique carried over, left-out
 * columns put back after their nearest kept neighbour or at the front, the
 * normaliser's refusal, and the name / description / notes fallbacks.
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test core/dataEngine/dataModel/datatableDraft.parse.characterisation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseDatatableDraft } = require('./datatableDraft');

const GOLDEN = path.join(__dirname, 'datatableDraft.parse.characterisation.golden.json');

const CURRENT = {
    name: 'Customers', description: 'Customers we onboarded.', rowCount: 12,
    fields: [
        { id: 'fld_a1', key: 'email', name: 'E-mail', type: 'text', required: true, unique: true },
        { id: 'fld_a2', key: 'stage', name: 'Stage', type: 'select', options: ['lead', { value: 'won' }, { label: 'lost' }, 7] },
        { id: 'fld_a3', key: 'notes', name: 'Notes', type: 'richtext' },
        { id: 'fld_a4', key: 'tags', type: 'multiselect', options: ['a'] },
        { id: 'fld_a5', key: 'score', name: 'Score', type: 'number' },
    ],
};
const revise = { mode: 'revise', current: CURRENT };
const off = { ...revise, allowDestructive: true };
const many = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => ({ name: `Col ${i}`, type: 'text' }));

/** @type {Record<string, [unknown, unknown?]>} */
const CASES = {
    notAnObject: ['nope'],
    noFields: [{ name: 'x' }],
    junkColumns: [{ fields: [null, 'x', { type: 'text' }, { name: '   ' }, { name: 'Real', type: 'bogus' }] }],
    createIgnoresKeys: [{ name: ' Orders ', description: 'One row per order.', notes: ' Assumed EUR. ', fields: [{ key: 'email', name: 'E-mail', type: 'text' }, { key: 'x', name: 'created_at', type: 'date' }, { name: '__secret', type: 'text' }] }, { current: CURRENT }],
    cap: [{ fields: many(105) }],
    capOne: [{ fields: many(101) }],
    selectOptions: [{ fields: [
        { name: 'Status', type: 'select', options: ['a', ' a ', { label: 'b' }, { value: 'c' }, { label: 7 }, null, 'x'.repeat(200)] },
        { name: 'Many', type: 'multiselect', options: Array.from({ length: 300 }, (_, i) => `o${i}`) },
        { name: 'Empty', type: 'select', options: 'nope' },
        { name: 'Empty multi', type: 'multiselect' },
        { name: 'Text with options', type: 'text', options: ['ignored'] },
    ] }],
    reviseKeepsAll: [{ fields: CURRENT.fields.map(f => ({ key: f.key, name: f.name || f.key, type: f.type, options: ['new'] })) }, revise],
    reviseUnknownAndRepeatedKey: [{ fields: [{ key: 'email', name: 'Mail', type: 'text' }, { key: 'email', name: 'Mail two', type: 'text' }, { key: 'nope', name: 'Stage', type: 'text' }] }, revise],
    reviseRetypeGuardOn: [{ fields: [{ key: 'email', name: 'E-mail', type: 'number' }, { key: 'stage', name: 'Stage', type: 'text' }, { key: 'notes', name: 'Notes', type: 'select', options: ['x'] }] }, revise],
    reviseRetypeGuardOff: [{ fields: [{ key: 'email', name: 'E-mail', type: 'number' }, { key: 'stage', name: 'Stage', type: 'multiselect', options: ['m'] }, { key: 'tags', name: 'Tags', type: 'multiselect', options: ['b'] }] }, off],
    reviseRequiredGuardOff: [{ fields: [{ key: 'email', name: 'E-mail', type: 'text' }, { key: 'score', name: 'Score', type: 'number', required: true }] }, off],
    reviseLeftOutPlacement: [{ fields: [{ key: 'score', name: 'Score', type: 'number' }, { name: 'Phone', type: 'text' }, { key: 'stage', name: 'Stage', type: 'select' }] }, revise],
    reviseAllLeftOut: [{ fields: [{ name: 'Phone', type: 'text' }] }, revise],
    reviseOneLeftOut: [{ fields: CURRENT.fields.slice(1).map(f => ({ key: f.key, name: f.name || f.key, type: f.type })) }, revise],
    reviseEmptyDraftRestores: [{ fields: [] }, revise],
    reviseEmptyDraftGuardOff: [{ fields: [] }, off],
    reviseNoCurrent: [{ fields: [{ key: 'email', name: 'E-mail', type: 'text' }] }, { mode: 'revise', current: null }],
    reviseCurrentJunk: [{ fields: [{ key: 'email', name: 'E-mail', type: 'text' }] }, { mode: 'revise', current: { name: 7, description: 8, fields: [null, { key: 3 }, { key: 'email', type: 'text' }] } }],
    namesAndDescription: [{ name: '  ', description: '', fields: [{ name: 'A', type: 'text' }] }, revise],
    noNameAnywhere: [{ name: 5, description: 6, fields: [{ name: 'A', type: 'text' }] }, { mode: 'create', current: { name: '', description: 3 } }],
    longNotes: [{ notes: 'n'.repeat(2000), fields: [...many(101)] }],
    duplicateNameKeys: [{ fields: [{ name: 'Naam', type: 'text' }, { name: 'naam', type: 'text' }, { name: 'NAAM!', type: 'text' }] }],
    nonLatinName: [{ fields: [{ name: '名前', type: 'text' }, { name: '123', type: 'number' }] }],
};

test('parseDatatableDraft: every case matches the golden result', () => {
    const actual = Object.fromEntries(Object.entries(CASES).map(([name, [structured, opts]]) => [
        name, parseDatatableDraft(/** @type {any} */ (structured), /** @type {any} */ (opts)),
    ]));
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    assert.deepEqual(Object.keys(actual), Object.keys(golden));
    for (const name of Object.keys(CASES)) assert.deepEqual(actual[name], golden[name], name);
});
