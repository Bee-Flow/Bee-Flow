/**
 * write_table (execWriteTable.mts): a table of the run as an .xlsx or .csv file
 * of the run. The writers are the real ones; the table store, the file ledger
 * and the storage check are fakes.
 *
 * Run: node --test core/automationRunner/execWriteTable.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { execWriteTable } = require('./execWriteTable.mts');
const { normalizeWriteTableStep, validateWriteTableStep } = require('../automationModel/tableOps/writeTableSpec.mts');

const COLUMNS = [{ key: 'ref', label: 'Ref' }, { key: 'article', label: 'Article' }, { key: 'price', label: 'Net price' }, { key: 'flags', label: 'Flags' }];
const ROWS = [
    { ref: '1', article: 'K-100', price: 1.255, flags: '' },
    { ref: '2', article: '=HYPERLINK("x")', price: 4.1, flags: 'unit_unknown' },
    { ref: '3', article: 'NOPE', price: null, flags: 'no_price; not_found' },
];
const HANDLE = { kind: 'table', tableId: `rtb_${'a'.repeat(32)}`, columns: COLUMNS, rowCount: 3, name: 'Priced' };
const ctx = { userId: 'u1', automationId: 'a1', runId: 'r1' };

function harness(over = {}) {
    const kept = [];
    const opened = [];
    const deps = {
        openTable: async (h, scope) => { opened.push({ h, scope }); return h.tableId === HANDLE.tableId ? { columns: COLUMNS, rows: () => ROWS } : null; },
        storageAvailable: () => true,
        keepGeneratedFile: async (a) => { kept.push(a); return { id: 'gf_1' }; },
        noteRunWarning: () => {},
        ...over,
    };
    return { deps, kept, opened };
}

const runState = { trigger: { output: { project: 'P-42' } }, steps: { priced: { output: { table: HANDLE } } }, vars: {} };
const step = (extra = {}) => ({ id: 'w1', type: 'write_table', label: 'Priced list', source: { kind: 'ref', path: 'steps.priced.output.table' }, ...extra });

async function sheetXml(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    return { sheet: await zip.file('xl/worksheets/sheet1.xml').async('string'), styles: zip.file('xl/styles.xml'), types: await zip.file('[Content_Types].xml').async('string') };
}

test('xlsx: chosen columns in order with their headers, flagged rows highlighted, kept as a generated file', async () => {
    const { deps, kept, opened } = harness();
    const out = await execWriteTable(step({
        fileName: 'Priced {{trigger.output.project}}',
        columns: [{ column: 'Article' }, { column: 'price', header: 'Unit price' }, 'flags'],
        highlightColumn: 'Flags',
    }), ctx, runState, 'live', deps);
    assert.equal(out.output.filename, 'Priced P-42.xlsx');
    assert.equal(out.output.rowCount, 3);
    assert.equal(out.output.highlightedRows, 2);
    assert.deepEqual(out.output.columns, [{ key: 'article', header: 'Article' }, { key: 'price', header: 'Unit price' }, { key: 'flags', header: 'Flags' }]);
    assert.deepEqual(out.output.sourceHandle, { kind: 'generated_file', fileId: 'gf_1' });
    assert.equal(opened[0].scope.runId, 'r1');
    assert.equal(kept.length, 1);
    assert.equal(kept[0].filename, 'Priced P-42.xlsx');
    assert.equal(kept[0].ttlDays, 7);
    const { sheet, styles, types } = await sheetXml(kept[0].buffer);
    assert.ok(styles, 'a styled workbook carries styles.xml');
    assert.match(types, /styles\+xml/);
    assert.match(sheet, /<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Article<\/t>/);
    assert.match(sheet, /<row r="2">/, 'an unflagged row is plain');
    assert.match(sheet, /<row r="3" s="2" customFormat="1">/, 'a flagged row is highlighted');
    assert.match(sheet, /<c r="B2"><v>1.255<\/v><\/c>/, 'a number stays a number');
    assert.match(sheet, /<c r="A3" s="2" t="inlineStr"><is><t xml:space="preserve">=HYPERLINK/, 'formula-shaped text stays text');
    assert.doesNotMatch(sheet, /<f>/);
    assert.match(sheet, /state="frozen"/);
});

test('csv: every column, the delimiter, formula-shaped text neutralised; a highlight is a warning', async () => {
    const { deps, kept } = harness();
    const out = await execWriteTable(step({ format: 'csv', highlightColumn: 'flags' }), ctx, runState, 'live', deps);
    assert.equal(out.output.filename, 'Priced list.csv');
    assert.equal(out.output.mimeType, 'text/csv; charset=utf-8');
    const text = kept[0].buffer.toString('utf8');
    assert.equal(text.split('\r\n')[0], '﻿Ref;Article;Net price;Flags');
    assert.match(text, /\r\n2;'=HYPERLINK\(""x""\)|\r\n2;"'=HYPERLINK\(""x""\)"/);
    assert.equal(out.output.warnings.length, 1);
});

test('a list of rows is a source too', async () => {
    const { deps, kept } = harness();
    const state = { steps: { code: { output: { result: [{ a: 1, b: 'x' }, { a: 2, b: 'y' }] } } } };
    const out = await execWriteTable(step({ source: { kind: 'ref', path: 'steps.code.output.result' }, format: 'csv', delimiter: ',' }), ctx, state, 'live', deps);
    assert.equal(out.output.rowCount, 2);
    assert.equal(kept[0].buffer.toString('utf8'), '﻿a,b\r\n1,x\r\n2,y\r\n');
});

test('a dry run keeps nothing and returns the live shape', async () => {
    const { deps, kept } = harness();
    const out = await execWriteTable(step({ columns: ['article'] }), ctx, runState, 'dry_run', deps);
    assert.equal(out.dryRunSynthesised, true);
    assert.deepEqual(out.output.sourceHandle, { kind: 'generated_file', fileId: 'dry-run' });
    assert.equal(out.output.filename, 'Priced list.xlsx');
    assert.equal(kept.length, 0);
});

test('refusals: no source, an unknown column, an expired table, too many rows, no storage', async () => {
    const { deps } = harness();
    await assert.rejects(execWriteTable(step({ source: null }), ctx, runState, 'live', deps), (e) => e.errorClass === 'table_source_missing');
    await assert.rejects(execWriteTable(step({ columns: ['nope'] }), ctx, runState, 'live', deps), (e) => e.errorClass === 'write_table_column_missing' && /nope/.test(e.message));
    await assert.rejects(execWriteTable(step({ highlightColumn: 'nope' }), ctx, runState, 'live', deps), (e) => e.errorClass === 'write_table_column_missing');
    const gone = { steps: { priced: { output: { table: { ...HANDLE, tableId: `rtb_${'b'.repeat(32)}` } } } } };
    await assert.rejects(execWriteTable(step(), ctx, gone, 'live', deps), (e) => e.errorClass === 'table_not_found');
    const capped = harness({ tableLimits: () => ({ maxRows: 1_000_000, writeMaxRows: 2 }) });
    await assert.rejects(execWriteTable(step(), ctx, runState, 'live', capped.deps), (e) => e.errorClass === 'table_too_large');
    const unlimited = harness({ tableLimits: () => ({ maxRows: 1_000_000, writeMaxRows: 0 }) });
    assert.equal((await execWriteTable(step(), ctx, runState, 'live', unlimited.deps)).output.rowCount, 3);
    const noStorage = harness({ storageAvailable: () => false });
    await assert.rejects(execWriteTable(step(), ctx, runState, 'live', noStorage.deps), (e) => e.errorClass === 'storage_unavailable');
    await assert.rejects(execWriteTable(step({ source: { kind: 'ref', path: 'steps.none.output' } }), ctx, runState, 'live', deps), (e) => e.errorClass === 'table_source_unresolved');
});

test('the spec: defaults, clamping and findings', () => {
    const n = normalizeWriteTableStep({ source: { kind: 'ref', path: 'x.y' }, format: 'pdf', expiresInDays: 500, delimiter: 'tab', columns: ['a', { key: 'b', label: 'B!' }, {}] });
    assert.equal(n.format, 'xlsx');
    assert.equal(n.expiresInDays, 90);
    assert.equal(n.delimiter, '\t');
    assert.deepEqual(n.columns, [{ column: 'a', header: null }, { column: 'b', header: 'B!' }]);
    const codes = validateWriteTableStep({ format: 'pdf', delimiter: '|', columns: [{}], expiresInDays: 0, highlightColumn: 'f' }).map((f) => f.code);
    assert.deepEqual(codes, ['write_table.source_missing', 'write_table.format_invalid', 'write_table.delimiter_invalid', 'write_table.columns_invalid', 'write_table.expires_invalid']);
    assert.deepEqual(validateWriteTableStep({ source: { kind: 'ref', path: 'a.b' }, format: 'csv', highlightColumn: 'f' }).map((f) => [f.code, f.severity]), [['write_table.highlight_in_csv', 'warning']]);
});
