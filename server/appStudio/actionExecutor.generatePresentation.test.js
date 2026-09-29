/**
 * App Studio — generate_presentation step (slides in → a .pptx / PDF deck in
 * the app's attachment store, as the SAME descriptor generate_file returns).
 *
 * The renderer is stubbed (pptxgenjs is not this test's subject) but the deck
 * COLLECTION is real: what the assertions read is the deck the renderer would
 * have been handed. Store, quota, storage and scan are stubbed exactly as the
 * fill_document suite does, so the three file steps' pipelines are compared
 * like for like.
 *
 * Run: cd server && node --test --test-force-exit appStudio/actionExecutor.generatePresentation.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const OWNER = 'owner-1';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

let renderThrows = null;
let degraded = false;
const renders = [];
stub('../services/presentationRenderer', {
    async renderPresentation(args) {
        if (renderThrows) throw renderThrows;
        renders.push(args);
        const pdf = args.format === 'pdf';
        return {
            buffer: Buffer.from(pdf ? '%PDF-1.7 deck' : 'PK-deck'), contentType: pdf ? 'application/pdf' : PPTX,
            format: pdf ? 'pdf' : 'pptx', extension: pdf ? 'pdf' : 'pptx',
            slideCount: args.deck.slides.length + 1, warnings: args.deck.warnings || [], degraded, marking: null, houseStyle: args.houseStyle !== false,
        };
    },
    makeUserImageResolver: () => async () => null,
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
stub('../stores/configStore', { getConfig: async () => null, setConfig: async () => {} });

const actionExecutor = require('./actionExecutor');

const app = { id: 'app-1', userId: OWNER, organizationId: 'org-1', name: 'Ops' };
const model = { modelVersion: 1, tables: [{ id: 'tbl_slides', name: 'Slides', fields: [{ key: 'title', type: 'text' }, { key: 'content', type: 'text' }, { key: 'deck', type: 'file' }] }], roles: [], roleMapping: { default: 'app', byGroup: {} } };
const ctx = (extra = {}) => ({
    viewerId: OWNER, role: 'owner', orgId: 'org-1', formValues: {},
    vars: {
        outline: '# Kwartaalcijfers\n\nVoor de bank\n\n## Omzet\n- Groei 12%\n\n## Marge\n- Stabiel',
        rows: [{ title: 'Rij A', content: '- a' }, { title: 'Rij B', content: '- b' }],
        deckJson: { title: 'JSON', slides: [{ title: 'One', bullets: ['x'] }] },
    },
    viewer: { id: OWNER }, ...extra,
});
const step = (extra = {}) => ({ kind: 'generate_presentation', slides: { kind: 'formula', expr: 'vars.outline' }, resultVar: 'file', ...extra });

test.beforeEach(() => {
    renders.length = 0; ledgerCalls.addAttachment.length = 0; ledgerCalls.setAttachmentScan.length = 0;
    addAttachmentThrows = null; attachmentQuotaThrows = null; renderThrows = null; degraded = false; scanClean = true; storageAvailable = true;
    uploads.length = 0; deletedBlobs.length = 0;
});

test('an ai_generate outline becomes a deck and returns the SAME descriptor generate_file returns', async () => {
    const r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.result.kind, 'studio_attachment');
    assert.strictEqual(r.result.fileId, 'led-1');
    assert.strictEqual(r.result.mime, PPTX);
    assert.strictEqual(r.result.name, 'Kwartaalcijfers.pptx', 'the outline title names the file');
    assert.strictEqual(r.result.slideCount, 3);
    assert.strictEqual(r.result.format, 'pptx');
    const deck = renders[0].deck;
    assert.strictEqual(deck.title, 'Kwartaalcijfers');
    assert.strictEqual(deck.subtitle, 'Voor de bank');
    assert.deepStrictEqual(deck.slides.map((s) => s.title), ['Omzet', 'Marge']);
    assert.strictEqual(renders[0].orgId, 'org-1', "the OWNER's organisation decides the house style");
    assert.strictEqual(renders[0].marking, null);
    assert.strictEqual(uploads.length, 1);
    assert.match(uploads[0].key, /^studio-apps\/owner-1\/app-1\/attachments\/[a-f0-9]{64}$/);
    assert.strictEqual(ledgerCalls.setAttachmentScan[0].patch.scanned, true);
});

test('records with title/content columns become one slide per row; a JSON deck is taken as is', async () => {
    let r = await actionExecutor.executeDataStep(app, model, step({ slides: { kind: 'formula', expr: 'vars.rows' }, title: { kind: 'formula', expr: '"Per rij"' } }), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.deepStrictEqual(renders[0].deck.slides.map((s) => s.title), ['Rij A', 'Rij B']);
    assert.strictEqual(renders[0].deck.title, 'Per rij');
    assert.strictEqual(r.result.name, 'Per rij.pptx', 'the step title names the file');

    r = await actionExecutor.executeDataStep(app, model, step({ slides: { kind: 'formula', expr: 'vars.deckJson' } }), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(renders[1].deck.title, 'JSON');
    assert.deepStrictEqual(renders[1].deck.slides.map((s) => s.title), ['One']);
});

test('format pdf, houseStyle false and an explicit fileName reach the renderer and the descriptor', async () => {
    const r = await actionExecutor.executeDataStep(app, model, step({ format: 'pdf', houseStyle: false, fileName: { kind: 'formula', expr: '"board deck.pptx"' } }), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(renders[0].format, 'pdf');
    assert.strictEqual(renders[0].houseStyle, false);
    assert.strictEqual(r.result.mime, 'application/pdf');
    assert.strictEqual(r.result.name, 'board deck.pdf', 'a stale extension is replaced by the real one');
});

test('empty slides is the author\'s mistake, said plainly; nothing is stored', async () => {
    const r = await actionExecutor.executeDataStep(app, model, step({ slides: { kind: 'formula', expr: 'vars.nothing' } }), ctx());
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /no slides/);
    assert.strictEqual(uploads.length, 0);
});

test('attachTo links the ledger row to the record + file column; a half link is refused by the validator, not here', async () => {
    const r = await actionExecutor.executeDataStep(app, model, step({ attachToRecordId: { kind: 'formula', expr: '"rec_9"' }, attachToFieldKey: 'deck' }), ctx());
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(ledgerCalls.addAttachment[0].row.recordId, 'rec_9');
    assert.strictEqual(ledgerCalls.addAttachment[0].row.fieldKey, 'deck');
});

test('the pipeline tail is the shared one: a dirty scan discards the blob, a failed ledger write never orphans it', async () => {
    scanClean = false;
    let r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /malware/);
    assert.strictEqual(deletedBlobs.length, 1);
    assert.strictEqual(ledgerCalls.addAttachment.length, 0);

    scanClean = true; deletedBlobs.length = 0;
    addAttachmentThrows = new Error('ledger down');
    r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, false, 'an infrastructure fault is a failed step');
    assert.strictEqual(deletedBlobs.length, 1, 'the uploaded blob was removed');

    addAttachmentThrows = null; storageAvailable = false;
    r = await actionExecutor.executeDataStep(app, model, step(), ctx());
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /storage/i);
});
