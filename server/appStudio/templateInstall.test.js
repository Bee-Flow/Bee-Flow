/**
 * App Studio — templateInstall (the single data-side instantiation path).
 *
 * Stubs the stores + the writeRecord choke point via the require-cache trick
 * (same pattern as actionExecutor.test.js) so the module can be exercised with
 * no Postgres / SQLite: we assert the ORDER of writes (parents first), that a
 * { $ref } relation value is rewritten to the parent's real id, that datasets
 * are created, and that nothing ever throws past a clean { ok:false, error }.
 *
 * Run: cd server && node --test appStudio/templateInstall.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

// ── Require-cache stubs (before templateInstall loads) ─────────────────────
function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const state = {
    app: { id: 'app-1', userId: 'owner-1', organizationId: 'org-1' },
    saveResult: { ok: true, version: 1 },
    writes: [],           // { tableKey, values, viewer }
    datasets: [],         // createDataset args
    writeImpl: null,      // optional per-test override
    saveImpl: null,       // optional per-test override
    idSeq: 0,
    // seedMode 'missing-tables-only' plumbing:
    rowCounts: {},        // tableKey → current row count (recountRows result)
    recountImpl: null,    // optional per-test override (e.g. throw)
    existingDatasets: [], // listDatasets result
    orgMembers: [],       // getOrgMembersForDirectory result
    directoryImpl: null,  // optional per-test override (e.g. throw)
};

stub('../stores/studioAppStore', {
    getStudioApp: async (id) => (state.app && state.app.id === id ? state.app : null),
});
stub('../stores/studioAppDataStore', {
    saveDataModel: async (appId, ownerId, model) => {
        if (state.saveImpl) return state.saveImpl(appId, ownerId, model);
        state.savedModel = model;
        return state.saveResult;
    },
    createDataset: async (appId, ownerId, args) => {
        state.datasets.push({ appId, ownerId, ...args });
        return { id: `ds-${state.datasets.length}` };
    },
    recountRows: async (appId, ownerId, tables) => {
        if (state.recountImpl) return state.recountImpl(appId, ownerId, tables);
        // Same contract as the real store: an authoritative { tableKey: n } map
        // covering the given tables (missing physical tables count as 0).
        const out = {};
        for (const t of (tables || [])) out[t.key] = state.rowCounts[t.key] || 0;
        return out;
    },
    listDatasets: async () => state.existingDatasets,
});
stub('../stores/userStore', {
    getOrgMembersForDirectory: async (orgId) => {
        if (state.directoryImpl) return state.directoryImpl(orgId);
        return state.orgMembers;
    },
});
stub('./actionExecutor', {
    writeRecord: async (app, model, table, values, opts) => {
        if (state.writeImpl) return state.writeImpl(app, model, table, values, opts);
        state.writes.push({ tableKey: table.key, values, viewer: opts && opts.viewer });
        return { id: `rec_${++state.idSeq}`, created: true };
    },
});

const { installTemplate, _orderTablesByDependency } = require('./templateInstall');

// ── Fixtures ────────────────────────────────────────────────────────────────

// A parent (companies) + child (deals, relation → companies) model, with the
// CHILD declared FIRST to prove ordering is by dependency, not array order.
function crmTemplate() {
    return {
        dataModel: {
            modelVersion: 1,
            tables: [
                {
                    id: 'tbl_deal', key: 'deals', name: 'Deals',
                    fields: [
                        { id: 'fld_title', key: 'title', type: 'text', required: true },
                        { id: 'fld_co', key: 'company', type: 'relation', relation: { table: 'tbl_co' } },
                    ],
                    access: { default: 'app' },
                },
                {
                    id: 'tbl_co', key: 'companies', name: 'Companies',
                    fields: [{ id: 'fld_name', key: 'name', type: 'text', required: true }],
                    access: { default: 'app' },
                },
            ],
            roles: [],
            roleMapping: { default: 'app', byGroup: {} },
        },
        seed: {
            tbl_co: [{ $id: 'acme', name: 'Acme' }],
            tbl_deal: [{ title: 'Renewal', company: { $ref: 'acme' } }],
        },
        datasets: [{ id: 'ds_x', name: 'By stage', tableId: 'tbl_deal', source: {}, descriptor: {} }],
    };
}

test.beforeEach(() => {
    state.app = { id: 'app-1', userId: 'owner-1', organizationId: 'org-1' };
    state.saveResult = { ok: true, version: 1 };
    state.writes = [];
    state.datasets = [];
    state.writeImpl = null;
    state.saveImpl = null;
    state.savedModel = null;
    state.idSeq = 0;
    state.rowCounts = {};
    state.recountImpl = null;
    state.existingDatasets = [];
});

// ── Happy path: model + seed + datasets ─────────────────────────────────────

test('installs model, seed rows and datasets; returns the model version', async () => {
    const res = await installTemplate({ appId: 'app-1', ownerId: 'owner-1', template: crmTemplate() });

    assert.deepStrictEqual(res, { ok: true, appId: 'app-1', dataModelVersion: 1 });
    // saveDataModel got a canonicalized model with both tables.
    assert.ok(state.savedModel && state.savedModel.tables.length === 2);
    // Two seed rows written, both acts-as-owner.
    assert.strictEqual(state.writes.length, 2);
    for (const w of state.writes) assert.deepStrictEqual(w.viewer, { id: 'owner-1', role: 'owner' });
    // One dataset created.
    assert.strictEqual(state.datasets.length, 1);
    assert.strictEqual(state.datasets[0].name, 'By stage');
});

test('seeds PARENT tables first and rewrites a { $ref } to the parent rec id', async () => {
    await installTemplate({ appId: 'app-1', ownerId: 'owner-1', template: crmTemplate() });

    // companies (parent) written before deals (child), despite deals being
    // declared first in the model.
    assert.deepStrictEqual(state.writes.map((w) => w.tableKey), ['companies', 'deals']);
    const parentId = state.writes[0].values && undefined; // parent has no relation
    const companyRecId = 'rec_1'; // first write returns rec_1
    // The child's relation column carries the parent's real rec id, not { $ref }.
    assert.strictEqual(state.writes[1].values.company, companyRecId);
    assert.strictEqual(typeof parentId, 'undefined');
});

test('orderTablesByDependency puts parents before children and tolerates a cycle', () => {
    const model = crmTemplate().dataModel;
    const order = _orderTablesByDependency(model).map((t) => t.key);
    assert.deepStrictEqual(order, ['companies', 'deals']);

    // Self-reference + mutual cycle must not loop or throw.
    const cyclic = {
        tables: [
            { id: 'tbl_a', key: 'a', fields: [{ id: 'fld_1', key: 'b', type: 'relation', relation: { table: 'tbl_b' } }] },
            { id: 'tbl_b', key: 'b', fields: [{ id: 'fld_2', key: 'a', type: 'relation', relation: { table: 'tbl_a' } }] },
        ],
    };
    const order2 = _orderTablesByDependency(cyclic).map((t) => t.key);
    assert.strictEqual(order2.length, 2);
});

// ── Robustness: never throws past { ok:false, error } ───────────────────────

test('a single throwing seed row is skipped — the install still succeeds', async () => {
    let n = 0;
    state.writeImpl = async (app, model, table, values) => {
        n += 1;
        if (table.key === 'deals') throw new Error('boom');
        state.writes.push({ tableKey: table.key, values });
        return { id: `rec_${n}`, created: true };
    };
    const res = await installTemplate({ appId: 'app-1', ownerId: 'owner-1', template: crmTemplate() });
    assert.strictEqual(res.ok, true, 'a bad row does not abort the install');
    assert.deepStrictEqual(state.writes.map((w) => w.tableKey), ['companies']);
});

test('a failed saveDataModel returns a clean { ok:false, error } (no throw, no seeding)', async () => {
    state.saveResult = { ok: false, invalid: true, errors: ['bad model'] };
    const res = await installTemplate({ appId: 'app-1', ownerId: 'owner-1', template: crmTemplate() });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /bad model/);
    assert.strictEqual(state.writes.length, 0, 'no rows seeded when the model save fails');
});

test('a throwing saveDataModel is caught into { ok:false, error }', async () => {
    state.saveImpl = async () => { throw new Error('db down'); };
    const res = await installTemplate({ appId: 'app-1', ownerId: 'owner-1', template: crmTemplate() });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /db down/);
});

test('an unowned / missing app returns { ok:false } without touching stores', async () => {
    state.app = null;
    const res = await installTemplate({ appId: 'app-1', ownerId: 'owner-1', template: crmTemplate() });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(state.writes.length, 0);
    assert.strictEqual(state.datasets.length, 0);

    // Wrong owner is also refused.
    state.app = { id: 'app-1', userId: 'someone-else', organizationId: 'org-1' };
    const res2 = await installTemplate({ appId: 'app-1', ownerId: 'owner-1', template: crmTemplate() });
    assert.strictEqual(res2.ok, false);
});

test('a definition-only template (no data side) is a clean no-op', async () => {
    const res = await installTemplate({ appId: 'app-1', ownerId: 'owner-1', template: { definition: {} } });
    assert.deepStrictEqual(res, { ok: true, appId: 'app-1', dataModelVersion: 0 });
    assert.strictEqual(state.writes.length, 0);
});

test('missing appId/ownerId is rejected without throwing', async () => {
    assert.deepStrictEqual(await installTemplate({}), { ok: false, error: 'appId and ownerId are required' });
    assert.strictEqual((await installTemplate({ appId: 'app-1' })).ok, false);
});

// ── seedMode 'missing-tables-only' (the template-UPGRADE re-run) ────────────

test('missing-tables-only seeds ONLY tables with zero rows — populated tables are never re-seeded', async () => {
    // companies already holds data (the user worked in it); deals is empty
    // (e.g. newly added by the upgrade's migration diff).
    state.rowCounts = { companies: 3, deals: 0 };
    const res = await installTemplate({ appId: 'app-1', ownerId: 'owner-1', template: crmTemplate(), seedMode: 'missing-tables-only' });

    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(state.writes.map((w) => w.tableKey), ['deals'], 'only the empty table is seeded');
    // The skipped parent was never seeded this run, so the child's { $ref }
    // resolves to null (the documented tolerant behavior) — NOT to a phantom id.
    assert.strictEqual(state.writes[0].values.company, null);
});

test('missing-tables-only with every table populated seeds nothing (a no-op re-run)', async () => {
    state.rowCounts = { companies: 1, deals: 5 };
    const res = await installTemplate({ appId: 'app-1', ownerId: 'owner-1', template: crmTemplate(), seedMode: 'missing-tables-only' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(state.writes.length, 0, 'no duplicate rows, ever');
});

test('missing-tables-only fails SAFE: unknowable counts skip ALL seeding, install still succeeds', async () => {
    state.recountImpl = async () => { throw new Error('recount unavailable'); };
    const res = await installTemplate({ appId: 'app-1', ownerId: 'owner-1', template: crmTemplate(), seedMode: 'missing-tables-only' });
    assert.strictEqual(res.ok, true, 'the model install still lands');
    assert.strictEqual(state.writes.length, 0, 'no seeding on unknown counts — duplication is the worse failure');
});

test('missing-tables-only dedupes datasets by name; default mode still creates them all', async () => {
    // The app already has the template dataset → the re-run must not mint a twin.
    state.existingDatasets = [{ id: 'ds-old', name: 'By stage' }];
    await installTemplate({ appId: 'app-1', ownerId: 'owner-1', template: crmTemplate(), seedMode: 'missing-tables-only' });
    assert.strictEqual(state.datasets.length, 0, 'same-named dataset is not duplicated');

    // A dataset the app does NOT have yet is created on upgrade.
    state.existingDatasets = [{ id: 'ds-old', name: 'Something else' }];
    await installTemplate({ appId: 'app-1', ownerId: 'owner-1', template: crmTemplate(), seedMode: 'missing-tables-only' });
    assert.strictEqual(state.datasets.length, 1);
    assert.strictEqual(state.datasets[0].name, 'By stage');

    // The default (create-time) mode is untouched by all of this.
    state.datasets = [];
    state.existingDatasets = [{ id: 'ds-old', name: 'By stage' }];
    await installTemplate({ appId: 'app-1', ownerId: 'owner-1', template: crmTemplate() });
    assert.strictEqual(state.datasets.length, 1, 'default mode ignores the dedupe');
});

test('default seedMode is unaffected by populated row counts (create-time behavior pinned)', async () => {
    state.rowCounts = { companies: 99, deals: 99 };
    await installTemplate({ appId: 'app-1', ownerId: 'owner-1', template: crmTemplate() });
    assert.deepStrictEqual(state.writes.map((w) => w.tableKey), ['companies', 'deals'], 'all tables seeded');
});

// ── seedPeople: demo names → the installer's real colleagues ────────────────

function rosterTemplate() {
    return {
        dataModel: {
            modelVersion: 1,
            tables: [
                {
                    id: 'tbl_team', key: 'team', name: 'Team',
                    fields: [
                        { id: 'fld_n', key: 'name', type: 'text' },
                        { id: 'fld_e', key: 'email', type: 'text' },
                        { id: 'fld_c', key: 'capacity_points', type: 'number' },
                    ],
                },
                {
                    id: 'tbl_work', key: 'work', name: 'Work',
                    fields: [
                        { id: 'fld_t', key: 'title', type: 'text' },
                        { id: 'fld_ai', key: 'assignee_id', type: 'text' },
                        { id: 'fld_an', key: 'assignee_name', type: 'text' },
                        { id: 'fld_ae', key: 'assignee_email', type: 'text' },
                    ],
                },
            ],
        },
        seed: {
            tbl_team: [
                { name: 'Anna de Vries', email: 'anna@example.com', capacity_points: 18 },
                { name: 'Bas Jansen', email: 'bas@example.com', capacity_points: 20 },
            ],
            tbl_work: [
                { title: 'Assigned one', assignee_name: 'Anna de Vries', assignee_email: 'anna@example.com' },
                { title: 'Assigned two', assignee_name: 'Bas Jansen', assignee_email: 'bas@example.com' },
                { title: 'Nobody has picked this up' },
            ],
        },
        seedPeople: {
            roster: { tableId: 'tbl_team', nameField: 'name', emailField: 'email' },
            assign: { tableId: 'tbl_work', idField: 'assignee_id', nameField: 'assignee_name', emailField: 'assignee_email' },
        },
    };
}

function resetPeopleState() {
    state.writes = [];
    state.directoryImpl = null;
    state.orgMembers = [];
}

const rowsFor = (key) => state.writes.filter((w) => w.tableKey === key).map((w) => w.values);

test('seedPeople fills the roster from the organisation, installer first', async () => {
    resetPeopleState();
    state.orgMembers = [
        { id: 'u-2', displayName: 'Bea Wolters' },
        { id: 'owner-1', displayName: 'Tom Smit' },
        { id: 'u-3', displayName: 'Sam Idris' },
    ];
    await installTemplate({ appId: 'app-1', ownerId: 'owner-1', template: rosterTemplate() });

    const team = rowsFor('team');
    // Two authored roster rows → the first two real people, installer first:
    // your own board should have you on it.
    assert.deepEqual(team.map((r) => r.name), ['Tom Smit', 'Bea Wolters']);
    // The authored SHAPE survives — capacity is what a team plans against.
    assert.deepEqual(team.map((r) => r.capacity_points), [18, 20]);
    // The directory carries no e-mail, so a fake one must not be left behind.
    assert.deepEqual(team.map((r) => r.email), [null, null]);
});

test('seedPeople deals assigned work to real people and leaves the rest alone', async () => {
    resetPeopleState();
    state.orgMembers = [
        { id: 'owner-1', displayName: 'Tom Smit' },
        { id: 'u-2', displayName: 'Bea Wolters' },
    ];
    await installTemplate({ appId: 'app-1', ownerId: 'owner-1', template: rosterTemplate() });

    const work = rowsFor('work');
    assert.equal(work[0].assignee_id, 'owner-1');
    assert.equal(work[0].assignee_name, 'Tom Smit');
    assert.equal(work[1].assignee_id, 'u-2');
    // An unassigned card in the seed is a deliberate "nobody has picked this
    // up yet" — inventing an owner for it would be a lie about the board.
    assert.equal(work[2].assignee_id, undefined);
    assert.equal(work[2].assignee_name, undefined);
    // Never write a colleague's address into demo data.
    assert.equal(work[0].assignee_email, null);
});

test('a one-person org keeps the authored demo rather than emptying the board', async () => {
    // The fallback is the path that matters: a self-host trial or a first login
    // should still open onto a board that shows what the app is for.
    resetPeopleState();
    state.orgMembers = [{ id: 'owner-1', displayName: 'Tom Smit' }];
    await installTemplate({ appId: 'app-1', ownerId: 'owner-1', template: rosterTemplate() });

    assert.deepEqual(rowsFor('team').map((r) => r.name), ['Anna de Vries', 'Bas Jansen']);
    assert.equal(rowsFor('work')[0].assignee_name, 'Anna de Vries');
});

test('a directory that will not answer does not fail the install', async () => {
    resetPeopleState();
    state.directoryImpl = async () => { throw new Error('directory unavailable'); };
    const res = await installTemplate({ appId: 'app-1', ownerId: 'owner-1', template: rosterTemplate() });

    assert.equal(res.ok, true);
    assert.deepEqual(rowsFor('team').map((r) => r.name), ['Anna de Vries', 'Bas Jansen']);
});

test('a template without seedPeople never touches the directory', async () => {
    resetPeopleState();
    let asked = false;
    state.directoryImpl = async () => { asked = true; return []; };
    await installTemplate({ appId: 'app-1', ownerId: 'owner-1', template: crmTemplate() });
    assert.equal(asked, false);
});
