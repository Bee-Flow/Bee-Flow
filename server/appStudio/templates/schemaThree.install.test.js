'use strict';

/**
 * The four schema-3 templates (field service, request and approval, sales
 * dashboard, inbound orders) through the REAL create-from-template path: the
 * studio-apps router's POST / with a templateId, which canonicalizes and gates
 * the definition, stores the app and runs templateInstall (data model, seed
 * rows through writeRecord, datasets), on PGlite with the per-app Postgres
 * engine. Only the permission gates are opened (routeHarness.openGates).
 *
 * Proves per template: the gate has nothing to report, the stored definition
 * needs and carries schema version 3, the tables, roles, datasets and sample
 * rows are there, and nothing is armed (no trigger row, no connector sync, the
 * app is a draft).
 *
 * Run: cd server && node --test appStudio/templates/schemaThree.install.test.js
 */

process.env.STUDIO_APP_ENGINE = 'pg';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'tpl3-test-master-key-0123456789abcdef0123456789';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { usePglitePool } = require('../../testUtils/pglitePool');
const { close: closePg, query } = usePglitePool();

const h = require('../../testUtils/routeHarness');

h.openGates();

const { getTemplate } = require('../templates');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { gateDefinition } = require('../definitionGate.mts');
const { canonicalizeDataModel } = require('../dataModel');

const ORG = 'org-tpl3';
const OWNER = { id: 'u-tpl3-owner', username: 'tpl3-owner', email: 'owner@example.com', organizationId: ORG, role: 'user', orgRole: 'member', groups: [] };

const SCHEMA_THREE = ['app-field-service', 'app-request-approval', 'app-sales-dashboard', 'app-inbound-orders'];

/** @type {ReturnType<typeof h.serve>} */
let api;

before(async () => {
    const userStore = require('../../stores/userStore');
    await userStore.initDB();
    await userStore.createOrganization({ id: ORG, name: 'Template org' }, { autoGrantTrial: false });
    await userStore.createUser({ ...OWNER, passwordHash: 'x' });
    await require('../../stores/studioAppStore').initDB();
    api = h.serve('/api/studio-apps', require('../../routes/studioApps/crud'), { user: OWNER });
}, { timeout: 120_000 });

after(async () => {
    if (api) await api.close();
    await closePg();
});

const count = async (sql, params) => Number((await query(sql, params)).rows[0].n);

for (const id of SCHEMA_THREE) {
    test(`${id}: stored at schema 3 and already the bytes canonicalize writes`, () => {
        const t = getTemplate(id);
        assert.ok(t, 'registered');
        assert.equal(t.definition.schemaVersion, 3);
        const { def, repairs } = canonicalizeAppDefinition(structuredClone(t.definition));
        assert.equal(def.schemaVersion, 3, 'it uses vocabulary of schema 3');
        assert.deepEqual(repairs.filter((r) => !/default/i.test(r.code)).map((r) => r.code), []);
        assert.equal(gateDefinition(def, { dataModel: canonicalizeDataModel(t.dataModel).model }).verdict, 'ok');
    });

    test(`${id}: installs through POST /api/studio-apps with its data and arms nothing`, async () => {
        const t = getTemplate(id);
        const res = await api.call('POST', '/api/studio-apps', { body: { templateId: id } });
        assert.equal(res.status, 200, res.text.slice(0, 400));
        const body = JSON.parse(res.text);
        assert.equal(body.findings, undefined, 'the definition gate has nothing to report');
        assert.deepEqual(body.dataInstall, { ok: true, dataModelVersion: body.dataInstall.dataModelVersion }, JSON.stringify(body.dataInstall));
        const appId = body.app.id;

        const app = await require('../../stores/studioAppStore').getStudioApp(appId);
        assert.equal(app.definition.schemaVersion, 3);
        assert.equal(app.templateId, id);
        assert.ok(!app.isPublished, 'a template installs as a draft');

        const meta = await require('../../stores/studioAppDataStore').getDataModel(appId, OWNER.id);
        const model = meta.model;
        assert.deepEqual(model.tables.map((x) => x.id), t.dataModel.tables.map((x) => x.id), 'every table');
        assert.deepEqual(model.roles.map((r) => r.key), t.dataModel.roles.map((r) => r.key), 'every role');

        // Every sample row landed, under the owner, in the app's own schema.
        for (const table of model.tables) {
            const want = (t.seed[table.id] || []).length;
            const got = await count(`SELECT COUNT(*)::int AS n FROM "app_${appId}"."${table.key}"`);
            assert.equal(got, want, `${table.key}: ${got} of ${want} sample rows`);
        }

        const datasets = await require('../../stores/studioAppDataStore').listDatasets(appId, OWNER.id);
        assert.deepEqual(datasets.map((d) => d.name).sort(), (t.datasets || []).map((d) => d.name).sort(), 'every dataset');

        // Nothing armed: triggers are armed by a publish, and no template here
        // syncs a connector.
        assert.equal(await count('SELECT COUNT(*)::int AS n FROM studio_app_triggers WHERE app_id = $1', [appId]), 0, 'no trigger armed');
        assert.equal(await count('SELECT COUNT(*)::int AS n FROM studio_app_connector_sync WHERE app_id = $1', [appId]), 0, 'no connector sync');

        // Every read of every screen runs on the installed data, as the owner
        // and as each role (the dry run the AI builder uses), over the
        // canonical form of the stored definition, as the gate reads it.
        const { appDryRun } = require('../appDryRun');
        const def = canonicalizeAppDefinition(structuredClone(app.definition)).def;
        for (const screen of def.screens) {
            for (const asRole of [null, ...model.roles.map((r) => r.key)]) {
                const run = await appDryRun({ def, dataModel: model, datasets: datasets.map((d) => d.id), app, ownerId: OWNER.id }, { screenId: screen.id, asRole });
                const failed = [...run.bindings, ...run.roleFindings].filter((b) => b.ok === false);
                assert.deepEqual(failed, [], `${screen.id} as ${asRole || 'owner'}`);
                assert.deepEqual(run.static.errors, [], `${screen.id} as ${asRole || 'owner'}`);
                assert.equal(run.ok, true, `${screen.id} as ${asRole || 'owner'}`);
            }
        }
    });
}

test('field service: the lookups and the rollups read back from the installed rows', async () => {
    const res = await api.call('POST', '/api/studio-apps', { body: { templateId: 'app-field-service', name: 'Field service, second copy' } });
    const appId = JSON.parse(res.text).app.id;
    const data = h.serve('/api/studio-apps', require('../../routes/studioAppData'), { user: OWNER });
    try {
        const read = async (tableId) => JSON.parse((await data.call('GET', `/api/studio-apps/${appId}/data/tables/${tableId}/records?limit=100`)).text).records;
        const jobs = await read('tbl_fsjob');
        assert.equal(jobs.length, 8);
        assert.ok(jobs.every((j) => typeof j.customer_name === 'string' && j.customer_name && typeof j.lead_name === 'string' && j.lead_name), 'every job looks up its customer and its lead');
        assert.ok(jobs.every((j) => typeof j.ref === 'number'), 'the job number is assigned on the way in');
        assert.ok(jobs.every((j) => j.margin === j.price - j.cost_price), 'the owner reads the cost price and the margin');
        const customers = await read('tbl_fscust');
        assert.equal(customers.reduce((n, c) => n + c.job_count, 0), 8, 'the job counts add up to the jobs');
        const harbour = customers.find((c) => c.name === 'Harbour Offices');
        assert.equal(harbour.open_value, 680 + 290, 'open value sums the open jobs only');
        const techs = await read('tbl_fstech');
        assert.equal(techs.find((x) => x.name === 'Alex Morgan').open_jobs, 2, 'open jobs per lead technician');
        // The crew is a many relation, seeded as [{ $ref }] and linked once every row exists.
        const nameOf = new Map(techs.map((x) => [x.id, x.name]));
        const crewOf = (title) => (jobs.find((j) => j.title === title).crew || []).map((id) => nameOf.get(id)).sort();
        assert.deepEqual(crewOf('Annual boiler service'), ['Robin Patel', 'Sam Rivera'], 'a crew of two reads back as the technicians');
        assert.deepEqual(crewOf('Replace fuse box'), ['Robin Patel']);
        assert.ok(jobs.every((j) => Array.isArray(j.crew) && j.crew.length > 0), 'every sample job has a crew');
    } finally {
        await data.close();
    }
});

test('field service: read back from the database in its key order, the app still counts as unchanged since install', async () => {
    const { hashDefinition, isPristine } = require('../templateUpgrade');
    const res = await api.call('POST', '/api/studio-apps', { body: { templateId: 'app-field-service' } });
    assert.equal(res.status, 200, res.text.slice(0, 400));
    const app = await require('../../stores/studioAppStore').getStudioApp(JSON.parse(res.text).app.id);
    const saved = canonicalizeAppDefinition(structuredClone(app.definition)).def;
    assert.deepEqual(app.definition, saved, 'the stored value is the canonical one');
    assert.notEqual(JSON.stringify(app.definition), JSON.stringify(saved), 'JSONB hands the keys back in another order than canonicalize writes');
    assert.ok(app.templateInstallHash, 'the install stamped its hash');
    assert.equal(hashDefinition(app.definition), app.templateInstallHash, 'the same hash as at install');
    assert.equal(isPristine(app), true, 'unchanged since install');
    assert.equal(isPristine({ ...app, definition: saved }), true, 'and after a save that changes nothing');
});
