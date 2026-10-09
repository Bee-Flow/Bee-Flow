'use strict';

/**
 * Consent to bind an existing table: what counts as the user naming it, how a
 * question card's answer is read back, and the gate itself.
 */
const test = require('node:test');
const assert = require('node:assert');
const {
    parseAnswersText, answerTextOf, namedTableIds, resolveTableChoice, buildApprovedSet, approvalGateError,
} = require('./datatableApproval');

const CATALOG = [
    { id: 'tbl_fact01', key: 'facturen', name: 'Facturen', canWrite: true },
    { id: 'tbl_klant1', key: 'klant_lijst', name: 'Klanten', canWrite: true },
    { id: 'tbl_ro0001', key: 'facturen_archief', name: 'Facturen archief', canWrite: false },
    { id: 'tbl_cat001', key: 'catalog', name: 'Catalog', canWrite: true },
    { id: 'tbl_ab', key: 'ab', name: 'AB', canWrite: true },
    { id: 'pending:1', key: 'nieuw', name: 'Nieuw', canWrite: true, pending: true },
];

// The literal text agent-hub's answersToText produces (questionAnswers.ts).
const QA = 'Q: Which table should this flow use?\nA: Facturen\n\nQ: Send a mail too?\nA: No';

test('parseAnswersText reads exactly the answersToText format and nothing else', () => {
    assert.deepStrictEqual(parseAnswersText(QA), [
        { prompt: 'Which table should this flow use?', answer: 'Facturen' },
        { prompt: 'Send a mail too?', answer: 'No' },
    ]);
    assert.strictEqual(parseAnswersText('Q: only a question'), null);
    assert.strictEqual(parseAnswersText('Hello Q: x\nA: y'), null);
    assert.strictEqual(parseAnswersText(null), null);
});

test('answerTextOf keeps only the answers of a Q/A message, and the whole text otherwise', () => {
    assert.strictEqual(answerTextOf(QA), 'Facturen\nNo');
    assert.strictEqual(answerTextOf('Use the klanten table'), 'Use the klanten table');
});

test('namedTableIds: name, key with underscores, exact id, diacritics', () => {
    assert.deepStrictEqual(namedTableIds(['schrijf naar de Facturen tabel'], CATALOG), ['tbl_fact01']);
    assert.deepStrictEqual(namedTableIds(['gebruik klant lijst'], CATALOG), ['tbl_klant1'], 'key read with spaces');
    assert.deepStrictEqual(namedTableIds(['use tbl_klant1 please'], CATALOG), ['tbl_klant1']);
    assert.deepStrictEqual(namedTableIds(['FÁCTUREN graag'], CATALOG), ['tbl_fact01'], 'diacritics and case fold');
});

test('namedTableIds: whole phrases only, short names ignored, pending rows skipped', () => {
    assert.deepStrictEqual(namedTableIds(['write to the catalog'], CATALOG), ['tbl_cat001']);
    assert.deepStrictEqual(namedTableIds(['write to the log'], CATALOG), [], '"log" is not inside "catalog"');
    assert.deepStrictEqual(namedTableIds(['AB testing'], CATALOG), [], 'names under 3 characters are ignored');
    assert.deepStrictEqual(namedTableIds(['nieuw'], CATALOG), [], 'a pending row is not an existing table');
    assert.deepStrictEqual(namedTableIds(['facturen archief'], CATALOG), ['tbl_fact01', 'tbl_ro0001'], 'a longer name also contains the shorter one: both are named');
});

const QUESTIONS = [{
    id: 'q1', prompt: 'Which table should this flow use?', options: ['Facturen', 'Klanten', 'Create a new table'],
    choice: { kind: 'datatable', access: 'write', options: [
        { label: 'Facturen', datatableId: 'tbl_fact01' }, { label: 'Klanten', datatableId: 'tbl_klant1' }, { label: 'Create a new table', create: true },
    ] },
}];

test('resolveTableChoice: an option label approves its id', () => {
    const r = resolveTableChoice({ questions: QUESTIONS, message: 'Q: Which table should this flow use?\nA: Klanten', catalog: CATALOG });
    assert.deepStrictEqual(r, { approvedIds: ['tbl_klant1'], createFor: [], tables: [{ id: 'tbl_klant1', key: 'klant_lijst', name: 'Klanten' }] });
});

test('resolveTableChoice: the create option asks for a new table', () => {
    const r = resolveTableChoice({ questions: QUESTIONS, message: 'Q: Which table should this flow use?\nA: Create a new table', catalog: CATALOG });
    assert.deepStrictEqual(r, { approvedIds: [], createFor: ['Which table should this flow use?'], tables: [] });
});

test('resolveTableChoice: a typed answer approves a table only when exactly one of the question\'s tables is named', () => {
    const typed = (a) => resolveTableChoice({ questions: QUESTIONS, message: `Q: Which table should this flow use?\nA: ${a}`, catalog: CATALOG });
    assert.deepStrictEqual(typed('the facturen one').approvedIds, ['tbl_fact01']);
    assert.deepStrictEqual(typed('facturen and klanten').approvedIds, [], 'ambiguous approves nothing');
    assert.deepStrictEqual(typed('something else').approvedIds, []);
    assert.deepStrictEqual(typed('catalog').approvedIds, [], 'not one of this question\'s tables');
});

test('resolveTableChoice: a message that is not a Q/A block, or answers another prompt, approves nothing', () => {
    assert.deepStrictEqual(resolveTableChoice({ questions: QUESTIONS, message: 'facturen', catalog: CATALOG }), { approvedIds: [], createFor: [], tables: [] });
    assert.deepStrictEqual(resolveTableChoice({ questions: QUESTIONS, message: 'Q: Other?\nA: Facturen', catalog: CATALOG }), { approvedIds: [], createFor: [], tables: [] });
});

test('buildApprovedSet is null without a catalog and unions every source otherwise', () => {
    assert.strictEqual(buildApprovedSet({ catalog: null }), null);
    const set = buildApprovedSet({
        catalog: CATALOG,
        defs: [{ steps: [{ id: 's', type: 'datatable', datatableId: 'tbl_ro0001' }] }, null],
        userTexts: ['gebruik de klanten tabel', 'Q: Which table?\nA: nothing named\n\nQ: x\nA: y'],
        carried: ['tbl_cat001'], choice: { approvedIds: ['tbl_fact01'] }, planUse: ['tbl_ab'],
    });
    assert.deepStrictEqual([...set].sort(), ['tbl_ab', 'tbl_cat001', 'tbl_fact01', 'tbl_klant1', 'tbl_ro0001']);
});

test('a table named only in the model\'s own question (the Q: part) is not approved', () => {
    const set = buildApprovedSet({ catalog: CATALOG, userTexts: ['Q: Shall I use Facturen?\nA: yes please'] });
    assert.strictEqual(set.size, 0);
});

test('the gate passes with the gate off, for pending tables and for approved ones', () => {
    const wrapOff = { _datatables: CATALOG };
    assert.strictEqual(approvalGateError(CATALOG[0], wrapOff, { op: 'add_row' }), null);
    const wrap = { _datatables: CATALOG, _approvedDatatableIds: new Set(['tbl_fact01']) };
    assert.strictEqual(approvalGateError(CATALOG[5], wrap, { op: 'add_row' }), null, 'pending');
    assert.strictEqual(approvalGateError(CATALOG[0], wrap, { op: 'add_row' }), null, 'approved');
});

test('the gate refuses an unchosen table with a ready question; writes offer writable alternatives only', () => {
    const wrap = { _datatables: CATALOG, _approvedDatatableIds: new Set() };
    const write = approvalGateError(CATALOG[0], wrap, { op: 'add_row' });
    assert.strictEqual(write.code, 'datatable_choice_required');
    assert.strictEqual(write._rejectedPath, 'datatableId');
    const ids = write._askArgs.questions[0].datatableIds;
    assert.strictEqual(ids[0], 'tbl_fact01');
    assert.ok(ids.length <= 3);
    assert.ok(!ids.includes('tbl_ro0001'), 'a read-only table is not offered for a write');
    assert.ok(write._askArgs.questions[0].createLabel);
    assert.match(write._fixHint, /builder_ask_questions/);
    const read = approvalGateError(CATALOG[0], wrap, { op: 'find_rows' });
    assert.ok(read._askArgs.questions[0].datatableIds.includes('tbl_ro0001'), 'a read may be offered the read-only archive');
});
