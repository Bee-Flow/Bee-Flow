/**
 * De DATA-API op een GEKOPPELDE tabel — de routes, niet de laag eronder.
 *
 * De rechtenbeslissing staat in appStudio/datatableSource.js en wordt daar
 * getest (datatableSource.test.js + datatableSource.grades.test.js). Dit bestand
 * gaat over de vier plekken in routes/studioAppData.js die de tweede tabelsoort
 * NIET kenden en er dus stil omheen liepen:
 *
 *   1. POST/PATCH  → actionExecutor.writeRecord. Het knooppunt las `table.source`
 *      niet, dus de rij belandde in de app-eigen schaduwtabel terwijl de lijst
 *      uit de datatabel leest: `success:true`, en de rij daarna nergens te zien.
 *   2. DELETE      → compileerde zijn eigen SQL tegen de MODELtabel; 404 op een
 *      rij die in de datatabel gewoon bestaat.
 *   3. readOne     → idem, dus een detailscherm zei structureel "Record not
 *      found" — en de her-lezing na een schrijving toonde de rij die net in de
 *      verkeerde opslag belandde als bewijs dat het gelukt was.
 *   4. GET /tables → filterde alleen op `rlsGateway.canRead` (het access-blok van
 *      de APP), dus naam en kolomnamen van een gekoppelde tabel stonden in de
 *      lijst van een lid dat de datatabel niet mag lezen.
 *   5. GET /export → schreef een gekoppelde tabel weg als `[]`, zonder enige
 *      markering. In een privacyproduct is dat het bestand waarmee iemand een
 *      inzageverzoek beantwoordt.
 *
 * Draaien: cd server && node --test --test-reporter=tap routes/studioAppData.datatable.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const OWNER = 'owner-1';
const MEMBER = 'member-1';
const ORG = 'org1';
const DT_ID = 'tbl_dt00001';

// ── De app en haar model ────────────────────────────────────────────
const apps = new Map();
const models = new Map();

function modelWith(mode = 'readwrite') {
    return {
        modelVersion: 1,
        roles: [{ key: 'manager' }, { key: 'member' }],
        roleMapping: { default: 'member', byGroup: {} },
        tables: [
            {
                id: 'tbl_link01', key: 'klanten', name: 'Klanten',
                source: { kind: 'datatable', datatableId: DT_ID, mode },
                fields: [{ id: 'fld_naam', key: 'naam', type: 'text' }],
                access: {
                    default: 'none',
                    roles: {
                        manager: { read: 'all', create: true, update: 'all', delete: 'all' },
                        member: { read: 'all', create: true, update: 'all', delete: 'all' },
                    },
                    rowFilters: {},
                },
            },
            {
                id: 'tbl_own001', key: 'notes', name: 'Notes',
                fields: [{ id: 'fld_body', key: 'body', type: 'text' }],
                access: { default: 'app', roles: {}, rowFilters: {} },
            },
        ],
    };
}

stub('../stores/studioAppStore', {
    getStudioApp: async (id) => apps.get(id) || null,
    canReadStudioApp: (app, userId) => !!app && (app.userId === userId || app.isPublished),
    canReadStudioAppAsync: async (app, userId) => !!app && (app.userId === userId || app.isPublished),
    canWriteStudioApp: (app, userId) => !!app && app.userId === userId,
});

const appDb = [];
stub('../stores/studioAppDbStore', {
    query: async (ownerId, appId, sql, params = []) => {
        appDb.push({ op: 'query', ownerId, appId, sql, params });
        return { rows: [], columns: [], truncated: false };
    },
    exec: async (ownerId, appId, sql, params = []) => {
        appDb.push({ op: 'exec', ownerId, appId, sql, params });
        return { changes: 1 };
    },
    sizeBytes: async () => 0,
});

stub('../stores/studioAppDataStore', {
    getDataModel: async (appId, ownerId) => {
        const m = models.get(appId);
        return m ? { appId, ownerUserId: ownerId, model: m.model, modelVersion: m.modelVersion } : null;
    },
    getMemberRole: async () => null,
    bumpDataVersion: async () => 1,
    bumpRowCount: async () => ({}),
    getRowCounts: async () => ({}),
    getDataset: async () => null,
    listDatasets: async () => [],
});

// ── De datatabel-kant ───────────────────────────────────────────────
let dtRow = null;
let grants = [];
const bumps = [];
stub('../stores/datatableStore', {
    orgScope: (id) => ({ kind: 'org', id }),
    userScope: (id) => ({ kind: 'user', id }),
    getDatatable: async (id, scope) => {
        if (id !== DT_ID || !dtRow) return null;
        return (scope.kind === 'org' && scope.id === ORG) ? dtRow : null;
    },
    listGrants: async () => grants,
    getTableMeta: async () => ({ id: DT_ID, key: 'dt_klanten', fields: [{ id: 'f1', key: 'naam', type: 'text' }] }),
    scopeUsage: async () => ({ tables: 1, rows: 3, bytes: 1024 }),
    bumpAfterWrite: async (id, scope, delta) => { bumps.push({ id, delta }); },
});

const dtCalls = [];
let dtRows = [{ id: 'rec_1', naam: 'Acme' }];
stub('../stores/datatableDbStore', {
    scopeKey: (scope) => `${scope.kind}:${scope.id}`,
    query: async (ownerId, entityId, sql, params = []) => {
        dtCalls.push({ op: 'query', ownerId, sql, params });
        return { rows: dtRows };
    },
    exec: async (ownerId, entityId, sql, params = []) => {
        dtCalls.push({ op: 'exec', ownerId, sql, params });
        return { changes: 1 };
    },
    batch: async (ownerId, entityId, statements) => {
        dtCalls.push({ op: 'batch', ownerId, statements });
        return { changes: statements.length };
    },
});

stub('../stores/userStore', {
    getUser: async (id) => ({ id, organizationId: ORG, orgRole: 'member', groups: [] }),
    getAllGroups: async () => [],
    getOrgMembersForDirectory: async () => [],
});
stub('../auth/audience', {
    resolveAudienceContext: async (req) => ({
        userId: req.session?.user?.id || null,
        orgIds: new Set(req._testOrgIds || [ORG]),
        userGroups: req._testGroups || [],
    }),
    canSeePublished: () => false,
});
stub('../stores/projectStore', {});

const router = require('./studioAppData');

// ── Dispatch (uit studioAppsRun.test.js) ────────────────────────────
function dispatch({ method = 'GET', url, user = MEMBER, body, query = {} } = {}) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, query,
            ip: '203.0.113.9',
            headers: body !== undefined ? { 'content-type': 'application/json' } : {},
            session: user ? { isAuthenticated: true, user: { id: user, organizationId: ORG } } : null,
            _testOrgIds: [ORG],
            _testGroups: [],
            get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        if (body !== undefined) req.body = body;
        const res = {
            statusCode: 200, headers: {}, body: undefined, chunks: [], destroyed: null,
            set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
            setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
            getHeader(k) { return this.headers[String(k).toLowerCase()]; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            write(chunk) { this.chunks.push(String(chunk)); return true; },
            end(chunk) {
                if (chunk !== undefined) this.chunks.push(String(chunk));
                if (this.chunks.length) this.text = this.chunks.join('');
                resolve(this);
                return this;
            },
            destroy(err) { this.destroyed = err || new Error('destroyed'); resolve(this); return this; },
        };
        router(req, res, (err) => reject(err || new Error(`fell through: ${method} ${url}`)));
    });
}

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

const EDITOR_GRANT = [{ grantee_type: 'user', grantee_id: MEMBER, grade: 'editor' }];
const VIEWER_GRANT = [{ grantee_type: 'user', grantee_id: MEMBER, grade: 'viewer' }];

let seq = 0;
function makeApp(mode = 'readwrite') {
    const id = `app-${++seq}`;
    apps.set(id, {
        id, userId: OWNER, organizationId: ORG, name: 'App', isPublished: true,
        sharedGroups: [], publishedDefinition: {}, definition: {}, publishedVersion: 3,
    });
    models.set(id, { model: modelWith(mode), modelVersion: 1 });
    return apps.get(id);
}

function reset({ table = datatable(), granted = EDITOR_GRANT } = {}) {
    dtRow = table;
    grants = granted;
    dtCalls.length = 0; appDb.length = 0; bumps.length = 0;
    dtRows = [{ id: 'rec_1', naam: 'Acme' }];
}

const onlyAppTable = (calls) => calls.filter((c) => /"klanten"/.test(c.sql || ''));

// ═══ 1+3. schrijven en teruglezen ════════════════════════════════════════

test('POST records schrijft in de DATATABEL en leest de rij daar terug', async () => {
    reset();
    const app = makeApp('readwrite');
    const r = await dispatch({
        method: 'POST', url: `/${app.id}/data/tables/tbl_link01/records`,
        user: MEMBER, body: { values: { naam: 'Acme' } },
    });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.success, true);
    // De INSERT ging naar de datatabel…
    assert.ok(dtCalls.some((c) => c.op === 'exec' && /^INSERT INTO "dt_klanten"/.test(c.sql)));
    // …en de her-lezing ook, dus wat de UI toont is wat er echt staat.
    assert.ok(dtCalls.some((c) => c.op === 'query' && /FROM "dt_klanten"/.test(c.sql)));
    // De app-eigen opslag is niet aangeraakt voor deze tabel.
    assert.deepStrictEqual(onlyAppTable(appDb), []);
});

test('POST records op een mode:read-koppeling is 403 met een reden, niet 200', async () => {
    reset();
    const app = makeApp('read');
    const r = await dispatch({
        method: 'POST', url: `/${app.id}/data/tables/tbl_link01/records`,
        user: MEMBER, body: { values: { naam: 'Acme' } },
    });
    assert.strictEqual(r.statusCode, 403);
    assert.match(r.body.error, /reading only/);
    assert.deepStrictEqual(onlyAppTable(appDb), [], 'nooit een schaduwrij als troostprijs');
    assert.strictEqual(dtCalls.filter((c) => c.op === 'exec').length, 0);
});

test('POST records door een kijker zonder graad is 403, geen stille rij', async () => {
    reset({ granted: [] });
    const app = makeApp('readwrite');
    const r = await dispatch({
        method: 'POST', url: `/${app.id}/data/tables/tbl_link01/records`,
        user: MEMBER, body: { values: { naam: 'Acme' } },
    });
    assert.strictEqual(r.statusCode, 403);
    assert.match(r.body.error, /do not have access/i);
    assert.deepStrictEqual(onlyAppTable(appDb), []);
});

test('PATCH records wijzigt de datatabelrij', async () => {
    reset();
    const app = makeApp('readwrite');
    const r = await dispatch({
        method: 'PATCH', url: `/${app.id}/data/tables/tbl_link01/records/rec_1`,
        user: MEMBER, body: { values: { naam: 'Acme BV' } },
    });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.ok(dtCalls.some((c) => c.op === 'exec' && /^UPDATE "dt_klanten"/.test(c.sql)));
    assert.deepStrictEqual(onlyAppTable(appDb), []);
});

test('PATCH records op een viewer-graad is 403 — de app deelt de rechten van zijn maker niet uit', async () => {
    reset({ granted: VIEWER_GRANT });
    const app = makeApp('readwrite');
    const r = await dispatch({
        method: 'PATCH', url: `/${app.id}/data/tables/tbl_link01/records/rec_1`,
        user: MEMBER, body: { values: { naam: 'Acme BV' } },
    });
    assert.strictEqual(r.statusCode, 403);
    assert.strictEqual(dtCalls.filter((c) => c.op === 'exec').length, 0);
});

// ═══ 2. DELETE ═══════════════════════════════════════════════════════════

test('DELETE records verwijdert uit de datatabel, niet uit de schaduwtabel', async () => {
    reset();
    const app = makeApp('readwrite');
    const r = await dispatch({
        method: 'DELETE', url: `/${app.id}/data/tables/tbl_link01/records/rec_1`, user: MEMBER,
    });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.ok(dtCalls.some((c) => c.op === 'exec' && /^DELETE FROM "dt_klanten"/.test(c.sql)));
    assert.deepStrictEqual(onlyAppTable(appDb), [], 'nooit DELETE FROM "klanten" op de app-opslag');
});

test('DELETE records op een mode:read-koppeling zegt WAAROM — geen 404', async () => {
    reset();
    const app = makeApp('read');
    const r = await dispatch({
        method: 'DELETE', url: `/${app.id}/data/tables/tbl_link01/records/rec_1`, user: MEMBER,
    });
    assert.strictEqual(r.statusCode, 403);
    assert.match(r.body.error, /reading only/);
    assert.notStrictEqual(r.statusCode, 404, '404 leest als "die rij bestaat niet" en dat is een andere mededeling');
});

// ═══ 3. readOne ══════════════════════════════════════════════════════════

test('GET één record leest de DATATABEL — niet structureel 404', async () => {
    reset();
    const app = makeApp('readwrite');
    const r = await dispatch({ url: `/${app.id}/data/tables/tbl_link01/records/rec_1`, user: MEMBER });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.record, { id: 'rec_1', naam: 'Acme' });
    assert.ok(dtCalls.some((c) => c.op === 'query' && /FROM "dt_klanten"/.test(c.sql)));
    assert.deepStrictEqual(onlyAppTable(appDb), []);
});

test('GET één record zonder graad is 403 met een reden, nooit 404', async () => {
    // 404 wordt door de runtime-client een LEGE lijst (readError.js), dus een
    // weigering die 404 antwoordt verschijnt op het scherm als "er is niets".
    reset({ granted: [] });
    const app = makeApp('readwrite');
    const r = await dispatch({ url: `/${app.id}/data/tables/tbl_link01/records/rec_1`, user: MEMBER });
    assert.strictEqual(r.statusCode, 403);
    assert.match(r.body.error, /do not have access/i);
});

// ═══ 4. de tabellenlijst ═════════════════════════════════════════════════

test('GET /data/tables toont een gekoppelde tabel alleen aan wie hem mag lezen', async () => {
    reset();
    const app = makeApp('readwrite');
    const ok = await dispatch({ url: `/${app.id}/data/tables`, user: MEMBER });
    assert.strictEqual(ok.statusCode, 200);
    const linked = ok.body.tables.find((t) => t.id === 'tbl_link01');
    assert.ok(linked, 'met een grant staat hij er gewoon in');
    assert.strictEqual(linked.linked, true);
    assert.strictEqual(linked.readOnly, false);
    // De datatableId hoort bij de organisatie waar hij staat, niet bij deze app.
    assert.strictEqual('source' in linked, false);
    assert.strictEqual(JSON.stringify(linked).includes(DT_ID), false);

    // …en zonder grant staat hij er NIET in — ook zijn naam en kolomnamen niet.
    reset({ granted: [] });
    const hidden = await dispatch({ url: `/${app.id}/data/tables`, user: MEMBER });
    assert.strictEqual(hidden.statusCode, 200);
    assert.strictEqual(hidden.body.tables.some((t) => t.id === 'tbl_link01'), false);
    assert.strictEqual(JSON.stringify(hidden.body).includes('naam'), false, 'ook de kolomnamen niet');
    // De gewone tabel blijft gewoon staan.
    assert.ok(hidden.body.tables.some((t) => t.id === 'tbl_own001'));
});

test('GET /data/tables markeert een read-koppeling als alleen-lezen', async () => {
    reset();
    const app = makeApp('read');
    const r = await dispatch({ url: `/${app.id}/data/tables`, user: MEMBER });
    const linked = r.body.tables.find((t) => t.id === 'tbl_link01');
    assert.strictEqual(linked.readOnly, true);
});

// ═══ 5. de export ════════════════════════════════════════════════════════

test('de export haalt de rijen van een gekoppelde tabel op en noemt de herkomst', async () => {
    reset();
    const app = makeApp('readwrite');
    const r = await dispatch({ url: `/${app.id}/data/export`, user: OWNER });
    assert.strictEqual(r.destroyed, null, 'de stream is niet afgebroken');
    const out = JSON.parse(r.text);
    assert.deepStrictEqual(out.tables.klanten, [{ id: 'rec_1', naam: 'Acme' }],
        'niet [] — "leeg" en "staat ergens anders" zijn verschillende antwoorden');
    assert.deepStrictEqual(out.linkedTables, { klanten: { datatableId: DT_ID, mode: 'readwrite' } });
    // De eigen tabel staat er nog gewoon in, uit de app-database.
    assert.deepStrictEqual(out.tables.notes, []);
});

test('een export die een gekoppelde tabel niet kan lezen faalt VOOR de eerste byte', async () => {
    // Eenmaal onderweg is de status al 200 en zou de weigering als geldige,
    // volledige JSON aankomen.
    reset({ table: null });
    const app = makeApp('readwrite');
    const r = await dispatch({ url: `/${app.id}/data/export`, user: OWNER });
    assert.strictEqual(r.statusCode, 422);
    assert.match(r.body.error, /no longer available/i);
    assert.strictEqual(r.chunks.length, 0, 'er is geen halve JSON de deur uit gegaan');
});

// ═══ De gewone tabelsoort verandert niet ════════════════════════════════

test('een tabel zonder `source` loopt nog gewoon over de app-opslag', async () => {
    reset();
    const app = makeApp('readwrite');
    const r = await dispatch({
        method: 'POST', url: `/${app.id}/data/tables/tbl_own001/records`,
        user: MEMBER, body: { values: { body: 'x' } },
    });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.ok(appDb.some((c) => c.op === 'exec' && /^INSERT INTO "notes"/.test(c.sql)));
    assert.strictEqual(dtCalls.length, 0);
});
