/**
 * THE GRADE ARITHMETIC, calculated instead of asserted.
 *
 * One table: (the viewer's own grade relative to that of the app owner) ×
 * (the route by which he comes in) × (the mode of the link) → which grade applies, and
 * what he gets to see. Each cell is determined with a REAL call to
 * `resolveDatatableRead` / `resolveDatatableWrite`; only the edges that touch a database
 * are injected. The grade chain itself (auth/datatableAccess: gradeForPrincipal,
 * narrowGrade, effectiveGradeForRun) runs along unreplaced.
 *
 * WHY THIS IS A SEPARATE FILE. datatableSource.test.js pins the rules one by one ("a
 * viewer does not write", "a public page does not read"). This file pins the FULL cross
 * table, because the bug you are looking for never sits in a rule but in a combination:
 * the cell in which the viewer may do less than the author and something gets through
 * anyway. One missing MIN is one cell that falls the wrong way, and without the whole
 * table that is the cell nobody checks.
 *
 * THE FOUR RULES THE TABLE PROVES
 *   1. the grade is that of the VIEWER, never that of the author;
 *   2. effective = MINIMUM of (viewer, app owner, app role, mode) — never the union: no
 *      cell comes out in which someone may do more than he alone was allowed to;
 *   3. `mode:'read'` caps at viewer, so writing is a REFUSAL with a reason and not a
 *      silent no-op;
 *   4. unknown narrows, but says why: no grade = 403, unreadable identity = 503, and
 *      never an empty list.
 *
 * Run: cd server && node --test --test-reporter=tap appStudio/datatableSource.grades.test.js
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
 * The injected edges. `identityFails` turns the VIEWER (and only him) into a principal with
 * `identityError` — the user read failed, the app owner is simply readable. That
 * distinction is exactly the cell in which "unknown" must not come out as "not allowed".
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
            // An org admin is `owner` on every table of his organisation (gradeForPrincipal rule 3).
            // That is the only way to give SOMEONE owner grade without his owning the table — a
            // GRANT with grade 'owner' yields none: gradeForPrincipal translates only 'editor' and
            // 'viewer' back (rule 4), and that is here a given, not an assertion.
            if (admins.includes(userId)) return { ...p, orgRole: 'admin' };
            return p;
        },
    };
}

// ── The four viewer situations, expressed as grants ─────────────────
//
// The datatable belongs to a THIRD party (`owner_user_id: STRANGER`), so that both grades
// come from explicit grants and each cell can be set separately.

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

    // And reading on a read link caps at viewer, even though the lower of the two people is editor.
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
    // The app owner is simply readable; only the viewer is not. Without this distinction the
    // refusal reads as a policy choice ("you do not belong to it") while in reality nobody
    // could check it.
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
    // Two independent gates: the reserved role, and the id. A future public route that sets
    // only one of them does not pass silently.
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
    // The systematic version of rows 1 and 2: all nine combinations of
    // (viewer grade × owner grade) on a readwrite link with the broadest app role. The
    // outcome must ALWAYS be the lower of the two.
    const order = { viewer: 0, editor: 1, owner: 2 };
    const min = (...gs) => gs.reduce((lo, g) => (order[g] < order[lo] ? g : lo));
    const world = (who, grade) => (grade === 'owner'
        ? { admins: [who], grants: [] }
        : { admins: [], grants: [GRANT(who, grade)] });
    // The THIRD MIN rides along: an ordinary app role with write rights caps at 'editor'
    // (appRoleGrade); only the app role 'owner' lets the ladder through entirely. Both are
    // run, so that the cap is visible in the difference between the two columns and not
    // silently in the expectation.
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

// ═══ THE ROW RULE OF THE APP ROLE ═══════════════════════════════════════════
//
// Until 2026-09-16 `access.rowFilters` of the MODEL table was thrown away in its entirety
// for a LINKED datatable: the access block was replaced by that of the datatable. A role
// "only supplier X" stored and validated just fine and filtered nothing — the quietest
// kind of authorisation error.

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
    // "Bekijk als" is not pretence: whoever views the app as a restricted role should see what
    // that role sees, even if he owns the table.
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
