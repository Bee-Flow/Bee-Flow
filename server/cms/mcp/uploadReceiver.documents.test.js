/**
 * Document uploads through the one-time upload URL (cms/mcp/uploadReceiver.js): PDF, DOCX, XLSX
 * and PPTX are checked on their bytes, streamed into storage (never buffered whole) under the
 * extension of their type, and refused when the bytes are something else.
 *
 * Run: node --test cms/mcp/uploadReceiver.documents.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const JSZip = require('jszip');

const { createUploadTickets } = require('./uploadTickets');
const { createUploadReceiver, EXT_BY_TYPE } = require('./uploadReceiver');
const { maxBytesFor } = require('../../core/cms/uploadPolicy');

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function harness() {
    const kv = new Map();
    const tickets = createUploadTickets({
        store: {
            get: async (k) => (kv.has(k) ? structuredClone(kv.get(k)) : null),
            set: async (k, v) => { kv.set(k, structuredClone(v)); },
            mutate: async (k, fn) => { const n = fn(kv.has(k) ? structuredClone(kv.get(k)) : null); kv.set(k, n); return n; },
            remove: async (k) => { kv.delete(k); },
            listKeys: async () => [...kv.keys()],
        },
    });
    const buffered = [];
    const streamed = [];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-doc-test-'));
    const receiver = createUploadReceiver({
        tickets,
        storage: { isAvailable: () => true, uploadFile: async (key, body, type) => { buffered.push({ key, type }); } },
        streamIntoStorage: async (file, size, key, type) => { streamed.push({ key, type, bytes: fs.readFileSync(file) }); },
        sanitizeSvg: () => null,
        isValidVtt: () => false,
        looksLikeClip: () => false,
        checkAccess: async () => ({ ok: true }),
        tmpRoot: () => tmp,
    });
    /** @param {string} contentType @param {Buffer} body @param {string} filename */
    async function upload(contentType, body, filename) {
        const { ticket } = await tickets.issue({ userId: 'u1', orgId: 'o1', siteId: 'pj_aaaa', contentType, maxSize: body.length, filename, tokenId: 't1', legacy: false });
        return receiver.handle({ ticket, contentType, contentLength: body.length, ip: '203.0.113.5', stream: Readable.from([body]) });
    }
    return { upload, buffered, streamed, tmp };
}

test('a PDF is stored as .pdf through the streaming path, bytes intact', async () => {
    const h = harness();
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2000, 0x20)]);
    const out = await h.upload(PDF, pdf, 'AI policy (v1).html');
    assert.equal(out.status, 200);
    assert.match(out.body.key, /^cms\/\d+-[a-f0-9]{12}-AI_policy__v1_\.pdf$/, 'the extension comes from the type, not the name');
    assert.equal(out.body.contentType, PDF);
    assert.equal(h.buffered.length, 0);
    assert.equal(h.streamed.length, 1);
    assert.deepEqual(h.streamed[0].bytes, pdf);
    assert.deepEqual(fs.readdirSync(h.tmp), []);
});

test('a real Word package is stored as .docx', async () => {
    const h = harness();
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('word/document.xml', '<w:document/>');
    const docx = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const out = await h.upload(DOCX, docx, 'template.docx');
    assert.equal(out.status, 200);
    assert.ok(out.body.key.endsWith('-template.docx'));
    assert.equal(h.streamed[0].type, DOCX);
});

test('bytes that are not the declared document are refused and nothing is stored', async () => {
    const h = harness();
    const html = Buffer.from('<html><body><script>alert(document.cookie)</script></body></html>');
    for (const type of [PDF, DOCX]) {
        const out = await h.upload(type, html, 'x.pdf');
        assert.equal(out.status, 400, type);
        assert.match(out.body.error, /not a valid PDF, Word, Excel or PowerPoint file/);
    }
    assert.equal(h.streamed.length + h.buffered.length, 0);
    assert.deepEqual(fs.readdirSync(h.tmp), []);
});

test('every document type has an extension and a size cap; the cap is CMS_DOCUMENT_MAX_MB (0 = no limit)', () => {
    for (const type of [PDF, DOCX, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']) {
        assert.ok(EXT_BY_TYPE[type], type);
        assert.equal(maxBytesFor(type), 25 * 1024 * 1024, type);
    }
    const old = process.env.CMS_DOCUMENT_MAX_MB;
    try {
        process.env.CMS_DOCUMENT_MAX_MB = '100';
        assert.equal(maxBytesFor(PDF), 100 * 1024 * 1024);
        process.env.CMS_DOCUMENT_MAX_MB = '0';
        assert.equal(maxBytesFor(PDF), Number.MAX_SAFE_INTEGER);
    } finally {
        if (old === undefined) delete process.env.CMS_DOCUMENT_MAX_MB; else process.env.CMS_DOCUMENT_MAX_MB = old;
    }
    assert.equal(maxBytesFor('application/msword'), null, 'old binary Office formats are not accepted');
    assert.equal(maxBytesFor('application/vnd.ms-word.document.macroenabled.12'), null);
});

test('with no document cap (CMS_DOCUMENT_MAX_MB=0) the storage deadline stays a delay a timer can hold', () => {
    const { storeDeadlineMs } = require('./uploadTickets');
    // Above 2^31 - 1 ms Node fires a timer at once: the store would time out immediately.
    assert.equal(storeDeadlineMs(Number.MAX_SAFE_INTEGER), 2 ** 31 - 1);
    assert.equal(storeDeadlineMs(3 * 1024 ** 4), 2 ** 31 - 1);
    assert.equal(storeDeadlineMs(10 * 1024 * 1024), 70 * 1000);
});
