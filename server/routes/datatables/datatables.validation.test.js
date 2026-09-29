'use strict';

/**
 * What the datatable routes accept, and what they say when they refuse
 * (routes/datatables/*.js).
 *
 * Four silent fall-backs lived in this router, every one of them under a 200:
 *
 *   - `rowScope: 'Own'` on a create. The store writes `rowScope === 'own' ?
 *     'own' : 'all'` and auth/datatableAccess reads it back the same way, so
 *     any other spelling meant "everyone with access sees every row" — the
 *     opposite of what was asked for, reported as a table that had been made.
 *   - `{"audiance": "organisation"}` on the sharing route. The body was read
 *     key by key and anything else fell off the end, so `setSharing` was
 *     called with nothing to set and answered 200 with the unchanged table.
 *   - `{"valeus": {...}}` on a row insert. `req.body?.values || {}` turned it
 *     into an INSERT of an empty row, answered with that row's id.
 *   - `?confirmBreaking=1` on the answers-column drop — the ONE surface that
 *     sends it (datatablesApi.removeAnswersColumn). `confirmedBreaking` read
 *     only the literal 'true', so the dialog's confirmation never arrived and
 *     the column could not be removed at all.
 *
 * What this file pins is the part a caller can act on:
 *
 *   - the 400 NAMES the field (`body.rowScope`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the stores are never reached, so a refused request changes nothing.
 *
 * Run: cd server && node --test --test-force-exit routes/datatables/datatables.validation.test.js
 */

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');
const express = require('express');

const SERVER = path.resolve(__dirname, '..', '..');
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

// Every store, engine and adapter call lands in `touched`. A refused request
// must leave it empty.
const touched = [];
const spy = (what, value) => (...args) => { touched.push({ what, args }); return value; };

const SCOPE = { kind: 'org', id: 'org1' };
const TABLE = {
    id: 'tbl_1', key: 'klanten', name: 'Klanten', scope: SCOPE, organizationId: 'org1',
    rowScope: 'all', rowCount: 3, managedKind: null, source: null, dataVersion: 2,
};
const META = { id: 'tbl_1', key: 'klanten', fields: [{ id: 'fld_a', key: 'naam', type: 'text' }] };
const PRINCIPAL = { userId: 'u1', orgId: 'org1', orgRole: 'org_admin', groupIds: [] };

// ── The modules the handlers reach through ──────────────────────────
mock(path.join(SERVER, 'stores/datatableStore'), {
    orgScope: () => SCOPE,
    userScope: (id) => ({ kind: 'user', id }),
    createDatatable: spy('createDatatable', Promise.resolve({ ...TABLE })),
    updateDatatableMeta: spy('updateDatatableMeta', Promise.resolve({ ...TABLE })),
    setSharing: spy('setSharing', Promise.resolve({ ...TABLE })),
    addGrant: spy('addGrant', Promise.resolve([])),
    removeGrant: spy('removeGrant', Promise.resolve([])),
    listGrants: async () => [],
    listGrantsForTables: async () => new Map(),
    listUsage: async () => [],
    listUsageCounts: async () => new Map(),
    listUsageForColumn: async () => [],
    listDatatablesForScope: async () => [],
    getTableMeta: async () => ({ ...META }),
    getModel: async () => ({ model: { tables: [{ id: 'tbl_1', key: 'klanten', fields: META.fields }] }, modelVersion: 7 }),
    saveModel: spy('saveModel', Promise.resolve({ ok: true, modelVersion: 8 })),
    bumpAfterWrite: spy('bumpAfterWrite', Promise.resolve()),
    getDatatable: async () => ({ ...TABLE }),
    setSource: async () => ({ ...TABLE }),
    markSourceStale: async () => {},
});
mock(path.join(SERVER, 'stores/datatableDbStore'), {
    scopeKey: () => 'org1',
    invalidate: () => {},
    applyMigration: spy('applyMigration', Promise.resolve()),
    dropDatatable: spy('dropDatatable', Promise.resolve(true)),
    query: spy('query', Promise.resolve({ rows: [] })),
    exec: spy('exec', Promise.resolve({ changes: 1 })),
    batch: spy('batch', Promise.resolve([{ changes: 1 }])),
    getSchemaStamp: async () => 7,
    schema: async () => ({ tables: [] }),
});
mock(path.join(SERVER, 'db'), {
    withTransaction: async (fn) => fn({}),
});
mock(path.join(SERVER, 'auth'), {
    assertUserCanUseOrg: async () => {},
    hasPermission: async () => true,
    Permissions: { MANAGE_DATATABLES: 'manage_datatables' },
    validateSharedGroupsForOrg: async (_org, groups) => (groups || []).map(String),
});
mock(path.join(SERVER, 'auth/datatableAccess'), {
    resolveDatatablePrincipal: async () => PRINCIPAL,
    datatableScopesFor: () => [SCOPE],
    defaultCreateScope: () => SCOPE,
    gradeForPrincipal: () => 'owner',
    gradeAtLeast: () => true,
    synthesizeAccess: () => ({}),
});
mock(path.join(SERVER, 'core/entitlements/entitlements'), {
    requireCapability: () => (req, res, next) => next(),
});
mock(path.join(SERVER, 'core/dataEngine/datatableLimits'), {
    assertDatatableQuota: async () => {},
});
mock(path.join(SERVER, 'core/dataEngine/accessFilter'), {
    assertCanWrite: () => 'all',
    compileAccessFilter: () => ({ where: '1=1', params: [] }),
});
mock(path.join(SERVER, 'core/dataEngine/sources'), {
    isSourceMirror: () => false,
    sourceOf: () => null,
    isSourceKind: () => false,
    kickStale: () => {},
    sourceLabel: () => 'Nextcloud',
});
mock(path.join(SERVER, 'core/dataEngine/queryCompiler'), {
    MATCH_MODES: ['all', 'any'],
    compileRecordList: spy('compileRecordList', { sql: 'SELECT 1', params: [], primaryField: 'created_at', limit: 50 }),
    compileGetById: spy('compileGetById', { sql: 'SELECT 1', params: [] }),
    compileInsert: spy('compileInsert', { sql: 'INSERT 1', params: [], id: 'rec_new' }),
    compileUpdate: spy('compileUpdate', { sql: 'UPDATE 1', params: [] }),
    compileDelete: spy('compileDelete', { sql: 'DELETE 1', params: [] }),
    encodeCursor: () => null,
});
mock(path.join(SERVER, 'automation/formAnswers'), {
    summary: {
        answersSummary: spy('answersSummary', Promise.resolve({ total: 0 })),
        readAggregateDescriptor: () => ({}),
        runAggregate: async () => ({ rows: [] }),
    },
    deleteRetiredColumn: spy('deleteRetiredColumn', Promise.resolve({ fields: [], modelVersion: 9, table: { ...TABLE } })),
    releaseAnswersTable: spy('releaseAnswersTable', Promise.resolve({ ...TABLE })),
});
mock(path.join(SERVER, 'compliance/dataPortability/stampExport'), () => (req, res, next) => next());

// The door, stubbed: this file is about what a request may CARRY, and the
// grade ladder has suites of its own (routes/datatables.test.js).
let currentTable = { ...TABLE };
mock(path.join(SERVER, 'routes/datatables/grade'), {
    requireDatatableGrade: () => (req, res, next) => {
        req.datatable = currentTable;
        req.datatableScope = currentTable.scope;
        req.datatableScopeKey = 'org1';
        req.datatableGrade = 'owner';
        req.datatablePrincipal = PRINCIPAL;
        next();
    },
    requireManageForOrgScope: () => (req, res, next) => next(),
    refuseWhenPersonal: (req, res, next) => next(),
    metaAndFilter: async () => ({ meta: { ...META }, filter: { where: '1=1', params: [] } }),
    metaFor: async () => ({ ...META }),
});

const router = express.Router();
for (const group of ['./tables', './metadata', './schema', './drift', './rows', './sharing', './source', './answers', './deleteTable']) {
    require(group).register(router);
}
const { terminalErrorHandler } = require(path.join(SERVER, 'core/http/terminalErrorHandler'));

function dispatch({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, query, body, headers: {},
            session: { user: { id: 'u1' } }, get() { return undefined; }, setTimeout() {},
            on() {}, once() {},
        };
        const res = {
            statusCode: 200, headersSent: false,
            set() { return this; }, setHeader() {}, getHeader() { return undefined; },
            flushHeaders() {}, setTimeout() {}, write() { return true; }, on() {}, once() {},
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end(b) { this.body = this.body ?? b; this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; currentTable = { ...TABLE }; });

/** Assert: refused with 400, the named field is in `details`, nothing touched. */
async function refuses(request, field) {
    const res = await dispatch(request);
    const what = `${request.method} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, `${what} → ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'invalid_request', what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
}

const CREATE = { name: 'Klanten', key: 'klanten', description: 'Onze klanten.' };

// ═══ POST / — making a table ════════════════════════════════════════

test('a row scope nobody implements is refused instead of quietly meaning "everyone"', async () => {
    // 'Own' used to be stored as 'all': the person asked for "only the person
    // who added it" and every colleague could read every row.
    const res = await dispatch({ method: 'POST', url: '/', body: { ...CREATE, rowScope: 'Own' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Rows are visible to everyone with access, or only to whoever added them');
    assert.ok(res.body.details.some((d) => d.path === 'body.rowScope'));
    assert.deepStrictEqual(touched, [], 'and no table is made');
});

test('the row scope a caller may ask for still reaches the store', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { ...CREATE, rowScope: 'own' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((x) => x.what === 'createDatatable').args[0].rowScope, 'own');
});

test('a table with no name is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { key: 'klanten', description: 'x' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Give the table a name', 'the caller reads this sentence');
    assert.deepStrictEqual(touched, []);
});

test('a numeric name is refused by name, instead of being stored as its digits', async () => {
    await refuses({ method: 'POST', url: '/', body: { ...CREATE, name: 42 } }, 'body.name');
});

test('the Art. 30 purpose is still demanded, and blank is still blank', async () => {
    await refuses({ method: 'POST', url: '/', body: { name: 'K', key: 'k' } }, 'body.description');
    await refuses({ method: 'POST', url: '/', body: { ...CREATE, description: '   ' } }, 'body.description');
});

test('a key that is not a key is refused rather than becoming a relation name', async () => {
    await refuses({ method: 'POST', url: '/', body: { ...CREATE, key: 'Mijn Tabel' } }, 'body.key');
});

test('a placement word nobody implements is refused rather than read as "personal"', async () => {
    // The WORD keeps its own code: the create dialog branches on `bad_scope`
    // to say it in the person's language. The schema's job here is the TYPE
    // and — through .strict() — the misspelled key.
    const res = await dispatch({ method: 'POST', url: '/', body: { ...CREATE, scope: 'organization' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'bad_scope');
    assert.deepStrictEqual(touched, []);

    await refuses({ method: 'POST', url: '/', body: { ...CREATE, scope: 1 } }, 'body.scope');
});

test('a key the create route does not read is refused rather than answered with 200', async () => {
    await refuses({ method: 'POST', url: '/', body: { ...CREATE, retentionDays: 30 } }, 'body');
});

test('a name is trimmed once, by the schema, on its way to the store', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { ...CREATE, name: '  Klanten  ' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((x) => x.what === 'createDatatable').args[0].name, 'Klanten');
});

// ═══ PATCH /:id — the table's own facts ═════════════════════════════

test('a key that cannot be changed is told apart from one that does not exist', async () => {
    const immutable = await dispatch({ method: 'PATCH', url: '/tbl_1', body: { key: 'anders' } });
    assert.strictEqual(immutable.statusCode, 400);
    assert.match(immutable.body.error, /names the table's own storage/);

    const unknown = await dispatch({ method: 'PATCH', url: '/tbl_1', body: { colour: 'blue' } });
    assert.strictEqual(unknown.statusCode, 400);
    assert.match(unknown.body.error, /is not something you can change/);
    assert.deepStrictEqual(touched, []);
});

test('a name that is not text is refused rather than stored as "[object Object]"', async () => {
    await refuses({ method: 'PATCH', url: '/tbl_1', body: { name: { nl: 'Klanten' } } }, 'body.name');
});

test('a lawful basis outside Art. 6 is refused, and none is still allowed', async () => {
    await refuses({ method: 'PATCH', url: '/tbl_1', body: { lawfulBasis: 'consnt' } }, 'body.lawfulBasis');
    const res = await dispatch({ method: 'PATCH', url: '/tbl_1', body: { lawfulBasis: null } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((x) => x.what === 'updateDatatableMeta').args[2].lawfulBasis, null);
});

test('a retention window that is not a whole number of days is refused', async () => {
    await refuses({ method: 'PATCH', url: '/tbl_1', body: { retentionDays: '30', retentionField: 'created_at' } }, 'body.retentionDays');
    await refuses({ method: 'PATCH', url: '/tbl_1', body: { retentionDays: 0, retentionField: 'created_at' } }, 'body.retentionDays');
});

// ═══ PUT /:id/schema — the column list ══════════════════════════════

test('a misspelled expectedVersion is refused rather than read as an absent one', async () => {
    // `{fields, expectedversion}` used to be told "send the modelVersion you
    // loaded" while it was doing exactly that.
    await refuses({ method: 'PUT', url: '/tbl_1/schema', body: { fields: [], expectedversion: 7 } }, 'body');
});

test('a version that is not the number GET /schema returned is refused', async () => {
    await refuses({ method: 'PUT', url: '/tbl_1/schema', body: { fields: [], expectedVersion: true } }, 'body.expectedVersion');
    await refuses({ method: 'PUT', url: '/tbl_1/schema', body: { fields: [], expectedVersion: '' } }, 'body.expectedVersion');
});

test('the body the shipped column designer sends still saves', async () => {
    const res = await dispatch({
        method: 'PUT', url: '/tbl_1/schema',
        body: { fields: [{ id: 'fld_a', key: 'naam', name: 'Naam', type: 'text' }], expectedVersion: 7, confirmBreaking: false },
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok(touched.some((x) => x.what === 'saveModel'));
});

// ═══ PUT /:id/sharing ═══════════════════════════════════════════════

test('a misspelled audience is refused rather than answered with an unchanged table', async () => {
    // `{"audiance":"organisation"}` reached setSharing with nothing to set and
    // came back 200 carrying the table — which is what a save looks like.
    await refuses({ method: 'PUT', url: '/tbl_1/sharing', body: { audiance: 'organisation' } }, 'body');
});

test('an audience word nobody implements is refused, not read as the narrowest', async () => {
    // Coded, for the same reason as `bad_scope`: on a route where two words
    // are the difference between "private" and "the whole organisation", the
    // caller gets a machine-readable answer.
    const res = await dispatch({ method: 'PUT', url: '/tbl_1/sharing', body: { audience: 'org' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'bad_audience');
    assert.deepStrictEqual(touched, []);

    await refuses({ method: 'PUT', url: '/tbl_1/sharing', body: { audience: ['groups'] } }, 'body.audience');
});

test('a write mode nobody implements is refused', async () => {
    await refuses({ method: 'PUT', url: '/tbl_1/sharing', body: { audience: 'private', writeMode: 'open' } }, 'body.writeMode');
});

test('the old body shape still gets the 409 that tells the tab to reload', async () => {
    const res = await dispatch({ method: 'PUT', url: '/tbl_1/sharing', body: { isPublished: true, sharedGroups: [] } });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'stale_client');
});

test('a grant with no grantee is refused by name, not by a NOT NULL constraint', async () => {
    await refuses({ method: 'POST', url: '/tbl_1/grants', body: { granteeType: 'user', grade: 'viewer' } }, 'body.granteeId');
    await refuses({ method: 'POST', url: '/tbl_1/grants', body: { granteeType: 'person', granteeId: 'u2', grade: 'viewer' } }, 'body.granteeType');
    await refuses({ method: 'POST', url: '/tbl_1/grants', body: { granteeType: 'user', granteeId: 'u2', grade: 'admin' } }, 'body.grade');
});

// ═══ GET /:id/rows — the list ═══════════════════════════════════════

test('a misspelled filter is refused, not dropped into a wider list', async () => {
    // `?fitlers=[…]` used to be ignored, so the list answered "every row" to
    // somebody looking at what they believed was a filtered view.
    await refuses({ method: 'GET', url: '/tbl_1/rows?fitlers=[]' }, 'query');
});

test('a sort direction that is not one is refused in words', async () => {
    const res = await dispatch({ method: 'GET', url: '/tbl_1/rows?sort=naam&dir=up' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Sort ascending or descending');
    assert.deepStrictEqual(touched, []);
});

test('a limit that is not a number is refused in words', async () => {
    const res = await dispatch({ method: 'GET', url: '/tbl_1/rows?limit=veel' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'limit is a number of rows.');
});

test('the parameters the shipped row browser sends still narrow', async () => {
    const res = await dispatch({ method: 'GET', url: '/tbl_1/rows?limit=50&sort=naam&dir=asc&match=any&q=jan&filters=%5B%5D' });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const opts = touched.find((x) => x.what === 'compileRecordList').args[1];
    assert.strictEqual(opts.limit, 50);
    assert.deepStrictEqual(opts.sort, [{ field: 'naam', dir: 'asc' }]);
    assert.strictEqual(opts.match, 'any');
});

test('the CSV export refuses a descriptor it would not honour', async () => {
    // It streams the WHOLE table; a client that appended the list's filters
    // would have downloaded every row believing it exported the view.
    await refuses({ method: 'GET', url: '/tbl_1/rows.csv?filters=%5B%5D' }, 'query');
});

// ═══ The row writes ═════════════════════════════════════════════════

test('a misspelled values key is refused rather than inserting an empty row', async () => {
    // `req.body?.values || {}` answered `{ok:true, id}` with the id of a row
    // that had nothing in it.
    await refuses({ method: 'POST', url: '/tbl_1/rows', body: { valeus: { naam: 'Jan' } } }, 'body');
    await refuses({ method: 'POST', url: '/tbl_1/rows', body: {} }, 'body.values');
});

test('an edit still needs the updated_at it read, and something to change', async () => {
    await refuses({ method: 'PUT', url: '/tbl_1/rows/rec_1', body: { values: { naam: 'Jan' } } }, 'body.expectedUpdatedAt');
    await refuses({ method: 'PUT', url: '/tbl_1/rows/rec_1', body: { values: {}, expectedUpdatedAt: '2026-01-01T00:00:00Z' } }, 'body.values');
});

test('a bulk import that is not a list of rows is refused by name', async () => {
    await refuses({ method: 'POST', url: '/tbl_1/rows/bulk', body: { row: [] } }, 'body');
    await refuses({ method: 'POST', url: '/tbl_1/rows/bulk', body: { rows: 'a,b' } }, 'body.rows');
});

test('a bulk delete of something that is not an id is refused before anything goes', async () => {
    await refuses({ method: 'POST', url: '/tbl_1/rows/bulk-delete', body: { ids: ['rec_1', 42] } }, 'body.ids.1');
    await refuses({ method: 'POST', url: '/tbl_1/rows/bulk-delete', body: { ids: ['rec_1'], hard: true } }, 'body');
});

// ═══ The confirmations ══════════════════════════════════════════════

test('the confirmation the Studio actually sends confirms', async () => {
    // datatablesApi.removeAnswersColumn builds `?confirmBreaking=1`, and
    // confirmedBreaking used to accept the literal 'true' and nothing else —
    // so the dialog's "Remove the column" never reached the server's ear.
    currentTable = { ...TABLE, managedKind: 'form_answers', source: { columnMap: { fld_a: { retired: true } } } };
    const res = await dispatch({ method: 'DELETE', url: '/tbl_1/answers/columns/fld_a?confirmBreaking=1' });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok(touched.some((x) => x.what === 'deleteRetiredColumn'), 'the column really goes');
});

test('a confirmation nobody spells that way is refused rather than read as "no"', async () => {
    await refuses({ method: 'DELETE', url: '/tbl_1?confirmBreaking=yes' }, 'query.confirmBreaking');
    await refuses({ method: 'DELETE', url: '/tbl_1?confirmbreaking=true' }, 'query');
});

test('a delete still confirms on either spelling a URL can carry', async () => {
    for (const q of ['?confirmBreaking=true', '?confirmBreaking=1']) {
        touched.length = 0;
        const res = await dispatch({ method: 'DELETE', url: `/tbl_1${q}` });
        assert.strictEqual(res.statusCode, 200, `${q} → ${JSON.stringify(res.body)}`);
        assert.ok(touched.some((x) => x.what === 'dropDatatable'), `${q} must really delete`);
    }
});

// ═══ The answers dashboard ══════════════════════════════════════════

test('a period written the way Europe writes one is refused, not silently widened', async () => {
    // resolveRange tests the value against YYYY-MM-DD and falls back to "the
    // last 30 days", so `?from=01-03-2026` answered a period nobody asked for.
    currentTable = { ...TABLE, managedKind: 'form_answers', source: {} };
    await refuses({ method: 'GET', url: '/tbl_1/answers/summary?from=01-03-2026' }, 'query.from');
    await refuses({ method: 'GET', url: '/tbl_1/answers/summary?form=2026-01-01' }, 'query');
});

// ═══ The routes that take nothing ═══════════════════════════════════

test('a repair takes no body, and says so rather than ignoring one', async () => {
    await refuses({ method: 'POST', url: '/tbl_1/repair', body: { onlyTableIds: ['tbl_2'] } }, 'body');
});
