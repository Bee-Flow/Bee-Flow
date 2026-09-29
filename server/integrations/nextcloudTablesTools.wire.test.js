/**
 * The wire shape of a Tables row write.
 *
 * The Tables API takes `data` as an OBJECT keyed by column id — its controller
 * reads `foreach ($data as $key => $value) { columnId = (int)$key }`. Bee Flow
 * built an ARRAY of {columnId, value} pairs and posted that, so PHP read the
 * array INDEX as the column id and every write failed with "Column with id 0
 * is not part of table with id N" (2026-09-12, Nextcloud Tables 34). The pair
 * list is still what mapRow and the error messages read; only the body shape
 * changed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'nextcloudTablesTools.js'), 'utf8');

test('both row writes post data keyed by column id, never the pair array', () => {
    // Source pins: the two call sites (create + update) must go through the
    // shaper. A regression here only shows up against a live Nextcloud.
    const raw = SRC.match(/data: resolved\.data\b/g) || [];
    assert.deepEqual(raw, [], 'no call site may post the internal pair array');
    const shaped = SRC.match(/data: toWireData\(resolved\.data\)/g) || [];
    assert.equal(shaped.length, 2, 'create_row and update_row both shape the body');
});

test('toWireData turns the pair list into a columnId-keyed object', () => {
    // Exercised through the module's own function, extracted the same way the
    // file defines it (it is internal on purpose — nothing else may build a
    // Tables payload).
    const body = SRC.slice(SRC.indexOf('function toWireData'), SRC.indexOf('function resolveValues'));
    const toWireData = new Function(`${body}; return toWireData;`)();

    assert.deepEqual(
        toWireData([{ columnId: 1, value: '2026-09-19' }, { columnId: 4, value: 1284.5 }]),
        { 1: '2026-09-19', 4: 1284.5 },
    );
    assert.deepEqual(toWireData([]), {}, 'an empty row is an empty object, not an empty array');
    // A falsy value must survive: 0 and "" are real cell contents.
    assert.deepEqual(toWireData([{ columnId: 2, value: '' }, { columnId: 3, value: 0 }]), { 2: '', 3: 0 });
});

// ── Keys are matched to column titles tolerantly, never renamed ─────────────
// The AI that fills a row keys it by its own extraction fields (excl_btw), not
// the table's titles (Excl. btw). Case, accents and punctuation must not fail
// the row; a different WORD must, and an ambiguous match must never guess.
const { resolveValues, normaliseColumnKey } = require('./nextcloudTablesTools');
const COLS = [{ id: 1, title: 'Datum' }, { id: 2, title: 'Leverancier' }, { id: 4, title: 'Excl. btw' }, { id: 5, title: 'Btw' }, { id: 6, title: 'Totaal' }];

test('normaliseColumnKey folds case, accents and punctuation only', () => {
    for (const v of ['Excl. btw', 'excl_btw', 'EXCL BTW', 'Excl.btw', ' excl-btw ']) assert.equal(normaliseColumnKey(v), 'exclbtw', v);
    assert.equal(normaliseColumnKey('Crème brûlée!'), 'cremebrulee');
    assert.equal(normaliseColumnKey(null), '');
    assert.notEqual(normaliseColumnKey('amount_total'), normaliseColumnKey('Totaal'), 'a different word never matches');
});

test('resolveValues accepts the tolerant spellings and still refuses a different word', () => {
    const ok = resolveValues({ excl_btw: 875, BTW: 183.75, datum: '2026-09-19', Totaal: 1058.75 }, COLS);
    assert.deepEqual(ok.data.map(d => d.columnId), [4, 5, 1, 6]);

    const bad = resolveValues({ amount_total: 2 }, COLS);
    assert.match(bad.error, /Unknown column\(s\).*amount_total/);
    assert.match(bad.error, /Available columns: Datum, Leverancier, Excl\. btw, Btw, Totaal/);
    assert.match(bad.error, /ignoring case, accents and punctuation/, 'the error explains the matching rule');
});

test('an ambiguous normalised title is never guessed, and a column is written once', () => {
    const amb = [{ id: 1, title: 'Btw' }, { id: 2, title: 'BTW.' }, { id: 3, title: 'Totaal' }];
    // "btw" IS the title "Btw" ignoring case — that exact match wins and is not
    // ambiguous. "b_t_w" only matches through normalisation, and there two
    // columns collapse to the same key: refused rather than guessed.
    assert.deepEqual(resolveValues({ btw: 1 }, amb).data, [{ columnId: 1, value: 1 }]);
    const r = resolveValues({ b_t_w: 1 }, amb);
    assert.match(r.error, /Unknown column/, 'an ambiguous normalised key is refused');
    assert.deepEqual(resolveValues({ 'BTW.': 1 }, amb).data, [{ columnId: 2, value: 1 }], 'the exact title still works');

    const twice = resolveValues({ 'Excl. btw': 1, excl_btw: 2 }, COLS);
    assert.match(twice.error, /same column "Excl\. btw"/);
});

// ── A table may be named by its TITLE, not only its id ──────────────────────
// The user knows "Facturen"; the API wants 4. A builder briefed with the
// title had no way to find the id at build time and guessed 1 — every row
// then landed in the wrong table or a 403. The resolver runs once, at the top
// of the dispatcher, for every table-scoped tool.
const { resolveTableId, TABLE_SCOPED_TOOLS } = require('./nextcloudTablesTools');
const TABLES = [{ id: 2, title: 'Klanten' }, { id: 4, title: 'Facturen' }, { id: 7, title: 'Facturen Q3' }, { id: 9, title: 'To-do' }];
function fakeFetch(tables = TABLES, calls = []) {
    return async (url) => {
        calls.push(url);
        return { ok: true, status: 200, json: async () => ({ ocs: { data: tables } }), text: async () => JSON.stringify(tables) };
    };
}
const authError = () => ({ error: 'auth' });

test('an id passes through without touching the network', async () => {
    const calls = [];
    assert.deepEqual(await resolveTableId('http://nc/api', fakeFetch(TABLES, calls), authError, 4), { tableId: 4 });
    assert.deepEqual(await resolveTableId('http://nc/api', fakeFetch(TABLES, calls), authError, '4'), { tableId: 4 });
    assert.deepEqual(await resolveTableId('http://nc/api', fakeFetch(TABLES, calls), authError, ' 12 '), { tableId: 12 });
    assert.equal(calls.length, 0, 'no table list fetched for a numeric id');
    assert.match((await resolveTableId('http://nc/api', fakeFetch(), authError, undefined)).error, /tableId is required.*table title/);
    assert.match((await resolveTableId('http://nc/api', fakeFetch(), authError, 0)).error, /not a valid table id/);
    assert.match((await resolveTableId('http://nc/api', fakeFetch(), authError, { id: 4 })).error, /must be a table id or a table title/);
});

test('a title resolves to exactly one table — case-blind, then punctuation-blind', async () => {
    const calls = [];
    const fetch = fakeFetch(TABLES, calls);
    assert.deepEqual(await resolveTableId('http://nc/api', fetch, authError, 'Facturen'), { tableId: 4, title: 'Facturen' });
    assert.deepEqual(await resolveTableId('http://nc/api', fetch, authError, ' facturen '), { tableId: 4, title: 'Facturen' });
    assert.deepEqual(await resolveTableId('http://nc/api', fetch, authError, 'todo'), { tableId: 9, title: 'To-do' }, 'the accent/punctuation-blind key column titles use');
    assert.deepEqual(await resolveTableId('http://nc/api', fetch, authError, 'facturen_q3'), { tableId: 7, title: 'Facturen Q3' });
    assert.ok(calls.every(u => u.endsWith('/tables')), 'only the table list is read');
});

test('a missing or ambiguous title is a soft error that lists the tables', async () => {
    const miss = await resolveTableId('http://nc/api', fakeFetch(), authError, 'Invoices');
    assert.match(miss.error, /No Nextcloud table called "Invoices"/);
    assert.match(miss.error, /"Klanten" \(id 2\), "Facturen" \(id 4\), "Facturen Q3" \(id 7\), "To-do" \(id 9\)/);
    const amb = await resolveTableId('http://nc/api', fakeFetch([{ id: 1, title: 'Btw' }, { id: 2, title: 'BTW.' }]), authError, 'b_t_w');
    assert.match(amb.error, /matches 2 tables \(id 1, id 2\) — pass the table id instead/);
    // The exact (case-blind) title still wins over a normalised collision.
    assert.deepEqual(await resolveTableId('http://nc/api', fakeFetch([{ id: 1, title: 'Btw' }, { id: 2, title: 'BTW.' }]), authError, 'btw'), { tableId: 1, title: 'Btw' });
});

test('every tool that takes a tableId is resolved, and the schema says a title is accepted', () => {
    const { NEXTCLOUD_TABLES_TOOLS } = require('./nextcloudTablesTools');
    const withTableId = NEXTCLOUD_TABLES_TOOLS.filter(t => t.function.parameters.properties.tableId).map(t => t.function.name);
    assert.deepEqual(new Set(withTableId), TABLE_SCOPED_TOOLS, 'the resolver covers exactly the tools whose schema has tableId');
    for (const t of NEXTCLOUD_TABLES_TOOLS) {
        const p = t.function.parameters.properties.tableId;
        if (!p) continue;
        assert.deepEqual(p.type, ['integer', 'string'], `${t.function.name}: tableId takes an id or a title`);
        assert.match(p.description, /exact table title/, `${t.function.name}: the description says so`);
    }
    // Source pin: the dispatcher resolves ONCE, before the switch.
    assert.match(SRC, /if \(TABLE_SCOPED_TOOLS\.has\(toolName\)\) \{\s*const table = await resolveTableId\(/);
});
