/**
 * A cloud folder as a knowledge source, the half that runs the storage layer's own rules: the
 * change-marker comparison and the export of native Google files
 * (core/dataEngine/sources/spreadsheetFile/providers, the datatables module's), behind the same
 * fake storage and extractor as cloudFolder.test.js (cloudFolder.testkit.js).
 *
 * Run: cd server && node --test core/kb/sources/cloudFolder.datatables.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { syncSource } = require('./index');
const cloudFolder = require('./cloudFolder.mts');
const { useCloudWorld, KB, DOCX, file, folder, fakeStorage, engine, SOURCE, stored } = require('./cloudFolder.testkit');
useCloudWorld();

test('new file ingested, changed file re-ingested in place, unchanged file never downloaded, vanished file removed', async () => {
    const storage = fakeStorage({
        tree: { '/Docs': [file('11', 'new.pdf'), file('12', 'edited.pdf', { marker: { etag: '"12-v2"' } }), file('13', 'same.pdf')] },
    });
    const { deps, calls } = engine({
        storage,
        stored: [stored('d12', '12', { etag: '"12-v1"' }), stored('d13', '13', { etag: '"13-v1"' }), stored('d99', '99', { etag: '"x"' })],
    });
    const r = await syncSource(SOURCE, { deps });
    assert.deepStrictEqual([r.added, r.updated, r.unchanged, r.removed, r.failed], [1, 1, 1, 1, 0]);
    assert.deepStrictEqual(storage.calls.download.map((d) => d.ref.fileId).sort(), ['11', '12'], 'the unchanged file costs no download');
    assert.strictEqual(calls.ingest[0].externalId, '11', 'identity is the storage file id, not the path');
    assert.strictEqual(calls.reingest[0].docId, 'd12', 'a changed file keeps its documents row');
    assert.deepStrictEqual(calls.deleted, ['d99']);
});

test('a renamed or moved file keeps its document: the external id is the file id, never the path', async () => {
    const storage = fakeStorage({ tree: { '/Docs': [file('11', 'renamed.pdf', { path: '/Docs/Elsewhere/renamed.pdf' })] } });
    const { deps, calls } = engine({ storage, stored: [stored('d11', '11', { etag: '"11-v1"' })] });
    const r = await syncSource(SOURCE, { deps });
    assert.deepStrictEqual([r.added, r.removed, r.unchanged], [0, 0, 1]);
    assert.strictEqual(calls.ingest.length + calls.reingest.length, 0);
});

test('the document handed to the engine: text, the file as original, and metadata from an explicit allow-list', async () => {
    const item = { externalId: '11', provider: 'nextcloud_files', fileId: '11', driveId: null, path: '/Docs/a.pdf', name: 'a.pdf', mimeType: 'application/octet-stream', format: 'pdf', size: 50, modifiedAt: '2026-09-01T10:00:00Z', webUrl: 'https://nc/f/11', marker: { etag: '"old"', token: 'SECRET' } };
    const storage = fakeStorage();
    const ctx = { source: SOURCE, kb: KB, log: () => {} };
    const doc = await cloudFolder.fetch(item, null, ctx, { cloud: storage.cloud });
    assert.strictEqual(doc.content, 'text of a.pdf');
    assert.strictEqual(doc.title, 'a.pdf');
    assert.strictEqual(doc.mime, 'application/pdf', 'the mime comes from the format, not from a storage that says octet-stream');
    assert.strictEqual(doc.sizeBytes, Buffer.byteLength('BYTES-11'));
    assert.strictEqual(doc.pageCount, 3);
    assert.strictEqual(doc.sourceUri, 'https://nc/f/11');
    assert.deepStrictEqual(Object.keys(doc.metadata).sort(), ['marker', 'path', 'provider', 'webUrl']);
    assert.deepStrictEqual(doc.metadata.marker, { etag: '"11-dl"' }, 'the marker probed with the bytes, so a change in between is caught next pass');
    assert.deepStrictEqual(doc.original.buffer, Buffer.from('BYTES-11'));
    assert.deepStrictEqual([doc.original.mime, doc.original.filename], ['application/pdf', 'a.pdf']);
    assert.strictEqual(storage.calls.download[0].opts.maxBytes, 50 * 1024 * 1024);
});

test('isUnchanged: marker equal is unchanged; a missing marker, an errored document or a moved marker is not', () => {
    const item = { provider: 'nextcloud_files', marker: { etag: '"a"' } };
    assert.strictEqual(cloudFolder.isUnchanged(item, stored('d', '1', { etag: '"a"' })), true);
    assert.strictEqual(cloudFolder.isUnchanged(item, stored('d', '1', { etag: '"b"' })), false);
    assert.strictEqual(cloudFolder.isUnchanged(item, stored('d', '1', null)), false);
    assert.strictEqual(cloudFolder.isUnchanged({ ...item, marker: null }, stored('d', '1', { etag: '"a"' })), false);
    assert.strictEqual(cloudFolder.isUnchanged(item, stored('d', '1', { etag: '"a"' }, { status: 'error' })), false, 'a document that failed to embed is retried');
    assert.strictEqual(cloudFolder.isUnchanged({ provider: 'onedrive', marker: { cTag: 'c1' } }, stored('d', '1', { cTag: 'c1' })), true);
    assert.strictEqual(cloudFolder.isUnchanged({ provider: 'google_drive', marker: { version: '5' } }, stored('d', '1', { version: 5 })), true);
});

test('a sub-folder that cannot be listed holds back deletions; the chosen folder failing fails the pass', async () => {
    const storage = fakeStorage({ tree: { '/Docs': [file('1', 'a.pdf'), folder('s', 'Sub')], '/Docs/Sub': new Error('boom') } });
    const { deps, calls } = engine({ storage, stored: [stored('d2', '2', { etag: '"x"' })] });
    const r = await syncSource(SOURCE, { deps });
    assert.strictEqual(r.added, 1);
    assert.strictEqual(r.removed, 0, 'the file in the unreadable sub-folder is not taken for deleted');
    assert.deepStrictEqual(calls.deleted, []);

    const broken = fakeStorage({ tree: { '/Docs': new Error('folder is gone') } });
    await assert.rejects(() => syncSource(SOURCE, { deps: engine({ storage: broken }).deps }), /folder is gone/);
});

test('a native Google Doc is read as its docx export, named and typed as one', async () => {
    const item = { externalId: 'g1', provider: 'google_drive', fileId: 'g1', driveId: null, path: '/Memo', name: 'Memo', mimeType: 'application/vnd.google-apps.document', format: 'gdoc', size: null, modifiedAt: null, webUrl: null, marker: { version: '4' } };
    const storage = fakeStorage();
    const g = { ...SOURCE, config: { provider: 'google_drive', folderName: 'x' } };
    const doc = await cloudFolder.fetch(item, null, { source: g, kb: KB, log: () => {} }, { cloud: storage.cloud });
    assert.deepStrictEqual(storage.calls.extract, [{ mime: DOCX, filename: 'Memo.docx' }]);
    assert.deepStrictEqual([doc.original.mime, doc.original.filename], [DOCX, 'Memo.docx']);
    assert.strictEqual(doc.sourceUri, null);
});

test('KB_CLOUD_MAX_FILE_MB: an oversized file is refused from the listing, without a download', async () => {
    process.env.KB_CLOUD_MAX_FILE_MB = '1';
    const storage = fakeStorage();
    const big = { externalId: 'b', provider: 'nextcloud_files', fileId: 'b', name: 'big.pdf', format: 'pdf', size: 3 * 1048576, marker: { etag: '"b"' } };
    await assert.rejects(() => cloudFolder.fetch(big, null, { source: SOURCE, kb: KB, log: () => {} }, { cloud: storage.cloud }), /"big.pdf" is 3.0 MB; the limit is 1.0 MB \(KB_CLOUD_MAX_FILE_MB\)/);
    assert.strictEqual(storage.calls.download.length, 0);
    process.env.KB_CLOUD_MAX_FILE_MB = '0';
    assert.strictEqual(cloudFolder.maxFileBytes(), Infinity);
    await cloudFolder.fetch(big, null, { source: SOURCE, kb: KB, log: () => {} }, { cloud: storage.cloud });
    assert.strictEqual(storage.calls.download[0].opts.maxBytes, null, 'no limit means no limit is passed on');
});

test('a file that cannot be read fails with its reason, and is not downloaded again until it changes', async () => {
    const storage = fakeStorage({ extractImpl: async () => { throw new Error('Could not extract text from PDF'); } });
    const ctx = { source: SOURCE, kb: KB, log: () => {} };
    const item = { externalId: 'scan', provider: 'nextcloud_files', fileId: 'scan', name: 'scan.pdf', format: 'pdf', size: 10, marker: { etag: '"s1"' } };
    await assert.rejects(() => cloudFolder.fetch(item, null, ctx, { cloud: storage.cloud }), /"scan.pdf" could not be read: Could not extract text from PDF/);
    await assert.rejects(() => cloudFolder.fetch(item, null, ctx, { cloud: storage.cloud }), /could not be read/);
    assert.strictEqual(storage.calls.download.length, 1, 'the second try comes from memory');
    await assert.rejects(() => cloudFolder.fetch({ ...item, marker: { etag: '"s2"' } }, null, ctx, { cloud: storage.cloud }));
    assert.strictEqual(storage.calls.download.length, 2, 'an edited file is tried afresh');

    const empty = fakeStorage({ extractImpl: async () => ({ text: '  ', meta: { pageCount: null, sheetNames: null } }) });
    await assert.rejects(() => cloudFolder.fetch({ ...item, fileId: 'e', externalId: 'e' }, null, ctx, { cloud: empty.cloud }), /has no text/);
});

test('in the engine a file that cannot be read is one failure; the other files still arrive', async () => {
    const storage = fakeStorage({
        tree: { '/Docs': [file('1', 'bad.pdf'), file('2', 'good.pdf')] },
        extractImpl: async (b, m, filename) => { if (filename === 'bad.pdf') throw new Error('nope'); return { text: 'fine text', meta: { pageCount: 1, sheetNames: null } }; },
    });
    const { deps, calls } = engine({ storage });
    const r = await syncSource(SOURCE, { deps });
    assert.deepStrictEqual([r.added, r.failed], [1, 1]);
    assert.deepStrictEqual(calls.ingest.map((i) => i.externalId), ['2']);
});

test('precheck: a moved cursor runs the pass and stores the new cursor only after a pass that read everything', async () => {
    const storage = fakeStorage({ tree: { '/Docs': [file('1', 'a.pdf')] }, cursor: async () => ({ changed: true, cursor: '"e2"' }) });
    const { deps, calls } = engine({ storage });
    const r = await syncSource({ ...SOURCE, config: { ...SOURCE.config, syncCursor: '"e1"' } }, { deps });
    assert.strictEqual(r.added, 1);
    assert.deepStrictEqual(calls.cursor, [{ id: 'src1', c: '"e2"' }]);
});

test('precheck: any error in the check means "changed" — the full pass runs', async () => {
    const storage = fakeStorage({ tree: { '/Docs': [file('1', 'a.pdf')] }, cursor: async () => { throw new Error('storage down'); } });
    const { deps, calls } = engine({ storage });
    const logs = [];
    const r = await syncSource({ ...SOURCE, config: { ...SOURCE.config, syncCursor: '"e1"' } }, { deps, log: (...a) => logs.push(a.join(' ')) });
    assert.strictEqual(r.added, 1, 'never skipped silently');
    assert.ok(logs.some((l) => /change check failed/.test(l)));
    assert.strictEqual(calls.cursor.length, 0);
});

test('precheck: a stale stored cursor is replaced by a fresh anchor and the pass runs', async () => {
    let n = 0;
    const storage = fakeStorage({
        tree: { '/Docs': [file('1', 'a.pdf')] },
        cursor: async (f, c) => { n += 1; if (c) throw new Error('410 gone'); return { changed: true, cursor: 'fresh' }; },
    });
    const { deps, calls } = engine({ storage });
    const r = await syncSource({ ...SOURCE, config: { ...SOURCE.config, syncCursor: 'stale' } }, { deps });
    assert.strictEqual(n, 2);
    assert.strictEqual(r.added, 1);
    assert.deepStrictEqual(calls.cursor, [{ id: 'src1', c: 'fresh' }]);
});
