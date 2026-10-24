/**
 * create_record / update_record / delete_record on a model table that takes its rows from a
 * STUDIO DATATABLE (`model.tables[].source`).
 *
 * The permission decision itself lives in appStudio/datatableSource.js and is tested there.
 * Here it is about the WRITE path around it: same module, other entry point. What is pinned:
 *
 *   • each of the three actions, on a read link and on a readwrite link;
 *   • `mode:'read'` refuses LOUDLY: nothing is written AND the step says so. A silent no-op
 *     would return ok:true and let the user search for a row that was never created;
 *   • a viewer who may do less than the owner, through all four MINs (own grade, owner's
 *     grade, app role, mode);
 *   • a public app never writes with the author's grade;
 *   • the rows go to `datatableDbStore` on the scope key, NEVER to `studioAppDbStore`, with
 *     the Postgres dialect and the quota of the TENANT.
 *
 * The grade chain runs unreplaced: only the edges that touch a database are stubbed, and the
 * grades come from real grants.
 *
 * Run: cd server && node --test --test-reporter=tap appStudio/actionExecutor/records.datatable.test.js
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

// `null` = readable by everyone; a user id = ONLY that one is not. That
// distinction is the whole point of the test below: if the read failed for everyone,
// the app owner would also lose their org and a completely different refusal would come out.
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

// The app's own storage, which must NOT be touched on this path.
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

// The owner is owner of the datatable (line 2 of gradeForPrincipal); the member
// has an explicit editor grant. That is the ordinary, working setup.
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
    // An update does not change the row count, but it does change the data version.
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
    // created_by is the audit field AND the column that `row_scope:'own'` filters on.
    // If the owner were stored in it, a member would immediately no longer see their own
    // just-created row.
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

// ═══ read: the three actions are a REFUSAL, not a silent no-op ═══════════

test('mode:read weigert elk van de drie schrijfacties, hardop', async () => {
    for (const step of ALL_STEPS()) {
        reset();
        const res = await run(step, ownerCtx(), 'read');
        assert.strictEqual(res.ok, false, `${step.kind} had geweigerd moeten worden`);
        assert.match(res.error, /reading only/);
        // The core: nothing has been written, AND the step says so too. A silent
        // no-op would return ok:true and let the user search for a row that was
        // never created.
        assert.strictEqual(dtExec.length, 0);
        assert.strictEqual(appExec.length, 0);
        assert.deepStrictEqual(bumps, []);
    }
});

test('mode:read weigert vóór de lookup — het antwoord hangt niet aan de tabel', async () => {
    // The table is gone; the refusal stays "linked read-only" and does not become
    // a fault. A refusal that only falls after the search can, though.
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

// ═══ a viewer who may do less than the owner ════════════════════════════

test('een kijker met viewer-graad schrijft niet, ook al is de eigenaar owner', async () => {
    // MIN(viewer, owner) = viewer, and the viewer does not write. This is the case
    // in which the app would otherwise be the issuing point for its maker's rights.
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
    reset();  // no grants, table not published
    const res = await run(createStep(), memberCtx());
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /do not have access/i);
    assert.strictEqual(dtExec.length, 0);
});

test('een eigenaar die zijn eigen graad kwijt is, deelt niets meer uit', async () => {
    // The datatable has become someone else's and the owner no longer has a grant;
    // the member still does. The MIN with the owner keeps the door shut.
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
    // The datatable would allow it (editor grant), but the author gave this app role
    // no write right: appRoleGrade then caps at viewer.
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
    // This role may add and change, but not delete. appRoleGrade folds that into
    // 'editor'; assertCanWrite asks the question again per action.
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
    // The cause stays inside: a `safe` message goes literally to the client, and
    // 'pg down' does not belong on that side of the line.
    assert.strictEqual(/pg down/.test(res.error), false);
});

test('een onleesbare identiteit van de KIJKER is een storing, geen weigering', async () => {
    // The owner can read fine and the member has an editor grant; only the user read of
    // the VIEWER fails. That is the case in which "I could not look" comes out differently
    // from "you are not allowed".
    //
    // The assertion names the sentence that MUST be there and excludes the sentence that
    // must NOT be there. A `Could not check who|do not have access` alternative would approve
    // both and thus pin nothing: exactly the 403 that identityError must prevent would have
    // passed the test.
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
    // canonicalizeDataModel fills a MISSING mode with 'read'; a typo ('readWrite') stays,
    // and modelValidate rejects it. If it gets through here anyway, the link is broken, not
    // silently narrower.
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

// ═══ THE NODES THEMSELVES ═════════════════════════════════════════════════
//
// Everything above goes through executeDataStep, the three step handlers. The record API
// (POST/PATCH/DELETE), ai_extract writeTo, file_intake, dataset_query, the send_email log
// row, the approval hook, connectorSync and templateInstall do NOT come through those
// handlers; they call writeRecord / writeRecordBatch / eraseRecord directly. Those three
// did not know the second table kind and wrote unconditionally to the app's own storage:
// `mode:'read'` was writable, the viewer's grade was never looked up, and the row landed in
// a shadow table that the read path never queries. `success:true`, and the row afterwards
// visible nowhere.

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
    reset(); // no grants, table not published
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
    // The permission is ALSO asked for an empty batch: "you were not allowed to do this"
    // and "there was nothing" are different answers.
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
