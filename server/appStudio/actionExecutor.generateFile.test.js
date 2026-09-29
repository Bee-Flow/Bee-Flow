/**
 * App Studio — generate_file step (rows → real CSV/XLSX bytes in the app's
 * attachment store).
 *
 * executeDataStep runs with the REAL queryCompiler + rlsGateway + stepDataSource
 * (so a `records` rows binding really compiles a SELECT), the REAL officegen
 * renderer (so the uploaded bytes are asserted, not a stub's echo) and the REAL
 * uploadGuard scanBuffer (so the dirty-scan path is a genuine EICAR verdict).
 * Only the stores + quota modules are stubbed.
 *
 * Run: cd server && node --test appStudio/actionExecutor.generateFile.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// ── Record/query plumbing stubs (mirror actionExecutor.ai.test.js) ───────────
const execCalls = [];
const queryCalls = [];
let queryRows = [];
stub('../stores/studioAppDbStore', {
    query: async (ownerId, appId, sql, params) => { queryCalls.push({ sql, params }); return { rows: queryRows }; },
    exec: async (ownerId, appId, sql, params) => { execCalls.push({ ownerId, appId, sql, params }); return { changes: 1, lastInsertRowid: 0 }; },
    batch: async (ownerId, appId, statements) => statements.map(() => ({ changes: 1 })),
    sizeBytes: async () => 0,
});

const ledgerCalls = { addAttachment: [], setAttachmentScan: [] };
let addAttachmentThrows = null;
stub('../stores/studioAppDataStore', {
    bumpDataVersion: async () => 1,
    bumpRowCount: async () => ({}),
    getRowCounts: async () => ({}),
    getMemberRole: async () => null,
    getAttachment: async () => null,
    addAttachment: async (appId, ownerId, row) => {
        if (addAttachmentThrows) throw addAttachmentThrows;
        ledgerCalls.addAttachment.push({ appId, ownerId, row });
        return { id: 'led-1' };
    },
    setAttachmentScan: async (id, appId, ownerId, patch) => { ledgerCalls.setAttachmentScan.push({ id, patch }); return { id }; },
});

// actionExecutor destructures assertRowQuota/assertDbByteQuota at load, so the
// stub must carry ALL of the quota surface; only the attachment one is
// controllable here (writeRecord's asserts are not under test).
let attachmentQuotaThrows = null;
stub('./studioAppQuota', {
    assertRowQuota: async () => {},
    assertDbByteQuota: async () => {},
    assertAttachmentQuota: async () => { if (attachmentQuotaThrows) throw attachmentQuotaThrows; },
});

const uploads = [];
const deletedBlobs = [];
let storageAvailable = true;
stub('../stores/storageStore', {
    isAvailable: () => storageAvailable,
    uploadFile: async (key, buffer, contentType) => { uploads.push({ key, buffer, contentType }); },
    deleteFile: async (key) => { deletedBlobs.push(key); },
    buildStudioAppAttachmentKey: (o, a, s) => `studio-apps/${o}/${a}/attachments/${s}`,
});

// generate_file only needs the byte-total assert; materializeAttachment rides
// along so the stub stays shape-compatible with the real module.
stub('./mailboxAttachments', {
    assertAttachmentTotalBytes: async () => {},
    materializeAttachment: async () => { throw new Error('not used in these tests'); },
});

const actionExecutor = require('./actionExecutor');
const { EICAR } = require('../middleware/uploadGuard'); // REAL scanBuffer's own test string
const { CONTENT_TYPES } = require('../integrations/officegen');

const OWNER = 'owner-1';
const app = { id: 'app-1', userId: OWNER, organizationId: 'org-1', name: 'Ops' };
const model = {
    modelVersion: 1,
    tables: [{
        id: 'tbl_ord', key: 'orders', name: 'Orders',
        fields: [
            { id: 'f_c', key: 'cad_bestand', type: 'text' },
            { id: 'f_a', key: 'aantal', type: 'number', subtype: 'integer' },
            { id: 'f_x', key: 'x', type: 'text' },
        ],
        access: { default: 'app', roles: {}, rowFilters: {} },
    }],
    roles: [], roleMapping: { default: 'app', byGroup: {} },
};
function ctx(extra = {}) { return { viewerId: OWNER, role: 'owner', orgId: 'org-1', formValues: {}, vars: {}, viewer: { id: OWNER }, ...extra }; }

// The portal-format column profile: mixed order keys, a constant column and an
// inactive one — exactly what a columns TABLE row-set resolves to.
const PORTAL_COLUMNS = [
    { name: 'cadfile', from: 'cad_bestand', order: 1 },
    { name: 'Orientation', value: '8', order: 2 },
    { name: 'Inactive', from: 'x', active: false },
    { name: 'Quantity', from: 'aantal', order: 3 },
];

function step(extra = {}) {
    return {
        kind: 'generate_file',
        rows: { kind: 'records', tableId: 'tbl_ord' },
        columns: { kind: 'static', value: PORTAL_COLUMNS },
        format: 'csv',
        delimiter: ';',
        fileName: { kind: 'static', value: 'jobs' },
        ...extra,
    };
}

test.beforeEach(() => {
    execCalls.length = 0;
    queryCalls.length = 0;
    queryRows = [
        { id: 'r1', cad_bestand: 'a.step', aantal: 2, x: 'ignore-me' },
        { id: 'r2', cad_bestand: 'b.step', aantal: 5, x: 'ignore-me' },
    ];
    ledgerCalls.addAttachment.length = 0;
    ledgerCalls.setAttachmentScan.length = 0;
    addAttachmentThrows = null;
    attachmentQuotaThrows = null;
    uploads.length = 0;
    deletedBlobs.length = 0;
    storageAvailable = true;
});

// ── happy path ───────────────────────────────────────────────────────────────

test('generate_file: renders the portal profile into real CSV bytes and a bare descriptor', async () => {
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);

    // The uploaded bytes are the deliverable — decode and assert them exactly:
    // BOM, ordered active columns only, the constant on every row, CRLF ends.
    assert.strictEqual(uploads.length, 1);
    const text = uploads[0].buffer.toString('utf8');
    assert.strictEqual(text, '﻿cadfile;Orientation;Quantity\r\na.step;8;2\r\nb.step;8;5\r\n');
    assert.ok(text.startsWith('﻿'), 'UTF-8 BOM present (Dutch Excel needs it)');
    assert.ok(!text.includes('Inactive'), 'active:false column is dropped');
    assert.ok(!text.includes('ignore-me'), 'and its data never leaks into the file');
    assert.strictEqual(uploads[0].contentType, 'text/csv');

    // The result is the BARE studio_attachment descriptor.
    assert.deepStrictEqual(r.result, {
        kind: 'studio_attachment',
        fileId: 'led-1',
        name: 'jobs.csv',
        mime: 'text/csv',
        size: uploads[0].buffer.length,
        rowCount: 2,
    });
    // …and the ledger row was marked scanned (three consumers key off it).
    assert.strictEqual(ledgerCalls.setAttachmentScan.length, 1);
    assert.deepStrictEqual(ledgerCalls.setAttachmentScan[0].patch, { scanned: true, quarantined: false });
});

test('generate_file: the rows binding really goes through stepDataSource (compiled SELECT)', async () => {
    await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(queryCalls.length, 1, 'one bounded query for the rows binding');
    assert.match(queryCalls[0].sql, /FROM "orders"/);
    assert.match(queryCalls[0].sql, /SELECT/i);
});

// ── refusals before any I/O ──────────────────────────────────────────────────

test('generate_file: zero rows is a loud refusal, nothing uploaded', async () => {
    queryRows = [];
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /rows/i);
    assert.strictEqual(uploads.length, 0, 'no header-only file was written');
    assert.strictEqual(ledgerCalls.addAttachment.length, 0);
});

test('generate_file: unavailable storage is a clear error before any upload', async () => {
    storageAvailable = false;
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /storage/i);
    assert.strictEqual(uploads.length, 0);
});

test('generate_file: an attachment-quota 409 surfaces as quota_exceeded and never costs an upload', async () => {
    attachmentQuotaThrows = Object.assign(new Error('Attachment storage is full'), {
        status: 409, code: 'quota_exceeded', limit: 100, used: 100,
    });
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'quota_exceeded');
    assert.strictEqual(r.limit, 100);
    assert.strictEqual(uploads.length, 0, 'quota is asserted BEFORE bytes move');
});

// ── AV scan (the real scanBuffer) ────────────────────────────────────────────

test('generate_file: a dirty scan deletes the blob and refuses a ledger row', async () => {
    // A real EICAR cell in the rendered CSV — the genuine dirty-scan path, not
    // a stubbed verdict. (Static rows: the scan is about the BYTES, whatever
    // produced them.)
    queryRows = [];
    const r = await actionExecutor.executeDataStep(app, model, step({
        rows: { kind: 'static', value: [{ name: EICAR }] },
        columns: { kind: 'static', value: [{ name: 'name', from: 'name' }] },
    }), ctx());

    assert.strictEqual(r.ok, false);
    assert.match(r.error, /scan/i);
    assert.strictEqual(uploads.length, 1, 'the blob was uploaded before the verdict');
    assert.strictEqual(deletedBlobs.length, 1, 'and deleted after it');
    assert.strictEqual(deletedBlobs[0], uploads[0].key, 'the same blob, healed');
    assert.strictEqual(ledgerCalls.addAttachment.length, 0, 'a dirty file never gets a ledger row');
});

// ── attachTo + ledger healing ────────────────────────────────────────────────

test('generate_file: attachTo links the ledger row to the record+field; absent → unlinked', async () => {
    const r1 = await actionExecutor.executeDataStep(app, model, step({
        attachToRecordId: { kind: 'static', value: 'rec_9' },
        attachToFieldKey: 'file',
    }), ctx());
    assert.strictEqual(r1.ok, true, r1.error);
    assert.strictEqual(ledgerCalls.addAttachment[0].row.recordId, 'rec_9');
    assert.strictEqual(ledgerCalls.addAttachment[0].row.fieldKey, 'file');

    ledgerCalls.addAttachment.length = 0;
    const r2 = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r2.ok, true, r2.error);
    assert.strictEqual(ledgerCalls.addAttachment[0].row.recordId, null);
    assert.strictEqual(ledgerCalls.addAttachment[0].row.fieldKey, null);
});

test('generate_file: a failed ledger write deletes the blob (no orphans) and fails generically', async () => {
    addAttachmentThrows = new Error('ledger db down');
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'Step failed', 'an internal fault collapses to the generic message');
    assert.strictEqual(uploads.length, 1);
    assert.strictEqual(deletedBlobs.length, 1, 'the blob does not outlive its ledger row');
    assert.strictEqual(deletedBlobs[0], uploads[0].key);
});

// ── formats + names ──────────────────────────────────────────────────────────

test('generate_file: format xlsx uploads real xlsx bytes under the xlsx content type', async () => {
    const r = await actionExecutor.executeDataStep(app, model, step({ format: 'xlsx' }), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(uploads[0].contentType, CONTENT_TYPES.xlsx);
    assert.strictEqual(r.result.mime, CONTENT_TYPES.xlsx);
    assert.ok(r.result.name.endsWith('.xlsx'), `name gets the format extension: ${r.result.name}`);
    // ZIP magic — officegen really packaged a workbook.
    assert.strictEqual(uploads[0].buffer.subarray(0, 2).toString('latin1'), 'PK');
});

test('generate_file: the file name is stripped of path/illegal characters (incl the colon)', async () => {
    const r = await actionExecutor.executeDataStep(app, model, step({
        fileName: { kind: 'static', value: '..\\..\\evil<name>:2026.csv' },
    }), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.ok(!/[/\\:<>|?*"\r\n;]/.test(r.result.name), `no path/illegal chars in ${r.result.name}`);
    assert.ok(r.result.name.endsWith('.csv'));
});
