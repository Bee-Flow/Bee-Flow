/**
 * App Studio v2 DATA API — route security model.
 *
 * Drives the REAL Express router with require-cache-stubbed stores + a fake
 * in-memory SQLite data engine (studioAppDbStore), via the stubbed req/res
 * dispatch harness from studioAppsRun.test.js. Asserts:
 *   • create stamps created_by from the SESSION (body created_by/id ignored);
 *   • non-owner can't hit owner-only schema/members (403);
 *   • unpublished + non-owner → 404 (no existence leak);
 *   • foreign / hidden recordId update → 404 (0 rows);
 *   • body cannot set system columns;
 *   • member reads/writes are RLS-scoped to own rows;
 *   • IDOR: every data-engine call carries the app's OWNER as ownerId scope;
 *   • quotas 409 with the frozen { error, code, limit, used } contract
 *     (create: row + byte caps; update: byte cap; delete always allowed);
 *   • member roleKey must exist in the model (∪ 'member') → else 422.
 *
 * Run: cd server && node --test routes/studioAppData.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// ── State ───────────────────────────────────────────────────────────
const apps = new Map();
const models = new Map();      // appId → { model, modelVersion }
const membership = new Map();  // `${appId}:${userId}` → roleKey
const dbCalls = [];            // every studioAppDbStore call (IDOR audit)
const saveModelCalls = [];
const memberMutations = [];
const rowCountsByApp = new Map(); // appId → row_counts map (quota reads)
const rowBumps = [];              // bumpRowCount calls
let dbSize = 0;                   // sizeBytes (byte-quota reads)
const directoryCalls = [];        // getOrgMembersForDirectory calls (org-scope audit)
let directoryRows = [];           // what the directory returns

// One shared in-memory engine, per-app-namespaced by a `tasks` table.
const memdb = new Database(':memory:');
memdb.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT, created_by TEXT, org_id TEXT,
    title TEXT, region TEXT, amount INTEGER
)`);
function norm(params) { return (params || []).map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v)); }

// Faithful copies of the store's pure predicates (real module needs live PG).
function canReadStudioApp(app, userId, userGroupIds = [], userOrgIds = []) {
    if (!app) return false;
    if (app.userId === userId) return true;
    if (!app.isPublished) return false;
    if (!app.organizationId) return false;
    const orgIds = Array.isArray(userOrgIds) ? userOrgIds : [...(userOrgIds || [])];
    if (!orgIds.includes(app.organizationId)) return false;
    const groups = Array.isArray(app.sharedGroups) ? app.sharedGroups : [];
    if (groups.length === 0) return true;
    return groups.some((g) => userGroupIds.includes(g));
}
function canWriteStudioApp(app, userId) { return !!app && app.userId === userId; }

stub('../stores/studioAppStore', {
    getStudioApp: async (id) => apps.get(id) || null,
    canReadStudioApp,
    // Project widening (canReadStudioAppAsync): no fixture here is filed into
    // a Studio Project, so the async predicate is the sync one — which is
    // exactly what the real store answers for project_id NULL.
    canReadStudioAppAsync: async (...a) => canReadStudioApp(...a),
    canWriteStudioApp,
});

stub('../stores/studioAppDataStore', {
    getDataModel: async (appId, ownerId) => {
        const m = models.get(appId);
        if (!m) return null;
        return { appId, ownerUserId: ownerId, model: m.model, modelVersion: m.modelVersion };
    },
    getMemberRole: async (appId, userId) => membership.get(`${appId}:${userId}`) || null,
    bumpDataVersion: async () => 1,
    setRowCount: async () => ({}),
    bumpRowCount: async (appId, tableKey, delta, ownerId) => { rowBumps.push({ appId, tableKey, delta, ownerId }); return {}; },
    getRowCounts: async (appId) => rowCountsByApp.get(appId) || {},
    saveDataModel: async (appId, ownerId, model, opts) => {
        saveModelCalls.push({ appId, ownerId, model, opts });
        return { ok: true, version: (models.get(appId)?.modelVersion || 0) + 1 };
    },
    getDataset: async () => null,
    listMembers: async (appId, ownerId) => { memberMutations.push({ op: 'list', appId, ownerId }); return []; },
    addMember: async (appId, ownerId, memberUserId, roleKey) => {
        memberMutations.push({ op: 'add', appId, ownerId, memberUserId, roleKey });
        return { appId, userId: memberUserId, roleKey };
    },
    removeMember: async (appId, ownerId, memberUserId) => {
        memberMutations.push({ op: 'remove', appId, ownerId, memberUserId });
        return true;
    },
});

stub('../stores/studioAppDbStore', {
    query: async (ownerId, appId, sql, params = []) => {
        dbCalls.push({ op: 'query', ownerId, appId, sql, params });
        const rows = memdb.prepare(sql).all(...norm(params));
        return { rows, columns: [], truncated: false };
    },
    exec: async (ownerId, appId, sql, params = []) => {
        dbCalls.push({ op: 'exec', ownerId, appId, sql, params });
        const r = memdb.prepare(sql).run(...norm(params));
        return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
    },
    sizeBytes: async () => dbSize,
});

stub('../stores/userStore', {
    // requireAuth confirms the session's user still exists; without this the
    // suite only passed because that check used to fail open on an error.
    getUser: async (id) => ({ id }),
    getOrgMembersForDirectory: async (orgId, limit) => {
        directoryCalls.push({ orgId, limit });
        return directoryRows;
    },
});

stub('../auth/audience', {
    resolveAudienceContext: async (req) => ({
        userId: req.session?.user?.id || null,
        orgIds: new Set(req._testOrgIds || []),
        userGroups: req._testGroups || [],
    }),
});

const router = require('./studioAppData');
const { DATA_LIMITS } = require('../appStudio/dataModel');

// ── Dispatch harness (from studioAppsRun.test.js) ───────────────────
function dispatch({ method = 'GET', url, user = 'viewer-1', orgIds = [], groups = [], body, query = {}, orgId } = {}) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, query,
            ip: '203.0.113.5',
            headers: body !== undefined ? { 'content-type': 'application/json' } : {},
            session: user ? { isAuthenticated: true, user: { id: user, organizationId: orgId || 'org1' } } : null,
            _testOrgIds: orgIds,
            _testGroups: groups,
            get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        if (body !== undefined) req.body = body;
        const res = {
            statusCode: 200, headers: {}, body: undefined,
            chunks: [],           // streamed writes (the export route)
            destroyed: null,
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

// ── Fixtures ────────────────────────────────────────────────────────
const OWNER = 'owner-1';
const ORG = 'org1';

function baseModel() {
    return {
        modelVersion: 1,
        roles: [{ key: 'manager' }, { key: 'member' }],
        roleMapping: { default: 'member', byGroup: {} },
        tables: [{
            id: 'tbl_tasks0', key: 'tasks', name: 'Tasks',
            fields: [
                { id: 'fld_title', key: 'title', type: 'text' },
                { id: 'fld_region', key: 'region', type: 'text' },
                { id: 'fld_amount', key: 'amount', type: 'number', subtype: 'integer' },
            ],
            access: {
                default: 'none',
                roles: {
                    manager: { read: 'all', create: true, update: 'all', delete: 'all' },
                    member: { read: 'own', create: true, update: 'own', delete: 'none' },
                },
                rowFilters: {},
            },
        }],
    };
}

let seq = 0;
function makeApp({ published = true, owner = OWNER, org = ORG, sharedGroups = [], model = baseModel() } = {}) {
    const id = `app-${++seq}`;
    apps.set(id, {
        id, userId: owner, organizationId: org, name: 'App', isPublished: published,
        sharedGroups, publishedDefinition: {}, definition: {},
    });
    models.set(id, { model, modelVersion: 1 });
    return apps.get(id);
}
function seedRow({ id, by, region = 'EU', amount = 10, title = 'T' }) {
    memdb.prepare(`INSERT INTO tasks (id, created_at, updated_at, created_by, org_id, title, region, amount)
        VALUES (?,?,?,?,?,?,?,?)`).run(id, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', by, ORG, title, region, amount);
}

test.beforeEach(() => {
    dbCalls.length = 0; saveModelCalls.length = 0; memberMutations.length = 0;
    rowBumps.length = 0; rowCountsByApp.clear(); dbSize = 0;
    memdb.exec('DELETE FROM tasks');
});

// ── Visibility ──────────────────────────────────────────────────────

test('unpublished app + non-owner → 404 (no existence leak)', async () => {
    const app = makeApp({ published: false });
    const r = await dispatch({ url: `/${app.id}/data/tables`, user: 'stranger', orgIds: [ORG] });
    assert.strictEqual(r.statusCode, 404);
    assert.strictEqual(r.body.error, 'App not found');
});

test('unauthenticated → 401', async () => {
    const app = makeApp();
    const r = await dispatch({ url: `/${app.id}/data/tables`, user: null });
    assert.strictEqual(r.statusCode, 401);
});

// ── Table listing hides access rules ────────────────────────────────

test('GET tables returns fields only — never access/rowFilters/roleMapping', async () => {
    const app = makeApp();
    const r = await dispatch({ url: `/${app.id}/data/tables`, user: OWNER });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body.tables.length, 1);
    const t = r.body.tables[0];
    assert.ok(Array.isArray(t.fields));
    assert.ok(!('access' in t), 'access rules not exposed');
    assert.ok(!('rowFilters' in t), 'rowFilters not exposed');
    const serialized = JSON.stringify(r.body);
    assert.ok(!serialized.includes('rowFilters') && !serialized.includes('roleMapping'), 'no enforcement config leaks');
});

test('a member with read:own still sees the table in the list; a null-role viewer does not', async () => {
    const app = makeApp();
    membership.set(`${app.id}:mem`, 'member');
    const member = await dispatch({ url: `/${app.id}/data/tables`, user: 'mem', orgIds: [ORG] });
    assert.strictEqual(member.body.tables.length, 1, 'member (read:own) can see the table');

    // roleMapping.default is 'member' here, so force a null-role model.
    const app2 = makeApp({ model: (() => { const m = baseModel(); m.roleMapping = { default: null, byGroup: {} }; return m; })() });
    const noRole = await dispatch({ url: `/${app2.id}/data/tables`, user: 'nobody', orgIds: [ORG] });
    assert.strictEqual(noRole.body.tables.length, 0, 'no-role viewer sees no tables');
});

// ── Create stamps created_by from the session ───────────────────────

test('create stamps created_by from SESSION; body created_by/id/org_id ignored', async () => {
    const app = makeApp();
    membership.set(`${app.id}:mem`, 'member');
    const r = await dispatch({
        method: 'POST',
        url: `/${app.id}/data/tables/tbl_tasks0/records`,
        user: 'mem', orgIds: [ORG],
        body: { values: { title: 'hello', created_by: 'attacker', id: 'evil-id', org_id: 'evil-org' } },
    });
    assert.strictEqual(r.statusCode, 200);
    assert.ok(r.body.id.startsWith('rec_'), 'server-generated id');
    assert.notStrictEqual(r.body.id, 'evil-id');

    // Inspect the actual row written to the engine.
    const row = memdb.prepare('SELECT * FROM tasks WHERE id = ?').get(r.body.id);
    assert.strictEqual(row.created_by, 'mem', 'created_by is the session user, not "attacker"');
    assert.strictEqual(row.org_id, ORG, 'org_id is the app org, not "evil-org"');
    assert.strictEqual(row.title, 'hello');
});

// ── RLS scoping through the route ───────────────────────────────────

test('member list is scoped to own rows; foreign rows are invisible', async () => {
    const app = makeApp();
    membership.set(`${app.id}:alice`, 'member');
    seedRow({ id: 'rec_alice', by: 'alice', title: 'mine' });
    seedRow({ id: 'rec_bob', by: 'bob', title: 'theirs' });

    const r = await dispatch({ url: `/${app.id}/data/tables/tbl_tasks0/records`, user: 'alice', orgIds: [ORG] });
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(r.body.records.map((x) => x.id), ['rec_alice']);
});

test('member updating a FOREIGN record → 404 (0 rows changed)', async () => {
    const app = makeApp();
    membership.set(`${app.id}:alice`, 'member');
    seedRow({ id: 'rec_bob', by: 'bob', title: 'theirs' });
    const r = await dispatch({
        method: 'PATCH',
        url: `/${app.id}/data/tables/tbl_tasks0/records/rec_bob`,
        user: 'alice', orgIds: [ORG],
        body: { values: { title: 'hijacked' } },
    });
    assert.strictEqual(r.statusCode, 404);
    assert.strictEqual(memdb.prepare('SELECT title FROM tasks WHERE id=?').get('rec_bob').title, 'theirs', 'row untouched');
});

test('member DELETE is forbidden (delete:none) → 403', async () => {
    const app = makeApp();
    membership.set(`${app.id}:alice`, 'member');
    seedRow({ id: 'rec_alice', by: 'alice' });
    const r = await dispatch({
        method: 'DELETE',
        url: `/${app.id}/data/tables/tbl_tasks0/records/rec_alice`,
        user: 'alice', orgIds: [ORG],
    });
    assert.strictEqual(r.statusCode, 403);
});

test('PATCH cannot set system columns (created_by stays put)', async () => {
    const app = makeApp();
    membership.set(`${app.id}:alice`, 'member');
    seedRow({ id: 'rec_alice', by: 'alice', title: 'orig' });
    const r = await dispatch({
        method: 'PATCH',
        url: `/${app.id}/data/tables/tbl_tasks0/records/rec_alice`,
        user: 'alice', orgIds: [ORG],
        body: { values: { title: 'new', created_by: 'attacker', org_id: 'evil' } },
    });
    assert.strictEqual(r.statusCode, 200);
    const row = memdb.prepare('SELECT * FROM tasks WHERE id=?').get('rec_alice');
    assert.strictEqual(row.created_by, 'alice', 'created_by not reassignable');
    assert.strictEqual(row.org_id, ORG, 'org_id not reassignable');
    assert.strictEqual(row.title, 'new');
});

// ── Export ──────────────────────────────────────────────────────────

test('export streams valid JSON with the model and EVERY row, owner-only', async () => {
    const app = makeApp();
    seedRow({ id: 'rec_alice', by: 'alice', title: 'mine' });
    seedRow({ id: 'rec_bob', by: 'bob', title: 'theirs' });

    const r = await dispatch({ url: `/${app.id}/data/export`, user: OWNER });
    assert.strictEqual(r.statusCode, 200);
    assert.match(r.headers['content-type'], /application\/json/);
    assert.match(r.headers['content-disposition'], /attachment; filename=".*-export\.json"/);

    const bundle = JSON.parse(r.text);
    assert.strictEqual(bundle.app.id, app.id);
    assert.ok(bundle.exportedAt);
    assert.ok(Array.isArray(bundle.model.tables), 'the model travels with the data');
    // The OWNER's filter is unconditional: a per-viewer slice would be a
    // silently incomplete backup.
    assert.deepStrictEqual(bundle.tables.tasks.map((x) => x.id).sort(), ['rec_alice', 'rec_bob']);
});

test('export pages beyond one keyset page without losing or repeating rows', async () => {
    const app = makeApp();
    const total = 1100; // > EXPORT_PAGE_ROWS (500)
    for (let i = 0; i < total; i++) seedRow({ id: `rec_p${String(i).padStart(4, '0')}`, by: OWNER, title: `t${i}` });

    const r = await dispatch({ url: `/${app.id}/data/export`, user: OWNER });
    const rows = JSON.parse(r.text).tables.tasks;
    assert.strictEqual(rows.length, total);
    assert.strictEqual(new Set(rows.map((x) => x.id)).size, total, 'no duplicates across pages');
});

test('export is owner-only: a member with data access gets 403', async () => {
    const app = makeApp();
    membership.set(`${app.id}:alice`, 'member');
    seedRow({ id: 'rec_alice', by: 'alice' });
    const r = await dispatch({ url: `/${app.id}/data/export`, user: 'alice', orgIds: [ORG] });
    assert.strictEqual(r.statusCode, 403);
});

// ── Optimistic concurrency (expectedUpdatedAt) ──────────────────────

test('PATCH with a MATCHING expectedUpdatedAt succeeds', async () => {
    const app = makeApp();
    membership.set(`${app.id}:alice`, 'member');
    seedRow({ id: 'rec_alice', by: 'alice', title: 'orig' });
    const before = memdb.prepare('SELECT updated_at FROM tasks WHERE id=?').get('rec_alice').updated_at;

    const r = await dispatch({
        method: 'PATCH',
        url: `/${app.id}/data/tables/tbl_tasks0/records/rec_alice`,
        user: 'alice', orgIds: [ORG],
        body: { values: { title: 'new' }, expectedUpdatedAt: before },
    });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(memdb.prepare('SELECT title FROM tasks WHERE id=?').get('rec_alice').title, 'new');
});

test('PATCH with a STALE expectedUpdatedAt → 409 record_conflict carrying the current row', async () => {
    // The bug this guards: two viewers editing one row, last write silently
    // wins. With a token the loser now learns, and gets the row that won.
    const app = makeApp();
    membership.set(`${app.id}:alice`, 'member');
    seedRow({ id: 'rec_alice', by: 'alice', title: 'orig' });

    const r = await dispatch({
        method: 'PATCH',
        url: `/${app.id}/data/tables/tbl_tasks0/records/rec_alice`,
        user: 'alice', orgIds: [ORG],
        body: { values: { title: 'mine' }, expectedUpdatedAt: '2000-01-01T00:00:00.000Z' },
    });
    assert.strictEqual(r.statusCode, 409);
    assert.strictEqual(r.body.code, 'record_conflict');
    assert.strictEqual(r.body.record.id, 'rec_alice');
    assert.strictEqual(r.body.record.title, 'orig', 'the CURRENT row travels back for the UI to show');
    assert.strictEqual(memdb.prepare('SELECT title FROM tasks WHERE id=?').get('rec_alice').title, 'orig', 'row untouched');
});

test('a stale token on an INVISIBLE row stays a 404 (never reveals existence)', async () => {
    const app = makeApp();
    membership.set(`${app.id}:alice`, 'member');
    seedRow({ id: 'rec_bob', by: 'bob', title: 'theirs' });
    const r = await dispatch({
        method: 'PATCH',
        url: `/${app.id}/data/tables/tbl_tasks0/records/rec_bob`,
        user: 'alice', orgIds: [ORG],
        body: { values: { title: 'hijacked' }, expectedUpdatedAt: '2000-01-01T00:00:00.000Z' },
    });
    assert.strictEqual(r.statusCode, 404, 'out-of-scope must not become a 409 existence oracle');
});

test('expectedUpdatedAt is an envelope field, never a column (bare-body form)', async () => {
    const app = makeApp();
    seedRow({ id: 'rec_alice', by: OWNER, title: 'orig' });
    const before = memdb.prepare('SELECT updated_at FROM tasks WHERE id=?').get('rec_alice').updated_at;
    const r = await dispatch({
        method: 'PATCH',
        url: `/${app.id}/data/tables/tbl_tasks0/records/rec_alice`,
        user: OWNER,
        body: { title: 'bare', expectedUpdatedAt: before },
    });
    assert.strictEqual(r.statusCode, 200, 'must not 422 as an unknown field');
    assert.strictEqual(memdb.prepare('SELECT title FROM tasks WHERE id=?').get('rec_alice').title, 'bare');
});

test('unknown field in a create body → 422 (not a 500)', async () => {
    const app = makeApp();
    const r = await dispatch({
        method: 'POST',
        url: `/${app.id}/data/tables/tbl_tasks0/records`,
        user: OWNER,
        body: { values: { title: 'x', ssn: '123' } },
    });
    assert.strictEqual(r.statusCode, 422);
    assert.match(r.body.error, /unknown field/);
});

// ── Aggregation query is RLS-scoped ─────────────────────────────────

test('POST /data/query aggregate folds only the viewer\'s rows', async () => {
    const app = makeApp();
    membership.set(`${app.id}:alice`, 'member');
    seedRow({ id: 'rec_a1', by: 'alice', amount: 10 });
    seedRow({ id: 'rec_a2', by: 'alice', amount: 20 });
    seedRow({ id: 'rec_b1', by: 'bob', amount: 100 });
    const r = await dispatch({
        method: 'POST',
        url: `/${app.id}/data/query`,
        user: 'alice', orgIds: [ORG],
        body: { tableId: 'tbl_tasks0', aggregate: { aggregates: [{ fn: 'sum', field: 'amount', as: 'total' }] } },
    });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body.rows[0].total, 30, 'only alice 10+20, not bob 100');
});

// ── Owner-only schema + members ─────────────────────────────────────

test('non-owner (readable viewer) cannot GET/PUT schema or touch members → 403', async () => {
    const app = makeApp();
    membership.set(`${app.id}:mem`, 'member');
    for (const [method, url, body] of [
        ['GET', `/${app.id}/schema`, undefined],
        ['PUT', `/${app.id}/schema`, { model: baseModel() }],
        ['GET', `/${app.id}/members`, undefined],
        ['POST', `/${app.id}/members`, { userId: 'x', roleKey: 'member' }],
        ['DELETE', `/${app.id}/members/x`, undefined],
    ]) {
        const r = await dispatch({ method, url, user: 'mem', orgIds: [ORG], body });
        assert.strictEqual(r.statusCode, 403, `${method} ${url} → 403`);
    }
    assert.strictEqual(saveModelCalls.length, 0, 'no model save reached the store');
    assert.strictEqual(memberMutations.length, 0, 'no member mutation reached the store');
});

test('invisible app → 404 for schema (not 403 — no existence leak)', async () => {
    const app = makeApp({ published: false });
    const r = await dispatch({ method: 'GET', url: `/${app.id}/schema`, user: 'stranger', orgIds: [ORG] });
    assert.strictEqual(r.statusCode, 404);
});

test('owner PUT schema validates rowFilters before saving', async () => {
    const app = makeApp();
    const badModel = baseModel();
    badModel.tables[0].access.rowFilters = { member: 'upper(record.title) == "X"' }; // function call → rejected
    const bad = await dispatch({ method: 'PUT', url: `/${app.id}/schema`, user: OWNER, body: { model: badModel } });
    assert.strictEqual(bad.statusCode, 422);
    assert.strictEqual(saveModelCalls.length, 0, 'invalid rowFilter never reaches saveDataModel');

    const okModel = baseModel();
    okModel.tables[0].access.rowFilters = { member: 'record.region == viewer.region' };
    const ok = await dispatch({ method: 'PUT', url: `/${app.id}/schema`, user: OWNER, body: { model: okModel } });
    assert.strictEqual(ok.statusCode, 200);
    assert.strictEqual(saveModelCalls.length, 1);
});

test('owner can add + remove members', async () => {
    const app = makeApp();
    const add = await dispatch({ method: 'POST', url: `/${app.id}/members`, user: OWNER, body: { userId: 'newbie', roleKey: 'manager' } });
    assert.strictEqual(add.statusCode, 200);
    assert.deepStrictEqual(memberMutations.at(-1), { op: 'add', appId: app.id, ownerId: OWNER, memberUserId: 'newbie', roleKey: 'manager' });
    const rem = await dispatch({ method: 'DELETE', url: `/${app.id}/members/newbie`, user: OWNER });
    assert.strictEqual(rem.statusCode, 200);
    assert.strictEqual(memberMutations.at(-1).op, 'remove');
});

test('adding a member with a roleKey NOT in the model → 422 { error:invalid_role, roleKey, validRoles }', async () => {
    const app = makeApp(); // model roles: manager, member
    const r = await dispatch({ method: 'POST', url: `/${app.id}/members`, user: OWNER, body: { userId: 'x', roleKey: 'ghost' } });
    assert.strictEqual(r.statusCode, 422);
    assert.strictEqual(r.body.error, 'invalid_role');
    assert.strictEqual(r.body.roleKey, 'ghost');
    assert.deepStrictEqual([...r.body.validRoles].sort(), ['manager', 'member']);
    assert.strictEqual(memberMutations.length, 0, 'no member row written');
});

test('omitted roleKey defaults to the built-in "member" and is accepted, even with no data model', async () => {
    const app = makeApp();
    models.delete(app.id); // no data model at all → valid roles = ['member']
    const r = await dispatch({ method: 'POST', url: `/${app.id}/members`, user: OWNER, body: { userId: 'plain' } });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(memberMutations.at(-1).roleKey, 'member');
});

// ── IDOR: every engine call carries the app OWNER as the ownerId scope ──

test('IDOR: studioAppDbStore is always called with the app OWNER as ownerId, and datastore with app.id', async () => {
    const app = makeApp(); // owner = OWNER
    membership.set(`${app.id}:alice`, 'member');
    seedRow({ id: 'rec_alice', by: 'alice' });

    await dispatch({ url: `/${app.id}/data/tables/tbl_tasks0/records`, user: 'alice', orgIds: [ORG] });
    await dispatch({
        method: 'POST', url: `/${app.id}/data/tables/tbl_tasks0/records`,
        user: 'alice', orgIds: [ORG], body: { values: { title: 'x' } },
    });
    assert.ok(dbCalls.length >= 2, 'engine was exercised');
    for (const c of dbCalls) {
        assert.strictEqual(c.ownerId, OWNER, 'per-app DB handle scoped to the app owner, never the viewer');
        assert.strictEqual(c.appId, app.id, 'scoped to this app id');
    }
});

// ── Quotas (409 quota_exceeded — frozen contract) ───────────────────

test('create at the per-table row cap → 409 { code, limit, used }, nothing written', async () => {
    const app = makeApp();
    rowCountsByApp.set(app.id, { tasks: DATA_LIMITS.MAX_ROWS_PER_TABLE });
    const r = await dispatch({
        method: 'POST', url: `/${app.id}/data/tables/tbl_tasks0/records`,
        user: OWNER, body: { values: { title: 'over' } },
    });
    assert.strictEqual(r.statusCode, 409);
    assert.strictEqual(r.body.code, 'quota_exceeded');
    assert.strictEqual(r.body.limit, DATA_LIMITS.MAX_ROWS_PER_TABLE);
    assert.strictEqual(r.body.used, DATA_LIMITS.MAX_ROWS_PER_TABLE);
    assert.ok(typeof r.body.error === 'string' && r.body.error, 'human-readable error text');
    assert.strictEqual(memdb.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0, 'no row inserted');
});

test('create at the whole-app row cap → 409 even when the target table is small', async () => {
    const app = makeApp();
    rowCountsByApp.set(app.id, { other_table: DATA_LIMITS.MAX_ROWS_PER_APP, tasks: 1 });
    const r = await dispatch({
        method: 'POST', url: `/${app.id}/data/tables/tbl_tasks0/records`,
        user: OWNER, body: { values: { title: 'over' } },
    });
    assert.strictEqual(r.statusCode, 409);
    assert.strictEqual(r.body.code, 'quota_exceeded');
    assert.strictEqual(r.body.limit, DATA_LIMITS.MAX_ROWS_PER_APP);
});

test('update at the DB byte cap → 409; the row is untouched', async () => {
    const app = makeApp();
    seedRow({ id: 'rec_o1', by: OWNER, title: 'orig' });
    dbSize = DATA_LIMITS.MAX_DB_BYTES;
    const r = await dispatch({
        method: 'PATCH', url: `/${app.id}/data/tables/tbl_tasks0/records/rec_o1`,
        user: OWNER, body: { values: { title: 'bigger' } },
    });
    assert.strictEqual(r.statusCode, 409);
    assert.strictEqual(r.body.code, 'quota_exceeded');
    assert.strictEqual(r.body.limit, DATA_LIMITS.MAX_DB_BYTES);
    assert.strictEqual(memdb.prepare('SELECT title FROM tasks WHERE id=?').get('rec_o1').title, 'orig');
});

test('delete still succeeds at every cap (the escape hatch) and decrements the row count', async () => {
    const app = makeApp();
    seedRow({ id: 'rec_full', by: OWNER });
    rowCountsByApp.set(app.id, { tasks: DATA_LIMITS.MAX_ROWS_PER_TABLE });
    dbSize = DATA_LIMITS.MAX_DB_BYTES;
    const r = await dispatch({
        method: 'DELETE', url: `/${app.id}/data/tables/tbl_tasks0/records/rec_full`, user: OWNER,
    });
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(rowBumps, [{ appId: app.id, tableKey: 'tasks', delta: -1, ownerId: OWNER }]);
});

test('row count is bumped +1 on create (best-effort bookkeeping)', async () => {
    const app = makeApp();
    const r = await dispatch({
        method: 'POST', url: `/${app.id}/data/tables/tbl_tasks0/records`,
        user: OWNER, body: { values: { title: 'counted' } },
    });
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(rowBumps, [{ appId: app.id, tableKey: 'tasks', delta: 1, ownerId: OWNER }]);
});

// ── Body caps ───────────────────────────────────────────────────────

test('oversized create body → 413', async () => {
    const app = makeApp();
    const r = await dispatch({
        method: 'POST', url: `/${app.id}/data/tables/tbl_tasks0/records`,
        user: OWNER, body: { values: { title: 'x'.repeat(70 * 1024) } },
    });
    assert.strictEqual(r.statusCode, 413);
});

// ── The organisation directory (sys_org_members) ────────────────────
//
// Every OTHER directory read on this server sits behind an admin permission.
// This one is reachable by anyone who can open a published app, so what it
// refuses matters as much as what it returns.

function directoryModel() {
    const m = baseModel();
    m.directory = { orgMembers: true };
    return m;
}

test.beforeEach(() => {
    directoryCalls.length = 0;
    directoryRows = [
        { id: 'u-1', displayName: 'Tom Smit', username: 'tom', avatarType: 'image/png' },
        { id: 'u-2', displayName: '', username: 'bea', avatarType: null },
    ];
});

test('an app that declared the directory gets its org members', async () => {
    const app = makeApp({ model: directoryModel() });
    const r = await dispatch({
        method: 'POST', url: `/${app.id}/data/query`, user: OWNER,
        body: { datasetId: 'sys_org_members' },
    });
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(r.body.rows.map((m) => m.name), ['Tom Smit', 'bea']);
    // `result` mirrors the runtime dataset contract; useAppDataSource reads it.
    assert.deepStrictEqual(r.body.result, r.body.rows);
});

test('the payload carries no e-mail — a picker needs a label, not an address book', async () => {
    const app = makeApp({ model: directoryModel() });
    const r = await dispatch({
        method: 'POST', url: `/${app.id}/data/query`, user: OWNER,
        body: { datasetId: 'sys_org_members' },
    });
    for (const m of r.body.rows) {
        assert.ok(!('email' in m), 'e-mail must not leave the server here');
    }
    assert.deepStrictEqual(Object.keys(r.body.rows[0]).sort(), ['avatarType', 'id', 'name', 'username']);
});

test('an app that did NOT declare the directory is refused', async () => {
    // Opt-in is the whole point: an AI-built app must not be able to start
    // reading colleagues without that showing up in the schema.
    const app = makeApp();
    const r = await dispatch({
        method: 'POST', url: `/${app.id}/data/query`, user: OWNER,
        body: { datasetId: 'sys_org_members' },
    });
    assert.strictEqual(r.statusCode, 403);
    assert.strictEqual(directoryCalls.length, 0, 'a refused app must not even hit the user table');
});

test('a stranger cannot read the directory through someone else’s app', async () => {
    const app = makeApp({ published: false, model: directoryModel() });
    const r = await dispatch({
        method: 'POST', url: `/${app.id}/data/query`, user: 'stranger', orgIds: [ORG],
        body: { datasetId: 'sys_org_members' },
    });
    assert.strictEqual(r.statusCode, 404);
    assert.strictEqual(directoryCalls.length, 0);
});

test('the org queried is the APP’s, never the viewer’s', async () => {
    // canReadStudioApp already requires the viewer to be in the app's org, so
    // the two agree — taking it from the app makes a cross-org read structurally
    // impossible rather than merely unlikely.
    const app = makeApp({ model: directoryModel() });
    await dispatch({
        method: 'POST', url: `/${app.id}/data/query`, user: 'mem', orgIds: [ORG, 'org-other'],
        body: { datasetId: 'sys_org_members' },
    });
    assert.deepStrictEqual(directoryCalls.map((c) => c.orgId), [ORG]);
});

test('an unknown reserved-looking dataset id is still a 404, not a directory read', async () => {
    const app = makeApp({ model: directoryModel() });
    const r = await dispatch({
        method: 'POST', url: `/${app.id}/data/query`, user: OWNER,
        body: { datasetId: 'sys_everything' },
    });
    assert.strictEqual(r.statusCode, 404);
    assert.strictEqual(directoryCalls.length, 0);
});

// ═══════════════════════════════════════════════════════════════════
// POST /:id/data/batch — many reads, one request
// ═══════════════════════════════════════════════════════════════════
//
// The batch route exists to stop a 19-binding screen from spending a third of
// the viewer's per-minute budget on one page load. What these tests protect is
// the contract that makes it SAFE to adopt: it never widens access (it runs the
// same dataReadRunner the single-read endpoints do), one bad descriptor never
// blanks the rest, and a whole-batch refusal is a refusal — never an empty
// result the client could render as "no rows".

function batch(app, reads, opts = {}) {
    return dispatch({ method: 'POST', url: `/${app.id}/data/batch`, body: { reads }, ...opts });
}

test('batch answers per read, in the shape the single endpoints use', async () => {
    const app = makeApp();
    seedRow({ id: 'r1', by: OWNER, region: 'EU', amount: 10 });
    seedRow({ id: 'r2', by: OWNER, region: 'US', amount: 5 });

    const r = await batch(app, [
        { id: 'rows', kind: 'records', tableId: 'tbl_tasks0' },
        { id: 'total', kind: 'aggregate', tableId: 'tbl_tasks0', aggregates: [{ fn: 'count', as: 'n' }] },
    ], { user: OWNER });

    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body.results.length, 2);
    const [rows, total] = r.body.results;
    assert.strictEqual(rows.ok, true);
    assert.strictEqual(rows.id, 'rows');
    assert.deepStrictEqual(rows.data.records.map((x) => x.id).sort(), ['r1', 'r2'], 'records + nextCursor, as GET .../records answers');
    assert.strictEqual(rows.data.nextCursor, null);
    assert.strictEqual(total.ok, true);
    assert.strictEqual(Number(total.data.rows[0].n), 2, 'aggregate answers { rows }, as POST /data/query does');
});

test('a batched read is RLS-scoped exactly like the single read it replaces', async () => {
    const app = makeApp();
    membership.set(`${app.id}:mem`, 'member'); // read: 'own'
    seedRow({ id: 'mine', by: 'mem' });
    seedRow({ id: 'theirs', by: 'someone-else' });

    const batched = await batch(app, [{ id: 'a', kind: 'records', tableId: 'tbl_tasks0' }], { user: 'mem', orgIds: [ORG] });
    const single = await dispatch({ url: `/${app.id}/data/tables/tbl_tasks0/records`, user: 'mem', orgIds: [ORG] });

    assert.deepStrictEqual(
        batched.body.results[0].data.records.map((x) => x.id),
        single.body.records.map((x) => x.id),
        'same rows through both doors',
    );
    assert.deepStrictEqual(batched.body.results[0].data.records.map((x) => x.id), ['mine']);
});

test('a table this role may not read is refused per read, not answered empty', async () => {
    // The distinction matters: the client degrades a 404 to an empty list, so a
    // 403 that came back as `ok: true, records: []` would look to the viewer
    // exactly like a table with nothing in it.
    const model = baseModel();
    model.tables[0].access.roles.member = { read: 'none', create: false, update: 'none', delete: 'none' };
    const app = makeApp({ model });
    membership.set(`${app.id}:noread`, 'member');
    seedRow({ id: 'r1', by: OWNER });

    const r = await batch(app, [{ id: 'a', kind: 'records', tableId: 'tbl_tasks0' }], { user: 'noread', orgIds: [ORG] });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body.results[0].ok, false);
    assert.strictEqual(r.body.results[0].status, 403);
    assert.ok(!('data' in r.body.results[0]), 'a refusal carries no data at all');
});

test('one bad descriptor does not blank the others', async () => {
    const app = makeApp();
    seedRow({ id: 'r1', by: OWNER });
    const r = await batch(app, [
        { id: 'bad', kind: 'records', tableId: 'tbl_does_not_exist' },
        { id: 'good', kind: 'records', tableId: 'tbl_tasks0' },
        { id: 'weird', kind: 'connector', connectorId: 'c1' },
        { kind: 'records', tableId: 'tbl_tasks0' },
    ], { user: OWNER });

    assert.strictEqual(r.statusCode, 200, 'the transport always succeeds once the app resolves');
    const byId = Object.fromEntries(r.body.results.map((x) => [x.id, x]));
    assert.strictEqual(byId.bad.status, 404);
    assert.strictEqual(byId.good.ok, true);
    assert.strictEqual(byId.good.data.records.length, 1);
    assert.strictEqual(byId.weird.status, 400, 'connectors are not a read kind — other router, other limiter, side effects');
    assert.strictEqual(r.body.results[3].status, 400, 'an unaddressable read is reported, never silently dropped');
});

test('an invisible app refuses the WHOLE batch — the client must downgrade, not render empty', async () => {
    const app = makeApp({ published: false });
    const r = await batch(app, [{ id: 'a', kind: 'records', tableId: 'tbl_tasks0' }], { user: 'stranger', orgIds: [ORG] });
    assert.strictEqual(r.statusCode, 404);
    assert.ok(!Array.isArray(r.body.results), 'no results array: the client cannot mistake this for data');
});

test('every batched query still carries the app OWNER as the data-engine scope', async () => {
    const app = makeApp();
    membership.set(`${app.id}:mem`, 'member');
    seedRow({ id: 'r1', by: 'mem' });
    dbCalls.length = 0;
    await batch(app, [
        { id: 'a', kind: 'records', tableId: 'tbl_tasks0' },
        { id: 'b', kind: 'aggregate', tableId: 'tbl_tasks0', aggregates: [{ fn: 'count', as: 'n' }] },
    ], { user: 'mem', orgIds: [ORG] });
    assert.ok(dbCalls.length >= 2);
    assert.ok(dbCalls.every((c) => c.ownerId === OWNER), 'never the viewer — IDOR guard');
});

test('the batch is capped, and an empty one is free', async () => {
    const app = makeApp();
    const tooMany = Array.from({ length: 26 }, (_, i) => ({ id: `r${i}`, kind: 'records', tableId: 'tbl_tasks0' }));
    const over = await batch(app, tooMany, { user: OWNER });
    assert.strictEqual(over.statusCode, 400);

    const empty = await batch(app, [], { user: OWNER });
    assert.strictEqual(empty.statusCode, 200);
    assert.deepStrictEqual(empty.body.results, []);

    const notAnArray = await dispatch({ method: 'POST', url: `/${app.id}/data/batch`, body: { reads: 'all' }, user: OWNER });
    assert.strictEqual(notAnArray.statusCode, 400);
});

test('the descriptor budget bites before 60 batches of 25 can become 1500 queries', async () => {
    // Twelve full batches spend the 300-read window; the thirteenth is refused
    // even though it is only the thirteenth REQUEST of a 60-request budget.
    const app = makeApp();
    const full = Array.from({ length: 25 }, (_, i) => ({ id: `r${i}`, kind: 'aggregate', tableId: 'tbl_tasks0', aggregates: [{ fn: 'count', as: 'n' }] }));
    for (let i = 0; i < 12; i++) {
        const r = await batch(app, full, { user: OWNER });
        assert.strictEqual(r.statusCode, 200, `batch ${i + 1} of 12 is within budget`);
    }
    const denied = await batch(app, [{ id: 'one-more', kind: 'records', tableId: 'tbl_tasks0' }], { user: OWNER });
    assert.strictEqual(denied.statusCode, 429);
    assert.ok(denied.headers['retry-after'], 'and says how long to wait');
});

test('a platform dataset is refused loudly in a batch, never degraded to empty', async () => {
    // The client excludes sys_* from batching, but a 404 here would come back
    // as an empty people-picker rather than an error — so the route refuses it
    // with a status the client cannot mistake for "no rows".
    const app = makeApp({ model: directoryModel() });
    const r = await batch(app, [{ id: 'dir', kind: 'dataset', datasetId: 'sys_org_members' }], { user: OWNER });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body.results[0].status, 400);
    assert.strictEqual(directoryCalls.length, 0, 'and the directory is never read through this door');
});
