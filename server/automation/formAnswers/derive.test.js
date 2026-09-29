'use strict';

/**
 * The pure half of form answers: columns from a definition, rows from a
 * submission. Every rule the header of derive.js states is pinned here.
 *
 * Run: cd server && node --test automation/formAnswers/derive.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const derive = require('./derive');
const { DATA_LIMITS } = require('../../core/dataEngine/dataModel/vocabulary');

function def(fields, { collect = true, pages = [] } = {}) {
    return {
        trigger: { kind: 'form', form: { collect, title: 'Intake', fields } },
        steps: pages.map(p => ({ id: p.id, type: 'form_page', mode: p.mode || 'input', form: { fields: p.fields } })),
    };
}
const Q = (name, type, label, extra = {}) => ({ name, type, label, ...extra });

test('collectEnabled reads the trigger form\'s collect flag and nothing else', () => {
    assert.equal(derive.collectEnabled(def([], { collect: true })), true);
    assert.equal(derive.collectEnabled(def([], { collect: false })), false);
    assert.equal(derive.collectEnabled({ trigger: { kind: 'form', form: {} } }), false);
    assert.equal(derive.collectEnabled({ trigger: { kind: 'schedule', form: { collect: true } } }), false);
    assert.equal(derive.collectEnabled(null), false);
});

test('the two fixed columns come first, then every input question in form order, display fields skipped', () => {
    const d = def([Q('email', 'email', 'Your e-mail', { required: true }), Q('dl', 'download', 'Report'), Q('dept', 'select', 'Department', { options: ['sales', 'support'] })]);
    const r = derive.deriveAnswerColumns(d, null);
    assert.deepEqual(r.fields.map(f => f.key), ['run_id', 'completed_at', 'email', 'dept']);
    assert.deepEqual(r.fields.map(f => f.type), ['text', 'datetime', 'text', 'select']);
    assert.equal(r.fields[0].id, 'fld_faxrunid');
    assert.deepEqual(r.fields[3].options, ['sales', 'support']);
    const email = r.columnMap[r.fields[2].id];
    assert.equal(email.formName, 'email');
    assert.equal(email.name, 'Your e-mail');
    assert.equal(email.required, true);
    assert.equal(email.retired, false);
    assert.match(r.fields[2].id, /^fld_fa[0-9a-f]{10}txt$/);
    assert.deepEqual(r.warnings, []);
});

test('identity is (page, name): a relabel keeps id and key, a page reuses a name without collision', () => {
    const a = derive.deriveAnswerColumns(def([Q('name', 'text', 'Name')], { pages: [{ id: 'p2', fields: [Q('name', 'text', 'Contact name')] }] }), null);
    assert.deepEqual(a.fields.map(f => f.key), ['run_id', 'completed_at', 'name', 'name_2']);
    const b = derive.deriveAnswerColumns(def([Q('name', 'text', 'Full name')], { pages: [{ id: 'p2', fields: [Q('name', 'text', 'Contact name')] }] }), a.columnMap);
    assert.deepEqual(b.fields.map(f => f.id), a.fields.map(f => f.id), 'same ids');
    assert.deepEqual(b.fields.map(f => f.key), a.fields.map(f => f.key), 'same keys');
    assert.equal(b.fields[2].name, 'Full name');
    assert.notEqual(a.fingerprint, b.fingerprint, 'a relabel is a change the save path must store');
});

test('a key is minted once: reordering questions never moves an answer under another key', () => {
    const a = derive.deriveAnswerColumns(def([Q('a', 'text', 'A'), Q('b', 'text', 'B')]), null);
    const b = derive.deriveAnswerColumns(def([Q('b', 'text', 'B'), Q('a', 'text', 'A')]), a.columnMap);
    assert.deepEqual(b.fields.slice(2).map(f => f.key), ['b', 'a']);
    assert.deepEqual([...b.fields.slice(2)].sort((x, y) => x.key.localeCompare(y.key)).map(f => f.id),
        [...a.fields.slice(2)].sort((x, y) => x.key.localeCompare(y.key)).map(f => f.id));
});

test('a removed question is retired, never dropped; re-added with the same name and type it comes back', () => {
    const a = derive.deriveAnswerColumns(def([Q('a', 'text', 'A'), Q('b', 'number', 'B')]), null);
    const gone = derive.deriveAnswerColumns(def([Q('a', 'text', 'A')]), a.columnMap);
    assert.deepEqual(gone.fields.map(f => f.key), ['run_id', 'completed_at', 'a', 'b'], 'the column stays, last');
    const bId = a.fields[3].id;
    assert.equal(gone.columnMap[bId].retired, true);
    assert.equal(gone.columnMap[bId].key, 'b');
    const back = derive.deriveAnswerColumns(def([Q('a', 'text', 'A'), Q('b', 'number', 'B again')]), gone.columnMap);
    assert.equal(back.columnMap[bId].retired, false);
    assert.equal(back.columnMap[bId].name, 'B again');
    assert.deepEqual(back.fields.map(f => f.key), ['run_id', 'completed_at', 'a', 'b']);
});

test('a retype is a new column beside the retired one — the old id and its answers are kept', () => {
    const a = derive.deriveAnswerColumns(def([Q('age', 'text', 'Age')]), null);
    const b = derive.deriveAnswerColumns(def([Q('age', 'number', 'Age')]), a.columnMap);
    assert.deepEqual(b.fields.map(f => f.key), ['run_id', 'completed_at', 'age_2', 'age']);
    const oldId = a.fields[2].id;
    assert.equal(b.columnMap[oldId].retired, true);
    assert.equal(b.fields[2].type, 'number');
    assert.match(b.fields[2].id, /num$/);
    assert.notEqual(b.fields[2].id, oldId);
    // and text/textarea/email share a column type, so switching between them is NOT a retype
    const c = derive.deriveAnswerColumns(def([Q('note', 'text', 'Note')]), null);
    const d = derive.deriveAnswerColumns(def([Q('note', 'textarea', 'Note')]), c.columnMap);
    assert.equal(d.fields[2].id, c.fields[2].id);
    assert.equal(d.columnMap[c.fields[2].id].formType, 'textarea');
});

test('select options are the option VALUES, unioned with what the column already had, never shrunk', () => {
    const a = derive.deriveAnswerColumns(def([Q('dept', 'select', 'Dept', { options: [{ value: 'sales', label: 'Sales' }, 'support'] })]), null);
    assert.deepEqual(a.fields[2].options, ['sales', 'support']);
    const b = derive.deriveAnswerColumns(def([Q('dept', 'select', 'Dept', { options: ['hr', 'sales'] })]), a.columnMap);
    assert.deepEqual(b.fields[2].options, ['sales', 'support', 'hr']);
});

test('the column cap leaves the fixed columns room and reports what got no column', () => {
    const many = Array.from({ length: DATA_LIMITS.MAX_FIELDS_PER_TABLE + 5 }, (_, i) => Q(`q${i}`, 'text', `Q ${i}`));
    // the form contract caps a form at 40 fields, so spread them over pages
    const pages = [];
    for (let i = 0; i < many.length; i += 30) pages.push({ id: `p${i}`, fields: many.slice(i, i + 30) });
    const r = derive.deriveAnswerColumns(def([], { pages }), null);
    assert.equal(r.fields.length, DATA_LIMITS.MAX_FIELDS_PER_TABLE);
    assert.ok(r.warnings.length >= 5);
    assert.equal(r.warnings[0].code, 'too_many_columns');
});

test('rowValuesFor maps one page of answers: "" → null, checkbox stays boolean, numbers parse, files shed their storage key', () => {
    const d = def([Q('email', 'email', 'E'), Q('dept', 'select', 'D', { options: ['a'] }), Q('ok', 'checkbox', 'Ok'), Q('n', 'number', 'N'), Q('cv', 'file', 'CV')],
        { pages: [{ id: 'p2', fields: [Q('age', 'number', 'Age')] }] });
    const { columnMap } = derive.deriveAnswerColumns(d, null);
    const row = derive.rowValuesFor(columnMap, null, {
        email: '', dept: 'a', ok: 'true', n: '12,5',
        cv: { kind: 'form_upload', fileId: 'f1', filename: 'cv.pdf', mimeType: 'application/pdf', size: '123', storageKey: 'secret', text: 'huge' },
        age: 3,
    });
    assert.deepEqual(row, { email: null, dept: 'a', ok: true, n: 12.5, cv: JSON.stringify({ kind: 'form_upload', fileId: 'f1', filename: 'cv.pdf', mimeType: 'application/pdf', size: 123 }) });
    assert.deepEqual(derive.rowValuesFor(columnMap, 'p2', { age: '7', email: 'x' }), { age: 7 });
    assert.deepEqual(derive.rowValuesFor(columnMap, null, { ok: false, n: 'abc' }), { ok: false, n: null });
    // a retired column is never written
    const gone = derive.deriveAnswerColumns(def([Q('email', 'email', 'E')]), columnMap);
    assert.deepEqual(derive.rowValuesFor(gone.columnMap, null, { email: 'a', dept: 'a' }), { email: 'a' });
});

test('publicSource ships the columns and the link, never the fingerprint', () => {
    const { columnMap, fingerprint } = derive.deriveAnswerColumns(def([Q('a', 'text', 'A')]), null);
    const pub = derive.publicSource({ kind: 'form_answers', automationId: 'auto_1', linked: true, fingerprint, columnMap, lastWriteError: null });
    assert.equal(pub.kind, 'form_answers');
    assert.equal(pub.automationId, 'auto_1');
    assert.equal(pub.linked, true);
    assert.deepEqual(Object.keys(pub.columns[0]).sort(), ['columnType', 'fieldId', 'formName', 'formType', 'key', 'name', 'pageStepId', 'required', 'retired']);
    assert.ok(!JSON.stringify(pub).includes(fingerprint));
    assert.equal(derive.publicSource({ kind: 'nextcloud_table' }), null);
});
