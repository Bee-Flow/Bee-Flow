/**
 * A folder in Nextcloud, OneDrive or Google Drive as a knowledge source
 * (core/kb/sources/cloudFolder.mts), driven through the real refresh engine
 * with a fake storage and a fake extractor.
 *
 * What a wrong answer costs here: a file listed but never read is a document
 * that silently is not there; a file the listing could not reach taken for
 * "deleted" is a customer's document destroyed; an unchanged file downloaded
 * every five minutes is the folder poll turned into a bandwidth bill; a
 * revoked connection read as an empty folder wipes the source.
 *
 * Run: cd server && node --test core/kb/sources/cloudFolder.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { syncSource, nextRefreshFor } = require('./index');
const cloudFolder = require('./cloudFolder.mts');

const KB = { id: 'kb1', tenant_id: 'tenant1', organization_id: 'org1' };
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const ENV = ['KB_CLOUD_MAX_FILES', 'KB_CLOUD_MAX_FILE_MB', 'KB_CLOUD_CHANGE_POLL_SECONDS'];
test.afterEach(() => { for (const k of ENV) delete process.env[k]; cloudFolder.forgetFailures(); });

const file = (id, name, extra = {}) => ({
    provider: 'nextcloud_files', fileId: id, driveId: null, path: `/Docs/${name}`, name, mimeType: 'application/pdf',
    format: 'pdf', size: 100, modifiedAt: '2026-09-01T10:00:00Z', webUrl: `https://nc/f/${id}`, isFolder: false,
    marker: { etag: `"${id}-v1"` }, ...extra,
});
const folder = (id, name, extra = {}) => ({ provider: 'nextcloud_files', fileId: id, path: `/Docs/${name}`, name, isFolder: true, ...extra });

/** A storage with a tree: key = the folder path, value = its entries (or an Error to throw). */
function fakeStorage({ tree = {}, cursor = null, linkerError = null, extractImpl = null } = {}) {
    const calls = { list: [], download: [], extract: [], resolved: 0, changeCursor: [] };
    const api = {
        list: async (opts) => {
            const key = opts.path || (opts.parentId && typeof opts.parentId === 'object' ? opts.parentId.id : opts.parentId) || '/';
            calls.list.push(key);
            const node = tree[key];
            if (node instanceof Error) throw node;
            return { items: node || [], nextPageToken: null };
        },
        download: async (ref, opts) => {
            calls.download.push({ ref, opts });
            return { buffer: Buffer.from(`BYTES-${ref.fileId}`), marker: { etag: `"${ref.fileId}-dl"` } };
        },
        ...(cursor ? { changeCursor: async (f, c) => { calls.changeCursor.push({ f, c }); return cursor(f, c); } } : {}),
    };
    const cloud = {
        resolveLinker: async (source, opts) => {
            calls.resolved += 1;
            calls.linkerArgs = { source, opts };
            if (linkerError) throw linkerError;
            return { api };
        },
        extract: async (buffer, mime, filename) => {
            calls.extract.push({ mime, filename });
            if (extractImpl) return extractImpl(buffer, mime, filename);
            return { text: `text of ${filename}`, meta: { pageCount: 3, sheetNames: null } };
        },
    };
    return { calls, cloud };
}

function engine({ stored = [], storage, cursorStore = true } = {}) {
    const calls = { ingest: [], reingest: [], deleted: [], cursor: [] };
    const deps = {
        kbStore: {
            getKB: async () => KB,
            listDocuments: async (kbId, { offset = 0 } = {}) => (offset > 0 ? [] : stored),
            getDocument: async (id) => stored.find((d) => d.id === id) || null,
            bumpKBVersion: async () => {},
        },
        kbSourcesStore: {
            isCancelRequested: async () => false,
            ...(cursorStore ? { setSyncCursor: async (id, c) => { calls.cursor.push({ id, c }); } } : {}),
        },
        helpers: {
            ingestDocument: async (t, k, content, title, sourceType, sourceUri, opts) => {
                calls.ingest.push({ content, title, sourceType, sourceUri, ...opts });
                return { document: { id: `new_${opts.externalId}` }, chunks: 1, status: 'processed' };
            },
            reingestDocument: async (t, k, docId, content, opts) => {
                calls.reingest.push({ docId, content, ...opts });
                return { document: { id: docId }, chunks: 1, status: 'processed' };
            },
            deleteDocumentChunks: async (kbId, docId) => { calls.deleted.push(docId); },
        },
        extractSummary: { summarise: async () => ({ summary: null }) },
        cloud: storage.cloud,
    };
    return { deps, calls };
}

const SOURCE = {
    id: 'src1', knowledgeBaseId: 'kb1', kind: 'cloud_folder', refreshMode: 'on_change', createdBy: 'u1',
    config: { provider: 'nextcloud_files', path: '/Docs', folderName: 'Docs', recursive: true },
};
const stored = (id, externalId, marker, over = {}) => ({
    id, external_id: externalId, title: externalId, status: 'processed', metadata: marker ? { marker } : {}, ...over,
});

// ─── The diff ───────────────────────────────────────────────────────────

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

// ─── Walking ────────────────────────────────────────────────────────────

test('recursion: sub-folders are walked, and a tree deeper than the depth cap stops there without deleting anything', async () => {
    // /Docs holds f0 and l1; l1 holds f1 and l2; and so on, 13 levels down.
    const tree = {};
    let here = '/Docs';
    for (let depth = 0; depth <= 12; depth += 1) {
        const below = `${here}/l${depth + 1}`;
        tree[here] = [file(`f${depth}`, `f${depth}.pdf`, { path: `${here}/f${depth}.pdf` }), folder(`s${depth + 1}`, `l${depth + 1}`, { path: below })];
        here = below;
    }
    const storage = fakeStorage({ tree });
    const ctx = { source: SOURCE, kb: KB, log: () => {} };
    const items = await cloudFolder.enumerate(SOURCE, ctx, { cloud: storage.cloud });
    assert.strictEqual(cloudFolder.MAX_DEPTH, 10);
    assert.deepStrictEqual(items.map((i) => i.externalId), Array.from({ length: 11 }, (_, i) => `f${i}`), 'levels 0 to 10');
    assert.strictEqual(ctx.partial, true, 'what was not reached is not "gone"');

    const { deps, calls } = engine({ storage: fakeStorage({ tree }), stored: [stored('dz', 'deep', { etag: '"x"' })] });
    const r = await syncSource(SOURCE, { deps });
    assert.strictEqual(r.removed, 0);
    assert.deepStrictEqual(calls.deleted, []);
});

test('recursive:false reads only the chosen folder', async () => {
    const storage = fakeStorage({ tree: { '/Docs': [file('1', 'a.pdf'), folder('s', 'Sub')], '/Docs/Sub': [file('2', 'b.pdf')] } });
    const ctx = { source: SOURCE, kb: KB, log: () => {} };
    const items = await cloudFolder.enumerate({ ...SOURCE, config: { ...SOURCE.config, recursive: false } }, ctx, { cloud: storage.cloud });
    assert.deepStrictEqual(items.map((i) => i.externalId), ['1']);
    assert.deepStrictEqual(storage.calls.list, ['/Docs']);
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

test('KB_CLOUD_MAX_FILES caps the listing (0 = no cap) and marks it partial', async () => {
    const entries = [file('1', 'a.pdf'), file('2', 'b.pdf'), file('3', 'c.pdf')];
    process.env.KB_CLOUD_MAX_FILES = '2';
    const capped = { source: SOURCE, kb: KB, log: () => {} };
    const items = await cloudFolder.enumerate(SOURCE, capped, { cloud: fakeStorage({ tree: { '/Docs': entries } }).cloud });
    assert.strictEqual(items.length, 2);
    assert.strictEqual(capped.partial, true);
    assert.strictEqual(cloudFolder.maxFiles(), 2);

    process.env.KB_CLOUD_MAX_FILES = '0';
    const free = { source: SOURCE, kb: KB, log: () => {} };
    assert.strictEqual((await cloudFolder.enumerate(SOURCE, free, { cloud: fakeStorage({ tree: { '/Docs': entries } }).cloud })).length, 3);
    assert.strictEqual(free.partial, undefined);
    assert.strictEqual(cloudFolder.maxFiles(), Infinity);
    delete process.env.KB_CLOUD_MAX_FILES;
    assert.strictEqual(cloudFolder.maxFiles(), 2000);
});

test('a file listed by two folders is one item; a file without a storage id is skipped, never keyed by its path', async () => {
    const storage = fakeStorage({ tree: { '/Docs': [file('1', 'a.pdf'), file('1', 'a-again.pdf'), file(null, 'nameless.pdf'), folder('s', 'Sub')], '/Docs/Sub': [file('1', 'a.pdf')] } });
    const items = await cloudFolder.enumerate(SOURCE, { source: SOURCE, kb: KB, log: () => {} }, { cloud: storage.cloud });
    assert.deepStrictEqual(items.map((i) => i.externalId), ['1']);
});

// ─── Credentials ────────────────────────────────────────────────────────

test('the storage is opened as the person who added the folder, in documents mode, with the folder as the file', async () => {
    const storage = fakeStorage({ tree: { '/Docs': [] } });
    await cloudFolder.enumerate(SOURCE, { source: SOURCE, kb: KB, log: () => {} }, { cloud: storage.cloud });
    assert.strictEqual(storage.calls.linkerArgs.source.linkedByUserId, 'u1');
    assert.deepStrictEqual(storage.calls.linkerArgs.source.file, { path: '/Docs' });
    assert.deepStrictEqual(storage.calls.linkerArgs.opts, { orgId: 'org1', accept: 'documents' });
    const g = { ...SOURCE, config: { provider: 'google_drive', folderId: 'F1', folderName: 'x' } };
    await cloudFolder.enumerate(g, { source: g, kb: KB, log: () => {} }, { cloud: storage.cloud });
    assert.deepStrictEqual(storage.calls.linkerArgs.source.file, { id: 'F1' });
});

test('a revoked or missing connection fails the pass with a sentence that says whose connection, and removes nothing', async () => {
    const reauth = Object.assign(new Error('internal'), { code: 'provider_not_connected', detail: 'needs_reauth' });
    const storage = fakeStorage({ linkerError: reauth });
    const { deps, calls } = engine({ storage, stored: [stored('d1', '1', { etag: '"x"' })] });
    await assert.rejects(() => syncSource({ ...SOURCE, config: { ...SOURCE.config, provider: 'google_drive' } }, { deps }),
        (e) => e.code === 'provider_not_connected' && /Google Drive needs to be reconnected by the person who added this folder/.test(e.message));
    assert.deepStrictEqual(calls.deleted, []);

    const none = fakeStorage({ linkerError: Object.assign(new Error('x'), { code: 'provider_not_connected' }) });
    await assert.rejects(() => syncSource(SOURCE, { deps: engine({ storage: none }).deps }), /not connected to Nextcloud/);

    const orphan = { ...SOURCE, createdBy: null };
    await assert.rejects(() => syncSource(orphan, { deps: engine({ storage: fakeStorage() }).deps }), /no longer in Bee Flow/);
});

// ─── Reading a file ─────────────────────────────────────────────────────

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

// ─── Precheck ───────────────────────────────────────────────────────────

test('precheck: an unchanged cursor ends the pass with no listing, no download and no write', async () => {
    const storage = fakeStorage({ tree: { '/Docs': [file('1', 'a.pdf')] }, cursor: async () => ({ changed: false, cursor: '"e1"' }) });
    const src = { ...SOURCE, config: { ...SOURCE.config, syncCursor: '"e1"' } };
    const { deps, calls } = engine({ storage });
    const r = await syncSource(src, { deps });
    assert.strictEqual(r.precheckUnchanged, true);
    assert.deepStrictEqual([r.added, r.updated, r.removed, r.unchanged, r.failed], [0, 0, 0, 0, 0]);
    assert.deepStrictEqual(storage.calls.list, []);
    assert.deepStrictEqual(storage.calls.download, []);
    assert.deepStrictEqual(storage.calls.changeCursor[0], { f: { folderId: null, driveId: null, path: '/Docs' }, c: '"e1"' });
    assert.ok(r.nextRefreshAt, 'rescheduled as usual');
    assert.strictEqual(calls.cursor.length, 0);
});

test('precheck: a moved cursor runs the pass and stores the new cursor only after a pass that read everything', async () => {
    const storage = fakeStorage({ tree: { '/Docs': [file('1', 'a.pdf')] }, cursor: async () => ({ changed: true, cursor: '"e2"' }) });
    const { deps, calls } = engine({ storage });
    const r = await syncSource({ ...SOURCE, config: { ...SOURCE.config, syncCursor: '"e1"' } }, { deps });
    assert.strictEqual(r.added, 1);
    assert.deepStrictEqual(calls.cursor, [{ id: 'src1', c: '"e2"' }]);
});

test('precheck: the cursor is not stored when a file failed, the listing was partial, or the pass was cut short', async () => {
    const cursor = async () => ({ changed: true, cursor: '"e2"' });
    const failing = fakeStorage({ tree: { '/Docs': [file('1', 'a.pdf')] }, cursor, extractImpl: async () => { throw new Error('x'); } });
    const a = engine({ storage: failing });
    await syncSource(SOURCE, { deps: a.deps });
    assert.strictEqual(a.calls.cursor.length, 0, 'a failed file must be retried by the next check');

    const partial = fakeStorage({ tree: { '/Docs': [file('1', 'a.pdf'), folder('s', 'Sub')], '/Docs/Sub': new Error('x') }, cursor });
    const b = engine({ storage: partial });
    await syncSource(SOURCE, { deps: b.deps });
    assert.strictEqual(b.calls.cursor.length, 0);
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

test('precheck: a first look (no cursor) always runs the pass; a storage without a change feed runs it too', async () => {
    const first = fakeStorage({ tree: { '/Docs': [] }, cursor: async (f, c) => ({ changed: !c ? true : false, cursor: 'a' }) });
    assert.deepStrictEqual(await cloudFolder.precheck(SOURCE, { source: SOURCE, kb: KB, log: () => {} }, { cloud: first.cloud }), { changed: true, cursor: 'a' });
    const none = fakeStorage({ tree: { '/Docs': [] } });
    assert.deepStrictEqual(await cloudFolder.precheck(SOURCE, { source: SOURCE, kb: KB, log: () => {} }, { cloud: none.cloud }), { changed: true });
});

// ─── Scheduling ─────────────────────────────────────────────────────────

test('on_change is due every KB_CLOUD_CHANGE_POLL_SECONDS (default 300), longer after failures', () => {
    const t0 = Date.UTC(2026, 10, 9, 12, 0, 0);
    const source = { refreshMode: 'on_change', refreshCron: '0 3 * * *', refreshTz: null };
    assert.strictEqual(nextRefreshFor(source, { fromTs: t0 }), new Date(t0 + 300_000).toISOString(), 'a cron left on the row does not apply');
    process.env.KB_CLOUD_CHANGE_POLL_SECONDS = '60';
    assert.strictEqual(nextRefreshFor(source, { fromTs: t0 }), new Date(t0 + 60_000).toISOString());
    process.env.KB_CLOUD_CHANGE_POLL_SECONDS = 'nonsense';
    assert.strictEqual(cloudFolder.changePollSeconds(), 300);
    assert.ok(Date.parse(nextRefreshFor(source, { fromTs: t0, consecutiveErrors: 3 })) - t0 > 300_000);
    assert.strictEqual(nextRefreshFor({ refreshMode: 'manual' }, { fromTs: t0 }), null);
});
