'use strict';

/**
 * The managed-part lock on webpages (design 5.1-5.3, D16), against a REAL
 * Postgres (@electric-sql/pglite behind db.js's pool, testUtils/pglitePool.js)
 * and the local-disk object storage: the webpage store, the project store and
 * the Solution stage store run their own schema and SQL, with no module
 * mocking. A page is managed when its project is a stage project (UAT/PRD).
 *
 * Pinned:
 *   - on a managed page a slot write, a metadata instructions change, an
 *     extra-file write, an automation grant and a non-null pin are refused
 *     (409 managed_part), while an audience change, clearing the pin and a
 *     data.db hash update pass;
 *   - a deploy's capability (an active deployment of exactly that stage) lets
 *     the pin through, on the deploy's own client;
 *   - createVersionSnapshotFromFiles writes a snapshot and leaves current/ alone;
 *   - the publish route on a managed page does not pin (the deploy owns the pointer);
 *   - an unmanaged page is untouched by all of this.
 *
 * Run: cd server && node --test stores/webpage/managedLock.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.NODE_ENV = 'test';
// Local-disk storage under server/data/storage (gitignored); never a real bucket.
delete process.env.RUSTFS_ENDPOINT;
delete process.env.RUSTFS_ACCESS_KEY;
delete process.env.RUSTFS_SECRET_KEY;

const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const projectStore = require('../projectStore');
const solutionStageStore = require('../solutionStageStore');
const storageStore = require('../storageStore');
const webpageStore = require('../webpageStore');
const webpageSchema = require('./schema');
const webpageUsageSync = require('../../core/webpages/webpageUsageSync');

// The dependents index is a detached side job of every page write; this file
// is about the lock, so it stays out of the way.
webpageUsageSync.reconcileWebpageUsageDetached = () => {};

// Unique per run, so the local object prefix is this run's own.
const OWNER = `wp-lock-${crypto.randomUUID()}`;
let dev;
let uat;
let managedPage;
let plainPage;

async function refused(promise, message) {
    await assert.rejects(promise, (err) => {
        assert.strictEqual(err.status, 409, message);
        assert.strictEqual(err.code, 'managed_part', message);
        assert.strictEqual(err.details.stage, 'uat');
        return true;
    }, message);
}

async function activeDeployment(stageProjectId) {
    const id = `dep-${crypto.randomUUID()}`;
    await pg.query(
        `INSERT INTO solution_deployments (id, solution_id, stage_project_id, stage, release_id, kind, status, plan,
                                           plan_hash, stage_settings_version, request_key, requested_by)
         VALUES ($1, $2, $3, 'uat', 'rel_1', 'deploy', 'committing', '{}'::jsonb, 'h', 1, $1, $4)`,
        [id, dev.id, stageProjectId, OWNER],
    );
    return id;
}

before(async () => {
    await pg.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, "organizationId" TEXT)`);
    await projectStore.initDB();
    await solutionStageStore.initDB();
    await webpageSchema.initDB();
    await storageStore.init();
    dev = await projectStore.createProject({ name: 'Portal', ownerId: OWNER, organizationId: 'org1', kind: 'solution' });
    [uat] = await solutionStageStore.createStages({ devProject: dev, stages: ['uat'], actorId: OWNER });

    managedPage = await webpageStore.createWebpage({ userId: OWNER, name: 'Managed', instructions: 'Old brief' });
    await pg.query('UPDATE webpages SET project_id = $1, organization_id = $2 WHERE id = $3', [uat.projectId, 'org1', managedPage.id]);
    plainPage = await webpageStore.createWebpage({ userId: OWNER, name: 'Plain', instructions: 'Old brief' });
});

after(async () => {
    // The local-disk store cannot list a prefix; this run's objects sit under one directory.
    fs.rmSync(path.resolve(__dirname, '..', '..', 'data', 'storage', 'users', OWNER), { recursive: true, force: true });
    await close();
});

// ── Refused on a managed page ────────────────────────────────────────

test('a slot write on a managed page is refused before any byte is stored', async () => {
    await refused(webpageStore.writeSlot(OWNER, managedPage.id, 'html', '<p>edited</p>'));
    assert.strictEqual(await webpageStore.readSlot(OWNER, managedPage.id, 'html'), '');
});

test('a metadata instructions change is refused; resending unchanged values passes', async () => {
    await refused(webpageStore.updateWebpageMetadata(managedPage.id, OWNER, { instructions: 'New brief' }));
    assert.strictEqual((await webpageStore.getWebpage(managedPage.id, OWNER)).instructions, 'Old brief');
    // The editor resends every field; what does not change is not a managed write.
    assert.strictEqual(await webpageStore.updateWebpageMetadata(managedPage.id, OWNER,
        { name: 'Managed', instructions: 'Old brief' }), true);
});

test('a data.db hash update passes on a managed page', async () => {
    assert.strictEqual(await webpageStore.updateWebpageMetadata(managedPage.id, OWNER, { dbSha: 'abc', dbSize: 3 }), true);
    const row = await webpageStore.getWebpage(managedPage.id, OWNER);
    assert.strictEqual(row.dbSha, 'abc');
    assert.strictEqual(row.dbSize, 3);
});

test('extra-file writes are refused on a managed page', async () => {
    await refused(webpageStore.upsertExtraFile({ webpageId: managedPage.id, userId: OWNER, path: 'a.css', content: 'x{}' }));
    await refused(webpageStore.upsertBinaryExtraFile({
        webpageId: managedPage.id, userId: OWNER, path: 'logo.png', buffer: Buffer.from([1, 2]), mimeType: 'image/png',
    }));
    await refused(webpageStore.deleteExtraFile({ webpageId: managedPage.id, userId: OWNER, path: 'a.css' }));
    assert.deepStrictEqual(await webpageStore.listExtraFiles(managedPage.id), []);
});

test('an automation grant entry is refused; the public column gate of a table is not', async () => {
    await refused(webpageStore.upsertBridgeGrantEntry(managedPage.id, OWNER, 'automations', { automationId: 'a1' }));
    await refused(webpageStore.updateBridgeGrants(managedPage.id, OWNER, { tables: [{ datatableId: 't1', columns: ['a'] }] }));

    // A binding the deploy wrote, then narrowed by the public share (a stage setting).
    await pg.query(`UPDATE webpages SET bridge_grants = $1::jsonb WHERE id = $2`, [
        JSON.stringify({ tables: [{ datatableId: 't1', mode: 'read', columns: ['a', 'b'], publicColumns: ['a', 'b'] }] }),
        managedPage.id,
    ]);
    const saved = await webpageStore.updateBridgeGrants(managedPage.id, OWNER,
        { tables: [{ datatableId: 't1', mode: 'read', columns: ['a', 'b'], publicColumns: ['a'] }] });
    assert.deepStrictEqual(saved.tables[0].publicColumns, ['a']);
    // Removing a carried binding is refused; removing an absent one is a no-op, as before.
    await refused(webpageStore.removeBridgeGrantEntry(managedPage.id, OWNER, 'tables', 't1'));
    assert.strictEqual((await webpageStore.removeBridgeGrantEntry(managedPage.id, OWNER, 'tables', 'absent')).tables.length, 1);
    // Re-granting the same binding with only a narrower public gate passes.
    const regranted = await webpageStore.upsertBridgeGrantEntry(managedPage.id, OWNER, 'tables',
        { datatableId: 't1', mode: 'read', columns: ['a', 'b'], publicColumns: [] });
    assert.deepStrictEqual(regranted.tables[0].publicColumns, []);
    // A caller who does not own the page gets null, not the managed_part details.
    assert.strictEqual(await webpageStore.upsertBridgeGrantEntry(managedPage.id, 'someone-else', 'automations', { automationId: 'a1' }), null);
    // Integration grants are never carried by a release: the stage's own.
    assert.ok(await webpageStore.upsertBridgeGrantEntry(managedPage.id, OWNER, 'integrations', { tool: 'mail_send' }));
});

test('chat history and delete are refused on a managed page', async () => {
    await refused(webpageStore.setChatMessages(managedPage.id, OWNER, [{ role: 'user', content: 'hi' }]));
    await refused(webpageStore.deleteWebpage(managedPage.id, OWNER));
    assert.ok(await webpageStore.getWebpage(managedPage.id, OWNER));
});

test('a non-null pin is refused, clearing it passes, and an audience change passes', async () => {
    const v = await webpageStore.createVersionSnapshotFromFiles(managedPage.id, OWNER, { html: '<p>r1</p>' },
        { managedWrite: { deploymentId: await activeDeployment(uat.projectId) } });
    await refused(webpageStore.setPublishedVersion(managedPage.id, OWNER, v.id));
    assert.strictEqual(await webpageStore.setPublishedVersion(managedPage.id, OWNER, null), true);
    assert.strictEqual(await webpageStore.setWebpagePublished(managedPage.id, true, OWNER, [], 'org1'), true);
    assert.strictEqual((await webpageStore.getWebpage(managedPage.id, OWNER)).isPublished, true);
    await pg.query(`UPDATE solution_deployments SET status = 'succeeded' WHERE stage_project_id = $1`, [uat.projectId]);
});

test('the deploy capability pins on its own client; a finished deployment no longer does', async () => {
    const deploymentId = await activeDeployment(uat.projectId);
    const managedWrite = { deploymentId };
    const v = await webpageStore.createVersionSnapshotFromFiles(managedPage.id, OWNER, { html: '<p>r2</p>' }, { managedWrite });
    const client = { query: (sql, params) => pg.query(sql, params) };
    assert.strictEqual(await webpageStore.setPublishedVersion(managedPage.id, OWNER, v.id, { client, managedWrite }), true);
    assert.strictEqual((await webpageStore.getWebpage(managedPage.id, OWNER)).publishedVersionId, v.id);

    await pg.query(`UPDATE solution_deployments SET status = 'succeeded' WHERE id = $1`, [deploymentId]);
    await refused(webpageStore.setPublishedVersion(managedPage.id, OWNER, v.id, { managedWrite }));
    await refused(webpageStore.createVersionSnapshotFromFiles(managedPage.id, OWNER, { html: '<p>r3</p>' }, { managedWrite }));
});

// ── Snapshots from files (D16) ───────────────────────────────────────

test('createVersionSnapshotFromFiles writes a snapshot and leaves current/ untouched', async () => {
    await webpageStore.writeSlot(OWNER, plainPage.id, 'html', '<p>live</p>');
    const db = Buffer.from('sqlite-bytes');
    const v = await webpageStore.createVersionSnapshotFromFiles(plainPage.id, OWNER,
        { html: '<p>release</p>', css: 'p{}', js: '', db }, { summary: 'Release 3' });

    assert.strictEqual(await webpageStore.readSlot(OWNER, plainPage.id, 'html'), '<p>live</p>', 'current/ is the live row');
    assert.strictEqual(await webpageStore.readSlot(OWNER, plainPage.id, 'css'), '');
    const files = await webpageStore.readAllSlots(OWNER, plainPage.id, v.id);
    assert.deepStrictEqual(files, { html: '<p>release</p>', css: 'p{}', js: '' });
    const { stream } = await storageStore.streamFile(storageStore.buildWebpageKey(OWNER, plainPage.id, 'db', v.id));
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    assert.strictEqual(Buffer.concat(chunks).toString(), 'sqlite-bytes');

    const meta = await webpageStore.getVersionMeta(v.id);
    assert.strictEqual(meta.webpageId, plainPage.id);
    assert.strictEqual(meta.source, 'published', 'a release snapshot is never pruned');
    assert.strictEqual(meta.summary, 'Release 3');
    assert.strictEqual(meta.htmlSha, webpageStore.sha256('<p>release</p>'));
    assert.strictEqual(meta.jsSha, '');
});

// ── Unmanaged pages ──────────────────────────────────────────────────

test('an unmanaged page takes every write as before', async () => {
    await webpageStore.writeSlot(OWNER, plainPage.id, 'css', 'body{}');
    assert.strictEqual(await webpageStore.updateWebpageMetadata(plainPage.id, OWNER, { instructions: 'New brief' }), true);
    assert.ok(await webpageStore.upsertExtraFile({ webpageId: plainPage.id, userId: OWNER, path: 'a.css', content: 'x{}' }));
    assert.ok(await webpageStore.upsertBridgeGrantEntry(plainPage.id, OWNER, 'automations', { automationId: 'a1' }));
    const v = await webpageStore.createVersion(OWNER, plainPage.id, 'Manual');
    assert.strictEqual(await webpageStore.setPublishedVersion(plainPage.id, OWNER, v.id), true);
    assert.strictEqual(await webpageStore.setChatMessages(plainPage.id, OWNER, []), true);
});

// ── The publish route ────────────────────────────────────────────────

async function withPublishRoute(t, fn, routeModule = 'publishing') {
    const perms = require('../../auth/permissions');
    const auth = require('../../auth');
    const saved = [[perms, 'requireAuth', perms.requireAuth], [auth, 'validateSharedGroupsForOrg', auth.validateSharedGroupsForOrg]];
    perms.requireAuth = (req, res, next) => next();
    auth.validateSharedGroupsForOrg = async (_org, groups) => (Array.isArray(groups) ? groups : []);
    t.after(() => { for (const [obj, key, value] of saved) obj[key] = value; });

    const { createTerminalErrorHandler } = require('../../core/http/terminalErrorHandler');
    const router = express.Router();
    require(`../../routes/webpages/${routeModule}`).register(router);
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = { user: { id: OWNER, organizationId: 'org1' } }; next(); });
    app.use(router);
    app.use(createTerminalErrorHandler());
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => server.close());
    return fn(`http://127.0.0.1:${server.address().port}`);
}

const patchJson = async (url, body) => {
    const res = await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
};

test('the publish route on a managed page does not pin, and unpublishing keeps the pointer', async (t) => {
    await withPublishRoute(t, async (base) => {
        const before = await webpageStore.getWebpage(managedPage.id, OWNER);
        assert.ok(before.publishedVersionId, 'the deploy pinned a release earlier in this file');
        const versionsBefore = (await webpageStore.getVersions(managedPage.id)).length;

        const on = await patchJson(`${base}/${managedPage.id}/publish`, { isPublished: true, republish: true });
        assert.strictEqual(on.status, 200);
        assert.strictEqual(on.body.publishedVersionId, before.publishedVersionId);
        assert.strictEqual((await webpageStore.getVersions(managedPage.id)).length, versionsBefore, 'no snapshot frozen');

        const off = await patchJson(`${base}/${managedPage.id}/publish`, { isPublished: false });
        assert.strictEqual(off.status, 200);
        const after = await webpageStore.getWebpage(managedPage.id, OWNER);
        assert.strictEqual(after.isPublished, false);
        assert.strictEqual(after.publishedVersionId, before.publishedVersionId, 'the deploy owns the pointer');
    });
});

test('the publish route refuses a managed page that was never deployed', async (t) => {
    const page = await webpageStore.createWebpage({ userId: OWNER, name: 'Undeployed' });
    await pg.query('UPDATE webpages SET project_id = $1, organization_id = $2 WHERE id = $3', [uat.projectId, 'org1', page.id]);
    await withPublishRoute(t, async (base) => {
        const res = await patchJson(`${base}/${page.id}/publish`, { isPublished: true });
        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.body.code, 'managed_part_not_deployed');
        assert.strictEqual((await webpageStore.getWebpage(page.id, OWNER)).isPublished, false);
    });
});

// ── The delete route ─────────────────────────────────────────────────

test('the delete route refuses a managed page before it drops the page\'s data.db handle', async (t) => {
    const webpageDbStore = require('../webpageDbStore');
    const original = webpageDbStore.invalidate;
    const invalidated = [];
    webpageDbStore.invalidate = async (id) => { invalidated.push(id); };
    t.after(() => { webpageDbStore.invalidate = original; });
    await withPublishRoute(t, async (base) => {
        for (const query of ['', '?confirm=1']) {
            const res = await fetch(`${base}/${managedPage.id}${query}`, { method: 'DELETE' });
            assert.strictEqual(res.status, 409);
            assert.strictEqual((await res.json()).code, 'managed_part');
        }
        assert.deepStrictEqual(invalidated, [], 'unflushed data.db writes are kept');
        assert.ok(await webpageStore.getWebpage(managedPage.id, OWNER));
    }, 'lifecycle');
});
