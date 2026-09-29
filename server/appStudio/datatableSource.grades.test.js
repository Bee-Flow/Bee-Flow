/**
 * DE GRAADREKENKUNDE, uitgerekend in plaats van beweerd.
 *
 * Eén tabel: (de eigen graad van de kijker t.o.v. die van de app-eigenaar) ×
 * (de route waarlangs hij binnenkomt) × (de modus van de koppeling) → welke
 * graad geldt er, en wat krijgt hij te zien. Elke cel wordt met een ECHTE
 * aanroep van `resolveDatatableRead` / `resolveDatatableWrite` bepaald; alleen
 * de randen die een database aanraken zijn geïnjecteerd. De graadketen zelf
 * (auth/datatableAccess: gradeForPrincipal, narrowGrade, effectiveGradeForRun)
 * draait onvervangen mee.
 *
 * WAAROM DIT EEN EIGEN BESTAND IS. datatableSource.test.js pint de regels één
 * voor één ("een viewer schrijft niet", "een publieke pagina leest niet"). Dit
 * bestand pint de VOLLEDIGE kruistabel, want de fout die je zoekt zit nooit in
 * een regel maar in een combinatie: de cel waarin de kijker minder mag dan de
 * auteur en er tóch iets doorheen komt. Eén ontbrekende MIN is één cel die de
 * verkeerde kant op valt, en zonder de hele tabel is dat de cel die niemand
 * naloopt.
 *
 * DE VIER REGELS DIE DE TABEL BEWIJST
 *   1. de graad is die van de KIJKER, nooit die van de auteur;
 *   2. effectief = MINIMUM van (kijker, app-eigenaar, app-rol, modus) — nooit
 *      de unie: er komt geen enkele cel uit waarin iemand méér mag dan hij
 *      alléén al mocht;
 *   3. `mode:'read'` capt op viewer, dus schrijven is er een WEIGERING met een
 *      reden en geen stille no-op;
 *   4. onbekend versmalt, maar zegt waarom: geen graad = 403, onleesbare
 *      identiteit = 503, en nooit een lege lijst.
 *
 * Draai: cd server && node --test --test-reporter=tap appStudio/datatableSource.grades.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const datatableSource = require('./datatableSource');

const ORG = 'org-a';
const OWNER = 'u-owner';      // de eigenaar van de APP
const VIEWER = 'u-viewer';    // wie er kijkt
const STRANGER = 'u-stranger'; // de eigenaar van de DATATABEL in sommige rijen
const DT_ID = 'tbl_dt00001';

// ── De wereld ───────────────────────────────────────────────────────

const datatable = (over = {}) => ({
    id: DT_ID,
    scope_kind: 'org',
    scope_id: ORG,
    organization_id: ORG,
    owner_user_id: STRANGER,
    is_published: false,
    shared_groups: [],
    write_mode: 'grants',
    row_scope: 'all',
    ...over,
});

const principal = (userId) => ({
    userId, orgId: ORG, organizationId: ORG, orgRole: 'member', groupIds: [], identityError: null,
});

const META = { id: DT_ID, key: 'dt_klanten', fields: [{ key: 'naam', type: 'text' }] };

/** De MODELtabel. `access.default:'app'` is de RUIMSTE app-rolmapping die
 *  bestaat — de scherpste test voor de caps die eromheen staan. */
const modelTable = (mode) => ({
    id: 'tbl_model01',
    key: 'klanten',
    fields: [{ key: 'naam', type: 'text' }],
    access: { default: 'app', roles: {} },
    source: { kind: 'datatable', datatableId: DT_ID, mode },
});

/** routes/studioAppData.js — ingelogd, `viewerId` is de sessiegebruiker. */
const dataCtx = () => ({
    app: { id: 'app_1', userId: OWNER },
    ownerScope: OWNER,
    viewerId: VIEWER,
    role: 'medewerker',
    viewer: { id: VIEWER, role: 'medewerker', organizationId: ORG },
});

/** routes/studioAppPublic.js — de gereserveerde rol én een anoniem id. */
const publicCtx = () => ({
    app: { id: 'app_1', userId: OWNER },
    ownerScope: OWNER,
    viewerId: 'anon:deadbeefdeadbeef',
    role: 'public',
    viewer: { id: 'anon:deadbeefdeadbeef', role: 'public', organizationId: null },
});

/**
 * De geïnjecteerde randen. `identityFails` maakt van de KIJKER (en alleen van
 * hem) een principaal met `identityError` — de gebruikerslezing viel uit, de
 * app-eigenaar is gewoon leesbaar. Dat onderscheid is precies de cel waarin
 * "onbekend" niet als "niet toegestaan" mag uitkomen.
 */
function deps({ table = datatable(), grants = [], identityFails = null, admins = [] } = {}) {
    const calls = { getDatatable: 0, listGrants: 0 };
    return {
        calls,
        datatableStore: {
            getDatatable: async (id, scope) => {
                calls.getDatatable += 1;
                if (id !== DT_ID || !table) return null;
                return (scope.kind === table.scope_kind && scope.id === table.scope_id) ? table : null;
            },
            listGrants: async () => { calls.listGrants += 1; return grants; },
            getTableMeta: async () => META,
        },
        datatableDbStore: { scopeKey: (scope) => `${scope.kind}:${scope.id}` },
        resolveDatatablePrincipalForUser: async (userId) => {
            const p = principal(userId);
            if (identityFails && userId === identityFails) {
                return { ...p, orgId: null, organizationId: null, orgRole: null, identityError: 'the account could not be read' };
            }
            // Een org-admin is `owner` op elke tabel van zijn organisatie
            // (gradeForPrincipal regel 3). Dat is de enige manier om ÍEMAND
            // owner-graad te geven zonder hem de tabel te laten bezitten — een
            // GRANT met grade 'owner' levert er geen op: gradeForPrincipal
            // vertaalt alleen 'editor' en 'viewer' terug (regel 4), en dat is
            // hier een gegeven, geen bewering.
            if (admins.includes(userId)) return { ...p, orgRole: 'admin' };
            return p;
        },
    };
}

// ── De vier kijkersituaties, als grants uitgedrukt ──────────────────
//
// De datatabel is van een DERDE (`owner_user_id: STRANGER`), zodat beide
// graden uit expliciete grants komen en elke cel apart in te stellen is.

const GRANT = (userId, grade) => ({ grantee_type: 'user', grantee_id: userId, grade });

/** kijker HOGER dan de eigenaar: editor tegenover viewer. */
const VIEWER_ABOVE_OWNER = [GRANT(VIEWER, 'editor'), GRANT(OWNER, 'viewer')];
/** kijker LAGER dan de eigenaar: viewer tegenover owner (de datatabel is van hem). */
const VIEWER_BELOW_OWNER = [GRANT(VIEWER, 'viewer')];
/** allebei hoog genoeg — de controlerij die bewijst dat er wél iets doorkomt. */
const BOTH_EDITOR = [GRANT(VIEWER, 'editor'), GRANT(OWNER, 'editor')];
/** de kijker heeft NIETS; de app-eigenaar bezit de datatabel (owner-graad). */
const VIEWER_NONE = [];

/** De tabel waarin de APP-EIGENAAR de eigenaar van de datatabel is. */
const OWNED_BY_APP_OWNER = datatable({ owner_user_id: OWNER });

async function outcome(promise) {
    try {
        const resolved = await promise;
        return { ok: true, grade: resolved.grade };
    } catch (err) {
        return { ok: false, status: err.status, message: err.message };
    }
}

const read = (ctx, mode, d) => outcome(datatableSource.resolveDatatableRead(ctx, modelTable(mode), d));
const write = (ctx, mode, d) => outcome(datatableSource.resolveDatatableWrite(ctx, modelTable(mode), 'create', d));

// ═══ RIJ 1 — de kijker mag MEER dan de app-eigenaar ═══════════════════════

test('kijker HOGER dan de eigenaar: de graad van de EIGENAAR wint — nooit de unie', async () => {
    for (const mode of ['read', 'readwrite']) {
        const d = deps({ grants: VIEWER_ABOVE_OWNER });
        const r = await read(dataCtx(), mode, d);
        assert.deepEqual(r, { ok: true, grade: 'viewer' },
            `${mode}: MIN(editor, viewer) is viewer; een unie zou hier editor opleveren`);
    }
});

test('kijker HOGER dan de eigenaar: schrijven wordt geweigerd, met verschillende redenen', async () => {
    // read → de MODUS weigert (vóór de opzoeking); readwrite → de GRAAD weigert.
    // Twee sloten, twee boodschappen: de auteur moet weten welke van de twee.
    const onRead = await write(dataCtx(), 'read', deps({ grants: VIEWER_ABOVE_OWNER }));
    assert.equal(onRead.ok, false);
    assert.equal(onRead.status, 403);
    assert.match(onRead.message, /reading only/);

    const onRw = await write(dataCtx(), 'readwrite', deps({ grants: VIEWER_ABOVE_OWNER }));
    assert.equal(onRw.ok, false);
    assert.equal(onRw.status, 403);
    assert.match(onRw.message, /do not have permission to change rows/);
});

// ═══ RIJ 2 — de kijker mag MINDER dan de app-eigenaar ═════════════════════

test('kijker LAGER dan de eigenaar: zijn eigen graad geldt, niet die van de auteur', async () => {
    for (const mode of ['read', 'readwrite']) {
        const d = deps({ table: OWNED_BY_APP_OWNER, grants: VIEWER_BELOW_OWNER });
        const r = await read(dataCtx(), mode, d);
        assert.deepEqual(r, { ok: true, grade: 'viewer' },
            `${mode}: de eigenaar is owner van de tabel; zonder regel 1 zou dat hier owner opleveren`);
    }
});

test('kijker LAGER dan de eigenaar: schrijven blijft dicht, ook op readwrite', async () => {
    const r = await write(dataCtx(), 'readwrite', deps({ table: OWNED_BY_APP_OWNER, grants: VIEWER_BELOW_OWNER }));
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.match(r.message, /do not have permission to change rows/);
});

// ═══ RIJ 3 — de controlerij: er komt wél iets doorheen ════════════════════

test('allebei editor: readwrite laat een SCHRIJVING toe, read niet', async () => {
    const rw = await write(dataCtx(), 'readwrite', deps({ grants: BOTH_EDITOR }));
    assert.deepEqual(rw, { ok: true, grade: 'editor' });

    // Dezelfde twee mensen, dezelfde grants — alleen de modus verschilt.
    const ro = await write(dataCtx(), 'read', deps({ grants: BOTH_EDITOR }));
    assert.equal(ro.ok, false);
    assert.match(ro.message, /reading only/);

    // En lezen op een read-koppeling capt de graad op viewer, ook al is de
    // laagste van de twee mensen editor.
    const readRo = await read(dataCtx(), 'read', deps({ grants: BOTH_EDITOR }));
    assert.deepEqual(readRo, { ok: true, grade: 'viewer' });
    const readRw = await read(dataCtx(), 'readwrite', deps({ grants: BOTH_EDITOR }));
    assert.deepEqual(readRw, { ok: true, grade: 'editor' });
});

// ═══ RIJ 4 — de kijker heeft GEEN graad ══════════════════════════════════

test('geen graad: 403 met een reden, nooit een lege lijst', async () => {
    for (const mode of ['read', 'readwrite']) {
        const r = await read(dataCtx(), mode, deps({ table: OWNED_BY_APP_OWNER, grants: VIEWER_NONE }));
        assert.equal(r.ok, false, `${mode}: een kijker zonder grade leest niet`);
        assert.equal(r.status, 403);
        assert.match(r.message, /do not have access to the Studio table/);

        const w = await write(dataCtx(), mode, deps({ table: OWNED_BY_APP_OWNER, grants: VIEWER_NONE }));
        assert.equal(w.ok, false);
        assert.equal(w.status, 403);
    }
});

// ═══ RIJ 5 — de identiteit van de KIJKER is onleesbaar ═══════════════════

test('onleesbare identiteit van de kijker: 503, niet 403 — onbekend is geen weigering', async () => {
    // De app-eigenaar is gewoon leesbaar; alleen de kijker niet. Zonder dit
    // onderscheid leest de weigering als een beleidskeuze ("je hoort er niet
    // bij") terwijl in werkelijkheid niemand het kon nagaan.
    for (const mode of ['read', 'readwrite']) {
        const d = deps({ table: OWNED_BY_APP_OWNER, grants: BOTH_EDITOR, identityFails: VIEWER });
        const r = await read(dataCtx(), mode, d);
        assert.equal(r.ok, false);
        assert.equal(r.status, 503, `${mode}: een storing is geen 403`);
        assert.match(r.message, /Could not check who you are/);
        assert.equal(d.calls.getDatatable, 0, 'er wordt niets opgezocht met een onbekende identiteit');
    }
});

test('onleesbare identiteit van de kijker: schrijven geeft dezelfde 503, ook op readwrite', async () => {
    const d = deps({ table: OWNED_BY_APP_OWNER, grants: BOTH_EDITOR, identityFails: VIEWER });
    const r = await write(dataCtx(), 'readwrite', d);
    assert.equal(r.ok, false);
    assert.equal(r.status, 503);
    assert.match(r.message, /Could not check who you are/);
});

test('onleesbare identiteit van de APP-EIGENAAR is een andere 503, met een andere zin', async () => {
    const d = deps({ table: OWNED_BY_APP_OWNER, grants: BOTH_EDITOR, identityFails: OWNER });
    const r = await read(dataCtx(), 'readwrite', d);
    assert.equal(r.ok, false);
    assert.equal(r.status, 503);
    assert.match(r.message, /Could not check who the app owner is/);
});

// ═══ DE PUBLIEKE KOLOM — alle vijf de rijen, altijd 403 ══════════════════

test('routes/studioAppPublic: elke kijkersituatie × elke modus is 403, vóór enige opzoeking', async () => {
    const situations = [
        ['kijker hoger', datatable(), VIEWER_ABOVE_OWNER, null],
        ['kijker lager', OWNED_BY_APP_OWNER, VIEWER_BELOW_OWNER, null],
        ['allebei editor', datatable(), BOTH_EDITOR, null],
        ['geen graad', OWNED_BY_APP_OWNER, VIEWER_NONE, null],
        ['identiteit onleesbaar', OWNED_BY_APP_OWNER, BOTH_EDITOR, VIEWER],
    ];
    for (const [what, table, grants, identityFails] of situations) {
        for (const mode of ['read', 'readwrite']) {
            const dRead = deps({ table, grants, identityFails });
            const r = await read(publicCtx(), mode, dRead);
            assert.equal(r.ok, false, `${what}/${mode}: een publieke pagina leest geen gekoppelde tabel`);
            assert.equal(r.status, 403);
            assert.match(r.message, /A public page cannot read a linked Studio table/);
            assert.equal(dRead.calls.getDatatable, 0, `${what}/${mode}: er wordt niets opgezocht`);
            assert.equal(dRead.calls.listGrants, 0, `${what}/${mode}: er worden geen grants gelezen`);

            const dWrite = deps({ table, grants, identityFails });
            const w = await write(publicCtx(), mode, dWrite);
            assert.equal(w.ok, false, `${what}/${mode}: en schrijft er al helemaal niet in`);
            assert.equal(w.status, 403);
            // Op een read-koppeling valt de MODUS eerst; op readwrite de
            // publieke poort. Allebei zeggen wat er aan de hand is.
            assert.match(w.message, mode === 'read' ? /reading only/ : /A public page cannot change rows in a linked Studio table/);
            assert.equal(dWrite.calls.getDatatable, 0);
        }
    }
});

test('een anoniem bezoekers-id onder een GEWONE rol blijft anoniem', async () => {
    // Twee onafhankelijke poorten: de gereserveerde rol, en het id. Een
    // toekomstige publieke route die er maar één zet loopt niet stil door.
    const ctx = { ...publicCtx(), role: 'medewerker', viewer: { id: 'anon:deadbeefdeadbeef', role: 'medewerker', organizationId: null } };
    const d = deps({ grants: BOTH_EDITOR });
    const r = await read(ctx, 'readwrite', d);
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.match(r.message, /needs a signed-in account/);
    assert.equal(d.calls.getDatatable, 0);
});

// ═══ DE APP-ROL IS DE DERDE MIN ═════════════════════════════════════════

test('de app-rol versmalt óók: een leesrol krijgt viewer, ook bij twee editors', async () => {
    const readOnlyRole = {
        ...modelTable('readwrite'),
        access: { default: 'none', roles: { reader: { read: 'all', create: false, update: 'none', delete: 'none' } } },
    };
    const ctx = { ...dataCtx(), role: 'reader', viewer: { id: VIEWER, role: 'reader', organizationId: ORG } };
    const r = await outcome(datatableSource.resolveDatatableRead(ctx, readOnlyRole, deps({ grants: BOTH_EDITOR })));
    assert.deepEqual(r, { ok: true, grade: 'viewer' });

    const w = await outcome(datatableSource.resolveDatatableWrite(ctx, readOnlyRole, 'create', deps({ grants: BOTH_EDITOR })));
    assert.equal(w.ok, false);
    assert.equal(w.status, 403);
});

test('een rol die nergens in de mapping valt komt er niet door', async () => {
    const strictRole = {
        ...modelTable('readwrite'),
        access: { default: 'none', roles: {} },
    };
    const ctx = { ...dataCtx(), role: null, viewer: { id: VIEWER, role: null, organizationId: ORG } };
    const r = await outcome(datatableSource.resolveDatatableRead(ctx, strictRole, deps({ grants: BOTH_EDITOR })));
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.match(r.message, /may not read the Studio table behind it/);
});

// ═══ ER IS NERGENS EEN UNIE ═════════════════════════════════════════════

test('geen enkele cel levert méér op dan de kleinste van de twee mensen', async () => {
    // De systematische versie van rij 1 en 2: alle negen combinaties van
    // (kijkersgraad × eigenaarsgraad) op een readwrite-koppeling met de ruimste
    // app-rol. De uitkomst moet ALTIJD de laagste van de twee zijn.
    const order = { viewer: 0, editor: 1, owner: 2 };
    const min = (...gs) => gs.reduce((lo, g) => (order[g] < order[lo] ? g : lo));
    const world = (who, grade) => (grade === 'owner'
        ? { admins: [who], grants: [] }
        : { admins: [], grants: [GRANT(who, grade)] });
    // De DERDE MIN rijdt mee: een gewone app-rol met schrijfrecht capt op
    // 'editor' (appRoleGrade), alleen de app-rol 'owner' laat de ladder
    // helemaal door. Beide worden gedraaid, zodat de cap zichtbaar is in het
    // verschil tussen de twee kolommen en niet stilzwijgend in de verwachting.
    for (const [appRole, roleCap] of [['medewerker', 'editor'], ['owner', 'owner']]) {
        const ctx = { ...dataCtx(), role: appRole, viewer: { id: VIEWER, role: appRole, organizationId: ORG } };
        for (const a of ['viewer', 'editor', 'owner']) {
            for (const b of ['viewer', 'editor', 'owner']) {
                const wa = world(VIEWER, a);
                const wb = world(OWNER, b);
                const d = deps({ grants: [...wa.grants, ...wb.grants], admins: [...wa.admins, ...wb.admins] });
                const r = await read(ctx, 'readwrite', d);
                const expected = min(a, b, roleCap);
                assert.deepEqual(r, { ok: true, grade: expected },
                    `app-rol ${appRole}: kijker ${a} × eigenaar ${b} hoort ${expected} te zijn`);
            }
        }
    }
});

test('en op een read-koppeling is elke cel viewer — de vierde MIN', async () => {
    const order = { viewer: 0, editor: 1, owner: 2 };
    const world = (who, grade) => (grade === 'owner'
        ? { admins: [who], grants: [] }
        : { admins: [], grants: [GRANT(who, grade)] });
    const ctx = { ...dataCtx(), role: 'owner', viewer: { id: VIEWER, role: 'owner', organizationId: ORG } };
    for (const a of ['viewer', 'editor', 'owner']) {
        for (const b of ['viewer', 'editor', 'owner']) {
            const wa = world(VIEWER, a);
            const wb = world(OWNER, b);
            const d = deps({ grants: [...wa.grants, ...wb.grants], admins: [...wa.admins, ...wb.admins] });
            const r = await read(ctx, 'read', d);
            assert.deepEqual(r, { ok: true, grade: 'viewer' },
                `kijker ${a} × eigenaar ${b}: een read-koppeling capt op viewer, ${order[a]}/${order[b]} of niet`);
        }
    }
});

// ═══ DE RIJREGEL VAN DE APP-ROL ═══════════════════════════════════════════
//
// Tot 2026-09-16 werd `access.rowFilters` van de MODELtabel voor een
// GEKOPPELDE datatabel in zijn geheel weggegooid: het access-blok werd
// vervangen door dat van de datatabel. Een rol "alleen leverancier X" bewaarde
// en valideerde prima en filterde niets — het stilste soort autorisatiefout.

/** Een modeltabel met een rijregel voor één app-rol. */
const modelTableWithRule = (mode, role, expr) => ({
    ...modelTable(mode),
    access: { default: 'app', roles: {}, rowFilters: { [role]: expr } },
});

const resolveWith = async (table, ctx, d) => {
    try { return { ok: true, resolved: await datatableSource.resolveDatatableRead(ctx, table, d) }; } catch (e) { return { ok: false, status: e.status }; }
};

test('de rijregel van de app-rol komt mee, onder de GRAAD waar de compiler hem zoekt', async () => {
    const d = deps({ grants: [GRANT(VIEWER, 'viewer'), GRANT(OWNER, 'editor')] });
    const table = modelTableWithRule('read', 'medewerker', 'record.naam == "ACME"');
    const r = await resolveWith(table, dataCtx(), d);
    assert.equal(r.ok, true);
    assert.equal(r.resolved.grade, 'viewer');
    // De sleutel is de graad, want `viewer.role` is hier de graad.
    assert.deepEqual(r.resolved.tableMeta.access.rowFilters, { viewer: 'record.naam == "ACME"' });
    assert.equal(r.resolved.viewer.role, 'viewer');
});

test('zonder rijregel verandert er NIETS aan het access-blok — de regressie die telt', async () => {
    const d = deps({ grants: [GRANT(VIEWER, 'viewer'), GRANT(OWNER, 'editor')] });
    const r = await resolveWith(modelTable('read'), dataCtx(), d);
    assert.equal(r.ok, true);
    assert.equal('rowFilters' in r.resolved.tableMeta.access, false,
        'een tabel zonder regel krijgt geen lege rowFilters erbij');
});

test('een rijregel voor een ANDERE rol raakt deze kijker niet', async () => {
    const d = deps({ grants: [GRANT(VIEWER, 'viewer'), GRANT(OWNER, 'editor')] });
    const table = modelTableWithRule('read', 'iemand_anders', 'record.naam == "ACME"');
    const r = await resolveWith(table, dataCtx(), d);
    assert.equal(r.ok, true);
    assert.equal('rowFilters' in r.resolved.tableMeta.access, false);
});

test('de app-rol `owner` krijgt geen regel; dezelfde persoon ONDER een beperkte rol wel', async () => {
    // "Bekijk als" is geen doen-alsof: wie de app als een beperkte rol bekijkt
    // hoort te zien wat die rol ziet, ook als hij de tabel bezit.
    const d = deps({ table: OWNED_BY_APP_OWNER, grants: [] });
    const asOwner = { ...dataCtx(), viewerId: OWNER, role: 'owner', viewer: { id: OWNER, role: 'owner', organizationId: ORG } };
    const ownerRun = await resolveWith(modelTableWithRule('readwrite', 'owner', 'record.naam == "ACME"'), asOwner, d);
    assert.equal(ownerRun.ok, true);
    assert.equal(ownerRun.resolved.grade, 'owner');
    assert.equal('rowFilters' in ownerRun.resolved.tableMeta.access, false,
        'de rol owner slaat rijfilters over — anders sluit een regel de eigenaar uit zijn eigen tabel');

    const asMember = { ...dataCtx(), viewerId: OWNER, viewer: { id: OWNER, role: 'medewerker', organizationId: ORG } };
    const memberRun = await resolveWith(modelTableWithRule('readwrite', 'medewerker', 'record.naam == "ACME"'), asMember, deps({ table: OWNED_BY_APP_OWNER, grants: [] }));
    assert.equal(memberRun.ok, true);
    assert.equal(memberRun.resolved.grade, 'editor', 'de app-rol capt de eigenaarsgraad op editor');
    assert.deepEqual(memberRun.resolved.tableMeta.access.rowFilters, { editor: 'record.naam == "ACME"' });
});

test('een lege of onzinnige regel is geen regel', async () => {
    const d = deps({ grants: [GRANT(VIEWER, 'viewer'), GRANT(OWNER, 'editor')] });
    for (const expr of ['', '   ', null, 42, [] ]) {
        const r = await resolveWith(modelTableWithRule('read', 'medewerker', expr), dataCtx(), d);
        assert.equal(r.ok, true);
        assert.equal('rowFilters' in r.resolved.tableMeta.access, false, `${JSON.stringify(expr)} is geen regel`);
    }
});
