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
 * The tests that also run the storage layer's own marker comparison and Google export rules
 * (the datatables module's spreadsheet-mirror providers) are cloudFolder.datatables.test.js.
 *
 * Run: cd server && node --test core/kb/sources/cloudFolder.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { syncSource, nextRefreshFor } = require('./index');
const cloudFolder = require('./cloudFolder.mts');
const { useCloudWorld, KB, file, folder, fakeStorage, engine, SOURCE, stored } = require('./cloudFolder.testkit');
useCloudWorld();

// ─── The diff ───────────────────────────────────────────────────────────

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
