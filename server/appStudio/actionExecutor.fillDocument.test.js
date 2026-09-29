/**
 * App Studio — fill_document step (a DESIGNED document + this run's values →
 * a real PDF in the app's attachment store).
 *
 * The renderer is stubbed (Chromium is not this test's subject) but the FILLER
 * is real, so what the assertions read is what would be printed. The store, the
 * quota and the scan are stubbed exactly as the generate_file suite does, so
 * the two steps' pipelines are compared like for like — that sameness is the
 * design, and a drift in it is what this file is for.
 *
 * Run: cd server && node --test --test-force-exit appStudio/actionExecutor.fillDocument.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const OWNER = 'owner-1';

// ── the owner's document library ────────────────────────────────────────────
const TEMPLATE = {
    id: 'doc_1',
    userId: OWNER,
    name: 'Factuur',
    docType: 'invoice',
    bodyHtml: '<h1>{{customer.name}}</h1>{{#each lines}}<tr><td>{{description}}</td></tr>{{/each}}<p>{{note}}</p>',
    css: '@page { size: A4; }',
    settings: {},
};
// A presentation in the same library: an OUTLINE with the same holes.
const DECK = { id: 'deck_1', userId: OWNER, name: 'Kwartaal', docType: 'presentation', bodyHtml: '# {{customer.name}}\n\n## Regels\n{{#each lines}}- {{description}}\n{{/each}}', css: '', settings: {} };
const documentLookups = [];
stub('../stores/documentStore', {
    async getDocumentVersion(id, userId) {
        documentLookups.push({ id, userId });
        if (userId !== OWNER) return null;
        return id === TEMPLATE.id ? { ...TEMPLATE } : (id === DECK.id ? { ...DECK } : null);
    },
});

// The renderer: real fill, stub bytes. `composed` is what a Chromium would
// have been handed, which is what the assertions read.
let renderThrows = null;
let degraded = false;
const renders = [];
stub('../core/documents/renderFilledDocument', {
    async renderFilledDocument(args) {
        if (renderThrows) throw renderThrows;
        const { fillDocumentBody } = require('../core/documents/documentTemplate');
        const fill = fillDocumentBody(args.document.bodyHtml, args.values, { escape: args.document.docType !== 'presentation' });
        renders.push({ ...args, composed: fill.bodyHtml });
        if (args.document.docType === 'presentation') {
            const pdf = args.format === 'pdf';
            return { buffer: Buffer.from(pdf ? '%PDF-1.7 deck' : 'PK deck'), contentType: pdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation', extension: pdf ? 'pdf' : 'pptx', slideCount: 3, degraded, marking: null, fill };
        }
        return { buffer: Buffer.from('%PDF-1.7 filled'), contentType: 'application/pdf', extension: 'pdf', degraded, marking: null, fill };
    },
    documentFileName: (raw, fallback = 'document') => `${raw || fallback}.pdf`,
    houseStyleCssFor: async () => '',
});

// ── store / quota / storage plumbing (mirrors the generate_file suite) ──────
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

stub('./mailboxAttachments', {
    assertAttachmentTotalBytes: async () => {},
    materializeAttachment: async () => { throw new Error('not used in these tests'); },
});

let scanClean = true;
stub('../middleware/uploadGuard', {
    scanBuffer: async () => ({ clean: scanClean }),
    EICAR: 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
});

const actionExecutor = require('./actionExecutor');

const app = { id: 'app-1', userId: OWNER, organizationId: 'org-1', name: 'Ops' };
const model = { modelVersion: 1, tables: [], roles: [], roleMapping: { default: 'app', byGroup: {} } };
const ctx = (extra = {}) => ({
    viewerId: OWNER, role: 'owner', orgId: 'org-1', formValues: {},
    vars: { klant: 'Van Dijk & Zn', regels: [{ description: 'Werk' }, { description: 'Reis' }] },
    viewer: { id: OWNER }, ...extra,
});

const step = (extra = {}) => ({
    kind: 'fill_document',
    documentId: 'doc_1',
    values: {
        'customer.name': { kind: 'formula', expr: 'vars.klant' },
        lines: { kind: 'formula', expr: 'vars.regels' },
    },
    resultVar: 'file',
    ...extra,
});

test.beforeEach(() => {
    documentLookups.length = 0;
    renders.length = 0;
    ledgerCalls.addAttachment.length = 0;
    ledgerCalls.setAttachmentScan.length = 0;
    addAttachmentThrows = null;
    attachmentQuotaThrows = null;
    renderThrows = null;
    degraded = false;
    scanClean = true;
    storageAvailable = true;
    uploads.length = 0;
    deletedBlobs.length = 0;
});

// ── happy path ──────────────────────────────────────────────────────────────

test('fills the design and returns the SAME descriptor generate_file returns', async () => {
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.kind, 'studio_attachment');
    assert.strictEqual(r.result.fileId, 'led-1');
    assert.strictEqual(r.result.mime, 'application/pdf');
    assert.strictEqual(r.result.name, 'Factuur.pdf');
    assert.strictEqual(r.result.documentId, 'doc_1');
    assert.ok(r.result.size > 0);
    assert.strictEqual(uploads.length, 1, 'the bytes were stored once');
    assert.deepStrictEqual(ledgerCalls.setAttachmentScan[0].patch, { scanned: true, quarantined: false });
});

test('a formula binding that yields a list arrives as a LIST, so the block repeats', async () => {
    // The invisible failure: a flattened binding makes {{#each lines}} render
    // nothing, which reads as a broken template.
    await actionExecutor.executeDataStep(app, model, step(), ctx());
    const composed = renders[0].composed;
    assert.strictEqual((composed.match(/<tr>/g) || []).length, 2);
    assert.ok(composed.includes('Van Dijk &amp; Zn'), 'values are escaped, not raw');
});

test('the document is looked up as the app OWNER, never as the viewer', async () => {
    await actionExecutor.executeDataStep(app, model, step(), ctx({ viewerId: 'someone-else', role: 'member', viewer: { id: 'someone-else' } }));
    assert.deepStrictEqual(documentLookups[0], { id: 'doc_1', userId: OWNER });
});

test('the letterhead is the APP\'s organisation\'s', async () => {
    await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(renders[0].orgId, 'org-1');
});

test('fileName overrides the document\'s own name', async () => {
    const r = await actionExecutor.executeDataStep(
        app, model, step({ fileName: { kind: 'static', value: 'Factuur 2026-014' } }), ctx(),
    );
    assert.strictEqual(r.result.name, 'Factuur 2026-014.pdf');
});

test('the empty placeholders are named in the result, the values are not', async () => {
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.deepStrictEqual(r.result.missing, ['note']);
    assert.ok(!JSON.stringify(r.result).includes('Van Dijk'), 'no customer data in the step result');
});

// ── refusals ────────────────────────────────────────────────────────────────

test('a document that is gone (or somebody else\'s) is a plain refusal', async () => {
    const r = await actionExecutor.executeDataStep(app, model, step({ documentId: 'doc_other' }), ctx());
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /no longer exists/);
    assert.strictEqual(uploads.length, 0);
});

test('a step with no document refuses before anything is read', async () => {
    const r = await actionExecutor.executeDataStep(app, model, step({ documentId: '' }), ctx());
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /no document/i);
    assert.strictEqual(documentLookups.length, 0);
});

test('an empty design says so instead of storing a blank page', async () => {
    renderThrows = Object.assign(new Error('empty'), { errorClass: 'document_empty' });
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /empty/);
    assert.strictEqual(uploads.length, 0);
});

test('unavailable storage refuses BEFORE the quota is spent', async () => {
    storageAvailable = false;
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /storage/i);
    assert.strictEqual(uploads.length, 0);
});

test('a quota refusal costs no upload', async () => {
    attachmentQuotaThrows = Object.assign(new Error('Storage quota exceeded'), { status: 409, code: 'quota_exceeded', limit: 10, used: 10 });
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'quota_exceeded');
    assert.strictEqual(uploads.length, 0);
});

test('a dirty scan discards the blob and never writes a ledger row', async () => {
    scanClean = false;
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /malware/i);
    assert.strictEqual(deletedBlobs.length, 1, 'the blob is deleted');
    assert.strictEqual(ledgerCalls.addAttachment.length, 0);
});

test('a failed ledger write never orphans the blob', async () => {
    addAttachmentThrows = new Error('db down');
    await assert.rejects(
        async () => {
            const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
            if (!r.ok) throw new Error(r.error);   // the dispatcher maps it to a generic failure
        },
    );
    assert.strictEqual(deletedBlobs.length, 1);
});

// ── attachTo ────────────────────────────────────────────────────────────────

test('attachTo links the ledger row so a non-owner can download it', async () => {
    await actionExecutor.executeDataStep(app, model, step({
        attachToRecordId: { kind: 'static', value: 'rec_1' },
        attachToFieldKey: 'factuur',
    }), ctx());
    assert.strictEqual(ledgerCalls.addAttachment[0].row.recordId, 'rec_1');
    assert.strictEqual(ledgerCalls.addAttachment[0].row.fieldKey, 'factuur');
});

test('without attachTo the row is owner-only, and the fieldKey is dropped rather than half-linked', async () => {
    await actionExecutor.executeDataStep(app, model, step({ attachToFieldKey: 'factuur' }), ctx());
    assert.strictEqual(ledgerCalls.addAttachment[0].row.recordId, null);
    assert.strictEqual(ledgerCalls.addAttachment[0].row.fieldKey, null);
});

// ── degraded render ─────────────────────────────────────────────────────────

test('a browserless render says so, because the design is then lost', async () => {
    degraded = true;
    const warn = console.warn;
    console.warn = () => {};
    try {
        const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
        assert.strictEqual(r.result.degraded, true);
    } finally { console.warn = warn; }
});

test('a presentation document fills into a .pptx (or the PDF deck), with the outline filled as text and the owner resolving its pictures', async () => {
    const r = await actionExecutor.executeDataStep(app, model, step({ documentId: 'deck_1' }), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.mime, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    assert.strictEqual(r.result.name, 'Kwartaal.pptx');
    assert.strictEqual(r.result.format, 'pptx');
    assert.strictEqual(r.result.slideCount, 3);
    assert.strictEqual(renders.at(-1).format, 'pptx');
    assert.strictEqual(typeof renders.at(-1).resolveImage, 'function');
    assert.match(renders.at(-1).composed, /^# Van Dijk/);
    const pdf = await actionExecutor.executeDataStep(app, model, step({ documentId: 'deck_1', format: 'pdf', fileName: { kind: 'static', value: 'Cijfers Q3' } }), ctx());
    assert.strictEqual(pdf.ok, true, pdf.error);
    assert.strictEqual(pdf.result.mime, 'application/pdf');
    assert.strictEqual(pdf.result.name, 'Cijfers Q3.pdf');
    const page = await actionExecutor.executeDataStep(app, model, step({ format: 'pptx' }), ctx());
    assert.strictEqual(page.result.name, 'Factuur.pdf', 'a page ignores the format');
});
