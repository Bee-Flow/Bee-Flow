/**
 * `readDataBinding` op een GEKOPPELDE tabel — het vierde-en-een-half leespad.
 *
 * `resolveDataBinding` levert de live context voor een serverstap
 * (ai_generate.promptContext, de bron van ai_extract, generate_file). Het
 * compileerde tegen de MODELtabel en bevroeg `studioAppDbStore`, dus voor een
 * tabel die haar rijen uit een Studio-datatabel haalt raakte het de LEGE
 * schaduwtabel: `[]`, en een SQL-fout werd door de catch `null`. Een AI-stap
 * die "de openstaande tickets" als context bindt kreeg dus een leeg antwoord
 * dat niet te onderscheiden was van "er zijn geen rijen".
 *
 * Wat hier gepind wordt:
 *   • de rijen komen uit de DATATABEL, op de scope-sleutel, met dialect pg;
 *   • de graad is die van de KIJKER — de moduledoc belooft "alles hier gaat als
 *     de VIEWER", en voor deze soort was dat niet waar;
 *   • een WEIGERING wordt niet tot `null` afgevlakt: hij gooit door, met status
 *     en reden, zodat "leeg" en "mocht niet" verschillende antwoorden blijven;
 *   • een tabel zonder `source` gedraagt zich exact zoals altijd.
 *
 * Draaien: cd server && node --test --test-reporter=tap appStudio/stepDataSource.datatable.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const ORG = 'org-a';
const OWNER = 'u-owner';
const MEMBER = 'u-member';
const DT_ID = 'tbl_dt00001';

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

let dtRow = null;
let grants = [];
stub('../stores/datatableStore', {
    orgScope: (id) => ({ kind: 'org', id }),
    userScope: (id) => ({ kind: 'user', id }),
    getDatatable: async (id, scope) => {
        if (id !== DT_ID || !dtRow) return null;
        return (scope.kind === 'org' && scope.id === ORG) ? dtRow : null;
    },
    listGrants: async () => grants,
    getTableMeta: async () => ({
        id: DT_ID, key: 'dt_klanten',
        fields: [{ id: 'f1', key: 'naam', type: 'text' }],
    }),
});

const dtQueries = [];
stub('../stores/datatableDbStore', {
    scopeKey: (scope) => `${scope.kind}:${scope.id}`,
    query: async (ownerId, entityId, sql, params) => {
        dtQueries.push({ ownerId, entityId, sql, params });
        return { rows: [{ id: 'rec_1', naam: 'Acme' }] };
    },
});

const appQueries = [];
stub('../stores/studioAppDbStore', {
    query: async (ownerId, appId, sql, params) => {
        appQueries.push({ ownerId, appId, sql, params });
        return { rows: [{ id: 'rec_app', body: 'x' }] };
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

const stepDataSource = require('./stepDataSource');

const app = { id: 'app-1', userId: OWNER, organizationId: ORG };

const datatable = (over = {}) => {
    const o = { ownerUserId: OWNER, organizationId: ORG, isPublished: false, sharedGroups: [], writeMode: 'grants', rowScope: 'all', ...over };
    return {
        id: DT_ID, key: 'dt_klanten', name: 'Klanten',
        scope: { kind: 'org', id: ORG }, scopeKind: 'org', scope_kind: 'org', scope_id: ORG,
        ...o,
        organization_id: o.organizationId,
        owner_user_id: o.ownerUserId,
        is_published: o.isPublished,
        shared_groups: o.sharedGroups,
        write_mode: o.writeMode,
        row_scope: o.rowScope,
    };
};

function model(mode = 'read') {
    return {
        modelVersion: 1,
        tables: [
            {
                id: 'tbl_model01', key: 'klanten', name: 'Klanten',
                source: { kind: 'datatable', datatableId: DT_ID, mode },
                fields: [{ id: 'f1', key: 'naam', type: 'text' }],
                access: { default: 'app', roles: {} },
            },
            {
                id: 'tbl_own001', key: 'notes', name: 'Notes',
                fields: [{ id: 'f2', key: 'body', type: 'text' }],
                access: { default: 'app', roles: {} },
            },
        ],
    };
}

const EDITOR_GRANT = [{ grantee_type: 'user', grantee_id: MEMBER, grade: 'editor' }];

function reset({ table = datatable(), granted = [] } = {}) {
    dtRow = table;
    grants = granted;
    dtQueries.length = 0;
    appQueries.length = 0;
}

const opts = (id = MEMBER, role = 'staff') => ({
    viewer: { id, role, organizationId: ORG },
    role,
    resolveValue: () => null,
});

const RECORDS = { kind: 'records', tableId: 'tbl_model01', limit: 5 };

async function refusal(promise) {
    try {
        await promise;
    } catch (err) {
        return err;
    }
    return assert.fail('verwacht een weigering, kreeg een geslaagde lezing');
}

test('de rijen komen uit de DATATABEL, op de scope-sleutel, niet uit de app-opslag', async () => {
    reset({ granted: EDITOR_GRANT });
    const rows = await stepDataSource.resolveDataBinding(app, model(), RECORDS, opts());
    assert.deepStrictEqual(rows, [{ id: 'rec_1', naam: 'Acme' }]);
    assert.strictEqual(appQueries.length, 0, 'studioAppDbStore mag hier nooit geraakt worden');
    assert.strictEqual(dtQueries.length, 1);
    assert.strictEqual(dtQueries[0].ownerId, `org:${ORG}`);
    assert.strictEqual(dtQueries[0].entityId, `org:${ORG}`);
    // De FYSIEKE naam van de datatabel, niet die van de modeltabel.
    assert.match(dtQueries[0].sql, /FROM "dt_klanten"/);
});

test('kind:record levert één rij en houdt dezelfde opslag aan', async () => {
    reset({ granted: EDITOR_GRANT });
    const row = await stepDataSource.resolveDataBinding(
        app, model(), { kind: 'record', tableId: 'tbl_model01' }, opts(),
    );
    assert.deepStrictEqual(row, { id: 'rec_1', naam: 'Acme' });
    assert.strictEqual(appQueries.length, 0);
});

test('row_scope:own bindt de filter aan de KIJKER, niet aan de app-eigenaar', async () => {
    reset({ table: datatable({ rowScope: 'own' }), granted: EDITOR_GRANT });
    await stepDataSource.resolveDataBinding(app, model(), RECORDS, opts());
    assert.match(dtQueries[0].sql, /"created_by" = \?/);
    assert.ok(dtQueries[0].params.includes(MEMBER), 'de rijfilter bindt de kijker');
    assert.strictEqual(dtQueries[0].params.includes(OWNER), false);
});

test('een kijker zonder graad krijgt een WEIGERING, geen lege context', async () => {
    // Dit is de kern: `[]` en "je mag niet kijken" zijn verschillende antwoorden,
    // en de eerste ziet er voor de AI-stap uit als een lege tabel.
    reset();
    const err = await refusal(stepDataSource.resolveDataBinding(app, model(), RECORDS, opts()));
    assert.strictEqual(err.status, 403);
    assert.strictEqual(err.safe, true);
    assert.match(err.message, /do not have access/i);
    assert.strictEqual(dtQueries.length, 0);
    assert.strictEqual(appQueries.length, 0);
});

test('een verdwenen datatabel is een 422 met reden, geen leeg antwoord', async () => {
    reset({ table: null });
    const err = await refusal(stepDataSource.resolveDataBinding(app, model(), RECORDS, opts()));
    assert.strictEqual(err.status, 422);
    assert.match(err.message, /no longer available/i);
    assert.strictEqual(appQueries.length, 0);
});

test('een kapotte `source` valt NIET terug op de eigen opslag van de app', async () => {
    reset({ granted: EDITOR_GRANT });
    const broken = model();
    broken.tables[0].source = { kind: 'datatabel', datatableId: DT_ID, mode: 'read' };
    const err = await refusal(stepDataSource.resolveDataBinding(app, broken, RECORDS, opts()));
    assert.strictEqual(err.status, 422);
    assert.match(err.message, /not valid/i);
    assert.strictEqual(appQueries.length, 0);
});

test('een tabel ZONDER source leest nog precies zoals altijd', async () => {
    reset();
    const rows = await stepDataSource.resolveDataBinding(
        app, model(), { kind: 'records', tableId: 'tbl_own001' }, opts(),
    );
    assert.deepStrictEqual(rows, [{ id: 'rec_app', body: 'x' }]);
    assert.strictEqual(appQueries.length, 1);
    assert.strictEqual(appQueries[0].ownerId, OWNER);
    assert.strictEqual(appQueries[0].appId, 'app-1');
    assert.strictEqual(dtQueries.length, 0);
});

test('een tabel die niet in het model staat blijft null — dat is geen weigering', async () => {
    reset();
    const out = await stepDataSource.resolveDataBinding(
        app, model(), { kind: 'records', tableId: 'tbl_weg' }, opts(),
    );
    assert.strictEqual(out, null);
    assert.strictEqual(dtQueries.length, 0);
    assert.strictEqual(appQueries.length, 0);
});
