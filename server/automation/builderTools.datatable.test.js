/**
 * builder_add_datatable / builder_update_step — the bindings a datatable step
 * carries.
 *
 * A datatable keeps its bindings in `values` and `where[].value`, NOT in
 * `inputs`, so both builder paths skipped the canonicaliser every other step
 * gets: the tool schema tells the model to write "{{steps.form.output.email}}"
 * and that string was stored verbatim, so the row got the braces instead of the
 * value. These pin that it goes through the same canonicaliser now.
 *
 * Run: node --test --test-force-exit automation/builderTools.datatable.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const { applyToolCall, emptyDefinition } = require('./builderTools');
const { validateDefinition } = require('./validate');

function freshWrap() {
    return { userId: 'u_test', def: emptyDefinition() };
}

// An upstream producer so `steps.<id>.output.*` refs point at something real.
async function withProducer(dw) {
    const http = await applyToolCall('builder_add_http_request', { url: 'https://api.example.com/x' }, dw);
    return http.added.id;
}

test('a bare {{…}} string in values becomes a template binding, not literal text', async () => {
    const dw = freshWrap();
    const hid = await withProducer(dw);
    const res = await applyToolCall('builder_add_datatable', {
        op: 'save_row', datatableId: 'tbl_1a2b3c', matchColumn: 'email',
        values: {
            email: `{{steps.${hid}.output.body}}`,
            status: 'new',
        },
    }, dw);
    assert.ok(!res.error, res.error);
    assert.deepStrictEqual(res.added.values.email, { kind: 'template', value: `{{steps.${hid}.output.body}}` });
    assert.deepStrictEqual(res.added.values.status, { kind: 'literal', value: 'new' });
});

test('a where value is canonicalised the same way', async () => {
    const dw = freshWrap();
    const hid = await withProducer(dw);
    const res = await applyToolCall('builder_add_datatable', {
        op: 'find_rows', datatableId: 'tbl_1a2b3c',
        where: [{ field: 'email', op: 'eq', value: `{{steps.${hid}.output.body}}` }],
    }, dw);
    assert.ok(!res.error, res.error);
    assert.deepStrictEqual(res.added.where[0], {
        field: 'email', op: 'eq',
        value: { kind: 'template', value: `{{steps.${hid}.output.body}}` },
    });
});

test('a valueless condition keeps no value key — isNull is complete on its own', async () => {
    const dw = freshWrap();
    const res = await applyToolCall('builder_add_datatable', {
        op: 'find_rows', datatableId: 'tbl_1a2b3c',
        where: [{ field: 'status', op: 'isNull' }],
    }, dw);
    assert.ok(!res.error, res.error);
    assert.deepStrictEqual(res.added.where[0], { field: 'status', op: 'isNull' });
});

test('a where entry is rebuilt from field/op/value — invented keys do not persist', async () => {
    const dw = freshWrap();
    const res = await applyToolCall('builder_add_datatable', {
        op: 'find_rows', datatableId: 'tbl_1a2b3c',
        where: [{ field: 'email', op: 'eq', value: 'a@b.c', caseSensitive: true, mode: 'fuzzy' }],
    }, dw);
    assert.ok(!res.error, res.error);
    assert.deepStrictEqual(Object.keys(res.added.where[0]).sort(), ['field', 'op', 'value'],
        'a field the runtime never reads would persist looking configured and do nothing');
});

test('a ref with an unknown root is refused at the tool boundary, naming the half that is wrong', async () => {
    const dw = freshWrap();
    const bad = await applyToolCall('builder_add_datatable', {
        op: 'add_row', datatableId: 'tbl_1a2b3c',
        values: { email: { kind: 'ref', path: 'results.email' } },
    }, dw);
    assert.match(bad.error, /datatable values/);
    assert.match(bad.error, /unknown root/);

    const badWhere = await applyToolCall('builder_add_datatable', {
        op: 'find_rows', datatableId: 'tbl_1a2b3c',
        where: [{ field: 'email', op: 'eq', value: { kind: 'ref', path: 'results.email' } }],
    }, dw);
    assert.match(badWhere.error, /datatable where\[0\]/);

    assert.strictEqual(dw.def.steps.length, 0, 'every rejection rolls back cleanly');
});

test('builder_update_step canonicalises a patched value too', async () => {
    const dw = freshWrap();
    const hid = await withProducer(dw);
    const added = (await applyToolCall('builder_add_datatable', {
        op: 'save_row', datatableId: 'tbl_1a2b3c', matchColumn: 'email',
        values: { email: { kind: 'literal', value: 'a@b.c' } },
    }, dw)).added;

    const res = await applyToolCall('builder_update_step', {
        stepId: added.id,
        patch: { values: { status: `{{steps.${hid}.output.body}}` } },
    }, dw);
    assert.ok(!res.error, res.error);
    assert.deepStrictEqual(res.updated.values.status, { kind: 'template', value: `{{steps.${hid}.output.body}}` });
    // merge, not replace: the column already mapped survives.
    assert.deepStrictEqual(res.updated.values.email, { kind: 'literal', value: 'a@b.c' });
});

test('a patched where list is replaced wholesale, and canonicalised', async () => {
    const dw = freshWrap();
    const hid = await withProducer(dw);
    const added = (await applyToolCall('builder_add_datatable', {
        op: 'update_rows', datatableId: 'tbl_1a2b3c',
        values: { status: { kind: 'literal', value: 'done' } },
        where: [{ field: 'email', op: 'eq', value: 'a@b.c' }, { field: 'status', op: 'isNull' }],
    }, dw)).added;
    assert.strictEqual(added.where.length, 2);

    const res = await applyToolCall('builder_update_step', {
        stepId: added.id,
        patch: { where: [{ field: 'email', op: 'eq', value: `{{steps.${hid}.output.body}}` }] },
    }, dw);
    assert.ok(!res.error, res.error);
    assert.strictEqual(res.updated.where.length, 1,
        'merging a condition list by index keeps one the author meant to drop');
    assert.strictEqual(res.updated.where[0].value.kind, 'template');
});

// ─── With a catalog: the "Datatables you may use" block on draftWrap ─────────
//
// Measured on local builds (2026-09): the save step of every invoice brief
// arrived with op "append", its column map under `fields`, the table as a
// literal binding carrying its NAME, and — one round later — the value keys
// spelled as the column titles. Each cost a rejected round. These pin that the
// unambiguous forms are read and SAID, and that the guesses are refused with a
// "Reject reason:" hint (the shape builderTools.js leaves alone).

const FACTUREN = {
    id: 'tbl_1a2b3c', key: 'facturen', name: 'Facturen', canWrite: true, managedKind: 'nextcloud_table',
    columns: [
        { key: 'datum', name: 'Datum', type: 'date' },
        { key: 'leverancier', name: 'Leverancier', type: 'text' },
        { key: 'factuurnummer', name: 'Factuurnummer', type: 'text' },
        { key: 'excl_btw', name: 'Excl. btw', type: 'number' },
        { key: 'btw', name: 'Btw', type: 'number' },
        { key: 'totaal', name: 'Totaal', type: 'number' },
    ],
};
// Viewer grade only: a write here passes every check and fails at run time.
const KLANTEN = {
    id: 'tbl_k1', key: 'klanten', name: 'Klanten', canWrite: false, managedKind: null,
    columns: [{ key: 'naam', name: 'Naam', type: 'text' }],
};
const EXTRACTION_FIELDS = ['datum', 'leverancier', 'factuurnummer', 'excl_btw', 'btw', 'totaal'];

function catalogWrap(datatables = [FACTUREN, KLANTEN]) {
    return { userId: 'u_test', def: emptyDefinition(), _datatables: datatables };
}

const lit = (value) => ({ kind: 'literal', value });
const ref = (path) => ({ kind: 'ref', path });
const warningsOf = (r) => (Array.isArray(r._warnings) ? r._warnings : []).join('\n');
const assertRejected = (r, why) => {
    assert.ok(r && r.error, `${why}: expected an error, got ${JSON.stringify(r)}`);
    assert.match(String(r._fixHint || ''), /^Reject reason: /, `${why}: hint must start with "Reject reason:" — got ${JSON.stringify(r)}`);
};

// list → read (one per file) → extract (one per read): the chain every
// invoice brief builds. The extraction declares the six Facturen columns.
const CHAIN = [
    { tempId: 'list_files', type: 'integration_action', spec: { tool: 'nextcloud_list_files', inputs: { path: lit('/Invoices-Test') }, label: 'Lijst bestanden' } },
    { tempId: 'read_pdf', type: 'integration_action', spec: { tool: 'nextcloud_read_file', inputs: { path: ref('loop.file.path') }, forEach: { itemVar: 'file', overRef: 'steps.$list_files.output.items' }, label: 'Lees PDF' } },
    {
        tempId: 'extract_data', type: 'data_extraction',
        spec: {
            forEach: { itemVar: 'res', overRef: 'steps.$read_pdf.output.results' },
            source: ref('loop.res.output.content'),
            fields: EXTRACTION_FIELDS.map(name => ({ name, type: ['datum', 'leverancier', 'factuurnummer'].includes(name) ? 'string' : 'number' })),
            label: 'Extraheer data uit PDF',
        },
    },
];

// The trace entry, byte for byte.
const MEASURED_ENTRY = {
    tempId: 'add_row', type: 'datatable',
    spec: {
        afterStepId: '$extract_data',
        datatableId: { kind: 'literal', value: 'Facturen' },
        fields: {
            btw: { kind: 'ref', path: 'loop.e.output.btw' },
            datum: { kind: 'ref', path: 'loop.e.output.datum' },
            excl_btw: { kind: 'ref', path: 'loop.e.output.excl_btw' },
            factuurnummer: { kind: 'ref', path: 'loop.e.output.factuurnummer' },
            leverancier: { kind: 'ref', path: 'loop.e.output.leverancier' },
            totaal: { kind: 'ref', path: 'loop.e.output.totaal' },
        },
        forEach: { itemVar: 'e', overRef: 'steps.$extract_data.output.results' },
        op: 'append',
    },
};

/** Builds the chain on `dw`; returns the extraction step's real id. */
async function withChain(dw) {
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const r = await applyToolCall('builder_add_steps', { steps: structuredClone(CHAIN) }, dw);
    assert.ok(!r.error, `chain: ${r.error}`);
    return r.idMap.extract_data;
}

test('(25) the measured entry, verbatim, lands on the FIRST call — read, said, and valid', async () => {
    const dw = catalogWrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const r = await applyToolCall('builder_add_steps', { steps: [...structuredClone(CHAIN), structuredClone(MEASURED_ENTRY)] }, dw);
    assert.ok(!r.error, r.error);
    const dt = dw.def.steps.find(s => s.type === 'datatable');
    assert.ok(dt, 'the datatable step was added');
    assert.strictEqual(dt.op, 'add_row');
    assert.strictEqual(dt.datatableId, 'tbl_1a2b3c');
    assert.strictEqual(dt.datatableKey, 'facturen');
    assert.deepStrictEqual(Object.keys(dt.values).sort(), [...EXTRACTION_FIELDS].sort());
    for (const [k, v] of Object.entries(dt.values)) assert.strictEqual(v.kind, 'ref', `values.${k} stays a ref`);
    assert.strictEqual(dt.forEach.itemVar, 'e');
    assert.ok(!('fields' in dt), 'the foreign key never reaches the step');
    const w = warningsOf(r);
    for (const needle of ['op "append" read as "add_row"', '"fields" read as values', 'datatableId was sent as a binding object', 'resolved to tbl_1a2b3c']) {
        assert.ok(w.includes(needle), `_warnings must say: ${needle}\n${w}`);
    }
    const v = validateDefinition(dw.def, { deliverableEvents: [] });
    assert.deepStrictEqual((v.errors || []).filter(e => String(e.code).startsWith('datatable')), [], JSON.stringify(v.errors));
});

test('(26) column TITLES are re-keyed to column keys in values, matchColumn, where and sort — each said', async () => {
    const dw = catalogWrap();
    const save = await applyToolCall('builder_add_datatable', {
        op: 'save_row', datatableId: 'tbl_1a2b3c', matchColumn: 'Factuurnummer',
        values: { 'Excl. btw': lit(10), Datum: lit('2026-01-01'), Factuurnummer: lit('F-1') },
    }, dw);
    assert.ok(!save.error, save.error);
    assert.deepStrictEqual(Object.keys(save.added.values), ['excl_btw', 'datum', 'factuurnummer'], 'key order kept');
    assert.deepStrictEqual(save.added.values.excl_btw, lit(10));
    assert.strictEqual(save.added.matchColumn, 'factuurnummer');
    const w = warningsOf(save);
    assert.match(w, /values key "Excl\. btw" mapped to column key "excl_btw"/);
    assert.match(w, /values key "Datum" mapped to column key "datum"/);
    assert.match(w, /matchColumn "Factuurnummer" mapped to column key "factuurnummer"/);

    const find = await applyToolCall('builder_add_datatable', {
        op: 'find_rows', datatableId: 'tbl_1a2b3c',
        where: [{ field: 'Leverancier', op: 'eq', value: lit('x') }, { field: 'created_at', op: 'gt', value: lit('2026-01-01') }],
        sort: [{ field: 'Datum', dir: 'desc' }],
    }, dw);
    assert.ok(!find.error, find.error);
    assert.strictEqual(find.added.where[0].field, 'leverancier');
    assert.strictEqual(find.added.where[1].field, 'created_at', 'a system column is fine in a condition');
    assert.deepStrictEqual(Object.keys(find.added.where[0]), ['field', 'op', 'value'], 'a where entry is still rebuilt from its three keys');
    assert.deepStrictEqual(find.added.sort, [{ field: 'datum', dir: 'desc' }]);
    assert.match(warningsOf(find), /where\[0\]\.field "Leverancier" mapped to column key "leverancier"/);
    assert.match(warningsOf(find), /sort\[0\]\.field "Datum" mapped to column key "datum"/);
});

test('(27) an unknown column is refused with the whole column list; every unknown key is named at once', async () => {
    const dw = catalogWrap();
    const one = await applyToolCall('builder_add_datatable', { op: 'add_row', datatableId: 'tbl_1a2b3c', values: { amount: lit(1) } }, dw);
    assertRejected(one, 'unknown column');
    assert.match(one.error, /values names a column "amount" that "Facturen" does not have/);
    assert.match(one.error, /datum \("Datum"\), leverancier \("Leverancier"\), factuurnummer \("Factuurnummer"\), excl_btw \("Excl\. btw"\), btw \("Btw"\), totaal \("Totaal"\)/);
    assert.match(one._fixHint, /^Reject reason: unknown column key/);
    const two = await applyToolCall('builder_add_datatable', { op: 'add_row', datatableId: 'tbl_1a2b3c', values: { amount: lit(1), vendor: lit('x') } }, dw);
    assertRejected(two, 'two unknown columns');
    assert.match(two.error, /columns "amount", "vendor"/);
    assert.strictEqual(dw.def.steps.length, 0, 'nothing was added');
});

test('(28) a key that fits two columns is refused, never guessed; two keys for one column likewise', async () => {
    const twoBtw = { ...FACTUREN, columns: FACTUREN.columns.concat([{ key: 'btw_2', name: 'BTW.', type: 'number' }]) };
    const dw = catalogWrap([twoBtw]);
    const amb = await applyToolCall('builder_add_datatable', { op: 'add_row', datatableId: 'tbl_1a2b3c', values: { 'BTW ': lit(1) } }, dw);
    assertRejected(amb, 'ambiguous column');
    assert.match(amb.error, /matches two columns/);
    const collapse = await applyToolCall('builder_add_datatable', { op: 'add_row', datatableId: 'tbl_1a2b3c', values: { excl_btw: lit(1), 'Excl. btw': lit(2) } }, dw);
    assertRejected(collapse, 'two keys, one column');
    assert.match(collapse.error, /send each column once/);
});

test('(29) op aliases are read and said; an unknown op is refused; an absent op is find_rows only without values', async () => {
    const dw = catalogWrap();
    const rows = [['insert', 'add_row'], ['upsert', 'save_row'], ['list', 'find_rows'], ['count', 'count_rows'], ['edit', 'update_rows'], ['remove', 'delete_rows'], ['Create Row', 'add_row']];
    for (const [alias, op] of rows) {
        const r = await applyToolCall('builder_add_datatable', { op: alias, datatableId: 'tbl_1a2b3c' }, dw);
        assert.ok(!r.error, `${alias}: ${r.error}`);
        assert.strictEqual(r.added.op, op, alias);
        assert.ok(warningsOf(r).includes(`op "${alias}" read as "${op}"`), `${alias}: ${warningsOf(r)}`);
    }
    const bad = await applyToolCall('builder_add_datatable', { op: 'frobnicate', datatableId: 'tbl_1a2b3c' }, dw);
    assertRejected(bad, 'unknown op');
    assert.match(bad._fixHint, /^Reject reason: unknown datatable op/);
    const noOp = await applyToolCall('builder_add_datatable', { datatableId: 'tbl_1a2b3c', values: { datum: lit('2026-01-01') } }, dw);
    assertRejected(noOp, 'absent op with values');
    assert.match(noOp.error, /op is required — this step carries values/);
    const read = await applyToolCall('builder_add_datatable', { datatableId: 'tbl_1a2b3c' }, dw);
    assert.ok(!read.error, read.error);
    assert.strictEqual(read.added.op, 'find_rows');
    assert.match(warningsOf(read), /read as find_rows/);
});

test('(30) the table resolves by id, by key, by name, and by key when the id is foreign; an unknown one lists what exists', async () => {
    const dw = catalogWrap();
    const exact = await applyToolCall('builder_add_datatable', { op: 'find_rows', datatableId: 'tbl_1a2b3c' }, dw);
    assert.ok(!exact.error, exact.error);
    assert.strictEqual(exact.added.datatableId, 'tbl_1a2b3c');
    assert.strictEqual(exact.added.datatableKey, 'facturen', 'the key is written from the catalog');
    assert.ok(!/resolved/.test(warningsOf(exact)), `an exact id has nothing to say: ${warningsOf(exact)}`);

    const byKey = await applyToolCall('builder_add_datatable', { op: 'find_rows', datatableId: 'facturen' }, dw);
    assert.ok(!byKey.error, byKey.error);
    assert.strictEqual(byKey.added.datatableId, 'tbl_1a2b3c');
    assert.match(warningsOf(byKey), /datatableId "facturen" resolved to tbl_1a2b3c .* by its key/);

    const imported = await applyToolCall('builder_add_datatable', { op: 'find_rows', datatableId: 'tbl_fact01', datatableKey: 'facturen' }, dw);
    assert.ok(!imported.error, imported.error);
    assert.strictEqual(imported.added.datatableId, 'tbl_1a2b3c');
    assert.match(warningsOf(imported), /is not a table here; datatableKey "facturen" resolved it/);

    const unknown = await applyToolCall('builder_add_datatable', { op: 'find_rows', datatableId: 'Orders' }, dw);
    assertRejected(unknown, 'unknown table');
    assert.match(unknown.error, /There is no datatable "Orders"/);
    assert.match(unknown.error, /tbl_1a2b3c/);
});

test('(31) an EMPTY catalog refuses every datatable step with a do-not-retry hint; no catalog stays permissive', async () => {
    const none = await applyToolCall('builder_add_datatable', { op: 'find_rows', datatableId: 'tbl_1a2b3c' }, catalogWrap([]));
    assertRejected(none, 'no tables');
    assert.match(none.error, /has no datatables/);
    assert.match(none._fixHint, /Do not retry/);
    const dw = freshWrap();
    const ok = await applyToolCall('builder_add_datatable', { op: 'find_rows', datatableId: 'tbl_whatever' }, dw);
    assert.ok(!ok.error, ok.error);
    assert.strictEqual(ok.added.datatableId, 'tbl_whatever', 'without a catalog the id is kept as sent');
});

test('(32) a write on a table this user can only read is refused before it can fail at run time; a read is fine', async () => {
    const dw = catalogWrap();
    const w = await applyToolCall('builder_add_datatable', { op: 'add_row', datatableId: 'tbl_k1', values: { naam: lit('x') } }, dw);
    assertRejected(w, 'write on read-only');
    assert.match(w.error, /"Klanten" is read-only for this user, so add_row would fail at run time/);
    assert.match(w._fixHint, /^Reject reason: no write access/);
    const r = await applyToolCall('builder_add_datatable', { op: 'find_rows', datatableId: 'tbl_k1' }, dw);
    assert.ok(!r.error, r.error);
});

test('(33) without a catalog a title in datatableKey is dropped and said; a ref for the table is refused either way', async () => {
    const dw = freshWrap();
    const r = await applyToolCall('builder_add_datatable', { op: 'find_rows', datatableId: 'tbl_x', datatableKey: 'Facturen' }, dw);
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.added.datatableKey, '');
    assert.match(warningsOf(r), /datatableKey "Facturen" is not a table key .* dropped/);
    const bad = await applyToolCall('builder_add_datatable', { op: 'find_rows', datatableId: ref('vars.table') }, dw);
    assertRejected(bad, 'table by ref');
    assert.match(bad.error, /cannot be a ref or template/);
});

test('(34) a values ref over an extraction fan-out must name a declared field: a spelling is corrected, a stranger is refused', async () => {
    const dw = catalogWrap();
    const ex = await withChain(dw);
    const fixed = await applyToolCall('builder_add_datatable', {
        op: 'add_row', datatableId: 'tbl_1a2b3c',
        forEach: { overRef: `steps.${ex}.output.results`, itemVar: 'x' },
        values: { btw: ref('loop.x.output.BTW'), datum: ref('loop.x.output.datum') },
    }, dw);
    assert.ok(!fixed.error, fixed.error);
    assert.deepStrictEqual(fixed.added.values.btw, ref('loop.x.output.btw'));
    assert.deepStrictEqual(fixed.added.values.datum, ref('loop.x.output.datum'), 'a declared field passes untouched');
    assert.match(warningsOf(fixed), /values\.btw read loop\.x\.output\.BTW — the extraction declares "btw"; path corrected\./);

    const bad = await applyToolCall('builder_add_datatable', {
        op: 'add_row', datatableId: 'tbl_1a2b3c',
        forEach: { overRef: `steps.${ex}.output.results`, itemVar: 'x' },
        values: { totaal: ref('loop.x.output.amount') },
    }, dw);
    assertRejected(bad, 'undeclared extraction field');
    assert.match(bad.error, new RegExp(`values\\.totaal reads loop\\.x\\.output\\.amount, but the extraction step ${ex} declares only: datum, leverancier`));
    assert.match(bad._fixHint, /^Reject reason: a values binding names a field the extraction does not produce/);
});

test('(34b) a ref path carrying JSON debris is trimmed server-side and builds — the Gemma tail never reaches the refusal loop', async () => {
    const dw = catalogWrap();
    const ex = await withChain(dw);
    // The measured Gemma-4 corruption, verbatim (findings F1, 2026-09-17): a
    // valid path plus an escape/punctuation tail the model cannot stop
    // emitting — before the trim this was refused 3× and the turn stopped.
    const r = await applyToolCall('builder_add_datatable', {
        op: 'add_row', datatableId: 'tbl_1a2b3c',
        forEach: { overRef: `steps.${ex}.output.results`, itemVar: 'x' },
        values: { leverancier: ref('loop.x.output.leverancier\\"}}}},tempId:'), datum: ref('loop.x.output.datum') },
    }, dw);
    assert.ok(!r.error, r.error);
    assert.deepStrictEqual(r.added.values.leverancier, ref('loop.x.output.leverancier'));
    assert.deepStrictEqual(r.added.values.datum, ref('loop.x.output.datum'), 'a clean path passes untouched');
    assert.match(warningsOf(r), /values\.leverancier: ref path ".*" carried JSON debris after the real path — read as "loop\.x\.output\.leverancier"\./);

    // The same debris in forEach.overRef is trimmed (sanitizeForEach shares the normaliser).
    const r2 = await applyToolCall('builder_add_datatable', {
        op: 'add_row', datatableId: 'tbl_1a2b3c',
        forEach: { overRef: `steps.${ex}.output.results\\"}}}`, itemVar: 'x' },
        values: { datum: ref('loop.x.output.datum') },
    }, dw);
    assert.ok(!r2.error, r2.error);
    assert.strictEqual(r2.added.forEach.overRef, `steps.${ex}.output.results`);
});

test('(35) values reading loop.<var> on a step with no forEach is refused where the model can still fix it', async () => {
    const dw = freshWrap();
    const r = await applyToolCall('builder_add_datatable', { op: 'add_row', datatableId: 'tbl_1a2b3c', values: { a: ref('loop.x.output.a') } }, dw);
    assertRejected(r, 'unbound loop var');
    assert.match(r.error, /has no forEach, so loop\.x is not bound/);
});

test('(36) builder_update_step speaks the same vocabulary: fields→values with title keys, op aliases, and a resolved datatableId', async () => {
    const dw = catalogWrap();
    const added = (await applyToolCall('builder_add_datatable', {
        op: 'save_row', datatableId: 'tbl_1a2b3c', matchColumn: 'factuurnummer', values: { factuurnummer: lit('F-1') },
    }, dw)).added;

    const fields = await applyToolCall('builder_update_step', { stepId: added.id, patch: { fields: { 'Excl. btw': lit(1) } } }, dw);
    assert.ok(!fields.error, fields.error);
    assert.deepStrictEqual(fields.updated.values, { factuurnummer: lit('F-1'), excl_btw: lit(1) }, 'merged onto the existing column, under its key');
    assert.match(warningsOf(fields), /"fields" read as values/);
    assert.match(warningsOf(fields), /values key "Excl\. btw" mapped to column key "excl_btw"/);

    const op = await applyToolCall('builder_update_step', { stepId: added.id, patch: { op: 'append' } }, dw);
    assert.ok(!op.error, op.error);
    assert.strictEqual(op.updated.op, 'add_row');
    assert.match(warningsOf(op), /op "append" read as "add_row"/);

    const same = await applyToolCall('builder_update_step', { stepId: added.id, patch: { datatableId: 'Facturen' } }, dw);
    assert.ok(!same.error, `the table the step already uses is a no-op, not a re-point: ${same.error}`);
    assert.strictEqual(same.updated.datatableId, 'tbl_1a2b3c');
    assert.match(warningsOf(same), /nothing to change/);

    // An import arrives with the id blanked; the catalog fills BOTH fields.
    const noCatalog = catalogWrap(null);
    const blank = (await applyToolCall('builder_add_datatable', { op: 'find_rows', datatableId: '' }, noCatalog)).added;
    assert.strictEqual(blank.datatableId, '');
    noCatalog._datatables = [FACTUREN, KLANTEN];
    const filled = await applyToolCall('builder_update_step', { stepId: blank.id, patch: { datatableId: 'Facturen' } }, noCatalog);
    assert.ok(!filled.error, filled.error);
    assert.strictEqual(filled.updated.datatableId, 'tbl_1a2b3c');
    assert.strictEqual(filled.updated.datatableKey, 'facturen');

    const elsewhere = (await applyToolCall('builder_add_datatable', { op: 'find_rows', datatableId: 'tbl_k1' }, dw)).added;
    const repoint = await applyToolCall('builder_update_step', { stepId: elsewhere.id, patch: { datatableId: 'Facturen' } }, dw);
    assert.match(repoint.error, /already uses datatable "tbl_k1"/, 'a different table is still not a patch');
});

test('(37) builder_replace_step into a datatable goes through the same reads and forwards what it read', async () => {
    const dw = catalogWrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const set = (await applyToolCall('builder_add_set', { fields: { x: lit(1) } }, dw)).added;
    const r = await applyToolCall('builder_replace_step', {
        stepId: set.id, newType: 'datatable',
        spec: { op: 'append', datatableId: 'tbl_1a2b3c', values: { 'Excl. btw': lit(1) } },
    }, dw);
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.replaced.id, set.id, 'the id survives the swap');
    assert.strictEqual(r.replaced.op, 'add_row');
    assert.deepStrictEqual(r.replaced.values, { excl_btw: lit(1) });
    assert.match(warningsOf(r), /op "append" read as "add_row"/);
    assert.match(warningsOf(r), /values key "Excl\. btw" mapped to column key "excl_btw"/);
});

test('(38) a bare-string repair is said under the step\'s own field names, on add and on patch', async () => {
    const dw = freshWrap();
    const r = await applyToolCall('builder_add_datatable', {
        op: 'update_rows', datatableId: 'tbl_1a2b3c',
        values: { status: 'new' }, where: [{ field: 'email', op: 'eq', value: 'a@b.c' }],
    }, dw);
    assert.ok(!r.error, r.error);
    assert.match(warningsOf(r), /^values\.status: wrapped bare value as \{kind:"literal", value:…\}/m);
    assert.match(warningsOf(r), /^where\[0\]\.value: wrapped bare value/m);
    assert.ok(!/inputs\./.test(warningsOf(r)), 'a datatable step has no inputs map to point at');
    const p = await applyToolCall('builder_update_step', { stepId: r.added.id, patch: { values: { note: 'x' } } }, dw);
    assert.ok(!p.error, p.error);
    assert.match(warningsOf(p), /^values\.note: wrapped bare value/m);
});

test('(39) the full echo shows a datatable step\'s op, table and value keys, and an extraction\'s declared fields', async () => {
    const dw = catalogWrap();
    const ex = await withChain(dw);
    dw._resultDetail = 'full';
    const r = await applyToolCall('builder_add_datatable', {
        op: 'save_row', datatableId: 'tbl_1a2b3c', matchColumn: 'factuurnummer',
        forEach: { overRef: `steps.${ex}.output.results`, itemVar: 'e' },
        values: { factuurnummer: ref('loop.e.output.factuurnummer'), totaal: ref('loop.e.output.totaal') },
    }, dw);
    assert.ok(!r.error, r.error);
    assert.ok(Array.isArray(r._draftSteps), 'the lean profile carries the structured echo');
    const dt = r._draftSteps.find(s => s.id === r.added.id);
    assert.strictEqual(dt.op, 'save_row');
    assert.strictEqual(dt.table, 'facturen (tbl_1a2b3c)');
    assert.deepStrictEqual(dt.values, ['factuurnummer', 'totaal']);
    assert.strictEqual(dt.matchColumn, 'factuurnummer');
    const exEcho = r._draftSteps.find(s => s.id === ex);
    assert.deepStrictEqual(exEcho.fields, EXTRACTION_FIELDS);
    const unlinked = { id: 'dt_x', type: 'datatable', op: 'find_rows', datatableId: '', datatableKey: 'facturen', values: {} };
    const { summariseDraftSteps } = require('./builderTools/modelPayload');
    assert.strictEqual(summariseDraftSteps({ steps: [unlinked] })[0].table, 'facturen (unlinked)');
});


// ─── Consent to bind an EXISTING table (datatableApproval) ───────────────────
//
// In a chat work mode `_approvedDatatableIds` is a Set; a step may only be
// bound to an existing table the user named, picked, or the flow already uses.
// Over MCP the Set is absent and nothing is gated.

const approvedWrap = (ids = [], datatables = [FACTUREN, KLANTEN]) => ({
    userId: 'u_test', def: emptyDefinition(), _datatables: datatables, _approvedDatatableIds: new Set(ids),
});
const PENDING_ROW = {
    id: 'pending:1', key: 'nieuw', name: 'Nieuw', canWrite: true, managedKind: null, pending: true, scope: 'org',
    columns: [{ key: 'a', name: 'A', type: 'text', unique: false }],
};

test('(36) an existing table the user did not choose is refused with a ready question — through every route to a datatable step', async () => {
    const entry = { type: 'datatable', spec: { op: 'find_rows', datatableId: 'tbl_1a2b3c' } };

    const add = approvedWrap();
    const viaAdd = await applyToolCall('builder_add_datatable', { op: 'find_rows', datatableId: 'tbl_1a2b3c' }, add);
    assert.strictEqual(viaAdd.code, 'datatable_choice_required');
    assert.deepStrictEqual(viaAdd._askArgs.questions[0].datatableIds[0], 'tbl_1a2b3c');
    assert.strictEqual(add.def.steps.length, 0, 'nothing was added');

    const batch = approvedWrap();
    const viaBatch = await applyToolCall('builder_add_steps', { steps: [entry] }, batch);
    assert.ok(viaBatch.error, JSON.stringify(viaBatch));
    assert.match(JSON.stringify(viaBatch), /datatable_choice_required|has not chosen the table/);
    assert.strictEqual(batch.def.steps.length, 0);

    const rep = approvedWrap();
    const note = await applyToolCall('builder_add_set', { fields: { x: lit('1') } }, rep);
    const viaReplace = await applyToolCall('builder_replace_step', { stepId: note.added.id, newType: 'datatable', spec: { op: 'find_rows', datatableId: 'tbl_1a2b3c' } }, rep);
    assert.strictEqual(viaReplace.code, 'datatable_choice_required');
    assert.strictEqual(rep.def.steps[0].type, 'set', 'the step was not replaced');
});

test('(36b) update_step filling a blank datatable step is gated too', async () => {
    const dw = { userId: 'u_test', def: emptyDefinition() };
    const blank = await applyToolCall('builder_add_datatable', { op: 'find_rows' }, dw);
    assert.ok(!blank.error, blank.error);
    dw._datatables = [FACTUREN, KLANTEN];
    dw._approvedDatatableIds = new Set();
    const refused = await applyToolCall('builder_update_step', { stepId: blank.added.id, patch: { datatableId: 'tbl_1a2b3c' } }, dw);
    assert.strictEqual(refused.code, 'datatable_choice_required');
    assert.strictEqual(dw.def.steps[0].datatableId, '');
    dw._approvedDatatableIds.add('tbl_1a2b3c');
    const filled = await applyToolCall('builder_update_step', { stepId: blank.added.id, patch: { datatableId: 'tbl_1a2b3c' } }, dw);
    assert.ok(!filled.error, filled.error);
    assert.strictEqual(dw.def.steps[0].datatableId, 'tbl_1a2b3c');
});

test('(37) a named, bound, carried or pending table passes the gate; without the Set nothing is gated', async () => {
    const named = await applyToolCall('builder_add_datatable', { op: 'find_rows', datatableId: 'tbl_1a2b3c' }, approvedWrap(['tbl_1a2b3c']));
    assert.ok(!named.error, named.error);
    const pending = await applyToolCall('builder_add_datatable', { op: 'add_row', datatableId: 'pending:1', datatableKey: 'nieuw', values: { a: lit('x') } }, approvedWrap([], [FACTUREN, PENDING_ROW]));
    assert.ok(!pending.error, pending.error);
    assert.strictEqual(pending.added.datatableId, 'pending:1');
    assert.strictEqual(pending.added.datatableKey, 'nieuw');
    const mcp = await applyToolCall('builder_add_datatable', { op: 'find_rows', datatableId: 'tbl_1a2b3c' }, catalogWrap());
    assert.ok(!mcp.error, 'MCP sets no approval Set');
});

test('(38) the columns of a pending table are checked like a real one; a forged pending id is refused', async () => {
    const dw = approvedWrap([], [FACTUREN, PENDING_ROW]);
    const bad = await applyToolCall('builder_add_datatable', { op: 'add_row', datatableId: 'pending:1', values: { zzz: lit('x') } }, dw);
    assertRejected(bad, 'unknown column on a pending table');
    assert.match(bad.error, /does not have/);
    const forged = await applyToolCall('builder_add_datatable', { op: 'find_rows', datatableId: 'pending:7' }, dw);
    assert.match(forged.error, /pending ids exist only inside the proposal/);
    const noCatalog = await applyToolCall('builder_add_datatable', { op: 'find_rows', datatableId: 'pending:1' }, freshWrap());
    assert.match(noCatalog.error, /pending ids exist only inside the proposal/, 'refused even when there is no catalog to check against');
});

test('(39) an approved table that is read-only is still refused for a write', async () => {
    const r = await applyToolCall('builder_add_datatable', { op: 'add_row', datatableId: 'tbl_k1', values: { naam: lit('x') } }, approvedWrap(['tbl_k1']));
    assert.match(r.error, /read-only for this user/);
});

test('(40) a batch refusal for an unchosen table carries the question to ask and tells the model not to pick one', async () => {
    const dw = approvedWrap();
    const r = await applyToolCall('builder_add_steps', { steps: [{ tempId: 't', type: 'datatable', spec: { op: 'find_rows', datatableId: 'tbl_1a2b3c' } }] }, dw);
    assert.strictEqual(r.code, 'datatable_choice_required');
    assert.deepStrictEqual(r._askArgs.questions[0].datatableIds[0], 'tbl_1a2b3c');
    assert.ok(!('datatableId' in r.resendAs.args.steps[0].spec), 'the refused value is not suggested back');
    assert.match(r._fixHint, /Ask the user \(builder_ask_questions with _askArgs\)/);
    assert.doesNotMatch(r._fixHint, /Fill it with one of the options/);
});
