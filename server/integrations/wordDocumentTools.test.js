/**
 * create_word_document — the chat's .docx tool. Pinned here: a real Word
 * package comes out (PK magic, the org's house style inside it), it lands
 * under the caller's own storage prefix, the chat card and the link the
 * model is told to write, the Nextcloud destination with its fallback, and
 * the refusals (no content, no user, no storage).
 *
 * DB-free: storage, the house-style store and Nextcloud are stubbed; the
 * renderer (html-to-docx) is real.
 *
 * Run: node --test integrations/wordDocumentTools.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../testUtils/stubRequire');

const uploads = [];
const storage = {
    available: true,
    isAvailable: () => storage.available,
    buildKey: (userId, category, filename) => `users/${userId}/${category}/${filename}`,
    buildProxyUrl: (key) => `/api/storage/file/${key.split('/').map(encodeURIComponent).join('/')}`,
    uploadFile: async (key, buffer, contentType) => { uploads.push({ key, buffer, contentType }); },
};

const HOUSE_STYLE = {
    id: 'hs-1', name: 'Kantoorstijl',
    styleMeta: {
        defaultFont: 'Georgia', defaultFontSize: 12, footer: { text: 'Acme BV · Vertrouwelijk' },
        headings: { h2: { font: 'Impact', size: 30, bold: true, color: '#ff0000' } },
    },
};
const styleLookups = [];
const houseStyleStore = {
    getById: async () => null,
    getDefaultForOrg: async (orgId) => { styleLookups.push(orgId); return orgId === 'org-1' ? HOUSE_STYLE : null; },
};

const ncPuts = [];
const nc = { connected: true, status: 201, throwOnPut: false };
const ncClient = {
    resolveAuth: async () => {
        if (!nc.connected) throw new Error('Nextcloud not connected.');
        return {
            mode: 'basic', baseUrl: 'https://cloud.example', uid: 'tom', authError: 'auth',
            fetch: async (url, opts = {}) => {
                if (opts.method === 'PUT' && nc.throwOnPut) throw new Error('getaddrinfo ENOTFOUND cloud.example');
                if (opts.method === 'PUT') ncPuts.push({ url, size: opts.body.length });
                return { ok: true, status: opts.method === 'PUT' ? nc.status : 201, headers: { get: (h) => (h === 'oc-fileid' ? '00000482ocabc' : null) }, text: async () => '' };
            },
        };
    },
    webdavRoot: (baseUrl, uid) => `${baseUrl}/remote.php/dav/files/${uid}`,
    REQUEST_TIMEOUT_MS: 30_000,
};

installResolveStub({
    '../stores/storageStore': storage,
    '../../stores/houseStyleStore': houseStyleStore,
    './nextcloudClient': ncClient,
    // webdav.js reads the same client; the real one would pull in auth and the DB.
    '../nextcloudClient': ncClient,
});

const { setMarkingResolver } = require('../core/automationRunner/documentMarking');
const { executeWordDocumentTool, WORD_DOCUMENT_TOOLS, isWordDocumentTool, safeWordFileName, nextcloudDocxPath } = require('./wordDocumentTools');

async function documentXml(buffer) {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(buffer);
    const parts = {};
    for (const name of Object.keys(zip.files)) {
        if (/^word\/.*\.xml$/.test(name)) parts[name] = await zip.file(name).async('string');
    }
    return parts;
}

test('the tool schema: title + markdown required, house style and Nextcloud optional', () => {
    const fn = WORD_DOCUMENT_TOOLS[0].function;
    assert.strictEqual(fn.name, 'create_word_document');
    assert.deepStrictEqual(fn.parameters.required, ['title', 'markdown']);
    for (const k of ['title', 'markdown', 'fileName', 'houseStyle', 'nextcloudPath']) assert.ok(fn.parameters.properties[k], k);
    assert.strictEqual(isWordDocumentTool('create_word_document'), true);
    assert.strictEqual(isWordDocumentTool('nextcloud_create_document'), false);
});

test('a real .docx in the house style, under the user\'s own prefix, with a card and a link', async () => {
    uploads.length = 0;
    styleLookups.length = 0;
    const res = await executeWordDocumentTool({
        title: 'Offerte Acme', markdown: '## Inleiding\n\nDit is de **offerte**.\n\n- punt een\n- punt twee\n',
    }, { userId: 'u1', orgId: 'org-1' });

    assert.strictEqual(res.success, true, JSON.stringify(res));
    assert.strictEqual(res.filename, 'Offerte-Acme.docx');
    assert.strictEqual(res.houseStyle, 'Kantoorstijl');
    assert.deepStrictEqual(styleLookups, ['org-1'], 'the org default style was asked for');
    assert.match(res.downloadUrl, /^\/api\/storage\/file\/users\/u1\/documents\/\d+_[0-9a-f]{6}_Offerte-Acme\.docx$/);
    assert.strictEqual(uploads.length, 1);
    assert.ok(uploads[0].key.startsWith('users/u1/documents/'), 'stored under the caller\'s prefix');
    assert.strictEqual(uploads[0].contentType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.strictEqual(uploads[0].buffer.subarray(0, 2).toString('latin1'), 'PK', 'a zip package');
    assert.strictEqual(res.size, uploads[0].buffer.length);

    assert.deepStrictEqual(res.file, {
        kind: 'word', name: 'Offerte-Acme.docx', mimeType: uploads[0].contentType, size: res.size, url: res.downloadUrl, source: 'create_word_document',
    });
    assert.match(res.message, /\[Offerte-Acme\.docx\]\(\/api\/storage\/file\/users\/u1\/documents\//);

    const xml = await documentXml(uploads[0].buffer);
    const all = Object.values(xml).join('\n');
    assert.ok(all.includes('Georgia'), 'the house-style font is in the package');
    assert.ok(all.includes('Acme BV · Vertrouwelijk'), 'the house-style footer text is in the package');
    assert.ok(xml['word/document.xml'].includes('Inleiding'), 'the body made it in');
});

test('houseStyle:false, or no organisation, is a neutral document — no style lookup', async () => {
    styleLookups.length = 0;
    const off = await executeWordDocumentTool({ title: 'T', markdown: 'x', houseStyle: false }, { userId: 'u1', orgId: 'org-1' });
    assert.strictEqual(off.houseStyle, false);
    const noOrg = await executeWordDocumentTool({ title: 'T', markdown: 'x' }, { userId: 'u1' });
    assert.strictEqual(noOrg.houseStyle, false);
    assert.deepStrictEqual(styleLookups, []);
    assert.doesNotMatch(off.message, /house style/);
});

test('the AI-Act marking reaches the .docx when the org marks generated documents', async (t) => {
    setMarkingResolver(async () => ({ enabled: true, footer_text: 'Gegenereerd met AI', provider: 'chat', org_name: 'Acme BV' }));
    t.after(() => setMarkingResolver(null));
    uploads.length = 0;
    const res = await executeWordDocumentTool({ title: 'Brief', markdown: 'tekst' }, { userId: 'u1', orgId: 'org-2' });
    assert.deepStrictEqual(res.marking, { visible: true, metadata: true });
    const xml = await documentXml(uploads[0].buffer);
    assert.ok(xml['word/document.xml'].includes('Gegenereerd met AI'));
});

test('filename: the caller\'s name wins, traversal and non-ASCII never reach the key', async () => {
    const res = await executeWordDocumentTool({ title: 'T', fileName: '../../résumé brief.docx', markdown: 'x' }, { userId: 'u1' });
    assert.strictEqual(res.filename, 'resume-brief.docx');
    assert.ok(!res.downloadUrl.includes('..'));
    assert.strictEqual(safeWordFileName(''), 'document.docx');
    assert.strictEqual(safeWordFileName('..hidden'), 'hidden.docx');
    assert.strictEqual(nextcloudDocxPath('/Documents/', { title: 'Offerte Acme' }), '/Documents/Offerte-Acme.docx');
    assert.strictEqual(nextcloudDocxPath('/Documents/brief.docx', { title: 'x' }), '/Documents/brief.docx');
    assert.strictEqual(nextcloudDocxPath('  ', { title: 'x' }), '');
    assert.strictEqual(nextcloudDocxPath(true, { title: 'x' }), '', 'only a string is a path');
});

test('refusals: no content, no user, no storage — each a message the model can act on', async () => {
    const noContent = await executeWordDocumentTool({ title: 'T', markdown: '  ' }, { userId: 'u1' });
    assert.match(noContent.error, /`markdown`/);
    const noUser = await executeWordDocumentTool({ title: 'T', markdown: 'x' }, {});
    assert.match(noUser.error, /user context/);
    storage.available = false;
    try {
        const noStorage = await executeWordDocumentTool({ title: 'T', markdown: 'x' }, { userId: 'u1' });
        assert.match(noStorage.error, /storage is not available/);
        assert.match(noStorage.error, /nextcloudPath/);
    } finally {
        storage.available = true;
    }
});

test('nextcloudPath: the file goes into Nextcloud with an Open link, not into storage', async () => {
    uploads.length = 0;
    ncPuts.length = 0;
    const res = await executeWordDocumentTool({ title: 'Offerte', markdown: 'x' }, { userId: 'u1', orgId: 'org-1', nextcloudPath: '/Documents/Offerte.docx' });
    assert.strictEqual(res.success, true, JSON.stringify(res));
    assert.strictEqual(uploads.length, 0, 'nothing kept in Bee Flow storage');
    assert.strictEqual(ncPuts.length, 1);
    assert.strictEqual(ncPuts[0].url, 'https://cloud.example/remote.php/dav/files/tom/Documents/Offerte.docx');
    assert.strictEqual(res.webUrl, 'https://cloud.example/f/482');
    assert.strictEqual(res.file.kind, 'word');
    assert.strictEqual(res.file.path, '/Documents/Offerte.docx');
    assert.match(res.message, /\[Open in Nextcloud Office\]\(https:\/\/cloud\.example\/f\/482\)/);
});

test('nextcloudPath with Nextcloud unreachable or denied: a download link, and the reason', async () => {
    uploads.length = 0;
    nc.connected = false;
    try {
        const res = await executeWordDocumentTool({ title: 'Offerte', markdown: 'x' }, { userId: 'u1', nextcloudPath: '/Documents/Offerte.docx' });
        assert.strictEqual(res.success, true);
        assert.strictEqual(uploads.length, 1, 'kept in storage instead');
        assert.match(res.nextcloud.error, /not connected/);
        assert.match(res.message, /could NOT be saved to Nextcloud/);
    } finally {
        nc.connected = true;
    }
    ncPuts.length = 0;
    const denied = await executeWordDocumentTool({ title: 'Offerte', markdown: 'x' }, { userId: 'u1', nextcloudPath: '/Private/x.docx', nextcloudError: 'outside the folders' });
    assert.strictEqual(ncPuts.length, 0, 'a denied destination is never written');
    assert.strictEqual(denied.nextcloud.error, 'outside the folders');
    assert.ok(denied.downloadUrl);
});

test('Nextcloud host unreachable (the upload throws): still a download link, and the reason', async () => {
    uploads.length = 0;
    nc.throwOnPut = true;
    try {
        const res = await executeWordDocumentTool({ title: 'Offerte', markdown: 'x' }, { userId: 'u1', nextcloudPath: '/Documents/Offerte.docx' });
        assert.strictEqual(res.success, true, JSON.stringify(res));
        assert.strictEqual(uploads.length, 1, 'kept in storage instead');
        assert.match(res.nextcloud.error, /upload failed/);
    } finally {
        nc.throwOnPut = false;
    }
});

test('house style heading font, size and colour reach word/document.xml', async () => {
    const res = await executeWordDocumentTool({ title: 'Offerte', markdown: '## Prijzen\n\ntekst' }, { userId: 'u1', orgId: 'org-1' });
    assert.strictEqual(res.success, true, JSON.stringify(res));
    const xml = (await documentXml(uploads[uploads.length - 1].buffer))['word/document.xml'];
    assert.match(xml, /Impact/);
    assert.match(xml, /FF0000/i);
    assert.match(xml, /w:sz w:val="60"/, '30pt in half-points');
});
