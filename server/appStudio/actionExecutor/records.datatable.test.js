/**
 * create_record / update_record / delete_record op een modeltabel die haar rijen
 * uit een STUDIO-DATATABEL haalt (`model.tables[].source`).
 *
 * De rechtenbeslissing zelf staat in appStudio/datatableSource.js en wordt daar
 * getest; hier gaat het om het SCHRIJFpad eromheen — dezelfde module, andere
 * ingang. Wat gepind wordt:
 *
 *   • elk van de drie acties, op een read- én op een readwrite-koppeling;
 *   • `mode:'read'` weigert HARDOP: niets geschreven én de stap zegt het. Een
 *     stille no-op zou ok:true teruggeven en de gebruiker een rij laten zoeken
 *     die nooit is aangemaakt;
 *   • een kijker die minder mag dan de eigenaar — langs alle vier de MINs
 *     (eigen graad, graad van de eigenaar, app-rol, mode);
 *   • een publieke app schrijft nooit met de graad van de auteur;
 *   • de rijen gaan naar `datatableDbStore` op de scope-sleutel, NOOIT naar
 *     `studioAppDbStore`, met de Postgres-dialect en de quota van de TENANT.
 *
 * De graadketen draait onvervangen mee: alleen de randen die een database
 * aanraken zijn gestubd, en de graden komen uit echte grants.
 *
 * Draaien: cd server && node --test --test-reporter=tap appStudio/actionExecutor/records.datatable.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const ORG = 'org-a';
const OWNER = 'u-owner';
const MEMBER = 'u-member';
const DT_ID = 'tbl_dt00001';

// ── De randen, vóór de eerste require van de executor ──────────────────────
// Node cachet op absoluut pad; deze bestanden slepen anders de pg-pool binnen.

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// De `datatables`-rij zoals stores/datatableStore.rowToDatatable hem geeft:
// camelCase voor de wereld, snake_case voor auth/datatableAccess. Een mismatch
// dáár faalt open-uitziend (undefined !== undefined is false), dus de stub
// bootst allebei na.
let dtRow = null;
function datatable(over = {}) {
    const o = {
        ownerUserId: OWNER, organizationId: ORG, isPublished: false,
        sharedGroups: [], writeMode: 'grants', rowScope: 'all', ...over,
    };
    return {
        id: DT_ID, key: 'dt_klanten', name: 'Klanten',
        scope: { kind: 'org', id: ORG }, scopeKind: 'org',
        scope_kind: 'org', scope_id: ORG,
        rowCount: 3,
        ...o,
        organization_id: o.organizationId,
        owner_user_id: o.ownerUserId,
        is_published: o.isPublished,
        shared_groups: o.sharedGroups,
        write_mode: o.writeMode,
        row_scope: o.rowScope,
    };
}

// De FYSIEKE naam van de datatabel wijkt af van de modeltabelnaam — dat is wat
// bewijst in welke tabel er geschreven wordt.
const DT_META = {
    id: DT_ID, key: 'dt_klanten',
    fields: [
        { id: 'f1', key: 'naam', type: 'text' },
        { id: 'f2', key: 'akkoord', type: 'bool' },
    ],
};

let grants = [];
const bumps = [];
let storeFails = null;
stub('../../stores/datatableStore', {
    orgScope: (id) => ({ kind: 'org', id }),
    userScope: (id) => ({ kind: 'user', id }),
    getDatatable: async (id, scope) => {
        if (storeFails === 'getDatatable') throw new Error('pg down');
        if (id !== DT_ID || !dtRow) return null;
        return (scope.kind === 'org' && scope.id === ORG) ? dtRow : null;
    },
    listGrants: async () => grants,
    getTableMeta: async () => DT_META,
    scopeUsage: async () => ({ tables: 1, rows: 3, bytes: 1024 }),
    bumpAfterWrite: async (id, scope, delta) => { bumps.push({ id, scope, delta }); },
});

const dtExec = [];
const dtBatch = [];
let dtExecResult = { changes: 1 };
stub('../../stores/datatableDbStore', {
    scopeKey: (scope) => `${scope.kind}:${scope.id}`,
    exec: async (ownerId, entityId, sql, params) => {
        dtExec.push({ ownerId, entityId, sql, params });
        return dtExecResult;
    },
    batch: async (ownerId, entityId, statements) => {
        dtBatch.push({ ownerId, entityId, statements });
        return { changes: statements.length };
    },
});

// `null` = iedereen leesbaar; een user-id = ALLEEN die ene niet. Dat
// onderscheid is de hele test hieronder: viel de lezing voor iedereen om, dan
// mist ook de app-eigenaar zijn org en komt er een heel andere weigering uit.
let userReadFails = null;
stub('../../stores/userStore', {
    getUser: async (id) => {
        if (userReadFails === 'all' || userReadFails === id) throw new Error('users unavailable');
        return { id, organizationId: ORG, orgRole: 'member', groups: [] };
    },
    getAllGroups: async () => [],
});
stub('../../auth/audience', {
    resolveAudienceContext: async () => ({ orgIds: new Set([ORG]), userGroups: [] }),
    canSeePublished: () => false,
    resolveUserGroups: async () => [],
});
stub('../../stores/projectStore', {});

// De app-eigen opslag, die op dit pad juist NIET geraakt mag worden.
const appExec = [];
stub('../../stores/studioAppDbStore', {
    exec: async (ownerId, appId, sql, params) => { appExec.push({ ownerId, appId, sql, params }); return { changes: 1 }; },
    sizeBytes: async () => 0,
});
const appBumps = [];
stub('../../stores/studioAppDataStore', {
    bumpDataVersion: async (...a) => { appBumps.push(a); return 1; },
    bumpRowCount: async (...a) => { appBumps.push(a); return {}; },
    getRowCounts: async () => ({}),
    getMemberRole: async () => null,
});

const actionExecutor = require('../actionExecutor');
const { PUBLIC_ROLE_KEY } = require('../dataModel');
const { ANON_VIEWER_PREFIX } = require('../publicAccess');

// ── De app en haar model ──────────────────────────────────────────────────

const app = { id: 'app-1', userId: OWNER, organizationId: ORG };

// De MODELtabel: haar eigen naam ('klanten'), haar eigen access-blok, en de
// `source` die naar de datatabel wijst.
function model(mode = 'readwrite', access = { default: 'app', roles: {}, rowFilters: {} }) {
    return {
        modelVersion: 1,
        tables: [{
            id: 'tbl_model01', key: 'klanten', name: 'Klanten',
            source: { kind: 'datatable', datatableId: DT_ID, mode },
            fields: DT_META.fields,
            access,
        }],
    };
}

const ctxFor = (id, role) => ({
    viewerId: id, role,
    viewer: { id, role, organizationId: ORG },
    formValues: {}, vars: {},
});
const ownerCtx = () => ctxFor(OWNER, 'owner');
const memberCtx = (role = 'staff') => ctxFor(MEMBER, role);
const anonCtx = () => ({
    viewerId: `${ANON_VIEWER_PREFIX}deadbeef`, role: PUBLIC_ROLE_KEY,
    viewer: { id: `${ANON_VIEWER_PREFIX}deadbeef`, role: PUBLIC_ROLE_KEY, organizationId: null },
    formValues: {}, vars: {},
});

const createStep = () => ({
    kind: 'create_record', tableId: 'tbl_model01',
    values: { naam: { kind: 'static', value: 'Acme' }, akkoord: { kind: 'static', value: true } },
});
const updateStep = () => ({
    kind: 'update_record', tableId: 'tbl_model01',
    recordId: { kind: 'static', value: 'rec_1' },
    values: { naam: { kind: 'static', value: 'Acme BV' } },
});
const deleteStep = () => ({
    kind: 'delete_record', tableId: 'tbl_model01',
    recordId: { kind: 'static', value: 'rec_1' },
});
const ALL_STEPS = () => [createStep(), updateStep(), deleteStep()];

function reset({ table = datatable(), granted = [] } = {}) {
    dtRow = table;
    grants = granted;
    dtExec.length = 0; dtBatch.length = 0; appExec.length = 0; bumps.length = 0; appBumps.length = 0;
    dtExecResult = { changes: 1 };
    storeFails = null;
    userReadFails = null;
}

const run = (step, ctx, mode = 'readwrite', access) =>
    actionExecutor.executeDataStep(app, model(mode, access), step, ctx);

// De eigenaar is owner van de datatabel (regel 2 van gradeForPrincipal); het lid
// heeft een expliciete editor-grant. Dat is de gewone, werkende opstelling.
const EDITOR_GRANT = [{ grantee_type: 'user', grantee_id: MEMBER, grade: 'editor' }];
const VIEWER_GRANT = [{ grantee_type: 'user', grantee_id: MEMBER, grade: 'viewer' }];

// ═══ readwrite: de drie acties doen hun werk, op de juiste opslag ═════════

test('create_record schrijft naar de DATATABEL, niet naar de app-opslag', async () => {
    reset();
    const res = await run(createStep(), ownerCtx());
    assert.strictEqual(res.ok, true, res.error);
    assert.strictEqual(res.result.created, true);
    assert.match(res.result.id, /^rec_/);

    assert.strictEqual(appExec.length, 0, 'studioAppDbStore mag hier nooit geraakt worden');
    assert.strictEqual(dtExec.length, 1);
    const call = dtExec[0];
    // De tenant is de SCOPE-sleutel, aan beide kanten — nooit app.userId/app.id.
    assert.strictEqual(call.ownerId, `org:${ORG}`);
    assert.strictEqual(call.entityId, `org:${ORG}`);
    // De FYSIEKE tabelnaam van de datatabel, niet die van de modeltabel.
    assert.match(call.sql, /^INSERT INTO "dt_klanten"/);
    // created_by = de KIJKER; org_id = de org van de TABEL.
    assert.strictEqual(call.params[3], OWNER);
    assert.strictEqual(call.params[4], ORG);
    // Dialect pg: een boolean blijft een boolean (sqlite zou er 1 van maken).
    assert.strictEqual(call.params[call.params.length - 1], true);
    // Rijteller + data-versie van de DATATABEL, niet die van de app.
    assert.deepStrictEqual(bumps, [{ id: DT_ID, scope: { kind: 'org', id: ORG }, delta: 1 }]);
    assert.strictEqual(appBumps.length, 0);
});

test('update_record schrijft naar de datatabel en meldt het aantal rijen', async () => {
    reset();
    const res = await run(updateStep(), ownerCtx());
    assert.strictEqual(res.ok, true, res.error);
    assert.deepStrictEqual(res.result, { id: 'rec_1', updated: true, changes: 1 });
    assert.strictEqual(appExec.length, 0);
    assert.match(dtExec[0].sql, /^UPDATE "dt_klanten" SET/);
    assert.match(dtExec[0].sql, /WHERE "id" = \? AND \(1=1\)/);
    // Een update verandert het rijaantal niet, maar wel de data-versie.
    assert.deepStrictEqual(bumps, [{ id: DT_ID, scope: { kind: 'org', id: ORG }, delta: 0 }]);
});

test('delete_record verwijdert uit de datatabel en telt de rij af', async () => {
    reset();
    const res = await run(deleteStep(), ownerCtx());
    assert.strictEqual(res.ok, true, res.error);
    assert.deepStrictEqual(res.result, { id: 'rec_1', deleted: true, changes: 1 });
    assert.strictEqual(appExec.length, 0);
    assert.match(dtExec[0].sql, /^DELETE FROM "dt_klanten" WHERE "id" = \?/);
    assert.deepStrictEqual(bumps, [{ id: DT_ID, scope: { kind: 'org', id: ORG }, delta: -1 }]);
});

test('create_record stempelt de KIJKER als maker, niet de app-eigenaar', async () => {
    // created_by is het auditveld én de kolom waarop `row_scope:'own'` filtert.
    // Stond de eigenaar erin, dan zag een lid zijn eigen zojuist gemaakte rij
    // meteen niet meer terug.
    reset({ granted: EDITOR_GRANT });
    const res = await run(createStep(), memberCtx());
    assert.strictEqual(res.ok, true, res.error);
    assert.strictEqual(dtExec[0].params[3], MEMBER);
    assert.strictEqual(dtExec[0].params[3] === OWNER, false);
});

test('een lid met een editor-grant mag alle drie de acties', async () => {
    for (const step of ALL_STEPS()) {
        reset({ granted: EDITOR_GRANT });
        const res = await run(step, memberCtx());
        assert.strictEqual(res.ok, true, `${step.kind}: ${res.error}`);
        assert.strictEqual(dtExec.length, 1);
    }
});

test('nul gewijzigde rijen is "niet gevonden", nooit een stil succes', async () => {
    for (const step of [updateStep(), deleteStep()]) {
        reset();
        dtExecResult = { changes: 0 };
        const res = await run(step, ownerCtx());
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.error, 'Record not found');
        assert.deepStrictEqual(bumps, [], 'niets gewijzigd = niets te boeken');
    }
});

test('een compare-and-set die niets raakt heet een conflict, geen 404', async () => {
    reset();
    dtExecResult = { changes: 0 };
    const res = await run({ ...updateStep(), expectedUpdatedAt: { kind: 'static', value: '2026-09-01T10:00:00.000Z' } }, ownerCtx());
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'record_conflict');
});

// ═══ read: de drie acties zijn een WEIGERING, geen stille no-op ═══════════

test('mode:read weigert elk van de drie schrijfacties, hardop', async () => {
    for (const step of ALL_STEPS()) {
        reset();
        const res = await run(step, ownerCtx(), 'read');
        assert.strictEqual(res.ok, false, `${step.kind} had geweigerd moeten worden`);
        assert.match(res.error, /reading only/);
        // De kern: er is niets geschreven, EN de stap zegt dat ook. Een stille
        // no-op zou ok:true teruggeven en de gebruiker een rij laten zoeken die
        // nooit is aangemaakt.
        assert.strictEqual(dtExec.length, 0);
        assert.strictEqual(appExec.length, 0);
        assert.deepStrictEqual(bumps, []);
    }
});

test('mode:read weigert vóór de lookup — het antwoord hangt niet aan de tabel', async () => {
    // De tabel is weg; de weigering blijft "alleen-lezen gekoppeld" en wordt
    // geen storing. Een weigering die pas ná het zoeken valt, kan dat wel.
    reset({ table: null });
    const res = await run(createStep(), ownerCtx(), 'read');
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /reading only/);
});

test('mode:read weigert ook een lid met een editor-grant', async () => {
    reset({ granted: EDITOR_GRANT });
    for (const step of ALL_STEPS()) {
        dtExec.length = 0;
        const res = await run(step, memberCtx(), 'read');
        assert.strictEqual(res.ok, false, `${step.kind} had geweigerd moeten worden`);
        assert.match(res.error, /reading only/);
        assert.strictEqual(dtExec.length, 0);
    }
});

// ═══ een kijker die minder mag dan de eigenaar ════════════════════════════

test('een kijker met viewer-graad schrijft niet, ook al is de eigenaar owner', async () => {
    // MIN(viewer, owner) = viewer, en viewer schrijft niet. Dit is het geval
    // waarin de app anders het uitgiftepunt van de rechten van zijn maker zou
    // zijn.
    reset({ granted: VIEWER_GRANT });
    for (const step of ALL_STEPS()) {
        dtExec.length = 0;
        const res = await run(step, memberCtx());
        assert.strictEqual(res.ok, false, `${step.kind} had geweigerd moeten worden`);
        assert.match(res.error, /permission/i);
        assert.strictEqual(dtExec.length, 0);
    }
});

test('een kijker zonder enige graad op de datatabel krijgt een weigering, geen leeg antwoord', async () => {
    reset();  // geen grants, tabel niet gepubliceerd
    const res = await run(createStep(), memberCtx());
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /do not have access/i);
    assert.strictEqual(dtExec.length, 0);
});

test('een eigenaar die zijn eigen graad kwijt is, deelt niets meer uit', async () => {
    // De datatabel is van iemand anders geworden en de eigenaar heeft geen
    // grant meer; het lid wél. De MIN met de eigenaar houdt de deur dicht.
    reset({
        table: datatable({ ownerUserId: 'u-stranger' }),
        granted: EDITOR_GRANT,
    });
    const res = await run(createStep(), memberCtx());
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /app owner no longer has access/i);
    assert.strictEqual(dtExec.length, 0);
});

test('het app-`access`-blok versmalt óók — een leesrol schrijft niet', async () => {
    // De datatabel zou het toestaan (editor-grant), maar de auteur gaf deze
    // app-rol geen schrijfrecht: appRoleGrade capt dan op viewer.
    const readOnlyRole = {
        default: 'none',
        roles: { reader: { read: 'all', create: false, update: 'none', delete: 'none' } },
        rowFilters: {},
    };
    for (const step of ALL_STEPS()) {
        reset({ granted: EDITOR_GRANT });
        const res = await run(step, ctxFor(MEMBER, 'reader'), 'readwrite', readOnlyRole);
        assert.strictEqual(res.ok, false, `${step.kind} had geweigerd moeten worden`);
        assert.match(res.error, /permission/i);
        assert.strictEqual(dtExec.length, 0);
    }
});

test('het app-`access`-blok wordt PER ACTIE bevraagd, niet als één bovengrens', async () => {
    // Deze rol mag toevoegen en wijzigen, maar niet verwijderen. appRoleGrade
    // vouwt dat tot 'editor'; assertCanWrite stelt de vraag alsnog per actie.
    const noDelete = {
        default: 'none',
        roles: { agent: { read: 'all', create: true, update: 'all', delete: 'none' } },
        rowFilters: {},
    };
    reset({ granted: EDITOR_GRANT });
    const created = await run(createStep(), ctxFor(MEMBER, 'agent'), 'readwrite', noDelete);
    assert.strictEqual(created.ok, true, created.error);

    reset({ granted: EDITOR_GRANT });
    const deleted = await run(deleteStep(), ctxFor(MEMBER, 'agent'), 'readwrite', noDelete);
    assert.strictEqual(deleted.ok, false, 'verwijderen mocht deze rol niet');
    assert.match(deleted.error, /permission/i);
    assert.strictEqual(dtExec.length, 0);
});

test('row_scope:own bindt de rijfilter aan de KIJKER, niet aan de eigenaar', async () => {
    // synthesizeAccess geeft editor dan update:'own' → compileAccessFilter zet
    // `created_by = ?` met de kijker erin.
    reset({ table: datatable({ rowScope: 'own' }), granted: EDITOR_GRANT });
    const res = await run(updateStep(), memberCtx());
    assert.strictEqual(res.ok, true, res.error);
    assert.match(dtExec[0].sql, /"created_by" = \?/);
    assert.ok(dtExec[0].params.includes(MEMBER), 'het rijfilter bindt de kijker');
    assert.strictEqual(dtExec[0].params.includes(OWNER), false);
});

// ═══ een publieke app schrijft nooit met de graad van de auteur ═══════════

test('een anonieme bezoeker schrijft niet in een Studio-tabel', async () => {
    reset();
    for (const step of ALL_STEPS()) {
        dtExec.length = 0;
        const res = await run(step, anonCtx());
        assert.strictEqual(res.ok, false, `${step.kind} had geweigerd moeten worden`);
        assert.match(res.error, /public page/i);
        assert.strictEqual(dtExec.length, 0, 'de tabel wordt niet eens opgezocht');
    }
});

test('ook een bezoeker-id onder een gewone rol blijft anoniem', async () => {
    // Twee onafhankelijke sloten: de gereserveerde rol, en het bezoekers-id.
    reset();
    const res = await run(createStep(), { ...anonCtx(), role: 'staff', viewer: { id: `${ANON_VIEWER_PREFIX}deadbeef`, role: 'staff', organizationId: null } });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /signed-in account/i);
    assert.strictEqual(dtExec.length, 0);
});

// ═══ storingen en kapotte koppelingen ════════════════════════════════════

test('een verdwenen datatabel is een gemelde weigering, geen leeg succes', async () => {
    reset({ table: null });
    const res = await run(createStep(), ownerCtx());
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /no longer available/i);
    assert.strictEqual(dtExec.length, 0);
});

test('een onbereikbare store is een storing, geen weigering-in-vermomming', async () => {
    reset();
    storeFails = 'getDatatable';
    const res = await run(createStep(), ownerCtx());
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /Could not reach/i);
    // De oorzaak blijft binnen: een `safe`-boodschap gaat letterlijk naar de
    // client, en 'pg down' hoort niet aan die kant van de lijn.
    assert.strictEqual(/pg down/.test(res.error), false);
});

test('een onleesbare identiteit van de KIJKER is een storing, geen weigering', async () => {
    // De eigenaar is prima leesbaar, het lid heeft een editor-grant — alleen de
    // gebruikerslezing van de KIJKER valt om. Dat is het geval waarin "ik kon
    // niet kijken" er anders uitkomt als "jij mag niet".
    //
    // De assertie noemt de zin die er MOET staan en sluit de zin uit die er NIET
    // mag staan. Een `Could not check who|do not have access`-alternatief zou
    // allebei goedkeuren en dus niets pinnen: precies de 403 die identityError
    // moet voorkomen, zou de test hebben gehaald.
    reset({ granted: EDITOR_GRANT });
    userReadFails = MEMBER;
    const res = await run(createStep(), memberCtx());
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /Could not check who you are/i);
    assert.strictEqual(/do not have access/i.test(res.error), false,
        'onbekend is geen weigering — dit is de 403 die niet mag terugkomen');
    assert.strictEqual(dtExec.length, 0);
});

test('een onleesbare identiteit van de APP-EIGENAAR krijgt zijn eigen zin', async () => {
    reset({ granted: EDITOR_GRANT });
    userReadFails = OWNER;
    const res = await run(createStep(), memberCtx());
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /Could not check who the app owner is/i);
    assert.strictEqual(dtExec.length, 0);
});

test('een `source` die niet gelezen kan worden schrijft NIET in de eigen opslag van de app', async () => {
    reset();
    const broken = model();
    broken.tables[0].source = { kind: 'datatabel', datatableId: DT_ID, mode: 'readwrite' };
    const res = await actionExecutor.executeDataStep(app, broken, createStep(), ownerCtx());
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /not valid/i);
    assert.strictEqual(appExec.length, 0, 'nooit terugvallen op studioAppDbStore');
    assert.strictEqual(dtExec.length, 0);
});

test('een onbekende mode is geen schrijfrecht', async () => {
    // canonicalizeDataModel vult een ONTBREKENDE mode met 'read'; een typefout
    // ('readWrite') blijft staan en modelValidate keurt hem af. Komt hij hier
    // toch langs, dan is de koppeling kapot — niet stilzwijgend smaller.
    reset();
    const res = await run(createStep(), ownerCtx(), 'readWrite');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(dtExec.length, 0);
});

// ═══ de gewone tabelsoort verandert niet ═════════════════════════════════

test('een tabel zonder `source` loopt nog gewoon over de app-opslag', async () => {
    reset();
    const own = model();
    delete own.tables[0].source;
    const res = await actionExecutor.executeDataStep(app, own, createStep(), ownerCtx());
    assert.strictEqual(res.ok, true, res.error);
    assert.strictEqual(appExec.length, 1, 'de eigen opslag, ongewijzigd');
    assert.strictEqual(dtExec.length, 0);
    assert.match(appExec[0].sql, /^INSERT INTO "klanten"/);
});

// ═══ DE KNOOPPUNTEN ZELF ═════════════════════════════════════════════════
//
// Alles hierboven gaat door executeDataStep — de drie stap-handlers. De
// record-API (POST/PATCH/DELETE), ai_extract writeTo, file_intake, dataset_query,
// de send_email-logrij, de goedkeuringshaak, connectorSync en templateInstall
// komen NIET langs die handlers maar rechtstreeks bij writeRecord /
// writeRecordBatch / eraseRecord. Die drie kenden de tweede tabelsoort niet en
// schreven onvoorwaardelijk naar de app-eigen opslag: `mode:'read'` was
// beschrijfbaar, de graad van de kijker werd nooit opgezocht, en de rij landde in
// een schaduwtabel die het leespad nooit bevraagt — `success:true`, en de rij
// daarna nergens te zien.

const LINKED = (mode = 'readwrite') => model(mode).tables[0];

async function refusal(fn) {
    try {
        await fn();
    } catch (err) {
        return err;
    }
    return assert.fail('verwacht een weigering, kreeg een geslaagde schrijving');
}

test('writeRecord schrijft een gekoppelde tabel naar de DATATABEL, niet naar de app-opslag', async () => {
    reset({ granted: EDITOR_GRANT });
    const res = await actionExecutor.writeRecord(
        app, model(), LINKED(), { naam: 'Acme' },
        { viewer: { id: MEMBER, role: 'staff', organizationId: ORG } },
    );
    assert.strictEqual(res.created, true);
    assert.match(res.id, /^rec_/);
    assert.strictEqual(appExec.length, 0, 'nooit studioAppDbStore');
    assert.strictEqual(dtExec.length, 1);
    assert.match(dtExec[0].sql, /^INSERT INTO "dt_klanten"/);
    assert.strictEqual(dtExec[0].ownerId, `org:${ORG}`);
    // created_by = de KIJKER, org_id = de org van de TABEL.
    assert.strictEqual(dtExec[0].params[3], MEMBER);
    assert.deepStrictEqual(bumps, [{ id: DT_ID, scope: { kind: 'org', id: ORG }, delta: 1 }]);
});

test('writeRecord weigert een mode:read-koppeling in plaats van in de app te schrijven', async () => {
    reset({ granted: EDITOR_GRANT });
    const err = await refusal(() => actionExecutor.writeRecord(
        app, model('read'), LINKED('read'), { naam: 'Acme' },
        { viewer: { id: MEMBER, role: 'staff', organizationId: ORG } },
    ));
    assert.strictEqual(err.status, 403);
    assert.strictEqual(err.safe, true, 'de router mag deze zin letterlijk doorgeven');
    assert.match(err.message, /reading only/);
    assert.strictEqual(appExec.length, 0);
    assert.strictEqual(dtExec.length, 0);
});

test('writeRecord weigert een kijker zonder graad — geen stille rij in de schaduwtabel', async () => {
    reset(); // geen grants, tabel niet gepubliceerd
    const err = await refusal(() => actionExecutor.writeRecord(
        app, model(), LINKED(), { naam: 'Acme' },
        { viewer: { id: MEMBER, role: 'staff', organizationId: ORG } },
    ));
    assert.strictEqual(err.status, 403);
    assert.match(err.message, /do not have access/i);
    assert.strictEqual(appExec.length, 0);
    assert.strictEqual(dtExec.length, 0);
});

test('writeRecord met een recordId wijzigt de datatabelrij en meldt het aantal', async () => {
    reset({ granted: EDITOR_GRANT });
    const res = await actionExecutor.writeRecord(
        app, model(), LINKED(), { naam: 'Acme BV' },
        { viewer: { id: MEMBER, role: 'staff', organizationId: ORG }, recordId: 'rec_1' },
    );
    assert.deepStrictEqual(res, { id: 'rec_1', updated: true, changes: 1 });
    assert.strictEqual(appExec.length, 0);
    assert.match(dtExec[0].sql, /^UPDATE "dt_klanten" SET/);
});

test('writeRecordBatch schrijft N rijen in ÉÉN transactie op de datatabel', async () => {
    reset({ granted: EDITOR_GRANT });
    const ids = await actionExecutor.writeRecordBatch(
        app, model(), LINKED(), [{ naam: 'A' }, { naam: 'B' }],
        { viewer: { id: MEMBER, role: 'staff', organizationId: ORG } },
    );
    assert.strictEqual(ids.length, 2);
    assert.strictEqual(appExec.length, 0, 'nooit studioAppDbStore.batch');
    assert.strictEqual(dtBatch.length, 1, 'één transactie, niet twee losse execs');
    assert.strictEqual(dtBatch[0].statements.length, 2);
    assert.match(dtBatch[0].statements[0].sql, /^INSERT INTO "dt_klanten"/);
    assert.deepStrictEqual(bumps, [{ id: DT_ID, scope: { kind: 'org', id: ORG }, delta: 2 }]);
});

test('writeRecordBatch weigert een mode:read-koppeling, ook met nul rijen', async () => {
    // De toestemming wordt óók voor een lege batch gevraagd: "je mocht dit niet"
    // en "er was niets" zijn verschillende antwoorden.
    reset({ granted: EDITOR_GRANT });
    for (const rows of [[{ naam: 'A' }], []]) {
        const err = await refusal(() => actionExecutor.writeRecordBatch(
            app, model('read'), LINKED('read'), rows,
            { viewer: { id: MEMBER, role: 'staff', organizationId: ORG } },
        ));
        assert.strictEqual(err.status, 403);
        assert.match(err.message, /reading only/);
    }
    assert.strictEqual(appExec.length, 0);
    assert.strictEqual(dtBatch.length, 0);
});

test('eraseRecord verwijdert uit de datatabel en telt de rij daar af', async () => {
    reset({ granted: EDITOR_GRANT });
    const res = await actionExecutor.eraseRecord(
        app, model(), LINKED(), 'rec_1',
        { viewer: { id: MEMBER, role: 'staff', organizationId: ORG } },
    );
    assert.deepStrictEqual(res, { id: 'rec_1', deleted: true, changes: 1 });
    assert.strictEqual(appExec.length, 0);
    assert.match(dtExec[0].sql, /^DELETE FROM "dt_klanten"/);
    assert.deepStrictEqual(bumps, [{ id: DT_ID, scope: { kind: 'org', id: ORG }, delta: -1 }]);
});

test('eraseRecord weigert een mode:read-koppeling — geen wis in de schaduwtabel', async () => {
    reset({ granted: EDITOR_GRANT });
    const err = await refusal(() => actionExecutor.eraseRecord(
        app, model('read'), LINKED('read'), 'rec_1',
        { viewer: { id: MEMBER, role: 'staff', organizationId: ORG } },
    ));
    assert.strictEqual(err.status, 403);
    assert.match(err.message, /reading only/);
    assert.strictEqual(appExec.length, 0);
    assert.strictEqual(dtExec.length, 0);
});

test('een publieke bezoeker komt ook via de knooppunten niet binnen', async () => {
    reset({ granted: EDITOR_GRANT });
    const anonViewer = { id: `${ANON_VIEWER_PREFIX}deadbeef`, role: PUBLIC_ROLE_KEY, organizationId: null };
    const err = await refusal(() => actionExecutor.writeRecord(
        app, model(), LINKED(), { naam: 'Acme' }, { viewer: anonViewer },
    ));
    assert.strictEqual(err.status, 403);
    assert.match(err.message, /public page cannot change rows/i);
    assert.strictEqual(appExec.length, 0);
    assert.strictEqual(dtExec.length, 0);
});

test('de knooppunten laten een tabel ZONDER source ongemoeid', async () => {
    reset();
    const own = model().tables[0];
    delete own.source;
    const created = await actionExecutor.writeRecord(app, model(), own, { naam: 'Acme' }, {
        viewer: { id: OWNER, role: 'owner', organizationId: ORG },
    });
    assert.strictEqual(created.created, true);
    assert.strictEqual(appExec.length, 1);
    assert.match(appExec[0].sql, /^INSERT INTO "klanten"/);

    const erased = await actionExecutor.eraseRecord(app, model(), own, 'rec_1', {
        viewer: { id: OWNER, role: 'owner', organizationId: ORG },
    });
    assert.deepStrictEqual(erased, { id: 'rec_1', deleted: true, changes: 1 });
    assert.strictEqual(appExec.length, 2);
    assert.match(appExec[1].sql, /^DELETE FROM "klanten"/);
    assert.strictEqual(dtExec.length, 0);
});
