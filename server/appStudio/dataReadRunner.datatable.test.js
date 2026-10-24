/**
 * The read runner chooses the right PATH — app-owned storage or Studio datatable.
 *
 * The permission decision itself lives in datatableSource.test.js. Here it is about the
 * split around it: that the existing kind notices nothing, that the second kind ends up in
 * the datatable storage (with its own table name, its own access block and the Postgres
 * dialect), that a batch does not repeat the lookup per descriptor, and that a refusal
 * arrives as a refusal and not as an empty list.
 *
 * The grade logic runs UNREPLACED along: only the edges that touch a database are stubbed,
 * and the viewer gets his grade from a real grant.
 *
 * Run: cd server && node --test --test-reporter=tap appStudio/dataReadRunner.datatable.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ORG = 'org-a';
const OWNER = 'u-owner';
const VIEWER = 'u-viewer';
const DT_ID = 'tbl_dt00001';

// ── De randen, vóór de eerste require van de runner ─────────────────
// Node cachet op absoluut pad; deze bestanden slepen anders de pg-pool binnen.

const appDbCalls = [];
const datatableDbCalls = [];
const storeCalls = { getDatatable: 0, listGrants: 0, getTableMeta: 0, dataset: 0 };

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stub('../stores/studioAppDbStore', {
    query: async (ownerId, entityId, sql, params) => {
        appDbCalls.push({ ownerId, entityId, sql, params });
        return { rows: [] };
    },
});
stub('../stores/studioAppDataStore', {
    getMemberRole: async () => null,
    getDataset: async () => { storeCalls.dataset += 1; return { id: 'ds_1', tableId: 'tbl_model01' }; },
});
stub('../stores/datatableDbStore', {
    scopeKey: (scope) => `${scope.kind}:${scope.id}`,
    query: async (ownerId, entityId, sql, params) => {
        datatableDbCalls.push({ ownerId, entityId, sql, params });
        return { rows: [] };
    },
});
stub('../stores/datatableStore', {
    orgScope: (id) => ({ kind: 'org', id }),
    userScope: (id) => ({ kind: 'user', id }),
    getDatatable: async (id, scope) => {
        storeCalls.getDatatable += 1;
        if (id !== DT_ID || scope.kind !== 'org' || scope.id !== ORG) return null;
        return {
            id: DT_ID,
            scope_kind: 'org', scope_id: ORG,
            organization_id: ORG, owner_user_id: OWNER,
            is_published: false, shared_groups: [], write_mode: 'grants', row_scope: 'all',
        };
    },
    listGrants: async () => {
        storeCalls.listGrants += 1;
        return [{ grantee_type: 'user', grantee_id: VIEWER, grade: 'editor' }];
    },
    getTableMeta: async () => {
        storeCalls.getTableMeta += 1;
        // The PHYSICAL name of the datatable is a different one from the model table name —
        // that is what proves which table is read from.
        return { id: DT_ID, key: 'dt_klanten', fields: [{ key: 'naam', type: 'text' }] };
    },
});
stub('../stores/userStore', {
    getUser: async (id) => ({ id, organizationId: ORG, orgRole: 'member', groups: [] }),
    getAllGroups: async () => [],
});
stub('../auth/audience', {
    resolveAudienceContext: async () => ({ orgIds: new Set([ORG]), userGroups: [] }),
    canSeePublished: () => false,
    resolveUserGroups: async () => [],
});
stub('../stores/projectStore', {});

const dataReadRunner = require('./dataReadRunner');

// ── De app en haar model ────────────────────────────────────────────

// The first kind: the app owns its own rows. `public` has explicit read rights here,
// so that the public test can show that such a table keeps working while the LINKED one
// next to it is refused.
const APP_TABLE = {
    id: 'tbl_app01',
    key: 'notities',
    fields: [{ key: 'naam', type: 'text' }],
    access: { default: 'app', roles: { public: { read: 'all' } } },
};

const LINKED_TABLE = {
    id: 'tbl_model01',
    key: 'klanten',
    fields: [{ key: 'naam', type: 'text' }],
    access: { default: 'app', roles: {} },
    source: { kind: 'datatable', datatableId: DT_ID, mode: 'read' },
};

/**
 * The same link, but with the reserved role `public` EXPLICITLY given read rights on the
 * model table. That way the read gets past the app's RLS gate (rlsGateway.canRead), and the
 * refusal must come from the datatable path — otherwise the test would prove that the gate
 * in front of it was closed, not this one.
 */
const LINKED_PUBLIC_TABLE = {
    id: 'tbl_model02',
    key: 'aanvragen',
    fields: [{ key: 'naam', type: 'text' }],
    access: { default: 'none', roles: { public: { read: 'all' } } },
    source: { kind: 'datatable', datatableId: DT_ID, mode: 'read' },
};

const model = { tables: [APP_TABLE, LINKED_TABLE, LINKED_PUBLIC_TABLE] };

const signedInCtx = (over = {}) => ({
    app: { id: 'app_1', userId: OWNER },
    ownerScope: OWNER,
    viewerId: VIEWER,
    model,
    role: 'medewerker',
    viewer: { id: VIEWER, role: 'medewerker', organizationId: ORG },
    ...over,
});

const publicCtx = (over = {}) => signedInCtx({
    viewerId: 'anon:cafecafecafecafe',
    role: 'public',
    viewer: { id: 'anon:cafecafecafecafe', role: 'public', organizationId: null },
    ...over,
});

function reset() {
    appDbCalls.length = 0;
    datatableDbCalls.length = 0;
    storeCalls.getDatatable = 0;
    storeCalls.listGrants = 0;
    storeCalls.getTableMeta = 0;
    storeCalls.dataset = 0;
}

const CONTAINS = [{ field: 'naam', op: 'contains', value: 'jan' }];

// ═══════════════════════════════════════════════════════════════════

test('een tabel met EIGEN opslag verandert niet: app-database, app-dialect', async () => {
    reset();
    await dataReadRunner.runRecordList(signedInCtx(), APP_TABLE, { filters: CONTAINS });

    assert.equal(datatableDbCalls.length, 0, 'de datatabel-opslag mag niet aangeraakt worden');
    assert.equal(storeCalls.getDatatable, 0);
    assert.equal(appDbCalls.length, 1);
    // The handle is still (owner, app) and the table name that of the model.
    assert.equal(appDbCalls[0].ownerId, OWNER);
    assert.equal(appDbCalls[0].entityId, 'app_1');
    assert.match(appDbCalls[0].sql, /FROM "notities"/);
    // De procesbrede dialect (sqlite) blijft gelden: LIKE, niet ILIKE.
    assert.match(appDbCalls[0].sql, /LIKE/);
    assert.doesNotMatch(appDbCalls[0].sql, /ILIKE/);
});

test('een GEKOPPELDE tabel leest uit de datatabel-opslag, op scope-sleutel en in Postgres', async () => {
    reset();
    const out = await dataReadRunner.runRecordList(signedInCtx(), LINKED_TABLE, { filters: CONTAINS });

    assert.deepEqual(out, { records: [], nextCursor: null });
    assert.equal(appDbCalls.length, 0, 'de app-database heeft deze rijen niet');
    assert.equal(datatableDbCalls.length, 1);
    // ownerId én entityId zijn allebei de scope-sleutel (stores/datatableDbStore.js).
    assert.equal(datatableDbCalls[0].ownerId, `org:${ORG}`);
    assert.equal(datatableDbCalls[0].entityId, `org:${ORG}`);
    // Uit de FYSIEKE tabel van de datatabel, niet uit de modeltabelnaam.
    assert.match(datatableDbCalls[0].sql, /FROM "dt_klanten"/);
    assert.doesNotMatch(datatableDbCalls[0].sql, /"klanten"/);
    // En in de dialect van die opslag — datatabellen staan altijd in Postgres.
    assert.match(datatableDbCalls[0].sql, /ILIKE/);
});

test('een aggregatie volgt hetzelfde pad', async () => {
    reset();
    await dataReadRunner.runInlineAggregate(signedInCtx(), LINKED_TABLE, {
        groupBy: [{ field: 'naam' }],
        aggregates: [{ fn: 'count', as: 'n' }],
    });
    assert.equal(appDbCalls.length, 0);
    assert.equal(datatableDbCalls.length, 1);
    assert.match(datatableDbCalls[0].sql, /FROM "dt_klanten"/);
});

test('een batch zoekt de gekoppelde tabel ÉÉN keer op, niet per descriptor', async () => {
    reset();
    const ctx = signedInCtx();
    const results = await dataReadRunner.runBatch(ctx, [
        { id: 'a', kind: 'records', tableId: 'tbl_model01' },
        { id: 'b', kind: 'records', tableId: 'tbl_model01' },
        { id: 'c', kind: 'aggregate', tableId: 'tbl_model01', aggregates: [{ fn: 'count', as: 'n' }] },
    ]);

    assert.deepEqual(results.map(r => r.ok), [true, true, true]);
    assert.equal(datatableDbCalls.length, 3, 'elke lezing draait wel degelijk');
    assert.equal(storeCalls.getDatatable, 1);
    assert.equal(storeCalls.listGrants, 1);
    assert.equal(storeCalls.getTableMeta, 1);
});

test('PUBLIEKE route: de weigering komt als weigering aan, niet als lege lijst', async () => {
    reset();
    const results = await dataReadRunner.runBatch(publicCtx(), [
        // De auteur heeft de rol `public` op deze tabel leesrecht gegeven; de
        // koppeling weigert alsnog.
        { id: 'a', kind: 'records', tableId: 'tbl_model02' },
        // A linked table WITHOUT that read right is already stopped by the app's RLS gate —
        // two locks, both closed.
        { id: 'b', kind: 'records', tableId: 'tbl_model01' },
        // The app-owned table on the same screen keeps working: one refused read must not blank
        // the rest of the screen.
        { id: 'c', kind: 'records', tableId: 'tbl_app01' },
    ]);

    assert.equal(results[0].ok, false);
    assert.equal(results[0].status, 403);
    assert.notEqual(results[0].status, 404, 'een 404 zou in de client een lege lijst worden');
    assert.match(results[0].error, /public page/i);
    assert.equal(results[1].ok, false);
    assert.equal(results[1].status, 403);
    assert.equal(results[2].ok, true);
    assert.deepEqual(results[2].data, { records: [], nextCursor: null });
    // Er is niets uit de datatabel gelezen en er is geen graad opgezocht.
    assert.equal(datatableDbCalls.length, 0);
    assert.equal(storeCalls.getDatatable, 0);
});

test('PUBLIEKE route, losse lezing: een weigering die zegt waarom', async () => {
    reset();
    await assert.rejects(
        () => dataReadRunner.runRecordList(publicCtx(), LINKED_PUBLIC_TABLE, {}),
        (err) => {
            assert.equal(err.status, 403);
            assert.equal(err.safe, true, 'de router mag deze boodschap letterlijk doorgeven');
            assert.match(err.message, /public page/i);
            return true;
        },
    );
    assert.equal(datatableDbCalls.length, 0);
});

test('een opgeslagen dataset over een gekoppelde tabel wordt geweigerd, niet stil op de app-database gedraaid', async () => {
    reset();
    await assert.rejects(
        () => dataReadRunner.runSavedDataset(signedInCtx(), 'ds_1', {}),
        (err) => {
            assert.equal(err.status, 501);
            assert.equal(err.safe, true);
            assert.match(err.message, /Studio table/i);
            return true;
        },
    );
    assert.equal(appDbCalls.length, 0, 'die tabel bestaat niet in de app-database');
    assert.equal(datatableDbCalls.length, 0);
});

test('readPlan is de enige splitsing: hij geeft per soort een compleet plan', async () => {
    reset();
    const own = await dataReadRunner.readPlan(signedInCtx(), APP_TABLE);
    assert.equal(own.tableMeta, APP_TABLE);
    assert.equal(own.role, 'medewerker');
    assert.equal(own.dialect, undefined, 'de app-eigen opslag volgt de procesbrede dialect');

    const linked = await dataReadRunner.readPlan(signedInCtx(), LINKED_TABLE);
    assert.equal(linked.tableMeta.key, 'dt_klanten');
    // De grant zegt 'editor'; mode:'read' capt hem op 'viewer'.
    assert.equal(linked.role, 'viewer');
    assert.equal(linked.viewer.id, VIEWER);
    assert.equal(linked.dialect, 'pg');
});
