'use strict';
/** read_table: source resolution, one stored table per sheet, dry run, errors. Collaborators are injected fakes. */

const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('@e965/xlsx');
const { execReadTable, defaultDeps } = require('./execReadTable');

function workbook(sheets) {
    const wb = XLSX.utils.book_new();
    for (const [name, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
    return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

function fakes({ buffer, filename = 'people.xlsx' } = {}) {
    const calls = { readSourceFile: [], writeTable: [] };
    const deps = {
        ...defaultDeps,
        readSourceFile: async (value, ctx) => {
            calls.readSourceFile.push({ value, ctx });
            return { buffer, filename, mimeType: 'application/octet-stream', size: buffer.length, kind: 'form_upload' };
        },
        writeTable: async (args) => {
            calls.writeTable.push({ ...args, rows: [...args.rows] });
            return {
                kind: 'table', tableId: `rtb_${String(calls.writeTable.length).padStart(32, '0')}`, runId: 'run-1', name: args.name,
                columns: args.columns, rowCount: args.rows.length, preview: [], expiresAt: null, provenance: args.provenance || null,
            };
        },
    };
    return { deps, calls };
}

const step = (extra = {}) => ({ id: 'read1', type: 'read_table', label: 'Read table', source: { kind: 'ref', path: 'trigger.output.upload' }, ...extra });
const state = (upload = { kind: 'form_upload', fileId: 'f1' }) => ({ trigger: { output: { upload } }, steps: {}, vars: {}, _templateWarnings: [] });
const ctx = { runId: 'run-1', automationId: 'a1', userId: 'u1' };

test('live: writes one table per sheet and returns the handles by name', async () => {
    const buffer = workbook({ People: [['Name', 'Score'], ['Ada', 3], ['Bo', 5]], Teams: [['Team'], ['Red']] });
    const { deps, calls } = fakes({ buffer });
    const { output } = await execReadTable(step({ expiresInDays: 14 }), ctx, state(), 'live', deps);

    assert.equal(calls.readSourceFile.length, 1);
    assert.deepEqual(calls.readSourceFile[0].value, { kind: 'form_upload', fileId: 'f1' });
    assert.deepEqual(calls.writeTable.map(c => [c.stepId, c.name, c.ttlDays]), [['read1', 'People', 14], ['read1', 'Teams', 14]]);
    assert.deepEqual(calls.writeTable[0].rows, [{ Name: 'Ada', Score: 3 }, { Name: 'Bo', Score: 5 }]);
    assert.equal(calls.writeTable[0].ctx, ctx);

    assert.equal(output.tables.length, 2);
    assert.equal(output.table, output.tables[0]);
    assert.deepEqual(Object.keys(output.tablesByName), ['People', 'Teams']);
    assert.equal(output.tablesByName.Teams, output.tables[1]);
    assert.deepEqual(output.sheets, [
        { name: 'People', index: 0, hidden: false, rowCount: 2, columnCount: 2, tableIndex: 0 },
        { name: 'Teams', index: 1, hidden: false, rowCount: 1, columnCount: 1, tableIndex: 1 },
    ]);
    assert.deepEqual(output.source, { filename: 'people.xlsx', format: 'xlsx', size: buffer.length });
    assert.equal(output.provenance, null);
    assert.deepEqual(output.warnings, []);
});

test('live: a skipped sheet is listed without a table; the provenance travels with each table', async () => {
    const buffer = workbook({ Data: [['A'], [1]], Info: [['Source', 'Synthetic']], Empty: [[]] });
    const { deps, calls } = fakes({ buffer });
    const { output } = await execReadTable(step(), ctx, state(), 'live', deps);
    assert.equal(calls.writeTable.length, 1);
    assert.deepEqual(calls.writeTable[0].provenance, { Source: 'Synthetic' });
    assert.deepEqual(output.provenance, { Source: 'Synthetic' });
    assert.deepEqual(output.sheets.map(s => [s.name, s.tableIndex, s.skipped]), [['Data', 0, undefined], ['Info', null, 'provenance'], ['Empty', null, 'empty']]);
    assert.deepEqual(Object.keys(output.tablesByName), ['Data']);
});

test('live: the step settings reach the reader', async () => {
    const buffer = workbook({ S: [['Title'], ['Name'], ['Ada']], T: [['Name'], ['Bo']] });
    const { deps, calls } = fakes({ buffer });
    const { output } = await execReadTable(step({ headerRow: 2, sheets: ['S'] }), ctx, state(), 'live', deps);
    assert.deepEqual(calls.writeTable.map(c => c.name), ['S']);
    assert.deepEqual(calls.writeTable[0].rows, [{ Name: 'Ada' }]);
    assert.equal(output.sheets[1].skipped, 'not_selected');
});

test('live: a file with nothing in it gives table null and a warning on the run', async () => {
    const { deps } = fakes({ buffer: workbook({ S: [[]] }) });
    const st = state();
    const { output } = await execReadTable(step(), ctx, st, 'live', deps);
    assert.equal(output.table, null);
    assert.deepEqual(output.tables, []);
    assert.match(output.warnings[0], /no table was made/);
    assert.match(st._templateWarnings[0], /^read1: /);
});

test('dry run never reads the source and returns the live shape, empty', async () => {
    const { deps, calls } = fakes({ buffer: Buffer.alloc(0) });
    const res = await execReadTable(step(), ctx, state(), 'dry_run', deps);
    assert.equal(calls.readSourceFile.length, 0);
    assert.equal(calls.writeTable.length, 0);
    assert.equal(res.dryRunSynthesised, true);
    assert.deepEqual(res.output.tables, []);
    assert.equal(res.output.table.tableId, 'dry-run');
    assert.equal(res.output.table.name, 'Sheet1');
    assert.deepEqual(res.output.table.columns, []);
    assert.deepEqual(res.output.tablesByName, {});
    assert.equal(res.output.source, null);
    assert.equal(res.output._dryRun, true);
    // even when the bound upload does not exist in a dry run
    const bare = await execReadTable(step(), ctx, { trigger: { output: {} }, steps: {} }, 'dry_run', deps);
    assert.equal(bare.dryRunSynthesised, true);
});

test('no source is table_source_missing, in both modes; an unresolved binding is too, live', async () => {
    const { deps, calls } = fakes({ buffer: Buffer.alloc(0) });
    for (const mode of ['live', 'dry_run']) {
        await assert.rejects(execReadTable(step({ source: undefined }), ctx, state(), mode, deps), { errorClass: 'table_source_missing' });
    }
    await assert.rejects(execReadTable(step(), ctx, state(null), 'live', deps), { errorClass: 'table_source_missing' });
    await assert.rejects(execReadTable(step(), ctx, { trigger: { output: {} }, steps: {} }, 'live', deps), { errorClass: 'table_source_missing' });
    assert.equal(calls.readSourceFile.length, 0);
});

test('errors from the source and the reader keep their class', async () => {
    const { deps } = fakes({ buffer: Buffer.from('a,b\n1,2\n') });
    const failing = { ...deps, readSourceFile: async () => { throw Object.assign(new Error('gone'), { errorClass: 'table_source_not_found' }); } };
    await assert.rejects(execReadTable(step(), ctx, state(), 'live', failing), { errorClass: 'table_source_not_found' });
    const bad = fakes({ buffer: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(50)]) });
    await assert.rejects(execReadTable(step(), ctx, state(), 'live', bad.deps), { errorClass: 'table_source_unsupported' });
    assert.equal(bad.calls.writeTable.length, 0);
});

test('a csv upload becomes one table named after the file', async () => {
    const { deps, calls } = fakes({ buffer: Buffer.from('a;b\n1,5;x\n'), filename: 'Export 2026.csv' });
    const { output } = await execReadTable(step(), ctx, state(), 'live', deps);
    assert.equal(calls.writeTable[0].name, 'Export 2026');
    assert.deepEqual(calls.writeTable[0].rows, [{ a: 1.5, b: 'x' }]);
    assert.equal(output.source.format, 'csv');
});
