/**
 * RLS gateway — the ACCESS MATRIX, exercised against a REAL in-memory SQLite.
 *
 * Seeds a `tasks` table owned across two members (alice, bob) and a manager
 * (carol), then compiles gateway access filters + query-compiler SQL and RUNS
 * them, asserting the row-level truth:
 *   • member reads/updates/deletes ONLY own rows; manager all;
 *   • cross-viewer update/delete changes 0 rows (→ 404);
 *   • a member's COUNT/SUM folds only own rows (no aggregate leakage);
 *   • a `record.region == viewer.region` row filter scopes with viewer.region
 *     bound as a param;
 *   • assertCanWrite blocks a role whose permission is false/none;
 *   • resolveViewerRole: owner → 'owner', member/manager via membership,
 *     group mapping, default mapping, else null.
 *
 * Run: cd server && node --test appStudio/rlsGateway.matrix.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

// Membership lookups drive resolveViewerRole — stub the PG store BEFORE the
// gateway loads it (the real module opens a live PG connection at require time).
const membership = new Map(); // userId → role_key
const filename = require.resolve('../stores/studioAppDataStore');
require.cache[filename] = {
    id: filename, filename, loaded: true,
    exports: { getMemberRole: async (appId, userId) => membership.get(userId) || null },
};

const gateway = require('./rlsGateway');
const qc = require('./queryCompiler');

// ── Model ───────────────────────────────────────────────────────────
function makeModel(rowFilters = {}) {
    return {
        modelVersion: 1,
        roles: [{ key: 'manager' }, { key: 'member' }],
        roleMapping: { default: null, byGroup: {} },
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
                rowFilters,
            },
        }],
    };
}

// ── In-memory DB seeded with cross-owner rows ───────────────────────
function seedDb() {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE tasks (
        id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT, created_by TEXT, org_id TEXT,
        title TEXT, region TEXT, amount INTEGER
    )`);
    const ins = db.prepare(`INSERT INTO tasks (id, created_at, updated_at, created_by, org_id, title, region, amount)
        VALUES (?,?,?,?,?,?,?,?)`);
    const rows = [
        ['rec_a1', '2026-01-01T00:00:00.000Z', 'alice', 'EU', 'A1', 10],
        ['rec_a2', '2026-01-02T00:00:00.000Z', 'alice', 'US', 'A2', 20],
        ['rec_b1', '2026-01-03T00:00:00.000Z', 'bob', 'EU', 'B1', 30],
        ['rec_c1', '2026-01-04T00:00:00.000Z', 'carol', 'EU', 'C1', 40],
    ];
    for (const [id, ts, by, region, title, amount] of rows) {
        ins.run(id, ts, ts, by, 'org1', title, region, amount);
    }
    return db;
}

// Run compiled SQL against the seeded DB (booleans → 0/1 like the store).
function run(db, sql, params) {
    const norm = params.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v));
    const stmt = db.prepare(sql);
    return stmt.reader ? stmt.all(...norm) : stmt.run(...norm);
}

const ALICE = { id: 'alice', region: 'EU' };
const CAROL = { id: 'carol', region: 'EU' };
const table = () => makeModel().tables[0];

// ── READ scoping ────────────────────────────────────────────────────

test('member lists ONLY own rows; manager lists all', () => {
    const db = seedDb();
    const t = table();

    const memberAf = gateway.compileAccessFilter(t, 'member', ALICE, 'read');
    const ml = qc.compileRecordList(t, {}, memberAf);
    const memberRows = run(db, ml.sql, ml.params);
    assert.deepStrictEqual(memberRows.map((r) => r.id).sort(), ['rec_a1', 'rec_a2']);

    const mgrAf = gateway.compileAccessFilter(t, 'manager', CAROL, 'read');
    const gl = qc.compileRecordList(t, {}, mgrAf);
    const mgrRows = run(db, gl.sql, gl.params);
    assert.strictEqual(mgrRows.length, 4, 'manager sees every row');
});

test('member get-one: own row visible, foreign row hidden (→ 404)', () => {
    const db = seedDb();
    const t = table();
    const af = gateway.compileAccessFilter(t, 'member', ALICE, 'read');

    const own = qc.compileGetById(t, 'rec_a1', af);
    assert.strictEqual(run(db, own.sql, own.params).length, 1);

    const foreign = qc.compileGetById(t, 'rec_b1', af);
    assert.strictEqual(run(db, foreign.sql, foreign.params).length, 0, "bob's row invisible to alice");
});

// ── UPDATE scoping (cross-viewer → 0 rows) ──────────────────────────

test('member updates own row (1) but not a foreign row (0 → 404)', () => {
    const db = seedDb();
    const t = table();
    const af = gateway.compileAccessFilter(t, 'member', ALICE, 'update');

    const own = qc.compileUpdate(t, 'rec_a1', { title: 'edited' }, af);
    assert.strictEqual(run(db, own.sql, own.params).changes, 1);

    const foreign = qc.compileUpdate(t, 'rec_b1', { title: 'hijack' }, af);
    assert.strictEqual(run(db, foreign.sql, foreign.params).changes, 0, 'cross-viewer update blocked');
    // bob's row is untouched.
    assert.strictEqual(db.prepare('SELECT title FROM tasks WHERE id=?').get('rec_b1').title, 'B1');
});

test('manager updates any row', () => {
    const db = seedDb();
    const t = table();
    const af = gateway.compileAccessFilter(t, 'manager', CAROL, 'update');
    const upd = qc.compileUpdate(t, 'rec_a1', { title: 'mgr-edit' }, af);
    assert.strictEqual(run(db, upd.sql, upd.params).changes, 1);
});

// ── DELETE gating ───────────────────────────────────────────────────

test('member delete is forbidden (delete:none) → assertCanWrite throws 403', () => {
    const t = table();
    assert.throws(() => gateway.assertCanWrite(t, 'member', 'delete'), (e) => e.status === 403);
});

test('manager deletes any row; the SQL is access-scoped', () => {
    const db = seedDb();
    const t = table();
    const scope = gateway.assertCanWrite(t, 'manager', 'delete');
    assert.strictEqual(scope, 'all');
    const af = gateway.compileAccessFilter(t, 'manager', CAROL, 'delete');
    const del = qc.compileDelete(t, 'rec_a1', af);
    assert.strictEqual(run(db, del.sql, del.params).changes, 1);
});

test('a member CAN create but a foreign-owned update still 0-rows', () => {
    const t = table();
    assert.strictEqual(gateway.assertCanWrite(t, 'member', 'create'), true);
    assert.strictEqual(gateway.assertCanWrite(t, 'member', 'update'), 'own');
});

// ── Aggregate leakage ───────────────────────────────────────────────

test('member COUNT/SUM folds ONLY own rows (no aggregate leakage)', () => {
    const db = seedDb();
    const t = table();
    const af = gateway.compileAccessFilter(t, 'member', ALICE, 'read');
    const agg = qc.compileAggregate(t, {
        aggregates: [{ fn: 'count', as: 'n' }, { fn: 'sum', field: 'amount', as: 'total' }],
    }, af);
    const [row] = run(db, agg.sql, agg.params);
    assert.strictEqual(row.n, 2, 'alice has 2 rows');
    assert.strictEqual(row.total, 30, 'sum folds only alice rows (10+20), not bob/carol');

    const mgrAf = gateway.compileAccessFilter(t, 'manager', CAROL, 'read');
    const gAgg = qc.compileAggregate(t, { aggregates: [{ fn: 'sum', field: 'amount', as: 'total' }] }, mgrAf);
    assert.strictEqual(run(db, gAgg.sql, gAgg.params)[0].total, 100, 'manager sum spans all rows');
});

// ── Row filter (record.<field> == viewer.<attr>) ────────────────────

test('rowFilter record.region == viewer.region scopes rows, binding viewer.region as a param', () => {
    const db = seedDb();
    const model = makeModel({ member: 'record.region == viewer.region' });
    const t = model.tables[0];

    // alice (EU) with own+rowfilter → own EU rows only (rec_a1).
    const af = gateway.compileAccessFilter(t, 'member', { id: 'alice', region: 'EU' }, 'read');
    assert.ok(af.where.includes('"created_by" = ?'), 'own scope present');
    assert.ok(af.where.includes('"region" = ?'), 'row filter column present');
    assert.ok(af.params.includes('EU'), 'viewer.region bound as a param');

    const list = qc.compileRecordList(t, {}, af);
    const rows = run(db, list.sql, list.params);
    assert.deepStrictEqual(rows.map((r) => r.id), ['rec_a1'], 'alice sees only her EU row, not her US row');

    // A manager row filter can narrow an otherwise-"all" manager too.
    const model2 = makeModel({ manager: 'record.region == viewer.region' });
    const t2 = model2.tables[0];
    const mgrAf = gateway.compileAccessFilter(t2, 'manager', { id: 'carol', region: 'EU' }, 'read');
    const l2 = qc.compileRecordList(t2, {}, mgrAf);
    const rows2 = run(db, l2.sql, l2.params).map((r) => r.id).sort();
    assert.deepStrictEqual(rows2, ['rec_a1', 'rec_b1', 'rec_c1'], 'manager+rowFilter sees all EU rows across owners');
});

test('rowFilter with a bogus field is rejected by validateRowFilter (save-time gate)', () => {
    const t = table();
    assert.strictEqual(gateway.validateRowFilter('record.region == viewer.region', t).ok, true);
    const bad = gateway.validateRowFilter('upper(record.title) == "X"', t);
    assert.strictEqual(bad.ok, false);
    assert.match(bad.errors[0], /row filter/i);
    assert.strictEqual(gateway.validateRowFilter('record.ghost == 1', t).ok, false);
});

// ── Scope defaults ──────────────────────────────────────────────────

test('a role with no table entry falls back to access.default (none = deny)', () => {
    const t = table(); // default:'none'
    const af = gateway.compileAccessFilter(t, 'stranger', { id: 'x' }, 'read');
    assert.strictEqual(af.where, '1=0', 'unknown role denied by default:none');
    assert.throws(() => gateway.assertCanWrite(t, 'stranger', 'update'), (e) => e.status === 403);
});

test('null role → deny (1=0) and no write', () => {
    const t = table();
    const af = gateway.compileAccessFilter(t, null, { id: 'x' }, 'read');
    assert.strictEqual(af.where, '1=0');
    assert.throws(() => gateway.assertCanWrite(t, null, 'create'), (e) => e.status === 403);
});

// ── Viewer role resolution ──────────────────────────────────────────

test('resolveViewerRole: owner → owner; membership; group mapping; default; else null', async () => {
    membership.clear();
    membership.set('carol', 'manager');
    membership.set('alice', 'member');

    const app = { id: 'app1', userId: 'owner1' };

    assert.strictEqual(await gateway.resolveViewerRole(app, 'owner1', makeModel(), {}), 'owner');
    assert.strictEqual(await gateway.resolveViewerRole(app, 'carol', makeModel(), {}), 'manager');
    assert.strictEqual(await gateway.resolveViewerRole(app, 'alice', makeModel(), {}), 'member');

    // group mapping ∩ viewer groups
    const groupModel = makeModel();
    groupModel.roleMapping = { default: null, byGroup: { g_sales: 'member' } };
    assert.strictEqual(await gateway.resolveViewerRole(app, 'dave', groupModel, { userGroups: ['g_sales'] }), 'member');
    assert.strictEqual(await gateway.resolveViewerRole(app, 'dave', groupModel, { userGroups: ['g_other'] }), null);

    // default mapping
    const defModel = makeModel();
    defModel.roleMapping = { default: 'member', byGroup: {} };
    assert.strictEqual(await gateway.resolveViewerRole(app, 'ellen', defModel, {}), 'member');

    // no membership, no group, no default → null (no access)
    assert.strictEqual(await gateway.resolveViewerRole(app, 'frank', makeModel(), {}), null);
});

// ── Deleted-role members (Wave 1b regression) ───────────────────────

test('a member row holding a role DELETED from the model is denied — the stale key falls to the table default, never to privilege', async () => {
    membership.clear();
    membership.set('gina', 'ghost'); // 'ghost' was removed from model.roles
    const app = { id: 'app1', userId: 'owner1' };
    const model = makeModel();
    model.roleMapping = { default: 'member', byGroup: {} };

    // The stale membership row still resolves to its recorded key (membership
    // wins over roleMapping.default)…
    const role = await gateway.resolveViewerRole(app, 'gina', model, {});
    assert.strictEqual(role, 'ghost');

    // …but the access matrix has no entry for it, so every action falls back
    // to access.default ('none' here) = deny. A deleted role must never grant
    // more than the table default.
    const t = model.tables[0];
    const af = gateway.compileAccessFilter(t, role, { id: 'gina' }, 'read');
    assert.strictEqual(af.where, '1=0', 'deleted role reads nothing');

    const db = seedDb();
    const list = qc.compileRecordList(t, {}, af);
    assert.strictEqual(run(db, list.sql, list.params).length, 0, 'no rows leak to a deleted role');

    for (const action of ['create', 'update', 'delete']) {
        assert.throws(() => gateway.assertCanWrite(t, role, action), (e) => e.status === 403, `${action} denied`);
    }
});

// ── A LINKED Studio datatable, with the app role's row rule ─────────
//
// The path a playbook's app takes: the data lives in a Studio datatable, so
// appStudio/datatableSource.js replaces the model's access block with the
// datatable's own grade ladder (`synthesizeAccess`) — and until 2026-09-16 it
// dropped the model's row filters on the floor while doing it. These two tests
// run the SQL that comes out of the combination, so "the rule is applied" is a
// row count and not a hopeful comment.
const { synthesizeAccess } = require('../auth/datatableAccess');

/** tableMeta exactly as resolveDatatableSource builds it for a linked table. */
function linkedMeta(rule, grade = 'viewer') {
    const t = table();
    const datatableRow = { row_scope: 'all' };
    const access = synthesizeAccess(datatableRow);
    return {
        ...t,
        access: rule ? { ...access, rowFilters: { [grade]: rule } } : access,
    };
}

test('LINKED table: the app role’s row rule narrows what the viewer sees', () => {
    const db = seedDb();
    const meta = linkedMeta('record.region == "US"');
    const af = gateway.compileAccessFilter(meta, 'viewer', { id: 'alice', role: 'viewer' }, 'read');
    const q = qc.compileRecordList(meta, {}, af);
    const rows = run(db, q.sql, q.params);
    assert.deepStrictEqual(rows.map((r) => r.id), ['rec_a2'], 'only the US row, across all owners');
    // The literal is BOUND, never interpolated.
    assert.ok(q.params.includes('US'), 'the value rides as a parameter');
    assert.doesNotMatch(q.sql, /'US'/, 'and never as text in the SQL');
});

test('LINKED table without a rule: every row the grade allows — byte for byte as before', () => {
    const db = seedDb();
    const meta = linkedMeta(null);
    const af = gateway.compileAccessFilter(meta, 'viewer', { id: 'alice', role: 'viewer' }, 'read');
    const q = qc.compileRecordList(meta, {}, af);
    assert.strictEqual(run(db, q.sql, q.params).length, 4, 'a viewer on row_scope "all" still sees everything');
});

test('LINKED table: the rule also folds aggregates, so a count cannot leak what a list hides', () => {
    const db = seedDb();
    const meta = linkedMeta('record.region == "US"');
    const af = gateway.compileAccessFilter(meta, 'viewer', { id: 'alice', role: 'viewer' }, 'read');
    const agg = qc.compileAggregate(meta, { aggregates: [{ fn: 'count', field: '*', as: 'n' }, { fn: 'sum', field: 'amount', as: 'total' }] }, af);
    const [row] = run(db, agg.sql, agg.params);
    assert.strictEqual(Number(row.n), 1);
    assert.strictEqual(Number(row.total), 20, 'the other three rows are not summed');
});

test('LINKED table: a row rule never WIDENS — own-scope still bites under it', () => {
    const db = seedDb();
    const t = table();
    // row_scope 'own' on the datatable + a rule that would match three rows:
    // the viewer still sees only their own.
    const access = synthesizeAccess({ row_scope: 'own' });
    const meta = { ...t, access: { ...access, rowFilters: { viewer: 'record.region == "EU"' } } };
    const af = gateway.compileAccessFilter(meta, 'viewer', { id: 'alice', role: 'viewer' }, 'read');
    const q = qc.compileRecordList(meta, {}, af);
    assert.deepStrictEqual(run(db, q.sql, q.params).map((r) => r.id), ['rec_a1'],
        'AND, never OR: own-scope and the rule both hold');
});
