/**
 * The builder's datatable vocabulary: what the model says versus what the step
 * stores. Every tolerant read is NOTED, every guess is REFUSED with a
 * "Reject reason:" hint — the two invariants every case below checks.
 *
 * Run: cd server && node --test --test-force-exit automation/builderTools/datatableRefs.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
    normaliseKey,
    DATATABLE_OP_ALIASES,
    resolveDatatableOp,
    translateDatatableVocabulary,
    resolveDatatableRef,
    mapColumnKeys,
    mapColumnName,
} = require('./datatableRefs');
const { DATATABLE_OPS } = require('../validate/constants');

const FACTUREN = {
    id: 'tbl_1a2b3c', key: 'facturen', name: 'Facturen', canWrite: true,
    columns: [
        { key: 'datum', name: 'Datum', type: 'date' },
        { key: 'leverancier', name: 'Leverancier', type: 'text' },
        { key: 'factuurnummer', name: 'Factuurnummer', type: 'text' },
        { key: 'excl_btw', name: 'Excl. btw', type: 'number' },
        { key: 'btw', name: 'Btw', type: 'number' },
        { key: 'totaal', name: 'Totaal', type: 'number' },
    ],
};
const FACTUREN_2024 = { id: 'tbl_9z8y7x', key: 'facturen_2024', name: 'Facturen 2024', canWrite: true, columns: [] };
const KLANTEN = { id: 'tbl_k1', key: 'klanten', name: 'Klanten', canWrite: true, columns: [] };

const assertRejected = (r, why) => {
    assert.ok(r.error, `${why}: expected an error, got ${JSON.stringify(r)}`);
    assert.match(r._fixHint, /^Reject reason: /, `${why}: hint must start with "Reject reason:"`);
};

// ─── normaliseKey ────────────────────────────────────────────────────────────

test('normaliseKey folds case, accents and punctuation — and nothing else', () => {
    for (const v of ['Excl. btw', 'excl_btw', 'EXCL BTW', 'Excl.btw', ' excl-btw ']) assert.strictEqual(normaliseKey(v), 'exclbtw', v);
    assert.strictEqual(normaliseKey('Café Été'), 'cafeete');
    assert.strictEqual(normaliseKey('Facturen 2024'), 'facturen2024');
    assert.notStrictEqual(normaliseKey('amount_total'), normaliseKey('Totaal'), 'spelling folds; meaning does not');
    assert.strictEqual(normaliseKey(null), '');
    assert.strictEqual(normaliseKey(undefined), '');
});

// ─── resolveDatatableOp ──────────────────────────────────────────────────────

test('a canonical op passes through without a note', () => {
    for (const op of DATATABLE_OPS) assert.deepStrictEqual(resolveDatatableOp(op), { op });
});

test('every alias row resolves to its op, with a note naming both spellings', () => {
    assert.ok(Object.isFrozen(DATATABLE_OP_ALIASES));
    const expected = {
        add_row: ['append', 'add', 'insert', 'create', 'create_row', 'add_rows', 'insert_row', 'insert_rows', 'append_row', 'append_rows', 'write', 'write_row'],
        save_row: ['upsert', 'save', 'add_or_update', 'update_or_insert', 'merge', 'insert_or_update'],
        find_rows: ['list', 'read', 'query', 'select', 'get', 'find', 'search', 'lookup', 'read_rows', 'get_rows', 'list_rows', 'find_row', 'fetch'],
        count_rows: ['count'],
        update_rows: ['update', 'edit', 'modify', 'set', 'update_row', 'patch'],
        delete_rows: ['delete', 'remove', 'delete_row', 'remove_row', 'remove_rows', 'erase'],
    };
    let rows = 0;
    for (const [op, aliases] of Object.entries(expected)) {
        for (const alias of aliases) {
            rows++;
            assert.strictEqual(DATATABLE_OP_ALIASES[alias], op, `alias table: ${alias}`);
            const r = resolveDatatableOp(alias);
            assert.strictEqual(r.op, op, alias);
            assert.strictEqual(r.note, `op "${alias}" read as "${op}" — use the exact name next time.`);
            assert.ok(DATATABLE_OPS.has(r.op), 'an alias never resolves outside the canonical set');
        }
    }
    assert.strictEqual(Object.keys(DATATABLE_OP_ALIASES).length, rows, 'no alias is undocumented here');
});

test('"Create Row" — case, spaces and dashes fold before the alias lookup', () => {
    assert.deepStrictEqual(resolveDatatableOp('Create Row'), { op: 'add_row', note: 'op "Create Row" read as "add_row" — use the exact name next time.' });
    assert.strictEqual(resolveDatatableOp('create-row').op, 'add_row');
    assert.strictEqual(resolveDatatableOp('  UPSERT ').op, 'save_row');
});

test('a mis-cased canonical op is read, and still said', () => {
    const r = resolveDatatableOp('Find Rows');
    assert.strictEqual(r.op, 'find_rows');
    assert.match(r.note, /"Find Rows" read as "find_rows"/);
});

test('"frobnicate" is refused with the full op list and the alias summary', () => {
    const r = resolveDatatableOp('frobnicate');
    assertRejected(r, 'unknown op');
    assert.match(r.error, /op "frobnicate" is not a datatable operation/);
    assert.match(r.error, /find_rows, count_rows, add_row, save_row, update_rows, delete_rows/);
    assert.match(r.error, /append\/insert → add_row, upsert → save_row/);
    assert.match(r._fixHint, /nothing else was checked yet/);
});

test('op absent WITH values is refused — the kind of write cannot be guessed', () => {
    for (const raw of [undefined, null, '', '   ']) {
        const r = resolveDatatableOp(raw, { hasValues: true });
        assertRejected(r, `absent op ${JSON.stringify(raw)} with values`);
        assert.match(r.error, /op is required/);
        assert.match(r.error, /add_row \(always insert\), save_row .* or update_rows \(needs where\)/);
        assert.match(r._fixHint, /op missing on a datatable write/);
    }
});

test('op absent WITHOUT values reads as find_rows, noted', () => {
    for (const raw of [undefined, null, '']) {
        const r = resolveDatatableOp(raw, { hasValues: false });
        assert.strictEqual(r.op, 'find_rows');
        assert.match(r.note, /op was not set — read as find_rows \(the only op that changes nothing\)/);
    }
    assert.strictEqual(resolveDatatableOp(undefined).op, 'find_rows', 'hasValues defaults to false');
});

// ─── translateDatatableVocabulary ────────────────────────────────────────────

test('"fields" becomes values when values is absent; the alias key is gone', () => {
    const r = translateDatatableVocabulary({ op: 'add_row', fields: { datum: '2026-01-01' } });
    assert.deepStrictEqual(r.args.values, { datum: '2026-01-01' });
    assert.ok(!('fields' in r.args), 'a foreign key never reaches the definition');
    assert.deepStrictEqual(r.notes, ['"fields" read as values — a datatable write puts its column→value map in values.']);
});

test('the alias order is fields, row, data, record, columns, cells, set', () => {
    const r = translateDatatableVocabulary({ record: { a: 1 }, row: { b: 2 } });
    assert.deepStrictEqual(r.args.values, { b: 2 });
    assert.ok(!('row' in r.args) && !('record' in r.args));
    assert.match(r.notes[0], /"row" read as values/);
    assert.match(r.notes[1], /"record" was sent beside values — ignored/);
});

test('an alias that is not a plain object is left for the validator', () => {
    const r = translateDatatableVocabulary({ fields: 'datum,btw' });
    assert.strictEqual(r.args.fields, 'datum,btw');
    assert.strictEqual(r.args.values, undefined);
    assert.deepStrictEqual(r.notes, []);
});

test('fields beside values: values wins, fields is dropped and said', () => {
    const r = translateDatatableVocabulary({ values: { a: 1 }, fields: { a: 2 } });
    assert.deepStrictEqual(r.args.values, { a: 1 });
    assert.ok(!('fields' in r.args));
    assert.deepStrictEqual(r.notes, ['"fields" was sent beside values — ignored; values is the column map.']);
});

test('tableId becomes datatableId', () => {
    const r = translateDatatableVocabulary({ op: 'find_rows', tableId: 'tbl_1a2b3c' });
    assert.strictEqual(r.args.datatableId, 'tbl_1a2b3c');
    assert.ok(!('tableId' in r.args));
    assert.deepStrictEqual(r.notes, ['"tableId" read as datatableId.']);
});

test('a table alias is not consumed when datatableId is already set, nor when it is not a string', () => {
    const kept = translateDatatableVocabulary({ datatableId: 'tbl_1', tableId: 'tbl_2' });
    assert.strictEqual(kept.args.datatableId, 'tbl_1');
    assert.strictEqual(kept.args.tableId, 'tbl_2', 'not ours to drop — the validator names it');
    const num = translateDatatableVocabulary({ table: 42 });
    assert.strictEqual(num.args.datatableId, undefined);
    assert.strictEqual(num.args.table, 42);
});

test('a literal binding on datatableId is unwrapped to its string, with the build-time note', () => {
    const r = translateDatatableVocabulary({ datatableId: { kind: 'literal', value: 'Facturen' } });
    assert.strictEqual(r.args.datatableId, 'Facturen');
    assert.deepStrictEqual(r.notes, ['datatableId was sent as a binding object — the table is chosen when the routine is built, not at run time; read as "Facturen".']);
    const viaAlias = translateDatatableVocabulary({ table: { kind: 'literal', value: 'tbl_1a2b3c' } });
    assert.strictEqual(viaAlias.args.datatableId, 'tbl_1a2b3c');
    assert.strictEqual(viaAlias.notes.length, 2, 'alias read + binding unwrap are both said');
});

test('a ref/template/expr binding on the table is refused — a routine cannot pick its table at run time', () => {
    for (const b of [{ kind: 'ref', path: 'vars.table' }, { kind: 'template', template: '{{vars.t}}' }, { kind: 'expr', expr: 'vars.t' }]) {
        const r = translateDatatableVocabulary({ datatableId: b });
        assertRejected(r, `datatableId ${b.kind}`);
        assert.match(r.error, /cannot be a ref or template — a routine cannot pick its table at run time/);
        assert.match(r._fixHint, /datatableId is a binding/);
    }
    const key = translateDatatableVocabulary({ datatableId: 'tbl_1', datatableKey: { kind: 'ref', path: 'vars.k' } });
    assertRejected(key, 'datatableKey ref');
    assert.match(key._fixHint, /datatableKey is a binding/);
});

test('a catalog row echoed back as datatableId is read by its id', () => {
    const r = translateDatatableVocabulary({ datatableId: { id: 'tbl_1a2b3c', key: 'facturen', name: 'Facturen' } });
    assert.strictEqual(r.args.datatableId, 'tbl_1a2b3c');
    assert.match(r.notes[0], /sent as a catalog row — read as its id "tbl_1a2b3c"/);
    const other = translateDatatableVocabulary({ datatableId: { foo: 'bar' } });
    assertRejected(other, 'object without id');
});

test('a datatableKey that is not a table key is dropped and said; a real key stays', () => {
    const r = translateDatatableVocabulary({ datatableId: 'tbl_1a2b3c', datatableKey: 'Facturen' });
    assert.ok(!('datatableKey' in r.args));
    assert.deepStrictEqual(r.notes, ['datatableKey "Facturen" is not a table key (lowercase letters, digits, underscores) — dropped; copy the key from the Datatables block.']);
    const ok = translateDatatableVocabulary({ datatableId: 'tbl_1a2b3c', datatableKey: 'facturen_2024' });
    assert.strictEqual(ok.args.datatableKey, 'facturen_2024');
    assert.deepStrictEqual(ok.notes, []);
});

test('translate never mutates its input', () => {
    const input = { fields: { a: 1 }, tableId: 'tbl_1', datatableKey: 'Bad Key' };
    const snapshot = JSON.stringify(input);
    translateDatatableVocabulary(input);
    assert.strictEqual(JSON.stringify(input), snapshot);
    assert.deepStrictEqual(translateDatatableVocabulary(null), { args: null, notes: [] });
});

// ─── resolveDatatableRef ─────────────────────────────────────────────────────

test('an exact id resolves with no note and returns the catalog object itself', () => {
    const r = resolveDatatableRef({ id: 'tbl_1a2b3c', datatables: [FACTUREN, KLANTEN] });
    assert.strictEqual(r.table, FACTUREN);
    assert.deepStrictEqual(r.notes, []);
});

test('an exact key sent as the id resolves, noted', () => {
    const r = resolveDatatableRef({ id: 'facturen', datatables: [FACTUREN, KLANTEN] });
    assert.strictEqual(r.table, FACTUREN);
    assert.deepStrictEqual(r.notes, ['datatableId "facturen" resolved to tbl_1a2b3c (key facturen, "Facturen") by its key — use the id from the Datatables block next time.']);
});

test('a table NAME sent as the id resolves by normalised name, noted', () => {
    const r = resolveDatatableRef({ id: 'Facturen', datatables: [FACTUREN, KLANTEN] });
    assert.strictEqual(r.table, FACTUREN);
    assert.deepStrictEqual(r.notes, ['datatableId "Facturen" resolved to tbl_1a2b3c (key facturen, "Facturen") by its name — use the id from the Datatables block next time.']);
});

test('an unknown id with a resolving key re-links by the key (the import case)', () => {
    const r = resolveDatatableRef({ id: 'tbl_fact01', key: 'facturen', datatables: [FACTUREN, KLANTEN] });
    assert.strictEqual(r.table, FACTUREN);
    assert.deepStrictEqual(r.notes, ['datatableId "tbl_fact01" is not a table here; datatableKey "facturen" resolved it to tbl_1a2b3c.']);
});

test('"facturen 2024" is a unique normalised match against Facturen and Facturen 2024', () => {
    const r = resolveDatatableRef({ id: 'facturen 2024', datatables: [FACTUREN, FACTUREN_2024] });
    assert.strictEqual(r.table, FACTUREN_2024);
    assert.match(r.notes[0], /resolved to tbl_9z8y7x \(key facturen_2024, "Facturen 2024"\) by its name/);
});

test('two tables whose names normalise equal are ambiguous — refused, both listed', () => {
    const a = { id: 'tbl_1', key: 'facturen', name: 'Facturen', columns: [] };
    const b = { id: 'tbl_2', key: 'facturen_2', name: 'FACTUREN.', columns: [] };
    const r = resolveDatatableRef({ id: 'Facturen!', datatables: [a, b, KLANTEN] });
    assertRejected(r, 'ambiguous name');
    assert.strictEqual(r.error, '"Facturen!" matches 2 datatables: tbl_1 (facturen, "Facturen"), tbl_2 (facturen_2, "FACTUREN."). Use the exact id of the one you mean.');
    assert.match(r._fixHint, /ambiguous table name/);
});

test('an unknown table lists the existing ones and says never to invent one', () => {
    const r = resolveDatatableRef({ id: 'tbl_nope', datatables: [FACTUREN, KLANTEN] });
    assertRejected(r, 'unknown table');
    assert.strictEqual(r.error, 'There is no datatable "tbl_nope" available to this user. Existing tables: tbl_1a2b3c (facturen, "Facturen"), tbl_k1 (klanten, "Klanten"). Use one of these ids, or tell the user the table must be created first — never invent one.');
    assert.match(r._fixHint, /unknown datatable/);
    const withKey = resolveDatatableRef({ id: 'tbl_nope', key: 'nope', datatables: [FACTUREN] });
    assertRejected(withKey, 'unknown id and unknown key');
    assert.match(withKey.error, /no datatable "tbl_nope"/);
});

test('the table list is capped at 20 with a count of the rest', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `tbl_${i}`, key: `t${i}`, name: `T ${i}`, columns: [] }));
    const r = resolveDatatableRef({ id: 'tbl_nope', datatables: many });
    assert.match(r.error, /tbl_19 \(t19, "T 19"\), …and 5 more\. Use one of these ids/);
    assert.ok(!r.error.includes('tbl_20 '));
});

test('an empty catalog refuses with a do-not-retry hint', () => {
    const r = resolveDatatableRef({ id: 'tbl_1a2b3c', datatables: [] });
    assertRejected(r, 'no tables');
    assert.match(r.error, /This user has no datatables/);
    assert.match(r.error, /Studio → Datatables/);
    assert.match(r._fixHint, /Do not retry this step/);
});

test('no catalog at all is permissive: table null, no notes', () => {
    for (const datatables of [undefined, null, 'nope', {}]) {
        assert.deepStrictEqual(resolveDatatableRef({ id: 'tbl_1a2b3c', datatables }), { table: null, notes: [] });
    }
});

test('id and key naming different tables: the id wins and the key correction is said', () => {
    const r = resolveDatatableRef({ id: 'tbl_1a2b3c', key: 'klanten', datatables: [FACTUREN, KLANTEN] });
    assert.strictEqual(r.table, FACTUREN);
    assert.deepStrictEqual(r.notes, ['datatableKey "klanten" names another table than datatableId — replaced by "facturen".']);
    const stale = resolveDatatableRef({ id: 'tbl_1a2b3c', key: 'oud', datatables: [FACTUREN, KLANTEN] });
    assert.deepStrictEqual(stale.notes, ['datatableKey "oud" is not the key of tbl_1a2b3c — replaced by "facturen".']);
    const agree = resolveDatatableRef({ id: 'tbl_1a2b3c', key: 'facturen', datatables: [FACTUREN, KLANTEN] });
    assert.deepStrictEqual(agree.notes, []);
});

test('key alone resolves and says the id was missing; neither is refused', () => {
    const r = resolveDatatableRef({ key: 'facturen', datatables: [FACTUREN] });
    assert.strictEqual(r.table, FACTUREN);
    assert.match(r.notes[0], /datatableId was not set — datatableKey "facturen" resolved it to tbl_1a2b3c/);
    const none = resolveDatatableRef({ datatables: [FACTUREN] });
    assertRejected(none, 'nothing named');
    assert.match(none.error, /datatableId is required/);
});

// ─── mapColumnKeys ───────────────────────────────────────────────────────────

test('title-cased keys are renamed to column keys, each rename noted; exact keys pass silently', () => {
    const r = mapColumnKeys(
        { Datum: '2026-01-01', 'Excl. btw': 10, totaal: 12.1, LEVERANCIER: 'Acme' },
        FACTUREN.columns, { tableName: FACTUREN.name },
    );
    assert.deepStrictEqual(r.map, { datum: '2026-01-01', excl_btw: 10, totaal: 12.1, leverancier: 'Acme' });
    assert.deepStrictEqual(Object.keys(r.map), ['datum', 'excl_btw', 'totaal', 'leverancier'], 'key order kept');
    assert.deepStrictEqual(r.notes, [
        'values key "Datum" mapped to column key "datum"',
        'values key "Excl. btw" mapped to column key "excl_btw"',
        'values key "LEVERANCIER" mapped to column key "leverancier"',
    ]);
    const exact = mapColumnKeys({ datum: 'x', btw: 1 }, FACTUREN.columns);
    assert.deepStrictEqual(exact, { map: { datum: 'x', btw: 1 }, notes: [] });
});

test('every unknown key is named in ONE error, with the table\'s columns', () => {
    const r = mapColumnKeys({ datum: 'x', amount: 1, vendor: 'y' }, FACTUREN.columns, { tableName: 'Facturen' });
    assertRejected(r, 'unknown keys');
    assert.strictEqual(r.error, 'values names columns "amount", "vendor" that "Facturen" does not have. Its columns are: datum ("Datum"), leverancier ("Leverancier"), factuurnummer ("Factuurnummer"), excl_btw ("Excl. btw"), btw ("Btw"), totaal ("Totaal"). Key values by these column keys.');
    assert.strictEqual(r._fixHint, 'Reject reason: unknown column key. Rename the key(s) named above to one of the listed column keys and resend the same step — the bindings were fine.');
    const one = mapColumnKeys({ amount: 1 }, FACTUREN.columns, { tableName: 'Facturen' });
    assert.match(one.error, /^values names a column "amount" that "Facturen" does not have\./);
});

test('a key that fits two columns (Btw vs BTW.) is refused, never guessed', () => {
    const columns = FACTUREN.columns.concat([{ key: 'btw_2', name: 'BTW.', type: 'number' }]);
    const r = mapColumnKeys({ 'BTW ': 1 }, columns, { tableName: 'Facturen' });
    assertRejected(r, 'ambiguous column');
    assert.strictEqual(r.error, 'values key "BTW " matches two columns of "Facturen" ("Btw", "BTW.") — use the exact column key.');
    // the exact keys still work — ambiguity only blocks the fuzzy rung
    assert.deepStrictEqual(mapColumnKeys({ btw: 1, btw_2: 2 }, columns).map, { btw: 1, btw_2: 2 });
});

test('two keys collapsing onto one column are refused', () => {
    const r = mapColumnKeys({ excl_btw: 1, 'Excl. btw': 2 }, FACTUREN.columns);
    assertRejected(r, 'collapse');
    assert.strictEqual(r.error, 'keys "excl_btw" and "Excl. btw" both map onto column "excl_btw" — send each column once.');
});

test('values sent as one whole-row binding is refused with the per-column fix, not "unknown column kind"', () => {
    const r = mapColumnKeys({ kind: 'ref', path: 'steps.extract.output' }, FACTUREN.columns);
    assertRejected(r, 'binding as map');
    assert.match(r.error, /cannot be one ref binding for the whole row/);
    assert.ok(!/unknown column/.test(r.error));
});

test('mapColumnKeys is permissive without a map or a column catalog, strict on an empty one', () => {
    assert.deepStrictEqual(mapColumnKeys(undefined, FACTUREN.columns), { map: undefined, notes: [] });
    assert.deepStrictEqual(mapColumnKeys({ a: 1 }, undefined), { map: { a: 1 }, notes: [] });
    const empty = mapColumnKeys({ a: 1 }, [], { tableName: 'Leeg' });
    assertRejected(empty, 'table without columns');
    assert.match(empty.error, /Its columns are: \(none\)/);
    assert.ok(!Object.hasOwn(mapColumnKeys({ id: 1 }, FACTUREN.columns), 'map'), 'system columns are not writable');
});

// ─── mapColumnName ───────────────────────────────────────────────────────────

test('mapColumnName: exact key, title with note, unknown with the column list', () => {
    assert.deepStrictEqual(mapColumnName('excl_btw', FACTUREN.columns), { key: 'excl_btw' });
    assert.deepStrictEqual(mapColumnName('Excl. btw', FACTUREN.columns, { what: 'where[0].field' }), { key: 'excl_btw', note: 'where[0].field "Excl. btw" mapped to column key "excl_btw"' });
    const r = mapColumnName('amount', FACTUREN.columns, { what: 'matchColumn', tableName: 'Facturen' });
    assertRejected(r, 'unknown column');
    assert.match(r.error, /^matchColumn names a column "amount" that "Facturen" does not have\. Its columns are: datum \("Datum"\)/);
    assert.match(r._fixHint, /unknown column key in matchColumn/);
});

test('mapColumnName admits created_at only with allowSystem (where/sort), never for a write', () => {
    assert.deepStrictEqual(mapColumnName('created_at', FACTUREN.columns, { allowSystem: true, what: 'sort[0].field' }), { key: 'created_at' });
    assert.deepStrictEqual(mapColumnName('Created At', FACTUREN.columns, { allowSystem: true, what: 'where[1].field' }), { key: 'created_at', note: 'where[1].field "Created At" mapped to column key "created_at"' });
    const write = mapColumnName('created_at', FACTUREN.columns, { what: 'matchColumn' });
    assertRejected(write, 'system column on a write');
    assert.ok(!write.error.includes('created_at ('), 'a refused system column is not offered in the list');
    const listed = mapColumnName('nope', FACTUREN.columns, { allowSystem: true, what: 'sort[0].field' });
    assert.match(listed.error, /totaal \("Totaal"\), id, created_at, updated_at, created_by, org_id\./, 'system keys are listed bare when admitted');
});

test('mapColumnName: ambiguous is refused; a non-string or blank name is left to the validator', () => {
    const columns = FACTUREN.columns.concat([{ key: 'btw_2', name: 'BTW.', type: 'number' }]);
    const r = mapColumnName('BTW', columns, { what: 'matchColumn', tableName: 'Facturen' });
    assertRejected(r, 'ambiguous');
    assert.strictEqual(r.error, 'matchColumn key "BTW" matches two columns of "Facturen" ("Btw", "BTW.") — use the exact column key.');
    assert.deepStrictEqual(mapColumnName(undefined, columns), { key: undefined });
    assert.deepStrictEqual(mapColumnName('', columns), { key: '' });
    const ref = { kind: 'ref', path: 'vars.col' };
    assert.deepStrictEqual(mapColumnName(ref, columns), { key: ref });
    assert.deepStrictEqual(mapColumnName('x', undefined), { key: 'x' });
});
