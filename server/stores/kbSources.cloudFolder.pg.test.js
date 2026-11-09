/**
 * The `cloud_folder` source kind in the kb_sources store, on real SQL (PGlite
 * behind the real db.js): the kind passes the CHECK on a fresh table AND on a
 * table that was created before the kind existed (the boot DDL widens the
 * constraint, it does not wait for a new database); the change cursor lives in
 * `config.syncCursor` without disturbing the rest of the config; and a person's
 * cloud folders are found by user and storage.
 *
 * Run: cd server && node --test stores/kbSources.cloudFolder.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { usePglitePool } = require('../testUtils/pglitePool');
const { pg, close } = usePglitePool();

process.env.NODE_ENV = 'test';

const kbStore = require('./knowledgeBases');
const sourcesStore = require('./kbSources');

before(async () => {
    await kbStore.whenReady();
    await sourcesStore.initDB();
});
after(close);

async function kbId() {
    const tenant = `tu_${crypto.randomBytes(4).toString('hex')}`;
    return (await kbStore.createKB(tenant, `cloud-${tenant}`, 'cloud folder test')).id;
}

const CONFIG = { provider: 'nextcloud_files', path: '/Docs', folderName: 'Docs', recursive: true };

test('cloud_folder is a kind of the store and passes the CHECK of a fresh table', async () => {
    assert.ok(sourcesStore.SOURCE_KINDS.includes('cloud_folder'));
    assert.ok(sourcesStore.SOURCE_KINDS.includes('nextcloud_folder'), 'the reserved kind stays');
    const src = await sourcesStore.create({ knowledgeBaseId: await kbId(), kind: 'cloud_folder', config: CONFIG, refreshMode: 'on_change', createdBy: 'u1' });
    assert.equal(src.kind, 'cloud_folder');
    assert.equal(src.refreshMode, 'on_change');
    await assert.rejects(() => pg.query(`INSERT INTO kb_sources (knowledge_base_id, kind) VALUES ('${src.knowledgeBaseId}', 'bogus')`), /kb_sources_kind_check/);
    // The list in the CREATE TABLE and SOURCE_KINDS are two spellings of one list: every kind passes.
    for (const kind of sourcesStore.SOURCE_KINDS) {
        assert.equal((await sourcesStore.create({ knowledgeBaseId: src.knowledgeBaseId, kind })).kind, kind);
    }
});

test('a table created before the kind existed is widened at boot', async () => {
    const old = `kind IN ('upload','text','webpage','nextcloud_folder','datatable','meeting_tag','automation','legacy')`;
    await pg.exec(`DELETE FROM kb_sources WHERE kind = 'cloud_folder'`); // an old table has none
    await pg.exec(`ALTER TABLE kb_sources DROP CONSTRAINT kb_sources_kind_check; ALTER TABLE kb_sources ADD CONSTRAINT kb_sources_kind_check CHECK (${old})`);
    const id = await kbId();
    await assert.rejects(() => pg.query(`INSERT INTO kb_sources (knowledge_base_id, kind) VALUES ('${id}', 'cloud_folder')`), /kb_sources_kind_check/);

    // The next boot: every store init runs again, as in a restarted process.
    require('./lib/storeInit')._resetAllForTests();
    await sourcesStore.initDB();

    const src = await sourcesStore.create({ knowledgeBaseId: id, kind: 'cloud_folder', config: CONFIG, createdBy: 'u1' });
    assert.equal(src.kind, 'cloud_folder');
    await assert.rejects(() => pg.query(`INSERT INTO kb_sources (knowledge_base_id, kind) VALUES ('${id}', 'bogus')`), /kb_sources_kind_check/, 'still a closed list');
    // And running it again changes nothing.
    require('./lib/storeInit')._resetAllForTests();
    await sourcesStore.initDB();
    assert.equal((await sourcesStore.get(src.id)).kind, 'cloud_folder');
});

test('setSyncCursor merges into config and clears again, leaving the rest of the config alone', async () => {
    const src = await sourcesStore.create({ knowledgeBaseId: await kbId(), kind: 'cloud_folder', config: CONFIG, createdBy: 'u1' });
    const set = await sourcesStore.setSyncCursor(src.id, '"etag-1"');
    assert.deepEqual(set.config, { ...CONFIG, syncCursor: '"etag-1"' });
    const again = await sourcesStore.setSyncCursor(src.id, 'https://graph.microsoft.com/v1.0/delta?token=abc');
    assert.equal(again.config.syncCursor, 'https://graph.microsoft.com/v1.0/delta?token=abc');
    const cleared = await sourcesStore.setSyncCursor(src.id, null);
    assert.deepEqual(cleared.config, CONFIG);
    assert.equal(await sourcesStore.setSyncCursor(null, 'x'), null);
});

test('listCloudFoldersByUser: the sources one person created at one storage, nobody else\'s', async () => {
    const id = await kbId();
    const mine = await sourcesStore.create({ knowledgeBaseId: id, kind: 'cloud_folder', config: CONFIG, refreshMode: 'on_change', createdBy: 'u-list' });
    await sourcesStore.create({ knowledgeBaseId: id, kind: 'cloud_folder', config: { ...CONFIG, provider: 'onedrive', folderId: 'F' }, createdBy: 'u-list' });
    await sourcesStore.create({ knowledgeBaseId: id, kind: 'cloud_folder', config: CONFIG, createdBy: 'someone-else' });
    await sourcesStore.create({ knowledgeBaseId: id, kind: 'webpage', config: { url: 'https://example.test' }, createdBy: 'u-list' });
    const found = await sourcesStore.listCloudFoldersByUser('u-list', 'nextcloud_files');
    assert.deepEqual(found.map((s) => s.id), [mine.id]);
    assert.equal((await sourcesStore.listCloudFoldersByUser('u-list', 'onedrive')).length, 1);
    assert.deepEqual(await sourcesStore.listCloudFoldersByUser('nobody', 'onedrive'), []);
    assert.deepEqual(await sourcesStore.listCloudFoldersByUser('', 'onedrive'), []);
});

test('a new source with next_refresh_at = now is claimed by the tick and a manual one is left alone afterwards', async () => {
    const id = await kbId();
    const src = await sourcesStore.create({ knowledgeBaseId: id, kind: 'cloud_folder', config: CONFIG, createdBy: 'u1', nextRefreshAt: new Date().toISOString() });
    const claimed = (await sourcesStore.claimDue(500)).find((r) => r.id === src.id);
    assert.ok(claimed, 'the first import is picked up');
    const done = await sourcesStore.finish(src.id, { ok: true, nextRefreshAt: null });
    assert.equal(done.nextRefreshAt, null, 'a manual source is read once and then waits for a person');
    assert.equal((await sourcesStore.claimDue(500)).find((r) => r.id === src.id), undefined);
});
