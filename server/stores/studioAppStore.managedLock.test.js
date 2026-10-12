/**
 * The managed-write lock on apps of a Solution stage, against a real Postgres
 * (@electric-sql/pglite, in-process). The writers come from
 * studioAppStore.makeStudioAppWriters and studioAppDataStore.makeDataModelSaver
 * over the PGlite handle; the guard is stores/lib/managedParts.js built with
 * which project is a stage, and the capability check is the real
 * solutionStageStore.isActiveDeployment over the same database. No module is
 * replaced.
 *
 * Pinned:
 *   - saveDefinition, a card rename, restoreVersion, deleteStudioApp and the
 *     AI builder session are refused on a managed app (409 managed_part); a
 *     deploy's capability lets the definition through;
 *   - setStudioAppPublished is refused on a managed app, always;
 *   - setStudioAppAudience changes who the app reaches and never touches
 *     published_definition / published_version;
 *   - publishDefinitionWith flips the published copy on the commit client
 *     with the capability, and leaves is_published alone;
 *   - saveDataModel with additiveOnly refuses a NOT NULL column and a dropped
 *     unique index, retains removed fields (no DROP), and a stage's model is
 *     additive even when the deploy forgets to ask; an unmanaged app is not.
 *
 * Run: cd server && node --test stores/studioAppStore.managedLock.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../testUtils/pgliteDb');

const { makeStudioAppWriters } = require('./studioAppStore');
const { makeDataModelSaver } = require('./studioAppDataStore');
const { makeManagedParts } = require('./lib/managedParts');
const { makeSolutionStageStore, applySolutionStageSchema } = require('./solutionStageStore');

const { pg, db } = pgliteDb();

const STAGES = { stage_prd: { solutionId: 'dev1', stage: 'prd', projectId: 'stage_prd' } };
const stages = makeSolutionStageStore(db);
const managedParts = makeManagedParts({
    stageOfProject: async (id) => STAGES[id] || null,
    stageOfProjectFresh: async (id) => STAGES[id] || null,
    isActiveDeployment: (dep, projectId, client) => stages.isActiveDeployment(dep, projectId, client),
});

const facade = {
    run: (sql, params) => db.query(sql, params),
    getOne: async (sql, params) => (await db.query(sql, params)).rows[0] || null,
    getAll: async (sql, params) => (await db.query(sql, params)).rows,
    getClient: async () => ({ query: (sql, params) => db.query(sql, params), release() {} }),
};
const apps = makeStudioAppWriters(facade, { managedParts });
const migrations = [];
const { saveDataModel } = makeDataModelSaver({
    getClient: facade.getClient,
    applyMigration: async (ownerId, appId, plan) => { migrations.push({ appId, plan }); },
    isPg: () => false,
    recountRows: async () => {},
    managedParts,
});

const CAPABILITY = { managedWrite: { deploymentId: 'dep_active' } };
const DEF = (name) => ({ schemaVersion: 1, meta: { name }, theme: { primary: '#112233' }, screens: [] });

const isManagedPart = (err) => {
    assert.strictEqual(err.status, 409);
    assert.strictEqual(err.code, 'managed_part');
    assert.strictEqual(err.expose, true);
    assert.deepStrictEqual(err.details, { solutionId: 'dev1', stage: 'prd' });
    return true;
};

async function seedApp(id, { projectId = 'stage_prd', published = null, publishedVersion = null } = {}) {
    await pg.query(
        `INSERT INTO studio_apps (id, user_id, organization_id, project_id, name, definition, definition_version,
                                  published_definition, published_version, is_published)
         VALUES ($1, 'runas', 'org1', $2, $1, $3, 4, $4, $5, FALSE)`,
        [id, projectId, JSON.stringify(DEF(id)), published ? JSON.stringify(published) : null, publishedVersion],
    );
}
const appRow = async (id) => (await pg.query('SELECT * FROM studio_apps WHERE id = $1', [id])).rows[0];

// ── Data models ─────────────────────────────────────────────────────

const table = (fields, over = {}) => ({
    id: 'tbl_aaaaaa', key: 'people', name: 'People', icon: null, fields,
    access: { default: 'app', roles: {}, rowFilters: {} }, ...over,
});
const model = (tables) => ({ modelVersion: 1, tables, roles: [], roleMapping: { default: 'app', byGroup: {} } });
const TITLE = { id: 'fld_aaaaaa', key: 'title', type: 'text', required: false, unique: false };
const NOTE = { id: 'fld_bbbbbb', key: 'note', type: 'text', required: false, unique: true };
const CODE = { id: 'fld_cccccc', key: 'code', type: 'text', required: true, unique: false, default: 'x' };
const EMAIL = { id: 'fld_dddddd', key: 'email', type: 'text', required: false, unique: false };

async function seedModel(appId, m) {
    await pg.query(
        `INSERT INTO studio_app_data_meta (app_id, owner_user_id, model, model_version) VALUES ($1, 'runas', $2, 1)`,
        [appId, JSON.stringify(m)],
    );
}
const storedModel = async (appId) => (await pg.query('SELECT model, model_version FROM studio_app_data_meta WHERE app_id = $1', [appId])).rows[0];

before(async () => {
    await pg.exec(`
        CREATE TABLE studio_apps (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            organization_id TEXT,
            project_id TEXT,
            name TEXT NOT NULL DEFAULT 'Untitled app',
            description TEXT DEFAULT '',
            icon TEXT,
            accent_color TEXT,
            category TEXT,
            definition JSONB NOT NULL DEFAULT '{}'::jsonb,
            definition_version INTEGER NOT NULL DEFAULT 1,
            published_definition JSONB,
            published_version INTEGER,
            builder_session JSONB,
            is_published BOOLEAN NOT NULL DEFAULT FALSE,
            shared_groups JSONB NOT NULL DEFAULT '[]'::jsonb,
            nextcloud_menu BOOLEAN NOT NULL DEFAULT FALSE,
            published_at TIMESTAMPTZ,
            template_id TEXT,
            template_version INT,
            template_install_hash TEXT,
            data_model_version INT DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE studio_app_versions (
            id TEXT PRIMARY KEY,
            app_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            definition JSONB NOT NULL,
            summary TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE studio_app_data_meta (
            app_id TEXT PRIMARY KEY REFERENCES studio_apps(id) ON DELETE CASCADE,
            owner_user_id TEXT NOT NULL,
            model JSONB NOT NULL DEFAULT '{}'::jsonb,
            model_version INTEGER NOT NULL DEFAULT 0,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
    await applySolutionStageSchema({
        runDdl: async (_tag, statements) => {
            for (const stmt of statements) await pg.exec(typeof stmt === 'string' ? stmt : stmt.sql);
        },
    });
    for (const [id, status] of [['dep_active', 'preparing'], ['dep_done', 'failed']]) {
        await pg.query(
            `INSERT INTO solution_deployments (id, solution_id, stage_project_id, stage, release_id, kind, status, plan,
                                               plan_hash, stage_settings_version, request_key, requested_by)
             VALUES ($1, 'dev1', 'stage_prd', 'prd', 'rel_1', 'deploy', $2, '{}'::jsonb, 'h', 1, $1, 'alice')`,
            [id, status],
        );
    }
});

after(async () => { await pg.close(); });

// ── studioAppStore ──────────────────────────────────────────────────

test('saveDefinition is refused on a managed app; the deploy capability lets it through', async () => {
    await seedApp('a_def');
    await assert.rejects(apps.saveDefinition('a_def', 'runas', DEF('changed')), isManagedPart);
    await assert.rejects(apps.saveDefinition('a_def', 'runas', DEF('changed'), { managedWrite: { deploymentId: 'dep_done' } }),
        isManagedPart);
    assert.strictEqual((await appRow('a_def')).definition_version, 4);

    const out = await apps.saveDefinition('a_def', 'runas', DEF('release 2'), { expectedVersion: 4, ...CAPABILITY });
    assert.deepStrictEqual(out, { ok: true, version: 5 });
    assert.strictEqual((await appRow('a_def')).definition.meta.name, 'release 2');
});

test('card edits, restore, delete and the builder session are refused on a managed app', async () => {
    await seedApp('a_misc');
    await assert.rejects(apps.updateStudioApp('a_misc', { name: 'Renamed' }, 'runas'), isManagedPart);
    // Re-sending what is stored changes nothing, so it is not a managed write.
    assert.strictEqual((await apps.updateStudioApp('a_misc', { name: 'a_misc' }, 'runas')).name, 'a_misc');

    await pg.query(`INSERT INTO studio_app_versions (id, app_id, user_id, definition, summary) VALUES ('v1', 'a_misc', 'runas', '{}', 'Published')`);
    await assert.rejects(apps.restoreVersion('a_misc', 'v1', 'runas'), isManagedPart);
    await assert.rejects(apps.deleteStudioApp('a_misc', 'runas'), isManagedPart);
    await assert.rejects(apps.setBuilderSession('a_misc', 'runas', { conversation: [] }), isManagedPart);
    const r = await appRow('a_misc');
    assert.strictEqual(r.definition_version, 4);
    assert.strictEqual(r.builder_session, null);
});

test('setStudioAppPublished is always refused on a managed app', async () => {
    await seedApp('a_pub', { published: DEF('release 1'), publishedVersion: 3 });
    await assert.rejects(apps.setStudioAppPublished('a_pub', true, 'runas', [], 'org1', DEF('draft'), 4), isManagedPart);
    await assert.rejects(apps.setStudioAppPublished('a_pub', false, 'runas'), isManagedPart);
    const r = await appRow('a_pub');
    assert.strictEqual(r.published_version, 3);
    assert.strictEqual(r.is_published, false);

    // An unmanaged app publishes as it always has.
    await seedApp('a_free', { projectId: null });
    assert.strictEqual(await apps.setStudioAppPublished('a_free', true, 'runas', [], 'org1', DEF('mine'), 4), true);
    assert.strictEqual((await appRow('a_free')).published_version, 4);
});

test('setStudioAppAudience changes who it reaches and leaves the published copy alone', async () => {
    await seedApp('a_aud', { published: DEF('release 1'), publishedVersion: 3 });
    assert.strictEqual(await apps.setStudioAppAudience('a_aud', 'runas', { isPublished: true, sharedGroups: ['g1'] }), true);
    let r = await appRow('a_aud');
    assert.strictEqual(r.is_published, true);
    assert.deepStrictEqual(r.shared_groups, ['g1']);
    assert.ok(r.published_at, 'a publish is stamped');
    assert.deepStrictEqual(r.published_definition, DEF('release 1'));
    assert.strictEqual(r.published_version, 3);
    assert.strictEqual(r.organization_id, 'org1', 'an organisation left undefined is kept');

    assert.strictEqual(await apps.setStudioAppAudience('a_aud', 'runas', { isPublished: false }), true);
    r = await appRow('a_aud');
    assert.strictEqual(r.is_published, false);
    assert.deepStrictEqual(r.shared_groups, ['g1'], 'groups left undefined are kept');
    assert.deepStrictEqual(r.published_definition, DEF('release 1'));
    assert.strictEqual(await apps.setStudioAppAudience('a_aud', 'someone-else', { isPublished: true }), false);
});

test('publishDefinitionWith flips the published copy on the commit client', async () => {
    await seedApp('a_flip', { published: DEF('release 1'), publishedVersion: 3 });
    await assert.rejects(db.tx((client) => apps.publishDefinitionWith(client, 'a_flip', DEF('release 2'), 5)), isManagedPart);
    assert.strictEqual((await appRow('a_flip')).published_version, 3);

    const ok = await db.tx((client) => apps.publishDefinitionWith(client, 'a_flip', DEF('release 2'), 5, CAPABILITY));
    assert.strictEqual(ok, true);
    const r = await appRow('a_flip');
    assert.deepStrictEqual(r.published_definition, DEF('release 2'));
    assert.strictEqual(r.published_version, 5);
    assert.strictEqual(r.is_published, false, 'whether it is published is the stage\'s setting');
    assert.strictEqual(r.accent_color, '#112233');
    assert.strictEqual(await db.tx((client) => apps.publishDefinitionWith(client, 'missing', DEF('x'), 1, CAPABILITY)), false);
});

// ── studioAppDataStore.saveDataModel ────────────────────────────────

test('saveDataModel on a managed app needs the capability', async () => {
    await seedApp('d_lock');
    await seedModel('d_lock', model([table([TITLE])]));
    await assert.rejects(saveDataModel('d_lock', 'runas', model([table([TITLE, EMAIL])])), isManagedPart);
    assert.strictEqual((await storedModel('d_lock')).model_version, 1);
});

test('additiveOnly refuses a NOT NULL column and a dropped unique index, and writes nothing', async () => {
    await seedApp('d_add');
    await seedModel('d_add', model([table([TITLE, NOTE])]));
    migrations.length = 0;
    await assert.rejects(
        saveDataModel('d_add', 'runas', model([table([TITLE, NOTE, CODE])]), { ...CAPABILITY, additiveOnly: true }),
        (err) => {
            assert.strictEqual(err.status, 409);
            assert.strictEqual(err.code, 'app.data_model_not_additive');
            assert.match(err.details.statements[0], /NOT NULL/);
            return true;
        },
    );
    await assert.rejects(
        saveDataModel('d_add', 'runas', model([table([TITLE, { ...NOTE, unique: false }])]), { ...CAPABILITY, additiveOnly: true }),
        (err) => err.code === 'app.data_model_not_additive' && /DROP INDEX/.test(err.details.statements[0]),
    );
    assert.strictEqual(migrations.length, 0, 'no migration ran');
    assert.strictEqual((await storedModel('d_add')).model_version, 1);
});

test('additiveOnly retains the fields a release leaves out, and plans only the additions', async () => {
    await seedApp('d_keep');
    await seedModel('d_keep', model([table([TITLE, NOTE])]));
    migrations.length = 0;
    const out = await saveDataModel('d_keep', 'runas', model([table([TITLE, EMAIL])]), { ...CAPABILITY, additiveOnly: true });
    assert.deepStrictEqual(out, { ok: true, version: 2 });
    assert.deepStrictEqual(migrations[0].plan, ['ALTER TABLE "people" ADD COLUMN "email" TEXT']);
    const stored = (await storedModel('d_keep')).model;
    assert.deepStrictEqual(stored.tables[0].fields.map((f) => f.key), ['title', 'email', 'note'],
        'the field the release left out is kept, so no DROP was planned');
});

test('a stage\'s model is additive even without the flag; an unmanaged app is not', async () => {
    await seedApp('d_force');
    await seedModel('d_force', model([table([TITLE, NOTE])]));
    await assert.rejects(saveDataModel('d_force', 'runas', model([table([TITLE, CODE])]), CAPABILITY),
        (err) => err.code === 'app.data_model_not_additive');

    await seedApp('d_free', { projectId: null });
    await seedModel('d_free', model([table([TITLE, NOTE])]));
    migrations.length = 0;
    const out = await saveDataModel('d_free', 'runas', model([table([TITLE])]));
    assert.strictEqual(out.ok, true);
    assert.ok(migrations[0].plan.some((stmt) => /DROP COLUMN/.test(stmt)), 'an ordinary app still drops what it removes');
});
