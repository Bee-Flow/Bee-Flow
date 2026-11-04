/**
 * writeTo.upsertKey and writeTo.replaceWhere (package 5) through the real ai_extract step, on a
 * REAL in-memory SQLite: the real compiler, RLS gateway, record choke point and step data reads.
 * Only the model (aiRuntime) and the Postgres-backed stores are replaced.
 *
 * Run: cd server && node --test appStudio/actionExecutor/writeToRows.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

// Swap the methods on the real module objects (the callers read them at call time) and put
// the originals back after the file, as bulkRecords.test.js does.
const restores = [];
function stub(path, methods) {
    const target = require(path);
    restores.push([target, Object.fromEntries(Object.keys(methods).map((k) => [k, target[k]]))]);
    Object.assign(target, methods);
}
test.after(() => restores.forEach(([target, saved]) => Object.assign(target, saved)));

const db = new Database(':memory:');
const norm = (params) => params.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v));
let failInsertAfter = Infinity; // make the Nth INSERT of a batch fail, to prove the rollback
stub('../../stores/studioAppDbStore', {
    exec: async (_o, _a, sql, params) => ({ changes: db.prepare(sql).run(...norm(params)).changes }),
    query: async (_o, _a, sql, params) => ({ rows: db.prepare(sql).all(...norm(params)) }),
    batch: async (_o, _a, statements) => {
        let inserts = 0;
        return db.transaction(() => statements.map((s) => {
            if (/^\s*insert/i.test(s.sql) && ++inserts > failInsertAfter) throw new Error('disk full');
            return { changes: db.prepare(s.sql).run(...norm(s.params)).changes };
        }))();
    },
    sizeBytes: async () => 0,
});
stub('../../stores/studioAppDataStore', {
    bumpDataVersion: async () => 1,
    bumpRowCount: async () => ({}),
    getRowCounts: async () => ({}),
    getMemberRole: async () => null,
    getAttachment: async (id) => ({ id, scanned: true, quarantined: false, sha256: 'x', mimeType: 'application/pdf' }),
});

const aiState = { rows: [] };
stub('../aiRuntime', {
    resolveOwnerModel: async () => ({ modelId: 'm', options: {}, supportsVision: false, tierName: 'standard' }),
    extractDocuments: async (_app, descriptors, opts) => { if (opts && opts.report) opts.report.read += descriptors.length; return [{ type: 'text', text: 'PO' }]; },
    groundWithKB: async () => ({ context: '', chunks: [] }),
    runStructured: async () => ({ structured: { rows: aiState.rows } }),
    runStructuredWithTools: async () => ({ structured: { rows: aiState.rows } }),
    runText: async () => ({ text: '' }),
    runTextWithTools: async () => ({ text: '' }),
    fieldsToObjectSchema: (fields) => ({ type: 'object', properties: Object.fromEntries((fields || []).map((f) => [f.name, { type: 'string' }])) }),
    normalizeSchemaFields: (fields) => fields.map((f) => ({ name: f.name, type: f.type || 'string', required: !!f.required })),
    coerceRowToFields: (row, fields) => Object.fromEntries(fields.map((f) => [f.name, row ? row[f.name] : undefined])),
    MAX_EXTRACT_ROWS: 500,
});

const dataModel = require('../dataModel');
const { executeDataStep } = require('./dispatch');
const { upsertKeyOf, keyFilterOf } = require('./writeToRows.mts');

const OWNER = 'owner-1';
const app = { id: 'app-1', userId: OWNER, organizationId: 'org-1' };
const LINES = {
    id: 'tbl_lines0', key: 'lines', name: 'Lines',
    fields: [
        { id: 'fld_po0000', key: 'po', type: 'text' },
        { id: 'fld_line00', key: 'line', type: 'number', subtype: 'integer' },
        { id: 'fld_qty000', key: 'qty', type: 'number', subtype: 'integer' },
        { id: 'fld_batch0', key: 'batch', type: 'text' },
    ],
    access: { default: 'app', roles: {}, rowFilters: {} },
};
const MODEL = { modelVersion: 1, tables: [LINES], roles: [], roleMapping: { default: 'app', byGroup: {} } };
db.exec(dataModel.ddlForTable(LINES, { tableKeyById: new Map(), dialect: 'sqlite' }));

const ctx = (extra = {}) => ({ viewerId: OWNER, role: 'owner', formValues: { doc: { kind: 'studio_attachment', fileId: 'f1' } }, vars: {}, viewer: { id: OWNER }, ...extra });
const extract = (writeTo) => ({
    kind: 'ai_extract', source: { kind: 'formula', expr: 'form.doc' },
    schema: [{ name: 'po', type: 'string' }, { name: 'line', type: 'number' }, { name: 'qty', type: 'number' }],
    writeTo: { tableId: 'tbl_lines0', mapping: { po: 'po', line: 'line', qty: 'qty' }, ...writeTo },
});
const rows = () => db.prepare('SELECT po, line, qty, batch FROM "lines" ORDER BY po, line').all();

test.beforeEach(() => {
    db.exec('DELETE FROM "lines"');
    failInsertAfter = Infinity;
    aiState.rows = [{ po: 'PO-1', line: 1, qty: 5 }, { po: 'PO-1', line: 2, qty: 7 }];
});

test('spec: the same ai_extract twice with upsertKey creates no duplicate rows', async () => {
    const step = extract({ upsertKey: ['po', 'line'] });
    const first = await executeDataStep(app, MODEL, step, ctx());
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.result.written, 2);
    assert.equal(rows().length, 2);

    aiState.rows = [{ po: 'PO-1', line: 1, qty: 50 }, { po: 'PO-1', line: 2, qty: 70 }];
    const second = await executeDataStep(app, MODEL, step, ctx());
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(rows().length, 2, 'the second run updated the same two rows');
    assert.deepEqual(rows().map((r) => r.qty), [50, 70], 'with the new values');

    aiState.rows = [{ po: 'PO-1', line: 3, qty: 1 }];
    await executeDataStep(app, MODEL, step, ctx());
    assert.equal(rows().length, 3, 'a new key is a new row');
});

test('upsertKey: a row with an empty key value has no identity and is inserted', async () => {
    const step = extract({ upsertKey: ['po', 'line'] });
    aiState.rows = [{ po: 'PO-1', line: null, qty: 1 }];
    await executeDataStep(app, MODEL, step, ctx());
    await executeDataStep(app, MODEL, step, ctx());
    assert.equal(rows().length, 2, 'never matched against another keyless row');
});

test('upsertKey: insertMissing false reports a key that matches nothing', async () => {
    const res = await executeDataStep(app, MODEL, extract({ upsertKey: ['po', 'line'], insertMissing: false }), ctx());
    assert.equal(res.ok, true);
    assert.equal(res.result.written, 0);
    assert.deepEqual(res.result.unmatched, ['PO-1 / 1', 'PO-1 / 2']);
    assert.equal(rows().length, 0);
});

test('upsertKey is exactly the listed columns; legacy upsertOn adds the scalar non-date constants', () => {
    const table = { ...LINES, fields: [...LINES.fields, { key: 'at', type: 'datetime' }] };
    assert.deepEqual(upsertKeyOf({ upsertKey: ['po', 'line'] }, table, { batch: 'B1' }), { columns: ['po', 'line'], narrowBy: [] });
    assert.deepEqual(upsertKeyOf({ upsertOn: 'po' }, table, { batch: 'B1', at: '2026-01-01' }), { columns: ['po'], narrowBy: [['batch', 'B1']] });
    assert.equal(upsertKeyOf({}, table, {}), null);
    assert.equal(keyFilterOf({ columns: ['po'], narrowBy: [] }, { po: '' }), null);
});

test('replaceWhere: deletes the scoped rows, then writes, in one batch', async () => {
    const ins = db.prepare('INSERT INTO "lines" (id, created_at, updated_at, created_by, org_id, po, line, qty, batch) VALUES (?,?,?,?,?,?,?,?,?)');
    ins.run('old_1', 't', 't', OWNER, 'org-1', 'PO-1', 9, 1, 'B1');
    ins.run('old_2', 't', 't', OWNER, 'org-1', 'PO-1', 8, 1, 'B1');
    ins.run('keep', 't', 't', OWNER, 'org-1', 'PO-2', 1, 1, 'B2');
    const step = extract({ replaceWhere: [{ field: 'po', op: 'eq', value: { kind: 'formula', expr: 'vars.po' } }] });
    const res = await executeDataStep(app, MODEL, step, ctx({ vars: { po: 'PO-1' } }));
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.result.replaced, 2);
    assert.equal(res.result.written, 2);
    assert.deepEqual(rows().map((r) => `${r.po}/${r.line}`), ['PO-1/1', 'PO-1/2', 'PO-2/1'], 'the other order is untouched');
});

test('replaceWhere: a failing insert leaves the old rows (atomic)', async () => {
    const ins = db.prepare('INSERT INTO "lines" (id, created_at, updated_at, created_by, org_id, po, line, qty) VALUES (?,?,?,?,?,?,?,?)');
    ins.run('old_1', 't', 't', OWNER, 'org-1', 'PO-1', 9, 1);
    failInsertAfter = 1;
    const res = await executeDataStep(app, MODEL, extract({ replaceWhere: [{ field: 'po', op: 'eq', value: 'PO-1' }] }), ctx());
    assert.equal(res.ok, false);
    assert.deepEqual(rows().map((r) => r.line), [9], 'the old row is still there, nothing new landed');
});

test('replaceWhere: an empty value refuses with nothing changed', async () => {
    const ins = db.prepare('INSERT INTO "lines" (id, created_at, updated_at, created_by, org_id, po, line, qty) VALUES (?,?,?,?,?,?,?,?)');
    ins.run('old_1', 't', 't', OWNER, 'org-1', 'PO-1', 9, 1);
    const res = await executeDataStep(app, MODEL, extract({ replaceWhere: [{ field: 'po', op: 'eq', value: { kind: 'formula', expr: 'vars.none' } }] }), ctx());
    assert.equal(res.ok, false);
    assert.equal(res.code, 'replace_filter_empty');
    assert.equal(rows().length, 1);
});

test('replaceWhere: more than 500 matches refuses with nothing changed', async () => {
    const ins = db.prepare('INSERT INTO "lines" (id, created_at, updated_at, created_by, org_id, po, line, qty) VALUES (?,?,?,?,?,?,?,?)');
    db.transaction(() => { for (let i = 0; i < 501; i++) ins.run(`r_${i}`, 't', 't', OWNER, 'org-1', 'PO-1', 100 + i, 1); })();
    const res = await executeDataStep(app, MODEL, extract({ replaceWhere: [{ field: 'po', op: 'eq', value: 'PO-1' }] }), ctx());
    assert.equal(res.ok, false);
    assert.equal(res.code, "replace_limit_exceeded", JSON.stringify(res));
    assert.match(res.error, /matches 501 rows; at most 500/);
    assert.equal(rows().length, 501);
});

test('replaceWhere + upsertKey: delete first, then upsert', async () => {
    const ins = db.prepare('INSERT INTO "lines" (id, created_at, updated_at, created_by, org_id, po, line, qty) VALUES (?,?,?,?,?,?,?,?)');
    ins.run('old_9', 't', 't', OWNER, 'org-1', 'PO-1', 9, 1);
    const res = await executeDataStep(app, MODEL, extract({ upsertKey: ['po', 'line'], replaceWhere: [{ field: 'line', op: 'gte', value: 9 }] }), ctx());
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.result.replaced, 1);
    assert.deepEqual(rows().map((r) => r.line), [1, 2]);
});
