/**
 * De leesrunner kiest het juiste PAD — app-eigen opslag of Studio-datatabel.
 *
 * De rechtenbeslissing zelf staat in datatableSource.test.js. Hier gaat het om
 * de splitsing eromheen: dat de bestaande soort niets merkt, dat de tweede
 * soort in de datatabel-opslag terechtkomt (met haar eigen tabelnaam, haar
 * eigen access-blok en de Postgres-dialect), dat een batch de opzoeking niet
 * per descriptor overdoet, en dat een weigering als weigering aankomt en niet
 * als lege lijst.
 *
 * De grade-logica draait ONVERVANGEN mee: alleen de randen die een database
 * aanraken zijn gestubd, en de kijker krijgt zijn graad uit een echte grant.
 *
 * Draai: cd server && node --test --test-reporter=tap appStudio/dataReadRunner.datatable.test.js
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
        // De FYSIEKE naam van de datatabel is een andere dan de modeltabelnaam —
        // dat is wat bewijst uit welke tabel er gelezen wordt.
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

// De eerste soort: de app bezit haar eigen rijen. `public` heeft hier
// uitdrukkelijk leesrecht, zodat de publieke test kan laten zien dat zo'n tabel
// blijft werken terwijl de GEKOPPELDE ernaast geweigerd wordt.
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
 * Dezelfde koppeling, maar met de gereserveerde rol `public` UITDRUKKELIJK
 * leesrecht op de modeltabel. Zo komt de lezing voorbij de RLS-poort van de app
 * (rlsGateway.canRead) en moet de weigering wel uit het datatabel-pad komen —
 * anders zou de test bewijzen dat de poort ervoor dicht zat, niet deze.
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
    // Het handvat is nog steeds (eigenaar, app) en de tabelnaam die van het model.
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
        // Een gekoppelde tabel ZONDER dat leesrecht wordt al door de RLS-poort
        // van de app tegengehouden — twee sloten, allebei dicht.
        { id: 'b', kind: 'records', tableId: 'tbl_model01' },
        // De app-eigen tabel op hetzelfde scherm blijft gewoon werken: één
        // geweigerde lezing mag de rest van het scherm niet blanco maken.
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
