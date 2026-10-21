'use strict';

/**
 * The table store: write a table, open it, read a page, export CSV.
 *
 * Storage is a fake that keeps the uploaded bytes in memory (the writer still
 * goes through a real temp file), and the ledger is an in-memory fake with the
 * same contract as stores/automationStore/runTables.js: live-only reads.
 *
 * Run: cd server && node --test core/automationRunner/tables/tableStore.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { Readable, Writable } = require('node:stream');
const { makeTableStore } = require('./tableStore');
const { TABLE_ID_RE, isTableHandle } = require('./handle');
const { tableLimits } = require('./limits');

const COLS = [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'score', label: 'Score', type: 'number' },
    { key: 'done', label: 'Done', type: 'boolean' },
    { key: 'when', label: 'When', type: 'datetime' },
];
const CTX = { userId: 'u1', automationId: 'a1', runId: 'r1', rootRunId: 'r1' };

let rows;       // ledger
let blobs;      // storage key -> Buffer
let uploads;    // keys uploaded
let runs;       // run id -> run row
let journeys;   // run id -> journey ids
let available;
let limits;

const fakeStore = {
    recordRunTable: async (r) => { rows.push({ ...r, createdAt: new Date(), expiresAt: new Date(Date.now() + r.ttlMs) }); return r; },
    getRunTableForAutomation: async (id, automationId) => {
        const r = rows.find(x => x.id === id && x.automationId === automationId && x.expiresAt > new Date());
        return r ? { ...r, size: r.size } : null;
    },
    countRunTablesForRun: async (runId) => rows.filter(r => r.runId === runId).length,
    getRun: async (id) => (runs[id] ? { ...runs[id] } : null),
};
const fakeStorage = {
    isAvailable: () => available,
    buildAutomationFileKey: (owner, automation, name) => `automation-forms/${owner}/${automation}/${name}`,
    uploadFileFromPath: async (key, path, type) => {
        assert.strictEqual(type, 'application/gzip');
        blobs[key] = fs.readFileSync(path);
        uploads.push(key);
        return { key };
    },
    streamFile: async (key) => {
        if (!(key in blobs)) { const e = new Error('Object not found'); e.name = 'NoSuchKey'; throw e; }
        return { stream: Readable.from([blobs[key]]), contentLength: blobs[key].length };
    },
    deleteFile: async (key) => { delete blobs[key]; },
};

function make(over = {}) {
    return makeTableStore({
        store: fakeStore,
        storage: fakeStorage,
        journeyRunIds: async (scope) => journeys[scope.runId] || [scope.runId],
        limits: () => limits,
        ...over,
    });
}

beforeEach(() => {
    rows = []; blobs = {}; uploads = []; available = true;
    limits = tableLimits({});
    runs = {
        r1: { id: 'r1', automationId: 'a1', userId: 'owner', startedByUserId: 'owner' },
        r2: { id: 'r2', automationId: 'a1', userId: 'owner', startedByUserId: 'owner' },
        rPriv: { id: 'rPriv', automationId: 'a1', userId: 'owner', startedByUserId: 'ron', connectionsMode: 'caller' },
        r3: { id: 'r3', automationId: 'a1', userId: 'owner', startedByUserId: 'owner' },
    };
    journeys = { r1: ['r1'], r2: ['r2'], r3: ['r3'] };
});

const sample = (n) => Array.from({ length: n }, (_, i) => ({ name: `row ${i}`, score: i * 1.5, done: i % 2 === 0, when: new Date(Date.UTC(2026, 0, 1 + i)) }));
const collect = async (iterable) => { const out = []; for await (const r of iterable) out.push(r); return out; };

test('writes a gzip blob: a header line, then one JSON array per row in column order', async () => {
    const handle = await make().writeTable({ ctx: CTX, stepId: 's1', name: 'Scores', columns: COLS, rows: sample(3) });
    const [key] = uploads;
    assert.match(key, /^automation-forms\/u1\/a1\/table-[0-9a-f]{32}$/);
    const lines = zlib.gunzipSync(blobs[key]).toString('utf8').split('\n');
    assert.strictEqual(lines.pop(), '');
    assert.deepStrictEqual(JSON.parse(lines[0]), { v: 1, columns: COLS });
    assert.deepStrictEqual(JSON.parse(lines[1]), ['row 0', 0, true, '2026-01-01T00:00:00.000Z']);
    assert.strictEqual(lines.length, 4);
    assert.ok(isTableHandle(handle));
    assert.match(handle.tableId, TABLE_ID_RE);
    assert.strictEqual(handle.runId, 'r1');
    assert.strictEqual(handle.rowCount, 3);
    assert.strictEqual(handle.preview.length, 3);
    assert.ok(new Date(handle.expiresAt) > new Date());
});

test('the ledger row carries the key, the step and the stored size', async () => {
    const handle = await make().writeTable({ ctx: CTX, stepId: 's9', name: 'Scores', columns: COLS, rows: sample(2) });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].id, handle.tableId);
    assert.strictEqual(rows[0].stepId, 's9');
    assert.strictEqual(rows[0].storageKey, uploads[0]);
    assert.strictEqual(rows[0].size, blobs[uploads[0]].length);
    assert.strictEqual(rows[0].rowCount, 2);
});

test('every table gets its own key, even with identical content', async () => {
    const t = make();
    await t.writeTable({ ctx: CTX, name: 'A', columns: COLS, rows: sample(2) });
    await t.writeTable({ ctx: CTX, name: 'B', columns: COLS, rows: sample(2) });
    assert.notStrictEqual(uploads[0], uploads[1]);
});

test('the preview is the first previewRows rows', async () => {
    limits = { ...limits, previewRows: 2 };
    const handle = await make().writeTable({ ctx: CTX, name: 'T', columns: COLS, rows: sample(10) });
    assert.strictEqual(handle.preview.length, 2);
    assert.strictEqual(handle.previewCut, true);
    assert.strictEqual(handle.rowCount, 10);
});

test('accepts an async iterable of rows', async () => {
    async function* gen() { for (const r of sample(4)) yield r; }
    const handle = await make().writeTable({ ctx: CTX, name: 'T', columns: COLS, rows: gen() });
    assert.strictEqual(handle.rowCount, 4);
});

test('Date, NaN, Infinity, undefined and objects are stored as JSON scalars', async () => {
    const cols = [{ key: 'a', label: 'a', type: 'mixed' }, { key: 'b', label: 'b', type: 'mixed' }, { key: 'c', label: 'c', type: 'mixed' }, { key: 'd', label: 'd', type: 'mixed' }, { key: 'e', label: 'e', type: 'mixed' }];
    await make().writeTable({
        ctx: CTX, name: 'T', columns: cols,
        rows: [{ a: new Date(Date.UTC(2026, 5, 1, 12)), b: NaN, c: Infinity, d: undefined, e: { x: 1 } }],
    });
    const lines = zlib.gunzipSync(blobs[uploads[0]]).toString('utf8').trim().split('\n');
    assert.deepStrictEqual(JSON.parse(lines[1]), ['2026-06-01T12:00:00.000Z', null, null, null, '{"x":1}']);
});

test('a row missing a column is stored as null', async () => {
    const t = make();
    const handle = await t.writeTable({ ctx: CTX, name: 'T', columns: COLS, rows: [{ name: 'only' }] });
    const opened = await t.openTable(handle.tableId, CTX);
    assert.deepStrictEqual(await collect(opened.rows()), [{ name: 'only', score: null, done: null, when: null }]);
});

test('more rows than maxRows is refused loudly and nothing is stored', async () => {
    limits = { ...limits, maxRows: 5 };
    await assert.rejects(make().writeTable({ ctx: CTX, name: 'T', columns: COLS, rows: sample(6) }), { errorClass: 'table_too_large' });
    assert.deepStrictEqual(uploads, []);
    assert.deepStrictEqual(rows, []);
    await make().writeTable({ ctx: CTX, name: 'T', columns: COLS, rows: sample(5) });
});

test('more bytes than maxBytes is refused', async () => {
    limits = { ...limits, maxBytes: 300 };
    await assert.rejects(make().writeTable({ ctx: CTX, name: 'T', columns: COLS, rows: sample(50) }), { errorClass: 'table_too_large' });
    assert.deepStrictEqual(uploads, []);
});

test('more columns than maxColumns is refused', async () => {
    limits = { ...limits, maxColumns: 3 };
    await assert.rejects(make().writeTable({ ctx: CTX, name: 'T', columns: COLS, rows: [] }), { errorClass: 'table_too_many_columns' });
});

test('0 means unlimited for rows, bytes and columns', async () => {
    limits = { ...limits, maxRows: 0, maxBytes: 0, maxColumns: 0 };
    const handle = await make().writeTable({ ctx: CTX, name: 'T', columns: COLS, rows: sample(50) });
    assert.strictEqual(handle.rowCount, 50);
});

test('a run may write only maxTablesPerRun tables', async () => {
    limits = { ...limits, maxTablesPerRun: 2 };
    const t = make();
    await t.writeTable({ ctx: CTX, name: 'A', columns: COLS, rows: [] });
    await t.writeTable({ ctx: CTX, name: 'B', columns: COLS, rows: [] });
    await assert.rejects(t.writeTable({ ctx: CTX, name: 'C', columns: COLS, rows: [] }), { errorClass: 'table_limit_per_run' });
    await t.writeTable({ ctx: { ...CTX, runId: 'r2' }, name: 'D', columns: COLS, rows: [] });
});

test('without storage the write fails with storage_unavailable', async () => {
    available = false;
    await assert.rejects(make().writeTable({ ctx: CTX, name: 'T', columns: COLS, rows: [] }), { errorClass: 'storage_unavailable' });
});

test('a failed upload leaves no ledger row', async () => {
    const failing = { ...fakeStorage, uploadFileFromPath: async () => { throw new Error('down'); } };
    await assert.rejects(make({ storage: failing }).writeTable({ ctx: CTX, name: 'T', columns: COLS, rows: [] }), { errorClass: 'storage_unavailable' });
    assert.deepStrictEqual(rows, []);
});

test('a failed ledger write removes the blob again', async () => {
    const failing = { ...fakeStore, recordRunTable: async () => { throw new Error('db down'); } };
    await assert.rejects(make({ store: failing }).writeTable({ ctx: CTX, name: 'T', columns: COLS, rows: [] }), /db down/);
    assert.deepStrictEqual(blobs, {});
});

test('the retention is clamped to 1..90 days and defaults to 7', async () => {
    const t = make();
    const days = async (ttlDays) => {
        const h = await t.writeTable({ ctx: CTX, name: 'T', columns: COLS, rows: [], ttlDays });
        return Math.round((new Date(h.expiresAt) - Date.now()) / 86_400_000);
    };
    assert.strictEqual(await days(undefined), 7);
    assert.strictEqual(await days(0), 7);
    assert.strictEqual(await days(500), 90);
    assert.strictEqual(await days(-4), 1);
    assert.strictEqual(await days(30), 30);
});

// ── reading ───────────────────────────────────────────────────────────

test('openTable round-trips the rows and every call opens a fresh stream', async () => {
    const t = make();
    const handle = await t.writeTable({ ctx: CTX, name: 'Scores', columns: COLS, rows: sample(5) });
    const opened = await t.openTable(handle, CTX);
    assert.deepStrictEqual(opened.columns, COLS);
    const first = await collect(opened.rows());
    const second = await collect(opened.rows());
    assert.deepStrictEqual(first, second);
    assert.strictEqual(first.length, 5);
    assert.deepStrictEqual(first[1], { name: 'row 1', score: 1.5, done: false, when: '2026-01-02T00:00:00.000Z' });
});

test('openTable accepts a bare table id', async () => {
    const t = make();
    const handle = await t.writeTable({ ctx: CTX, name: 'T', columns: COLS, rows: sample(1) });
    assert.ok(await t.openTable(handle.tableId, CTX));
});

test('openTable needs a run scope', async () => {
    const t = make();
    const handle = await t.writeTable({ ctx: CTX, name: 'T', columns: COLS, rows: [] });
    await assert.rejects(t.openTable(handle, null), { errorClass: 'handle_scope_missing' });
    await assert.rejects(t.openTable(handle, { automationId: 'a1' }), { errorClass: 'handle_scope_missing' });
});

test('a bad id, a dry-run id and an unknown id open nothing', async () => {
    const t = make();
    assert.strictEqual(await t.openTable('dry-run', CTX), null);
    assert.strictEqual(await t.openTable('nope', CTX), null);
    assert.strictEqual(await t.openTable(`rtb_${'0'.repeat(32)}`, CTX), null);
    assert.strictEqual(await t.openTable({}, CTX), null);
});

test('the same journey may open a table a leg of it wrote', async () => {
    const t = make();
    const handle = await t.writeTable({ ctx: CTX, name: 'T', columns: COLS, rows: sample(1) });
    journeys.r2 = ['r1', 'r2'];
    assert.ok(await t.openTable(handle, { runId: 'r2', rootRunId: 'r1', automationId: 'a1', userId: 'owner' }));
});

test('a later run of the same automation may open an earlier run\'s table', async () => {
    const t = make();
    const handle = await t.writeTable({ ctx: CTX, name: 'T', columns: COLS, rows: sample(1) });
    assert.ok(await t.openTable(handle, { runId: 'r3', rootRunId: 'r3', automationId: 'a1', userId: 'owner' }));
});

test('another automation cannot open the table', async () => {
    const t = make();
    const handle = await t.writeTable({ ctx: CTX, name: 'T', columns: COLS, rows: sample(1) });
    assert.strictEqual(await t.openTable(handle, { runId: 'rx', rootRunId: 'rx', automationId: 'a2', userId: 'owner' }), null);
});

test('a caller-private run keeps its table from a run started by somebody else', async () => {
    const t = make();
    const handle = await t.writeTable({ ctx: { ...CTX, runId: 'rPriv', rootRunId: 'rPriv' }, name: 'T', columns: COLS, rows: sample(1) });
    // r3 was started by the owner, not by the person whose connections rPriv used.
    assert.strictEqual(await t.openTable(handle, { runId: 'r3', rootRunId: 'r3', automationId: 'a1', userId: 'owner' }), null);
    // A run that person started may read it.
    runs.r4 = { id: 'r4', automationId: 'a1', userId: 'owner', startedByUserId: 'ron' };
    assert.ok(await t.openTable(handle, { runId: 'r4', rootRunId: 'r4', automationId: 'a1', userId: 'ron' }));
});

test('an expired table cannot be opened', async () => {
    const t = make();
    const handle = await t.writeTable({ ctx: CTX, name: 'T', columns: COLS, rows: sample(1) });
    rows[0].expiresAt = new Date(Date.now() - 1000);
    assert.strictEqual(await t.openTable(handle, CTX), null);
});

test('rows() enforces maxBytes on what the blob unpacks to', async () => {
    const t = make();
    const handle = await t.writeTable({ ctx: CTX, name: 'T', columns: COLS, rows: sample(200) });
    limits = { ...limits, maxBytes: 200 };
    const opened = await t.openTable(handle, CTX);
    await assert.rejects(collect(opened.rows()), { errorClass: 'table_too_large' });
});

test('readTablePage returns a window and says whether more follow', async () => {
    const t = make();
    await t.writeTable({ ctx: CTX, name: 'T', columns: COLS, rows: sample(25) });
    const { row } = await t.openTable(rows[0].id, CTX);
    const first = await t.readTablePage(row, { offset: 0, limit: 10 });
    assert.strictEqual(first.rows.length, 10);
    assert.strictEqual(first.hasMore, true);
    assert.strictEqual(first.rows[0].name, 'row 0');
    const last = await t.readTablePage(row, { offset: 20, limit: 10 });
    assert.deepStrictEqual(last.rows.map(r => r.name), ['row 20', 'row 21', 'row 22', 'row 23', 'row 24']);
    assert.strictEqual(last.hasMore, false);
    const exact = await t.readTablePage(row, { offset: 15, limit: 10 });
    assert.strictEqual(exact.rows.length, 10);
    assert.strictEqual(exact.hasMore, false);
    const beyond = await t.readTablePage(row, { offset: 100, limit: 10 });
    assert.deepStrictEqual(beyond.rows, []);
    assert.strictEqual(beyond.hasMore, false);
    assert.deepStrictEqual(beyond.columns, COLS);
});

// ── csv ───────────────────────────────────────────────────────────────

class Sink extends Writable {
    constructor(opts = {}) { super({ highWaterMark: opts.highWaterMark ?? 16 * 1024 }); this.chunks = []; this.delayMs = opts.delayMs ?? 0; }
    _write(chunk, _enc, cb) { this.chunks.push(chunk); if (this.delayMs) setTimeout(cb, this.delayMs); else cb(); }
    get text() { return Buffer.concat(this.chunks).toString('utf8'); }
}

async function csvOf(rowsIn, cols = COLS, sinkOpts) {
    const t = make();
    const handle = await t.writeTable({ ctx: CTX, name: 'T', columns: cols, rows: rowsIn });
    const { row } = await t.openTable(handle, CTX);
    const sink = new Sink(sinkOpts);
    await t.streamTableCsv(row, sink);
    await new Promise(r => sink.once('finish', r));
    return sink.text;
}

test('the CSV starts with a BOM and a header of labels, then the rows', async () => {
    const text = await csvOf(sample(2));
    assert.ok(text.startsWith('\uFEFFName,Score,Done,When\r\n'));
    assert.deepStrictEqual(text.slice(1).split('\r\n'), [
        'Name,Score,Done,When',
        'row 0,0,true,2026-01-01T00:00:00.000Z',
        'row 1,1.5,false,2026-01-02T00:00:00.000Z',
        '',
    ]);
});

test('formula-shaped text is prefixed with an apostrophe; numbers and quoting are not', async () => {
    const cols = [{ key: 'a', label: 'a', type: 'text' }, { key: 'b', label: 'b', type: 'number' }];
    const text = await csvOf([
        { a: '=1+1', b: -5 },
        { a: '@SUM(A1)', b: 3 },
        { a: 'plain, with comma', b: null },
        { a: 'say "hi"', b: 1 },
        { a: '-dash', b: 1 },
    ], cols);
    const lines = text.slice(1).split('\r\n');
    assert.strictEqual(lines[1], "'=1+1,-5");
    assert.strictEqual(lines[2], "'@SUM(A1),3");
    assert.strictEqual(lines[3], '"plain, with comma",');
    assert.strictEqual(lines[4], '"say ""hi""",1');
    assert.strictEqual(lines[5], "'-dash,1");
});

test('a formula-shaped column label is made harmless too', async () => {
    const text = await csvOf([{ a: 'x' }], [{ key: 'a', label: '=HYPERLINK("x")', type: 'text' }]);
    assert.ok(text.startsWith("\uFEFF\"'=HYPERLINK(\"\"x\"\")\"\r\n"));
});

test('a large table streams through a slow writer without loss', async () => {
    const big = Array.from({ length: 5000 }, (_, i) => ({ name: `row ${i}`, score: i, done: false, when: null }));
    const text = await csvOf(big, COLS, { highWaterMark: 64, delayMs: 0 });
    assert.strictEqual(text.trim().split('\r\n').length, 5001);
});

test('a reader that goes away stops the export without an error', async () => {
    const t = make();
    await t.writeTable({ ctx: CTX, name: 'T', columns: COLS, rows: sample(3000) });
    const { row } = await t.openTable(rows[0].id, CTX);
    const sink = new Sink({ highWaterMark: 8 });
    const pending = t.streamTableCsv(row, sink);
    setImmediate(() => sink.destroy());
    assert.strictEqual(await pending, false);
});

test('a missing blob fails before anything is written', async () => {
    const t = make();
    await t.writeTable({ ctx: CTX, name: 'T', columns: COLS, rows: sample(2) });
    const { row } = await t.openTable(rows[0].id, CTX);
    blobs = {};
    const sink = new Sink();
    await assert.rejects(t.streamTableCsv(row, sink), { name: 'NoSuchKey' });
    assert.strictEqual(sink.destroyed, false);
    assert.strictEqual(sink.chunks.length, 0);
});
