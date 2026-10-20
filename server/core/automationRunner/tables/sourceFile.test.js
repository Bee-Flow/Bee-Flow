'use strict';

/**
 * Resolving a source binding to file bytes: verified through the ledger, never
 * through what the descriptor says, journey-scoped and size-capped.
 *
 * Run: cd server && node --test core/automationRunner/tables/sourceFile.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');
const { readSourceFile } = require('./sourceFile');
const { tableLimits } = require('./limits');

const CTX = { automationId: 'a1', runId: 'r1', rootRunId: 'r1' };
let uploads;
let generated;
let blobs;
let streamed;
let limits;

const fakeStore = {
    getClaimedFormUploadForAutomation: async (id, automationId) => uploads.find(u => u.id === id && u.automationId === automationId) || null,
    getGeneratedFileForRuns: async (id, runIds) => generated.find(f => f.id === id && runIds.includes(f.runId)) || null,
};
const fakeStorage = {
    streamFile: async (key) => {
        streamed.push(key);
        if (!(key in blobs)) { const e = new Error('missing'); e.name = 'NoSuchKey'; throw e; }
        return { stream: Readable.from([blobs[key]]), contentType: 'application/octet-stream' };
    },
};
const read = (value, ctx = CTX) => readSourceFile(value, ctx, {
    store: fakeStore, storage: fakeStorage, limits: () => limits, journeyRunIds: async (c) => (c.runId === 'r1' ? ['r1', 'r1b'] : [c.runId]),
});

beforeEach(() => {
    limits = tableLimits({});
    streamed = [];
    uploads = [
        { id: 'u1', automationId: 'a1', storageKey: 'real/u1', filename: 'real.csv', mimeType: 'text/csv', size: 5 },
        { id: 'uOther', automationId: 'a2', storageKey: 'real/other', filename: 'other.csv', mimeType: 'text/csv', size: 5 },
    ];
    generated = [
        { id: 'g1', runId: 'r1b', storageKey: 'gen/g1', filename: 'made.xlsx', mimeType: 'application/vnd.ms-excel', size: 4 },
        { id: 'gForeign', runId: 'rx', storageKey: 'gen/foreign', filename: 'f.xlsx', mimeType: 'x', size: 4 },
    ];
    blobs = {
        'real/u1': Buffer.from('a,b\n1'),
        'real/other': Buffer.from('secret'),
        'gen/g1': Buffer.from('XLSX'),
        'gen/foreign': Buffer.from('foreign'),
        'attacker/key': Buffer.from('forged'),
    };
});

test('a form upload is verified through the store and read from the row\'s key', async () => {
    const out = await read({ kind: 'form_upload', fileId: 'u1' });
    assert.strictEqual(out.buffer.toString(), 'a,b\n1');
    assert.strictEqual(out.filename, 'real.csv');
    assert.strictEqual(out.mimeType, 'text/csv');
    assert.strictEqual(out.size, 5);
    assert.strictEqual(out.kind, 'form_upload');
});

test('a forged storageKey, filename or mimeType in the descriptor is ignored', async () => {
    const out = await read({ kind: 'form_upload', fileId: 'u1', storageKey: 'attacker/key', filename: 'evil.exe', mimeType: 'application/x-evil', size: 1 });
    assert.deepStrictEqual(streamed, ['real/u1']);
    assert.strictEqual(out.filename, 'real.csv');
    assert.strictEqual(out.mimeType, 'text/csv');
    assert.strictEqual(out.buffer.toString(), 'a,b\n1');
});

test('an upload of another automation is not found', async () => {
    await assert.rejects(read({ kind: 'form_upload', fileId: 'uOther' }), { errorClass: 'table_source_not_found' });
    assert.deepStrictEqual(streamed, []);
});

test('a generated file is read through the journey of the run', async () => {
    const out = await read({ kind: 'generated_file', fileId: 'g1' });
    assert.strictEqual(out.buffer.toString(), 'XLSX');
    assert.strictEqual(out.kind, 'generated_file');
    assert.strictEqual(out.filename, 'made.xlsx');
});

test('a generated file of another journey is not found', async () => {
    await assert.rejects(read({ kind: 'generated_file', fileId: 'gForeign' }), { errorClass: 'table_source_not_found' });
    await assert.rejects(read({ kind: 'generated_file', fileId: 'g1' }, { automationId: 'a1', runId: 'r9' }), { errorClass: 'table_source_not_found' });
});

test('an object with .sourceHandle is unwrapped', async () => {
    const out = await read({ filename: 'x', sourceHandle: { kind: 'generated_file', fileId: 'g1' } });
    assert.strictEqual(out.buffer.toString(), 'XLSX');
});

test('nothing bound is table_source_missing', async () => {
    for (const v of [undefined, null, '', 'text', [], {}, { kind: 'form_upload' }, { kind: 'form_upload', fileId: '' }]) {
        await assert.rejects(read(v), { errorClass: 'table_source_missing' }, JSON.stringify(v));
    }
});

test('another kind of source is unsupported', async () => {
    await assert.rejects(read({ kind: 'url', fileId: 'x' }), { errorClass: 'table_source_unsupported' });
    await assert.rejects(read({ sourceHandle: { kind: 'gmail_attachment', fileId: 'x' } }), { errorClass: 'table_source_unsupported' });
});

test('a file past maxFileBytes is refused by its recorded size before it is read', async () => {
    limits = { ...limits, maxFileBytes: 4 };
    await assert.rejects(read({ kind: 'form_upload', fileId: 'u1' }), { errorClass: 'table_source_too_large' });
    assert.deepStrictEqual(streamed, []);
});

test('the byte cap also holds while streaming, whatever the row claims', async () => {
    uploads[0].size = 1;
    limits = { ...limits, maxFileBytes: 4 };
    await assert.rejects(read({ kind: 'form_upload', fileId: 'u1' }), { errorClass: 'table_source_too_large' });
});

test('0 means unlimited', async () => {
    limits = { ...limits, maxFileBytes: 0 };
    assert.strictEqual((await read({ kind: 'form_upload', fileId: 'u1' })).size, 5);
});

test('a live row without bytes is not found', async () => {
    delete blobs['real/u1'];
    await assert.rejects(read({ kind: 'form_upload', fileId: 'u1' }), { errorClass: 'table_source_not_found' });
});
