/**
 * The security core of the linked Studio table: WHOSE grade applies, and how far it reaches.
 *
 * Every test here is a way in which an app would otherwise become a channel for the rights of
 * its maker. The grade logic itself is the REAL one (auth/datatableAccess runs unreplaced); only
 * the edges that touch a database — looking up the table, reading the grants, fetching the
 * principal — are injected.
 *
 * Run: cd server && node --test --test-reporter=tap appStudio/datatableSource.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { compileAccessFilter } = require('../core/dataEngine/accessFilter');
const datatableSource = require('./datatableSource');

const ORG = 'org-a';
const OWNER = 'u-owner';     // de eigenaar van de APP
const VIEWER = 'u-viewer';   // wie er kijkt
const DT_ID = 'tbl_dt00001'; // de Studio-datatabel

// ── De wereld waarin een lezing plaatsvindt ─────────────────────────

const datatable = (over = {}) => ({
    id: DT_ID,
    scope_kind: 'org',
    scope_id: ORG,
    organization_id: ORG,
    owner_user_id: OWNER,
    is_published: false,
    shared_groups: [],
    write_mode: 'grants',
    row_scope: 'all',
    ...over,
});

const principal = (userId, over = {}) => ({
    userId,
    orgId: ORG,
    organizationId: ORG,
    orgRole: 'member',
    groupIds: [],
    ...over,
});

/** De MODELtabel van de app — de tabel met het `source`-blok. */
const modelTable = (over = {}) => ({
    id: 'tbl_model01',
    key: 'klanten',
    fields: [{ key: 'naam', type: 'text' }],
    // 'app' = iedereen die de app mag openen mag alles met deze tabel; dat is de
    // ruimste app-rolmapping die bestaat en dus de scherpste test voor de cap.
    access: { default: 'app', roles: {} },
    source: { kind: 'datatable', datatableId: DT_ID, mode: 'read' },
    ...over,
});

/** De leescontext zoals routes/studioAppData.js hem bouwt (INGELOGD). */
const signedInCtx = (over = {}) => ({
    app: { id: 'app_1', userId: OWNER },
    ownerScope: OWNER,
    viewerId: VIEWER,
    role: 'medewerker',
    viewer: { id: VIEWER, role: 'medewerker', organizationId: ORG },
    ...over,
});

/** De leescontext zoals routes/studioAppPublic.js hem bouwt (PUBLIEK). */
const publicCtx = (over = {}) => ({
    app: { id: 'app_1', userId: OWNER },
    ownerScope: OWNER,
    viewerId: 'anon:deadbeefdeadbeef',
    role: 'public',
    viewer: { id: 'anon:deadbeefdeadbeef', role: 'public', organizationId: null },
    ...over,
});

/**
 * The injected edges. `calls` counts what was touched, so that a test can prove that a
 * refusal falls BEFORE the lookup.
 */
function deps({ table = datatable(), grants = [], meta = { id: DT_ID, key: 'dt_klanten', fields: [{ key: 'naam', type: 'text' }] }, principals = {} } = {}) {
    const calls = { getDatatable: 0, listGrants: 0, getTableMeta: 0, principals: [] };
    return {
        calls,
        datatableStore: {
            getDatatable: async (id, scope) => {
                calls.getDatatable += 1;
                if (id !== DT_ID) return null;
                if (!table) return null;
                return (scope.kind === table.scope_kind && scope.id === table.scope_id) ? table : null;
            },
            listGrants: async () => { calls.listGrants += 1; return grants; },
            getTableMeta: async () => { calls.getTableMeta += 1; return meta; },
        },
        datatableDbStore: { scopeKey: (scope) => `${scope.kind}:${scope.id}` },
        resolveDatatablePrincipalForUser: async (userId) => {
            calls.principals.push(userId);
            if (Object.hasOwn(principals, userId)) {
                const p = principals[userId];
                if (typeof p === 'function') return p();
                return p;
            }
            return principal(userId);
        },
    };
}

async function refusal(promise) {
    try {
        await promise;
    } catch (err) {
        return err;
    }
    return assert.fail('expected a refusal, got a resolved read');
}

// ═══════════════════════════════════════════════════════════════════
// REGEL 1 — de graad is die van de KIJKER, nooit die van de auteur
// ═══════════════════════════════════════════════════════════════════

test('de kijker zonder graad krijgt een WEIGERING, niet de graad van de app-eigenaar', async () => {
    // The app owner is the owner of the datatable (grade owner). The viewer has nothing: no grant,
    // and the table is not published. If the grade were determined for the owner, this viewer
    // would read the entire table here.
    const d = deps();
    const err = await refusal(datatableSource.resolveDatatableRead(signedInCtx(), modelTable(), d));

    assert.equal(err.status, 403);
    assert.equal(err.safe, true);
    assert.match(err.message, /You do not have access/i);
    // Geen stille terugval op de laagste graad, en geen lege lijst.
    assert.notEqual(err.status, 404, 'een 404 wordt door de runtime-client een LEGE LIJST');
});

test('de kijker MET een grant leest — en met zijn eigen graad', async () => {
    const d = deps({ grants: [{ grantee_type: 'user', grantee_id: VIEWER, grade: 'viewer' }] });
    const out = await datatableSource.resolveDatatableRead(signedInCtx(), modelTable(), d);

    assert.equal(out.grade, 'viewer');
    // De viewer waar de rijfilter tegen bindt is de KIJKER, niet de eigenaar.
    assert.equal(out.viewer.id, VIEWER);
    assert.equal(out.viewer.role, 'viewer');
    // Beide principalen zijn opgehaald: de kijker én de eigenaar (voor de MIN).
    assert.deepEqual(d.calls.principals, [VIEWER, OWNER]);
});

test('een kijker uit een ANDERE organisatie komt er niet in', async () => {
    const d = deps({
        grants: [{ grantee_type: 'user', grantee_id: VIEWER, grade: 'editor' }],
        principals: { [VIEWER]: principal(VIEWER, { orgId: 'org-b', organizationId: 'org-b' }) },
    });
    const err = await refusal(datatableSource.resolveDatatableRead(signedInCtx(), modelTable(), d));
    assert.equal(err.status, 403);
    assert.match(err.message, /You do not have access/i);
});

// ═══════════════════════════════════════════════════════════════════
// REGEL 2 — effectief = MINIMUM, nooit de unie
// ═══════════════════════════════════════════════════════════════════

test('MIN(kijker, eigenaar): de hogere graad van de kijker wordt verlaagd tot die van de eigenaar', async () => {
    // The datatable belongs to a THIRD party. The viewer is an org admin (grade owner via rule 3);
    // the app owner has only a viewer grant. The union would say 'owner' here — a permission that
    // neither of them had through this door.
    const d = deps({
        table: datatable({ owner_user_id: 'u-third' }),
        grants: [{ grantee_type: 'user', grantee_id: OWNER, grade: 'viewer' }],
        principals: { [VIEWER]: principal(VIEWER, { orgRole: 'org_admin' }) },
    });
    const out = await datatableSource.resolveDatatableRead(
        signedInCtx({ role: 'owner' }), modelTable({ source: { kind: 'datatable', datatableId: DT_ID, mode: 'readwrite' } }), d,
    );
    assert.equal(out.grade, 'viewer');
});

test('MIN(kijker, eigenaar): een eigenaar ZONDER graad sluit de deur, ook voor een kijker die alles mag', async () => {
    // The app owner has lost his access (the datatable belongs to a third party and he has no grant
    // any more). The viewer is an org admin and may do everything. The app is then no longer a
    // channel: it hands out what its maker has, and that is nothing.
    const d = deps({
        table: datatable({ owner_user_id: 'u-third' }),
        grants: [{ grantee_type: 'user', grantee_id: VIEWER, grade: 'editor' }],
        principals: { [VIEWER]: principal(VIEWER, { orgRole: 'org_admin' }) },
    });
    const err = await refusal(datatableSource.resolveDatatableRead(signedInCtx(), modelTable(), d));
    assert.equal(err.status, 403);
    assert.match(err.message, /app owner/i);
});

test('MIN met de APP-ROL: een leesrol krijgt geen owner-graad, ook niet als hij die op de datatabel heeft', async () => {
    // The viewer is an org admin (grade owner) and the link is readwrite, so the only brake is the
    // app role mapping: 'employee' may only read this table.
    const d = deps({ principals: { [VIEWER]: principal(VIEWER, { orgRole: 'org_admin' }) } });
    const readOnlyRole = modelTable({
        access: { default: 'role', roles: { medewerker: { read: 'all' } } },
        source: { kind: 'datatable', datatableId: DT_ID, mode: 'readwrite' },
    });
    const out = await datatableSource.resolveDatatableRead(signedInCtx(), readOnlyRole, d);
    assert.equal(out.grade, 'viewer');

    // The check: the same viewer, the same table, but an app role that DOES allow writing — then the
    // grade stays where the datatable puts it.
    const writableRole = modelTable({
        access: { default: 'role', roles: { medewerker: { read: 'all', update: 'all' } } },
        source: { kind: 'datatable', datatableId: DT_ID, mode: 'readwrite' },
    });
    const out2 = await datatableSource.resolveDatatableRead(signedInCtx(), writableRole, deps({
        principals: { [VIEWER]: principal(VIEWER, { orgRole: 'org_admin' }) },
    }));
    assert.equal(out2.grade, 'editor');
});

// ═══════════════════════════════════════════════════════════════════
// REGEL 3 — mode:'read' capt op viewer
// ═══════════════════════════════════════════════════════════════════

test("mode:'read' verlaagt zelfs de app-eigenaar die zijn eigen datatabel leest", async () => {
    // Kijker == app-eigenaar == eigenaar van de datatabel: graad owner langs elke
    // route, en app-rol 'owner'. Alleen de koppelingsmodus houdt hem tegen.
    const ownerCtx = signedInCtx({ viewerId: OWNER, role: 'owner', viewer: { id: OWNER, role: 'owner', organizationId: ORG } });

    const read = await datatableSource.resolveDatatableRead(ownerCtx, modelTable(), deps());
    assert.equal(read.grade, 'viewer');

    const rw = await datatableSource.resolveDatatableRead(
        ownerCtx, modelTable({ source: { kind: 'datatable', datatableId: DT_ID, mode: 'readwrite' } }), deps(),
    );
    assert.equal(rw.grade, 'owner');
});

test("de cap is niet symbolisch: met row_scope 'own' scheelt hij álle rijen", async () => {
    // owner short-circuits in resolveScope to 'all'; a viewer gets `created_by = ?`. That difference
    // is precisely what the cap is about.
    const ownerCtx = signedInCtx({ viewerId: OWNER, role: 'owner', viewer: { id: OWNER, role: 'owner', organizationId: ORG } });
    const own = { table: datatable({ row_scope: 'own' }) };

    const capped = await datatableSource.resolveDatatableRead(ownerCtx, modelTable(), deps(own));
    const cappedFilter = compileAccessFilter(capped.tableMeta, capped.grade, capped.viewer, 'read', { dialect: 'pg' });
    assert.match(cappedFilter.where, /created_by/);
    assert.deepEqual(cappedFilter.params, [OWNER]);

    const uncapped = await datatableSource.resolveDatatableRead(
        ownerCtx, modelTable({ source: { kind: 'datatable', datatableId: DT_ID, mode: 'readwrite' } }), deps(own),
    );
    const uncappedFilter = compileAccessFilter(uncapped.tableMeta, uncapped.grade, uncapped.viewer, 'read', { dialect: 'pg' });
    assert.equal(uncappedFilter.where, '1=1');
});

// ═══════════════════════════════════════════════════════════════════
// DE TWEE ROUTES
// ═══════════════════════════════════════════════════════════════════

test('PUBLIEKE route: een anonieme bezoeker leent NOOIT de graad van de auteur', async () => {
    const d = deps();
    const err = await refusal(datatableSource.resolveDatatableRead(publicCtx(), modelTable(), d));

    assert.equal(err.status, 403);
    assert.equal(err.safe, true);
    assert.match(err.message, /public page/i);
    // En de weigering valt VOOR de opzoeking: er is geen moment waarop de graad
    // van de eigenaar überhaupt is berekend.
    assert.equal(d.calls.getDatatable, 0);
    assert.equal(d.calls.listGrants, 0);
    assert.deepEqual(d.calls.principals, []);
});

test('PUBLIEKE route: ook zonder de gereserveerde rol houdt het anonieme id hem tegen', async () => {
    // The second, independent gate — for a future route that sets the role differently but does carry
    // an anonymous visitor id.
    const d = deps();
    const err = await refusal(datatableSource.resolveDatatableRead(publicCtx({ role: 'medewerker' }), modelTable(), d));
    assert.equal(err.status, 403);
    assert.match(err.message, /signed-in account/i);
    assert.equal(d.calls.getDatatable, 0);
});

test('INGELOGDE route: de graad komt uit de datatabel, het access-blok ook', async () => {
    const d = deps({ grants: [{ grantee_type: 'user', grantee_id: VIEWER, grade: 'editor' }] });
    const out = await datatableSource.resolveDatatableRead(signedInCtx(), modelTable(), d);

    // De koppeling is 'read', dus editor wordt viewer.
    assert.equal(out.grade, 'viewer');
    // tableMeta is that of the DATATABLE (columns + the access block that synthesizeAccess builds),
    // not the access block of the model table.
    assert.equal(out.tableMeta.key, 'dt_klanten');
    assert.equal(out.tableMeta.access.default, 'none');
    assert.deepEqual(Object.keys(out.tableMeta.access.roles).sort(), ['editor', 'viewer']);
    // De opslag: de scope-sleutel van de EIGENAAR-scope, en altijd Postgres.
    assert.equal(out.scopeKey, `org:${ORG}`);
    assert.equal(out.dialect, 'pg');
});

// ═══════════════════════════════════════════════════════════════════
// ONBEKEND VERSMALT — maar zegt waarom
// ═══════════════════════════════════════════════════════════════════

test('de principaal-resolver valt om: 503 met een reden, geen viewer en geen lege lijst', async () => {
    const boom = deps({
        principals: { [VIEWER]: () => { throw new Error('users table unreachable'); } },
    });
    const err = await refusal(datatableSource.resolveDatatableRead(signedInCtx(), modelTable(), boom));

    assert.equal(err.status, 503);
    assert.equal(err.safe, true);
    assert.match(err.message, /Could not check who you are/i);
    // Not presented as "no access": that would blame the viewer for an outage. And not as a 404,
    // because that is an empty screen.
    assert.notEqual(err.status, 403);
    assert.notEqual(err.status, 404);
    // The internal cause does not leak to the client.
    assert.doesNotMatch(err.message, /users table unreachable/);
});

test('de resolver geeft een principaal ZONDER gebruiker terug: ook 503', async () => {
    const d = deps({ principals: { [VIEWER]: { userId: null, orgId: null, groupIds: [] } } });
    const err = await refusal(datatableSource.resolveDatatableRead(signedInCtx(), modelTable(), d));
    assert.equal(err.status, 503);
    assert.equal(d.calls.getDatatable, 0);
});

test('de resolver valt om voor de APP-EIGENAAR: ook een weigering, met wie er niet te lezen was', async () => {
    const d = deps({ principals: { [OWNER]: () => { throw new Error('nope'); } } });
    const err = await refusal(datatableSource.resolveDatatableRead(signedInCtx(), modelTable(), d));
    assert.equal(err.status, 503);
    assert.match(err.message, /app owner/i);
});

test('de grants zijn niet te lezen: 503, nooit een gok naar beneden die "geen toegang" heet', async () => {
    const d = deps();
    d.datatableStore.listGrants = async () => { throw new Error('pg down'); };
    const err = await refusal(datatableSource.resolveDatatableRead(signedInCtx(), modelTable(), d));
    assert.equal(err.status, 503);
    assert.match(err.message, /who may read/i);
});

test('de gekoppelde tabel bestaat niet meer: 422, nadrukkelijk geen 404', async () => {
    const d = deps({ table: null });
    const err = await refusal(datatableSource.resolveDatatableRead(signedInCtx(), modelTable(), d));
    assert.equal(err.status, 422);
    assert.notEqual(err.status, 404, 'een 404 degradeert in de runtime-client naar een lege lijst');
    assert.match(err.message, /no longer available/i);
});

test('de tabel zonder kolommen: 422 met een reden', async () => {
    const d = deps({ meta: null, grants: [{ grantee_type: 'user', grantee_id: VIEWER, grade: 'viewer' }] });
    const err = await refusal(datatableSource.resolveDatatableRead(signedInCtx(), modelTable(), d));
    assert.equal(err.status, 422);
    assert.match(err.message, /no columns/i);
});

test('een kapotte koppeling wordt niet stilzwijgend als "eigen opslag" of als read gelezen', async () => {
    const cases = [
        [{ kind: 'datatable', datatableId: DT_ID, mode: 'readWrite' }, 'een typefout in de modus'],
        [{ kind: 'datatable', datatableId: DT_ID }, 'een ontbrekende modus'],
        [{ kind: 'datatable', mode: 'read' }, 'geen tabel gekozen'],
        [{ kind: 'automation', datatableId: DT_ID, mode: 'read' }, 'een onbekende soort'],
        ['tbl_dt00001', 'een string in plaats van een blok'],
    ];
    for (const [source, why] of cases) {
        const d = deps();
        const err = await refusal(datatableSource.resolveDatatableRead(signedInCtx(), modelTable({ source }), d));
        assert.equal(err.status, 422, why);
        assert.equal(d.calls.getDatatable, 0, `${why}: er mag niets opgezocht worden`);
    }
});

// ═══════════════════════════════════════════════════════════════════
// De pure helften
// ═══════════════════════════════════════════════════════════════════

test('isDatatableBacked kent alleen de tweede soort', () => {
    assert.equal(datatableSource.isDatatableBacked({ id: 'tbl_1' }), false);
    assert.equal(datatableSource.isDatatableBacked({ id: 'tbl_1', source: null }), false);
    assert.equal(datatableSource.isDatatableBacked(modelTable()), true);
    // A broken block DOES count as linked: it must be reported, not quietly land on the app database.
    assert.equal(datatableSource.isDatatableBacked({ id: 'tbl_1', source: 'kapot' }), true);
});

test('minGrade is een minimum, en onbekend is geen graad', () => {
    const min = datatableSource._minGrade;
    assert.equal(min('owner', 'viewer'), 'viewer');
    assert.equal(min('viewer', 'owner'), 'viewer');
    assert.equal(min('editor', 'editor'), 'editor');
    assert.equal(min('owner', 'editor'), 'editor');
    for (const bad of [null, undefined, '', 'admin', 'reader']) {
        assert.equal(min(bad, 'owner'), null, `${JSON.stringify(bad)} is geen graad`);
        assert.equal(min('owner', bad), null, `${JSON.stringify(bad)} is geen graad`);
    }
});

test('appRoleGrade leest de rolmapping van de app, niet die van de datatabel', () => {
    const cap = datatableSource._appRoleGrade;
    const t = (access) => ({ id: 'tbl_1', key: 'k', fields: [], access });
    assert.equal(cap(t({ default: 'app', roles: {} }), 'owner'), 'owner');
    assert.equal(cap(t({ default: 'app', roles: {} }), 'medewerker'), 'editor');
    assert.equal(cap(t({ default: 'role', roles: { medewerker: { read: 'all' } } }), 'medewerker'), 'viewer');
    assert.equal(cap(t({ default: 'role', roles: { medewerker: { read: 'all', create: true } } }), 'medewerker'), 'editor');
    // No role = no grade; the MIN turns that into a refusal.
    assert.equal(cap(t({ default: 'app', roles: {} }), null), null);
    assert.equal(cap(t({ default: 'app', roles: {} }), ''), null);
});
