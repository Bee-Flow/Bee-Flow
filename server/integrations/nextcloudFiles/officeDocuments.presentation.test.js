/**
 * nextcloud_create_presentation — the deck lands in Nextcloud Files and the
 * tool answers with the deep link that opens it in Nextcloud Office.
 *
 * The WebDAV fetch is a recording stub. What is pinned: MKCOL parents then a
 * PUT with the pptx MIME, the file id from the `OC-FileId` header or from one
 * PROPFIND when the header is missing (connector hop), and which base URL a
 * link may be built from.
 *
 * DB-free: configStore is stubbed (the house style reads it).
 *
 * Run: node --test --test-force-exit integrations/nextcloudFiles/officeDocuments.presentation.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const JSZip = require('jszip');

const { installResolveStub } = require('../../testUtils/stubRequire');
installResolveStub({
    '../../stores/configStore': { getConfig: async () => null, setConfig: async () => {} },
});

const { executeOfficeDocumentTool } = require('./officeDocuments');

const BASE = 'https://nc.example.test';
const ROOT = `${BASE}/remote.php/dav/files/alice`;
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const PROPFIND_XML = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:response>
    <d:href>/remote.php/dav/files/alice/Presentations/q3.pptx</d:href>
    <d:propstat><d:prop><oc:fileid>4711</oc:fileid><d:getetag>"abc"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;

function response({ ok, status, headers = {}, body = '' }) {
    return { ok, status, headers: new Headers(headers), text: async () => body, arrayBuffer: async () => Buffer.from(body).buffer };
}

function makeCtx({ putHeaders = {}, mode = 'bearer', publicBaseUrl = null, propfind = true } = {}) {
    const calls = [];
    const ncFetch = async (url, opts = {}) => {
        const method = opts.method || 'GET';
        calls.push({ url, method, headers: opts.headers || {}, body: opts.body });
        if (method === 'MKCOL') return response({ ok: true, status: 201 });
        if (method === 'PUT') return response({ ok: true, status: 201, headers: putHeaders });
        if (method === 'PROPFIND') return propfind ? response({ ok: true, status: 207, body: PROPFIND_XML }) : response({ ok: false, status: 404 });
        throw new Error(`unexpected method ${method}`);
    };
    return {
        calls,
        ctx: { ncFetch, authError: 'Reconnect Nextcloud', root: ROOT, baseUrl: BASE, uid: 'alice', mode, publicBaseUrl, userId: 'u1', orgId: null },
    };
}

const ARGS = { path: '/Presentations/q3', title: 'Q3', slides: [{ title: 'Omzet', bullets: ['Groei 12%'], notes: 'n' }] };
const run = (args, ctx) => executeOfficeDocumentTool('nextcloud_create_presentation', args, ctx);

test('creates the parents, PUTs a real .pptx and links it by the OC-FileId header', async () => {
    const { ctx, calls } = makeCtx({ putHeaders: { 'OC-FileId': '00004711ocabcdef' } });
    const res = await run(ARGS, ctx);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.path, '/Presentations/q3.pptx', '.pptx appended');
    assert.strictEqual(res.contentType, PPTX_MIME);
    assert.strictEqual(res.fileId, '4711');
    assert.strictEqual(res.webUrl, `${BASE}/f/4711`);
    assert.strictEqual(res.slideCount, 2);
    assert.match(res.message, /\[Open in Nextcloud Office\]\(https:\/\/nc\.example\.test\/f\/4711\)/);

    assert.deepStrictEqual(calls.map((c) => c.method), ['MKCOL', 'PUT'], 'no PROPFIND when the header answers');
    const put = calls[1];
    assert.ok(put.url.endsWith('/Presentations/q3.pptx'));
    assert.strictEqual(put.headers['Content-Type'], PPTX_MIME);
    const zip = await JSZip.loadAsync(put.body);
    assert.match(await zip.file('ppt/slides/slide2.xml').async('string'), /Groei 12%/);
});

test('without the header (connector hop) one PROPFIND supplies the file id', async () => {
    const { ctx, calls } = makeCtx({ mode: 'connector', publicBaseUrl: 'https://cloud.example.org' });
    const res = await run(ARGS, ctx);
    assert.deepStrictEqual(calls.map((c) => c.method), ['MKCOL', 'PUT', 'PROPFIND']);
    assert.strictEqual(calls[2].headers.Depth, '0');
    assert.strictEqual(res.fileId, '4711');
    assert.strictEqual(res.webUrl, 'https://cloud.example.org/f/4711', 'the PUBLIC base URL, never the connector proxy');
});

test('a connector session without a public base URL gets the path but no link', async () => {
    const { ctx } = makeCtx({ mode: 'connector', publicBaseUrl: null });
    const res = await run(ARGS, ctx);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.fileId, '4711');
    assert.strictEqual(res.webUrl, null);
    assert.match(res.message, /Saved \/Presentations\/q3\.pptx/);
});

test('no file id at all is still a success', async () => {
    const { ctx } = makeCtx({ propfind: false });
    const res = await run(ARGS, ctx);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.fileId, null);
    assert.strictEqual(res.webUrl, null);
});

test('refuses a call without slides or markdown, and surfaces a deck error as a message', async () => {
    const { ctx } = makeCtx();
    assert.match((await run({ path: '/x', title: 'T' }, ctx)).error, /`slides`.*`markdown`/);
    const tooBig = await run({ path: '/x', title: 'T', slides: Array.from({ length: 70 }, (_, i) => ({ title: `s${i}` })) }, ctx);
    assert.match(tooBig.error, /limit is 60/);
    assert.strictEqual(await executeOfficeDocumentTool('nextcloud_something_else', {}, ctx), undefined);
});

test('templatePath: the template deck is read from Nextcloud and its look rides along; a missing one is a plain error', async () => {
    const PptxGenJS = require('pptxgenjs');
    const sharp = require('sharp');
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_16x9';
    const bg = `data:image/png;base64,${(await sharp({ create: { width: 64, height: 36, channels: 4, background: { r: 15, g: 150, b: 224, alpha: 1 } } }).png().toBuffer()).toString('base64')}`;
    const s = pptx.addSlide();
    s.addImage({ data: bg, x: 0, y: 0, w: 10, h: 5.625 });
    s.addText('Conf', { x: 1, y: 1, w: 3, h: 1, color: 'FFFFFF' });
    const tplBytes = await pptx.write({ outputType: 'nodebuffer' });
    const { calls, ctx } = makeCtx();
    const plainFetch = ctx.ncFetch;
    ctx.ncFetch = async (url, opts = {}) => {
        if ((opts.method || 'GET') === 'GET' && /Templates\/conf\.pptx$/.test(url)) return { ok: true, status: 200, headers: new Headers({ 'content-type': PPTX_MIME }), arrayBuffer: async () => tplBytes.buffer.slice(tplBytes.byteOffset, tplBytes.byteOffset + tplBytes.byteLength) };
        if ((opts.method || 'GET') === 'GET') return response({ ok: false, status: 404 });
        return plainFetch(url, opts);
    };
    const res = await run({ ...ARGS, templatePath: '/Templates/conf.pptx' }, ctx);
    assert.ok(!res.error, res.error);
    const put = calls.find((c) => c.method === 'PUT');
    const zip = await JSZip.loadAsync(put.body);
    let content = null;
    for (const n of Object.keys(zip.files).filter((f) => /slideLayouts\/slideLayout\d+\.xml$/.test(f))) { const x = await zip.file(n).async('string'); if (x.includes('name="BF_CONTENT"')) content = x; }
    assert.match(content, /<p:bg>[\s\S]*?<a:blipFill/, 'the deck is built on the template picture');
    const missing = await run({ ...ARGS, templatePath: '/Templates/nope.pptx' }, ctx);
    assert.match(missing.error, /Template deck not found/);
});
