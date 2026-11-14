// @typecheck
/**
 * Studio App data store cross-tenant IDOR regression tests, against a real
 * Postgres (PGlite behind db.js's pool, testUtils/pglitePool.js).
 *
 * Every mutation of App Studio data metadata is owner-scoped, so a foreign
 * app, dataset or attachment id can never be written through by guessing it:
 *   • studio_app_data_meta / _datasets / _attachments are matched on
 *     owner_user_id;
 *   • studio_app_members has no owner column, so its mutations are gated by
 *     an ownsApp() check on studio_apps.user_id.
 *
 * saveDataModel's owner path runs through makeDataModelSaver with the real
 * client and a no-op migration (the per-app engine is not under test here; an
 * unchanged model plans no DDL).
 *
 * Run: cd server && node --test stores/studioAppDataStore.idor.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const db = require('../db');
const appStore = require('./studioAppStore');
const store = require('./studioAppDataStore');
const { makeDataModelSaver } = require('./studioAppData/dataModel');

const VALID_MODEL = {
    modelVersion: 1,
    tables: [{
        id: 'tbl_aaaaaa', key: 'people', name: 'People', icon: null,
        fields: [{ id: 'fld_aaaaaa', key: 'title', type: 'text', required: false, unique: false }],
        access: { default: 'app', roles: {}, rowFilters: {} },
    }],
    roles: [], roleMapping: { default: 'app', byGroup: {} },
};
const incoming = () => structuredClone(VALID_MODEL);

const { saveDataModel } = makeDataModelSaver({
    getClient: () => db.getClient(),
    ready: () => store.initDB(),
    applyMigration: async () => ({ applied: 0, skipped: [], probed: [] }),
    isPg: () => false,
    recountRows: async () => {},
});

test.before(async () => {
    await appStore.initDB();
    await store.initDB();
    await pg.query("INSERT INTO studio_apps (id, user_id, name) VALUES ('app-alice', 'alice', 'A'), ('app-bob', 'bob', 'B')");
    await pg.query(
        `INSERT INTO studio_app_data_meta (app_id, owner_user_id, model, model_version, data_versions, row_counts)
         VALUES ('app-alice', 'alice', $1::jsonb, 1, '{"people": 3}'::jsonb, '{"people": 2}'::jsonb)`,
        [JSON.stringify(VALID_MODEL)],
    );
    await pg.exec(`
        INSERT INTO studio_app_datasets (id, app_id, owner_user_id, name) VALUES ('ds-alice', 'app-alice', 'alice', 'A'), ('ds-bob', 'app-bob', 'bob', 'B');
        INSERT INTO studio_app_members (app_id, user_id, role_key) VALUES ('app-alice', 'm1', 'editor');
        INSERT INTO studio_app_attachments (id, app_id, owner_user_id, record_id, field_key, mime_type, sha256, size) VALUES
            ('att-alice', 'app-alice', 'alice', 'r1', 'f', 'image/png', 'x', 1),
            ('att-bob', 'app-bob', 'bob', 'r2', 'f', 'image/png', 'y', 1);
    `);
});
test.after(close);

const one = async (sql, params) => (await pg.query(sql, params)).rows[0];
const meta = (appId) => one('SELECT owner_user_id, model_version, data_versions, row_counts FROM studio_app_data_meta WHERE app_id = $1', [appId]);

// ── saveDataModel ─────────────────────────────────────────────────

test('saveDataModel: a foreign app with no meta is refused and no meta row appears', async () => {
    assert.deepStrictEqual(await saveDataModel('app-bob', 'alice', incoming()), { ok: false, notFound: true });
    assert.deepStrictEqual(await store.saveDataModel('app-bob', 'alice', incoming()), { ok: false, notFound: true });
    assert.strictEqual(await meta('app-bob'), undefined);
});

test('saveDataModel: a meta row owned by another user is refused (no clobber)', async () => {
    const before = await meta('app-alice');
    assert.deepStrictEqual(await saveDataModel('app-alice', 'bob', incoming()), { ok: false, notFound: true });
    assert.deepStrictEqual(await meta('app-alice'), before);
});

test('saveDataModel: the owner saves; the meta row and the studio_apps mirror move', async () => {
    const res = await saveDataModel('app-alice', 'alice', incoming());
    assert.strictEqual(res.ok, true);
    assert.strictEqual((await meta('app-alice')).model_version, res.version);
    assert.strictEqual((await one("SELECT data_model_version FROM studio_apps WHERE id = 'app-alice'")).data_model_version, res.version);
    assert.notStrictEqual((await one("SELECT data_model_version FROM studio_apps WHERE id = 'app-bob'")).data_model_version, res.version);
});

// ── bumpDataVersion / setRowCount ─────────────────────────────────

test('bumpDataVersion and setRowCount for a foreign owner answer null and write nothing', async () => {
    const before = await meta('app-alice');
    assert.strictEqual(await store.bumpDataVersion('app-alice', 'people', 'bob'), null);
    assert.strictEqual(await store.setRowCount('app-alice', 'people', 5, 'bob'), null);
    assert.deepStrictEqual(await meta('app-alice'), before);
});

test('bumpDataVersion and setRowCount for the owner write their counter', async () => {
    const before = await meta('app-alice');
    await store.bumpDataVersion('app-alice', 'people', 'alice');
    await store.setRowCount('app-alice', 'people', 5, 'alice');
    const after = await meta('app-alice');
    assert.ok(Number(after.data_versions.people) > Number(before.data_versions.people || 0));
    assert.strictEqual(Number(after.row_counts.people), 5);
});

// ── Datasets ──────────────────────────────────────────────────────

test('createDataset records the caller as owner', async () => {
    const ds = await store.createDataset('app-alice', 'alice', { name: 'X' });
    assert.strictEqual((await one('SELECT owner_user_id FROM studio_app_datasets WHERE id = $1', [ds.id])).owner_user_id, 'alice');
});

test("a dataset of another owner can't be read, renamed or deleted", async () => {
    assert.strictEqual(await store.getDataset('ds-bob', 'app-bob', 'alice'), null);
    assert.strictEqual(await store.getDataset('ds-bob', 'app-alice', 'alice'), null, 'nor through an app the caller owns');
    assert.strictEqual(await store.updateDataset('ds-bob', 'app-bob', 'alice', { name: 'hax' }), null);
    assert.strictEqual(await store.deleteDataset('ds-bob', 'app-bob', 'alice'), false);
    assert.strictEqual(await store.deleteDataset('ds-bob', 'app-alice', 'alice'), false);
    assert.deepStrictEqual(await one("SELECT name FROM studio_app_datasets WHERE id = 'ds-bob'"), { name: 'B' });
});

test('the owner reads, renames and deletes their own dataset', async () => {
    assert.ok(await store.getDataset('ds-alice', 'app-alice', 'alice'));
    assert.ok(await store.updateDataset('ds-alice', 'app-alice', 'alice', { name: 'Y' }));
    assert.deepStrictEqual(await one("SELECT name FROM studio_app_datasets WHERE id = 'ds-alice'"), { name: 'Y' });
    const extra = await store.createDataset('app-alice', 'alice', { name: 'Z' });
    assert.strictEqual(await store.deleteDataset(extra.id, 'app-alice', 'alice'), true);
    assert.strictEqual(await one('SELECT 1 FROM studio_app_datasets WHERE id = $1', [extra.id]), undefined);
});

// ── Members (ownsApp-gated) ───────────────────────────────────────

test('member mutations by someone who does not own the app change nothing', async () => {
    assert.strictEqual(await store.addMember('app-alice', 'bob', 'evil', 'admin'), null);
    assert.strictEqual(await store.removeMember('app-alice', 'bob', 'm1'), false);
    const members = (await pg.query("SELECT user_id, role_key FROM studio_app_members WHERE app_id = 'app-alice' ORDER BY user_id")).rows;
    assert.deepStrictEqual(members, [{ user_id: 'm1', role_key: 'editor' }]);
});

test('the owner adds and removes members', async () => {
    await store.addMember('app-alice', 'alice', 'newuser', 'viewer');
    assert.deepStrictEqual(await one("SELECT role_key FROM studio_app_members WHERE app_id = 'app-alice' AND user_id = 'newuser'"), { role_key: 'viewer' });
    assert.strictEqual(await store.removeMember('app-alice', 'alice', 'newuser'), true);
    assert.strictEqual(await one("SELECT 1 FROM studio_app_members WHERE user_id = 'newuser'"), undefined);
});

// ── Attachments ───────────────────────────────────────────────────

test("an attachment of another owner can't be read, marked or deleted", async () => {
    assert.strictEqual(await store.getAttachment('att-bob', 'app-bob', 'alice'), null);
    assert.strictEqual(await store.setAttachmentScan('att-bob', 'app-bob', 'alice', { scanned: true }), null);
    assert.strictEqual(await store.deleteAttachment('att-bob', 'app-bob', 'alice'), false);
    assert.strictEqual(await store.deleteAttachment('att-bob', 'app-alice', 'alice'), false);
    assert.deepStrictEqual(await one("SELECT scanned FROM studio_app_attachments WHERE id = 'att-bob'"), { scanned: false });
});

test('the owner adds, marks and deletes their own attachment', async () => {
    const att = await store.addAttachment('app-alice', 'alice', { recordId: 'r', fieldKey: 'f', mimeType: 'image/png', sha256: 'z', size: 2 });
    assert.strictEqual((await one('SELECT owner_user_id FROM studio_app_attachments WHERE id = $1', [att.id])).owner_user_id, 'alice');
    assert.ok(await store.setAttachmentScan(att.id, 'app-alice', 'alice', { scanned: true }));
    assert.deepStrictEqual(await one('SELECT scanned FROM studio_app_attachments WHERE id = $1', [att.id]), { scanned: true });
    assert.strictEqual(await store.deleteAttachment(att.id, 'app-alice', 'alice'), true);
    assert.strictEqual(await one('SELECT 1 FROM studio_app_attachments WHERE id = $1', [att.id]), undefined);
});
