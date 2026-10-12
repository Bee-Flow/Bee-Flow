'use strict';

/**
 * `/api/datatables`, END TO END, against a REAL Postgres.
 *
 * routes/datatables.test.js reads this router with fs.readFileSync and matches
 * regexes against it. It pins invariants no behavioural test catches — 404 not
 * 403, no `SELECT … FROM` string in the router, `dialect: 'pg'` stated at every
 * compile — and by construction it cannot see a wrong row, a missing column, a
 * counter that drifted or a probe row that leaked into the response. It passes
 * because the source says the right words.
 *
 * This file drives the same handlers against a live database: the genuine
 * store, the genuine pgAppEngine, the genuine migration planner and the genuine
 * query compiler, over @electric-sql/pglite (real Postgres, WASM, in-process —
 * already a devDependency, already the harness under stores/lib/pgAppEngine
 * .test.js). It ALWAYS runs: no service container, no self-skip. See
 * stores/datatableDbStore.integration.test.js for the storage-layer half.
 *
 * Mocked: the gate chain (accessRegistry and the regex suite freeze it) and
 * `users` (routes/datatables.principal.test.js is the resolver's own suite).
 * Everything from datatableStore down is real.
 *
 * Handlers are invoked directly rather than over HTTP — the same require.cache
 * + route-stack technique routes/datatables.principal.test.js uses, so the
 * route-level gate still runs.
 *
 * Run: cd server && node --test --test-force-exit routes/datatables.integration.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const SERVER = path.resolve(__dirname, '..');

// ── A db.js facade over one pglite connection ───────────────────────────────

// Constructed before the stores are required: every store in the require graph
// kicks off its own createSchema at load time, and a null handle there fills
// the output with unrelated init errors. The constructor returns immediately;
// the first query awaits readiness.
const { PGlite } = require('@electric-sql/pglite');
const pg = new PGlite();

function adaptResult(res, sql) {
    const r = Array.isArray(res) ? (res[res.length - 1] || {}) : (res || {});
    const rows = r.rows || [];
    const fields = r.fields || [];
    const command = fields.length > 0 ? 'SELECT' : String(sql).trim().split(/\s+/)[0].toUpperCase();
    const rowCount = fields.length > 0
        ? rows.length
        : (typeof r.affectedRows === 'number' ? r.affectedRows : 0);
    return { rows, fields, rowCount, command };
}

async function rawQuery(sql, params) {
    if (Array.isArray(params) && params.length > 0) return adaptResult(await pg.query(sql, params), sql);
    if (/;\s*\S/.test(String(sql).trim())) return adaptResult(await pg.exec(sql), sql);
    return adaptResult(await pg.query(sql), sql);
}

// pglite is ONE connection, so every "client" is that connection and these
// tests must stay sequential — two overlapping transactions would interleave.
const client = { query: (sql, params) => rawQuery(sql, params), release: () => {} };

function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

mock(path.join(SERVER, 'db.js'), {
    pool: { query: rawQuery, connect: async () => client },
    run: rawQuery,
    getOne: async (sql, params) => (await rawQuery(sql, params)).rows[0] || null,
    getAll: async (sql, params) => (await rawQuery(sql, params)).rows,
    exec: (sql) => rawQuery(sql, []),
    getClient: async () => client,
    withTransaction: async (fn) => {
        await client.query('BEGIN');
        try {
            const out = await fn(client);
            await client.query('COMMIT');
            return out;
        } catch (e) {
            try { await client.query('ROLLBACK'); } catch { /* already aborted */ }
            throw e;
        }
    },
    makeStoreInit: (tag, schemaFn) => {
        let promise = null;
        return function ensureInit() {
            if (!promise) promise = Promise.resolve().then(schemaFn).catch((err) => { promise = null; throw err; });
            return promise;
        };
    },
    getRedis: () => null,
    redisHealthy: () => false,
    isSqlStateError: (e) => typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code),
});

// ── The `users` table the principal resolver reads ──────────────────────────

const ORG = 'org-routes-a';
const OWNER = 'u-owner';
const COLLEAGUE = 'u-colleague';

const USERS = {
    [OWNER]: { id: OWNER, organizationId: ORG, orgRole: 'member', groups: [] },
    [COLLEAGUE]: { id: COLLEAGUE, organizationId: ORG, orgRole: 'member', groups: [] },
    // The account with no organisation at all — a first-class supported state.
    'u-loner': { id: 'u-loner', organizationId: '', orgRole: null, groups: [] },
};
mock(path.join(SERVER, 'stores/userStore'), {
    getUser: async (id) => USERS[id] || null,
    getAllGroups: async () => [],
});
mock(path.join(SERVER, 'stores/projectStore'), {});

// ── The gate chain, which is not what this file is about ────────────────────

const pass = () => (req, res, next) => next();
mock(path.join(SERVER, 'auth'), {
    requirePermission: pass,
    requireActiveOrgForMutations: pass,
    assertUserCanUseOrg: async () => true,
    validateSharedGroupsForOrg: async (_req, groups) => groups || [],
    hasPermission: async () => true,
    Permissions: { MANAGE_DATATABLES: 'manage_datatables' },
});
mock(path.join(SERVER, 'core/entitlements/betaFeatures'), { requireBetaFeature: pass });
mock(path.join(SERVER, 'core/entitlements/entitlements'), { requireCapability: pass });
mock(path.join(SERVER, 'utils/perUserRateLimit'), { perUserRateLimit: pass });

const router = require('./datatables');
const datatableStore = require('../stores/datatableStore');
const datatableDbStore = require('../stores/datatableDbStore');

// The physical schema name is a hash of the scope, not 'dtorg_' + the id — see
// the schemaNameFor header in datatableDbStore.js. Every ground-truth read below
// asks the store for the name rather than spelling it out, so a rename of the
// naming rule cannot leave these probes silently looking at nothing.
const schemaOf = (orgId) => datatableDbStore.schemaNameFor('org', orgId);
const SC = datatableStore.orgScope(ORG);

// ── Harness ─────────────────────────────────────────────────────────────────

const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function routeStack(method, routePath) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
            return layer.route.stack.map(l => l.handle);
        }
    }
    throw new Error(`route not found: ${method} ${routePath}`);
}

/**
 * Run every handler of one route in order, stopping at the first that answers.
 * requireDatatableGrade is route-level middleware, so a test that only invoked
 * the last handler would skip the gate it is checking.
 *
 * `next(err)` is not `next()`, and the difference matters as much as the gate:
 * a request schema refuses by handing the error on (core/http/validate), so a
 * harness that read any next() as "carry on" would run the handler anyway and
 * report a 200 for a request the real server had already refused. The terminal
 * handler sits behind the stack here exactly as it does in index.js.
 */
async function call(method, routePath, req) {
    const res = { statusCode: 200, body: null, sent: false, headers: {}, text: '', headersSent: false };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; res.sent = true; return res; };
    // The streaming half — GET /:id/rows.csv writes its answer rather than
    // handing back one object, and its error path turns on headersSent.
    res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = v; return res; };
    res.write = (chunk) => { res.headersSent = true; res.text += chunk; return true; };
    res.end = () => { res.sent = true; return res; };
    const full = { params: {}, query: {}, body: {}, headers: {}, ...req };
    for (const handle of routeStack(method, routePath)) {
        let advanced = false;
        let failed = null;
        await handle(full, res, (err) => { advanced = true; failed = err || null; });
        if (failed) { terminalErrorHandler(failed, full, res, () => {}); break; }
        if (res.sent || !advanced) break;
    }
    return res;
}

/** The returning-user session shape: an id, and nothing else. */
const as = (userId, over = {}) => ({ session: { user: { id: userId } }, ...over });

/** Rows straight out of Postgres, bypassing every layer under test. */
async function realRows(orgId, key) {
    return (await rawQuery(`SELECT * FROM "${schemaOf(orgId)}"."${key}" ORDER BY "created_at"`)).rows;
}

/**
 * A timestamp as the optimistic token spells it. pglite hands TIMESTAMPTZ back
 * as a Date while the compiler binds and compares the ISO STRING it stamped, so
 * a test that passed the Date through would be comparing two different things.
 */
const isoOf = (v) => (v instanceof Date ? v.toISOString() : String(v));

let tableId = null;

before(async () => {
    await pg.exec("SET TIME ZONE 'UTC'");
    await datatableStore.initDB();
    // listUsage LEFT JOINs `automations` to name the automation in the refusal,
    // and reads its definition (step position and type) and last run.
    // automationStore owns that DDL and is not in this router's require graph,
    // so the columns the join reads are created here — without them every
    // destructive-change guard answers 500 instead of asking its question.
    // `studio_apps` and `webpages` are the other two consumer kinds; listUsage
    // probes for them and joins only what exists, so they are created here to
    // exercise the joined form.
    await pg.exec(`CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY, user_id TEXT, title TEXT, definition_json JSONB, last_run_at TIMESTAMPTZ)`);
    await pg.exec('CREATE TABLE IF NOT EXISTS studio_apps (id TEXT PRIMARY KEY, user_id TEXT, name TEXT)');
    await pg.exec('CREATE TABLE IF NOT EXISTS webpages (id TEXT PRIMARY KEY, user_id TEXT, name TEXT)');
});

after(async () => { await pg.close(); });

// ── Create ──────────────────────────────────────────────────────────────────

test('POST / creates the metadata AND the physical Postgres table', async () => {
    const res = await call('post', '/', as(OWNER, {
        body: {
            name: 'Customers', key: 'customers', description: 'the customer list',
            fields: [
                { key: 'email', name: 'E-mail', type: 'text' },
                { key: 'status', name: 'Status', type: 'text' },
            ],
        },
    }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    tableId = res.body.datatable.id;
    assert.strictEqual(res.body.datatable.grade, 'owner');
    assert.strictEqual(res.body.datatable.rowCount, 0);

    // The route answers 200 whether or not the DDL ran; ask Postgres instead.
    const cols = await rawQuery(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'customers' ORDER BY ordinal_position`, [schemaOf(ORG)]);
    assert.deepStrictEqual(cols.rows.map(r => r.column_name),
        ['id', 'created_at', 'updated_at', 'created_by', 'org_id', 'email', 'status']);
});

test('the projection never carries the access rules to the client', async () => {
    const res = await call('get', '/:id', as(OWNER, { params: { id: tableId } }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.datatable.access, undefined);
    assert.strictEqual(res.body.datatable.rowFilters, undefined);
});

// ── Schema edits ────────────────────────────────────────────────────────────

test('PUT /:id/schema ALTERs the real table and keeps the existing column ids', async () => {
    const before = await call('get', '/:id/schema', as(OWNER, { params: { id: tableId } }));
    const priorIds = before.body.fields.map(f => f.id);

    const res = await call('put', '/:id/schema', as(OWNER, {
        params: { id: tableId },
        body: {
            expectedVersion: before.body.modelVersion,
            fields: [
                ...before.body.fields,
                { key: 'score', name: 'Score', type: 'number' },
            ],
        },
    }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    // A re-minted id reads to the planner as "drop that column, add this one" —
    // a DROP COLUMN against live rows on a save that only added one.
    assert.deepStrictEqual(res.body.fields.slice(0, priorIds.length).map(f => f.id), priorIds);

    const cols = await rawQuery(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'customers'`, [schemaOf(ORG)]);
    assert.ok(cols.rows.some(r => r.column_name === 'score'), 'the ALTER must actually have run');
});

test('a stale expectedVersion is a 409 and changes nothing', async () => {
    const before = await call('get', '/:id/schema', as(OWNER, { params: { id: tableId } }));
    const res = await call('put', '/:id/schema', as(OWNER, {
        params: { id: tableId },
        body: { expectedVersion: 0, fields: [{ key: 'only_this', name: 'Only', type: 'text' }] },
    }));
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'version_conflict');

    const after = await call('get', '/:id/schema', as(OWNER, { params: { id: tableId } }));
    assert.deepStrictEqual(after.body.fields.map(f => f.key), before.body.fields.map(f => f.key),
        'a conflict that had already written the model would be worse than no check at all');
});

test('dropping a column an automation still reads is refused until the owner confirms', async () => {
    // listUsageForColumn is the index written for exactly this question and had
    // no caller for a while: a dropped column breaks somebody else's automation
    // silently, at 3am.
    await rawQuery(`INSERT INTO automations (id, user_id, title) VALUES ($1,$2,$3)`,
        ['auto_1', COLLEAGUE, 'Nightly sync']);
    const written = await datatableStore.reconcileUsage('auto_1', SC, [
        { datatableId: tableId, stepId: 's1', mode: 'read', columns: ['score'] },
    ]);
    assert.strictEqual(written, 1, 'the guarded INSERT writes nothing when the org is wrong');

    const current = await call('get', '/:id/schema', as(OWNER, { params: { id: tableId } }));
    const without = current.body.fields.filter(f => f.key !== 'score');

    const refused = await call('put', '/:id/schema', as(OWNER, {
        params: { id: tableId },
        body: { expectedVersion: current.body.modelVersion, fields: without },
    }));
    assert.strictEqual(refused.statusCode, 409, JSON.stringify(refused.body));
    assert.strictEqual(refused.body.code, 'breaking_change');
    assert.deepStrictEqual(refused.body.breaking.map(b => [b.column, b.automationTitle]), [['score', 'Nightly sync']]);

    // And the column is still there: a guard that answers 409 after the DDL ran
    // would be worse than none.
    const cols = await rawQuery(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'customers'`, [schemaOf(ORG)]);
    assert.ok(cols.rows.some(r => r.column_name === 'score'));

    // A rename keeps the field id, so it is not a drop and is not refused.
    const renamed = current.body.fields.map(f => f.key === 'score' ? { ...f, name: 'Points' } : f);
    const ok = await call('put', '/:id/schema', as(OWNER, {
        params: { id: tableId },
        body: { expectedVersion: current.body.modelVersion, fields: renamed },
    }));
    assert.strictEqual(ok.statusCode, 200, JSON.stringify(ok.body));

    await datatableStore.reconcileUsage('auto_1', SC, []);
});

// ── Rows ────────────────────────────────────────────────────────────────────

test('POST /:id/rows writes a real row and moves row_count', async () => {
    for (const email of ['a@b.c', 'd@e.f', 'g@h.i']) {
        const res = await call('post', '/:id/rows', as(OWNER, {
            params: { id: tableId }, body: { values: { email, status: 'new', score: 1 } },
        }));
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    }
    const rows = await realRows(ORG, 'customers');
    assert.strictEqual(rows.length, 3);
    assert.strictEqual(rows[0].created_by, OWNER, 'compileInsert stamps the writer, the client never can');
    assert.strictEqual(rows[0].org_id, ORG);

    const t = await datatableStore.getDatatable(tableId, SC);
    assert.strictEqual(t.rowCount, 3);
});

test('GET /:id/rows slices the cursor probe row off the response', async () => {
    // compileRecordList deliberately asks for limit+1. A caller that forgets to
    // slice returns a row the page did not ask for — stepDataSource records the
    // day one leaked into an AI prompt.
    const res = await call('get', '/:id/rows', as(OWNER, { params: { id: tableId }, query: { limit: '2' } }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.rows.length, 2);
    assert.strictEqual(res.body.count, 2);
    assert.strictEqual(res.body.hasMore, true);

    const all = await call('get', '/:id/rows', as(OWNER, { params: { id: tableId }, query: { limit: '50' } }));
    assert.strictEqual(all.body.rows.length, 3);
    assert.strictEqual(all.body.hasMore, false);
});

test('deleting a row that is not there is a 404 and does NOT move row_count', async () => {
    // bumpAfterWrite clamps at zero, so N unconditional decrements walk a full
    // table's row_count down to 0 — and the quota check then passes for ever.
    const res = await call('delete', '/:id/rows/:rowId', as(OWNER, {
        params: { id: tableId, rowId: 'rec_does_not_exist' },
    }));
    assert.strictEqual(res.statusCode, 404);
    const t = await datatableStore.getDatatable(tableId, SC);
    assert.strictEqual(t.rowCount, 3);
});

test('deleting a real row removes it and decrements the counter to match COUNT(*)', async () => {
    const rows = await realRows(ORG, 'customers');
    const res = await call('delete', '/:id/rows/:rowId', as(OWNER, {
        params: { id: tableId, rowId: rows[0].id },
    }));
    assert.strictEqual(res.statusCode, 200);
    const left = await realRows(ORG, 'customers');
    assert.strictEqual(left.length, 2);
    const t = await datatableStore.getDatatable(tableId, SC);
    assert.strictEqual(t.rowCount, left.length);
});

// ── Who may see what ────────────────────────────────────────────────────────

test('a colleague with no grade gets 404, not 403 — existence is not probeable', async () => {
    const res = await call('get', '/:id/rows', as(COLLEAGUE, { params: { id: tableId } }));
    assert.strictEqual(res.statusCode, 404);
});

test('publishing makes it readable org-wide but still NOT writable', async () => {
    const shared = await call('put', '/:id/sharing', as(OWNER, {
        params: { id: tableId }, body: { audience: 'organisation' },
    }));
    assert.strictEqual(shared.statusCode, 200, JSON.stringify(shared.body));

    const read = await call('get', '/:id/rows', as(COLLEAGUE, { params: { id: tableId } }));
    assert.strictEqual(read.statusCode, 200);
    assert.strictEqual(read.body.rows.length, 2);

    const write = await call('post', '/:id/rows', as(COLLEAGUE, {
        params: { id: tableId }, body: { values: { email: 'sneak@x.y' } },
    }));
    assert.strictEqual(write.statusCode, 403, 'published means readable, never writable');
    assert.strictEqual((await realRows(ORG, 'customers')).length, 2);
});

test('an account with no organisation gets a PERSONAL scope, not an empty dead end', async () => {
    // An inviting empty state on an account that can never own a table here is
    // what sent BFSF-412 round twice. `organizationId` is the EMPTY STRING for
    // such an account, not null — createUser writes `organizationId || ''`.
    const res = await call('get', '/', as('u-loner'));
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.datatables, []);
    assert.deepStrictEqual(res.body.scope, { kind: 'user', id: 'u-loner', label: 'this account' });
});

test('the list is narrowed to the caller\'s tenants and carries the grade', async () => {
    const res = await call('get', '/', as(OWNER));
    assert.deepStrictEqual(res.body.scope, { kind: 'org', id: ORG, label: 'your organisation' });
    assert.deepStrictEqual(res.body.datatables.map(t => [t.id, t.grade]), [[tableId, 'owner']]);
});

// ── Bulk delete ─────────────────────────────────────────────────────────────

test('POST /:id/rows/bulk-delete removes a selection in one call and moves the counter by what went', async () => {
    const before = (await realRows(ORG, 'customers')).length;
    for (const email of ['bulk1@x.y', 'bulk2@x.y', 'bulk3@x.y']) {
        const r = await call('post', '/:id/rows', as(OWNER, {
            params: { id: tableId }, body: { values: { email, status: 'doomed', score: 0 } },
        }));
        assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    }
    const doomed = (await realRows(ORG, 'customers')).filter(r => r.status === 'doomed').map(r => r.id);
    assert.strictEqual(doomed.length, 3);

    // One id that is not there, one duplicated: neither is counted.
    const res = await call('post', '/:id/rows/bulk-delete', as(OWNER, {
        params: { id: tableId }, body: { ids: [...doomed, 'rec_not_there', doomed[0]] },
    }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body, { deleted: 3, requested: 4 });

    const left = await realRows(ORG, 'customers');
    assert.strictEqual(left.length, before);
    assert.ok(!left.some(r => r.status === 'doomed'));
    const t = await datatableStore.getDatatable(tableId, SC);
    assert.strictEqual(t.rowCount, before, 'the counter moved by the 3 that went, not the 4 asked for');
});

test('a bulk delete is bounded and validated: over the cap is 413, a bad body 400, nothing is nothing', async () => {
    const tooMany = await call('post', '/:id/rows/bulk-delete', as(OWNER, {
        params: { id: tableId }, body: { ids: Array.from({ length: 201 }, (_, i) => `rec_${i}`) },
    }));
    assert.strictEqual(tooMany.statusCode, 413);
    assert.strictEqual(tooMany.body.code, 'too_many_ids');
    assert.deepStrictEqual([tooMany.body.limit, tooMany.body.used], [200, 201]);

    // Refused by the request schema now, so the code is the schema's
    // (`invalid_request`) and `details` NAMES the field that is wrong — which
    // `bad_body` never did.
    for (const bad of [{ ids: 'rec_1' }, { ids: [1, 2] }, { ids: ['rec_1', ''] }, {}]) {
        const r = await call('post', '/:id/rows/bulk-delete', as(OWNER, { params: { id: tableId }, body: bad }));
        assert.strictEqual(r.statusCode, 400, JSON.stringify(bad));
        assert.strictEqual(r.body.code, 'invalid_request');
        assert.ok(r.body.details.some(d => d.path.startsWith('body.ids')), JSON.stringify(r.body));
    }

    const none = await call('post', '/:id/rows/bulk-delete', as(OWNER, { params: { id: tableId }, body: { ids: [] } }));
    assert.strictEqual(none.statusCode, 200);
    assert.deepStrictEqual(none.body, { deleted: 0, requested: 0 });

    // Nothing above moved the counter.
    const t = await datatableStore.getDatatable(tableId, SC);
    assert.strictEqual(t.rowCount, (await realRows(ORG, 'customers')).length);
});

test('a bulk delete needs editor access — a viewer (the table is published by now) is refused and nothing moves', async () => {
    const rows = await realRows(ORG, 'customers');
    const res = await call('post', '/:id/rows/bulk-delete', as(COLLEAGUE, {
        params: { id: tableId }, body: { ids: rows.map(r => r.id) },
    }));
    assert.strictEqual(res.statusCode, 403, JSON.stringify(res.body));
    assert.strictEqual((await realRows(ORG, 'customers')).length, rows.length);
    const t = await datatableStore.getDatatable(tableId, SC);
    assert.strictEqual(t.rowCount, rows.length);
});

// ── Who uses it, every kind ─────────────────────────────────────────────────

test('the list counts CONSUMERS of every kind, and the usage read names each by its own table', async () => {
    await rawQuery(`UPDATE automations SET definition_json = $2::jsonb, last_run_at = '2026-09-04T10:00:00Z' WHERE id = $1`,
        ['auto_1', JSON.stringify({
            trigger: { id: 'trg', type: 'trigger' },
            steps: [
                { id: 's_http', type: 'http_request' },
                { id: 's1', type: 'datatable', op: 'find_rows', datatableId: tableId },
            ],
            edges: [{ from: 'trg', to: 's_http' }, { from: 's_http', to: 's1' }],
        })]);
    await rawQuery(`INSERT INTO studio_apps (id, user_id, name) VALUES ('app_1', $1, 'Order desk')`, [COLLEAGUE]);
    await datatableStore.reconcileUsage('auto_1', SC, [
        { datatableId: tableId, stepId: 's1', mode: 'read', columns: ['email'] },
        { datatableId: tableId, stepId: 's_http', mode: 'read' },
    ]);
    await datatableStore.reconcileUsageFor('app', 'app_1', SC, [
        { datatableId: tableId, stepId: 'tbl_orders', mode: 'readwrite' },
    ]);

    const list = await call('get', '/', as(OWNER));
    assert.strictEqual(list.body.datatables[0].usageCount, 2, 'two consumers, three steps');

    const usage = await call('get', '/:id/usage', as(OWNER, { params: { id: tableId } }));
    assert.strictEqual(usage.statusCode, 200);
    const step = usage.body.usage.find(u => u.consumerKind === 'automation' && u.stepId === 's1');
    assert.strictEqual(step.consumerTitle, 'Nightly sync');
    assert.strictEqual(step.automationTitle, 'Nightly sync', 'the legacy alias the panel reads today');
    assert.strictEqual(step.stepOrdinal, 2);
    assert.strictEqual(step.stepType, 'datatable');
    assert.strictEqual(step.stepOp, 'find_rows');
    assert.strictEqual(step.lastRunAt, '2026-09-04T10:00:00.000Z');
    const app = usage.body.usage.find(u => u.consumerKind === 'app');
    assert.strictEqual(app.consumerId, 'app_1');
    assert.strictEqual(app.consumerTitle, 'Order desk');
    assert.strictEqual(app.consumerOwner, COLLEAGUE);
    assert.strictEqual(app.mode, 'readwrite');
    assert.strictEqual(app.stepOrdinal, null);

    // An app that uses the table blocks its deletion exactly as an automation does.
    const refused = await call('delete', '/:id', as(OWNER, { params: { id: tableId } }));
    assert.strictEqual(refused.statusCode, 409);
    assert.strictEqual(refused.body.code, 'in_use');
    assert.ok(refused.body.usage.some(u => u.consumerKind === 'app'));

    await datatableStore.purgeUsageFor('app', 'app_1');
    await datatableStore.reconcileUsage('auto_1', SC, []);
    const clean = await call('get', '/', as(OWNER));
    assert.strictEqual(clean.body.datatables[0].usageCount, 0);
});

// ── Delete ──────────────────────────────────────────────────────────────────

test('DELETE /:id drops the metadata AND the physical table', async () => {
    const exists = async () => (await rawQuery(`SELECT to_regclass($1) AS t`, [`"${schemaOf(ORG)}"."customers"`])).rows[0].t;
    assert.ok(await exists());

    const res = await call('delete', '/:id', as(OWNER, { params: { id: tableId } }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    // The route used to commit the metadata and only THEN run the DDL, and
    // answered {ok:true} either way — leaving a Postgres table full of personal
    // data that no metadata described and no UI could reach.
    assert.strictEqual(await exists(), null, 'an orphaned table is un-erasable personal data');
    assert.strictEqual(await datatableStore.getDatatable(tableId, SC), null);

    const list = await call('get', '/', as(OWNER));
    assert.deepStrictEqual(list.body.datatables, []);
});

// ── The optimistic lock is MANDATORY ────────────────────────────────────────

/** A fresh table for a test that needs one of its own. Returns its id. */
async function makeTable(key, fields) {
    const res = await call('post', '/', as(OWNER, {
        body: { name: key, key, description: `the ${key} list`, fields },
    }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    return res.body.datatable.id;
}

/** The org model as stored, straight out of Postgres. */
async function storedModel() {
    const r = await rawQuery('SELECT model, model_version FROM datatable_models WHERE organization_id = $1', [ORG]);
    const row = r.rows[0] || {};
    const model = typeof row.model === 'string' ? JSON.parse(row.model) : row.model;
    return { model, modelVersion: Number(row.model_version) };
}

test('a schema save with NO expectedVersion is refused, and writes nothing', async () => {
    // It used to be `expectedVersion === undefined ? null : Number(...)` against
    // saveModel's `if (expectedVersion !== null)`: a client that simply forgot
    // the field clobbered a concurrent editor unconditionally.
    const id = await makeTable('lock_check', [{ key: 'email', name: 'E-mail', type: 'text' }]);
    const before = await storedModel();

    const res = await call('put', '/:id/schema', as(OWNER, {
        params: { id },
        body: { fields: [{ key: 'email', name: 'E-mail', type: 'text' }, { key: 'note', name: 'Note', type: 'text' }] },
    }));
    assert.strictEqual(res.statusCode, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'version_required');
    assert.deepStrictEqual(await storedModel(), before, 'a refusal that had already written is no refusal');
});

test('a garbage expectedVersion is a 400, not the accidental 409 that made every save fail', async () => {
    // Number('x') is NaN and `current !== NaN` is always true, so a client
    // sending a string got version_conflict for ever — a permanent 409 that
    // said somebody else was editing when nobody was.
    const id = await makeTable('nan_check', [{ key: 'email', name: 'E-mail', type: 'text' }]);
    // `Number()` alone would launder three of these into a valid version:
    // true -> 1, [] -> 0, '' -> 0. Each then answers 409 "somebody else is
    // editing" — the same lie the NaN case told, just quieter.
    for (const bad of ['not-a-number', '1.5', '', -1, 2.5, {}, [], true]) {
        const res = await call('put', '/:id/schema', as(OWNER, {
            params: { id },
            body: { expectedVersion: bad, fields: [{ key: 'email', name: 'E-mail', type: 'text' }] },
        }));
        assert.strictEqual(res.statusCode, 400, `${JSON.stringify(bad)} -> ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.code, 'invalid_request');
        assert.ok(res.body.details.some(d => d.path === 'body.expectedVersion'), JSON.stringify(res.body));
    }
});

// ── Model and DDL are ONE transaction ───────────────────────────────────────

/** Run `fn` with applyMigration throwing, then put the real one back. */
async function withFailingDdl(fn) {
    const real = datatableDbStore.applyMigration;
    datatableDbStore.applyMigration = async () => {
        const e = new Error('lock timeout on ALTER TABLE');
        e.code = '55P03';
        throw e;
    };
    try { return await fn(); } finally { datatableDbStore.applyMigration = real; }
}

test('a CREATE TABLE that fails takes the datatables row back with it', async () => {
    // The metadata used to commit BEFORE the DDL, so a failure left a table the
    // picker listed and every read 500'd on — and the retry then hit
    // uq_datatables_org_key, which itself surfaced as a 500.
    const before = await storedModel();
    const res = await withFailingDdl(() => call('post', '/', as(OWNER, {
        body: {
            name: 'Doomed', key: 'doomed', description: 'never lands',
            fields: [{ key: 'email', name: 'E-mail', type: 'text' }],
        },
    })));
    assert.strictEqual(res.statusCode, 500);

    const rows = await rawQuery('SELECT id FROM datatables WHERE organization_id = $1 AND key = $2', [ORG, 'doomed']);
    assert.strictEqual(rows.rows.length, 0, 'a table the picker lists and every read 500s on');
    assert.deepStrictEqual(await storedModel(), before, 'and the model must not claim it either');

    // And the key is free again, so the obvious retry works.
    const retry = await call('post', '/', as(OWNER, {
        body: {
            name: 'Doomed', key: 'doomed', description: 'now it lands',
            fields: [{ key: 'email', name: 'E-mail', type: 'text' }],
        },
    }));
    assert.strictEqual(retry.statusCode, 200, JSON.stringify(retry.body));
});

test('a failing ALTER leaves model_version unmoved, and the NEXT save still emits the ADD COLUMN', async () => {
    // The divergence this transaction exists to prevent was PERMANENT: the
    // model committed first, so model_version was bumped and the field id was
    // in the model — and migrationPlan step 4 skips a field whose id is already
    // in `oldIds`, so the ADD COLUMN was never re-emitted. Nothing reported it.
    const id = await makeTable('ledger', [{ key: 'amount', name: 'Amount', type: 'number' }]);
    const start = await storedModel();
    const schema = await call('get', '/:id/schema', as(OWNER, { params: { id } }));
    const next = [...schema.body.fields, { key: 'vat', name: 'VAT', type: 'number' }];

    const failed = await withFailingDdl(() => call('put', '/:id/schema', as(OWNER, {
        params: { id }, body: { expectedVersion: schema.body.modelVersion, fields: next },
    })));
    assert.notStrictEqual(failed.statusCode, 200);
    const afterFailure = await storedModel();
    assert.strictEqual(afterFailure.modelVersion, start.modelVersion,
        'a bumped version with no column is the divergence nothing ever repairs');
    const stored = afterFailure.model.tables.find(t => t.id === id);
    assert.deepStrictEqual(stored.fields.map(f => f.key), ['amount'], 'the model must not claim the column');

    // The same save again, with the version the client still holds.
    const ok = await call('put', '/:id/schema', as(OWNER, {
        params: { id }, body: { expectedVersion: schema.body.modelVersion, fields: next },
    }));
    assert.strictEqual(ok.statusCode, 200, JSON.stringify(ok.body));
    const cols = await rawQuery(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'ledger'`, [schemaOf(ORG)]);
    assert.ok(cols.rows.some(r => r.column_name === 'vat'), 'the retry has to actually create the column');
});

// ── Drift: /health and /repair ──────────────────────────────────────────────

test('/health names the columns Postgres does not have, and /repair adds them', async () => {
    const id = await makeTable('contacts', [
        { key: 'email', name: 'E-mail', type: 'text' },
        { key: 'phone', name: 'Phone', type: 'text' },
    ]);
    const healthy = await call('get', '/:id/health', as(OWNER, { params: { id } }));
    assert.strictEqual(healthy.statusCode, 200, JSON.stringify(healthy.body));
    assert.deepStrictEqual(healthy.body.missingColumns, []);
    assert.strictEqual(healthy.body.healthy, true);
    assert.strictEqual(healthy.body.tableExists, true);

    // The drift the id-less-fields era produced: the model promises a column
    // the table never grew. Made here by hand, because the code path that made
    // it is fixed.
    await rawQuery(`ALTER TABLE "${schemaOf(ORG)}"."contacts" DROP COLUMN "phone"`);

    const drifted = await call('get', '/:id/health', as(OWNER, { params: { id } }));
    assert.deepStrictEqual(drifted.body.missingColumns, ['phone']);
    assert.strictEqual(drifted.body.healthy, false);

    const repaired = await call('post', '/:id/repair', as(OWNER, { params: { id } }));
    assert.strictEqual(repaired.statusCode, 200, JSON.stringify(repaired.body));
    assert.strictEqual(repaired.body.repaired, true);
    assert.deepStrictEqual(repaired.body.missingColumns, []);
    assert.strictEqual(repaired.body.healthy, true);

    const cols = await rawQuery(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'contacts'`, [schemaOf(ORG)]);
    assert.ok(cols.rows.some(r => r.column_name === 'phone'), 'the repair must run real DDL, not just report');
});

test('/repair is add-only — it never drops a column the model still has', async () => {
    // It is offered as a button, so the plan it builds has to be incapable of
    // destroying anything: the baseline it diffs against is this table with NO
    // fields, so the planner can only ever emit CREATE TABLE and ADD COLUMN.
    const id = await makeTable('add_only', [{ key: 'email', name: 'E-mail', type: 'text' }]);
    // A column Postgres has that the model does not know about — the shape a
    // whole-model diff would happily DROP.
    await rawQuery(`ALTER TABLE "${schemaOf(ORG)}"."add_only" ADD COLUMN "legacy_note" TEXT`);
    await rawQuery(`INSERT INTO "${schemaOf(ORG)}"."add_only" (id, legacy_note) VALUES ('rec_x', 'keep me')`);

    const res = await call('post', '/:id/repair', as(OWNER, { params: { id } }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const kept = await rawQuery(`SELECT legacy_note FROM "${schemaOf(ORG)}"."add_only"`);
    assert.deepStrictEqual(kept.rows.map(r => r.legacy_note), ['keep me']);
});

// ── The row list descriptor: filters, sort, search, keyset paging ────────────

/** Run `fn` with every compiled SELECT captured, then put the real query back. */
async function withCapturedSql(fn) {
    const real = datatableDbStore.query;
    const seen = [];
    datatableDbStore.query = async (...args) => {
        seen.push({ sql: args[2], params: args[3] });
        return real(...args);
    };
    try { await fn(seen); } finally { datatableDbStore.query = real; }
}

/** Add rows through the real route, oldest first. */
async function seedRows(id, rows, who = OWNER) {
    for (const values of rows) {
        const res = await call('post', '/:id/rows', as(who, { params: { id }, body: { values } }));
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    }
}

/**
 * A table whose access predicate is a REAL one.
 *
 * The owner's predicate is `1=1` whatever the row scope says (accessFilter's
 * resolveScope: owner is always full), so a test that asserted "the filter is
 * ANDed onto the access predicate" as the owner would pass against a router
 * that dropped the predicate entirely. An own-scoped table read by an EDITOR
 * grantee compiles `created_by = ?`, which is the thing worth pinning.
 */
async function ownScopedTable(key, fields) {
    const id = await makeTable(key, fields);
    await rawQuery(`UPDATE datatables SET row_scope = 'own' WHERE id = $1`, [id]);
    await datatableStore.addGrant(id, SC, {
        granteeType: 'user', granteeId: COLLEAGUE, grade: 'editor', grantedBy: OWNER,
    });
    return id;
}

test('a filter from the query string still ANDs the access predicate into the SQL', async () => {
    // THE test for this route. `filters`/`sort`/`q` are new CLIENT-CONTROLLED
    // input on a path whose whole promise is that no client SQL exists, so the
    // property worth pinning is not "the filter works" but "the filter cannot
    // widen what the caller may see". compileRecordList puts the access
    // predicate first and ANDs everything else onto it; assert that on the
    // compiled statement, because a behavioural test on an owner (whose
    // predicate is 1=1) would pass either way.
    const id = await ownScopedTable('scoped_list', [
        { key: 'email', name: 'E-mail', type: 'text' },
        { key: 'status', name: 'Status', type: 'text' },
    ]);
    await seedRows(id, [{ email: 'a@b.c', status: 'new' }, { email: 'd@e.f', status: 'done' }], COLLEAGUE);

    await withCapturedSql(async (seen) => {
        const res = await call('get', '/:id/rows', as(COLLEAGUE, {
            params: { id },
            query: { filters: JSON.stringify([{ field: 'status', op: 'eq', value: 'new' }]) },
        }));
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(res.body.rows.map(r => r.status), ['new']);
        const list = seen.find(s => /SELECT \* FROM "scoped_list"/.test(s.sql));
        assert.ok(list, 'the list statement was compiled');
        assert.match(list.sql, /WHERE \("created_by" = \?\) AND "status" = \?/,
            'the access predicate is ANDed in first and the client filter onto it');
        assert.strictEqual(list.params[0], COLLEAGUE, 'and it is bound to THIS caller');
    });
});

test('match:"any" ORs the filters while the access predicate stays ANDed outside', async () => {
    const id = await ownScopedTable('any_list', [{ key: 'status', name: 'Status', type: 'text' }]);
    await seedRows(id, [{ status: 'new' }, { status: 'retry' }, { status: 'done' }], COLLEAGUE);

    await withCapturedSql(async (seen) => {
        const res = await call('get', '/:id/rows', as(COLLEAGUE, {
            params: { id },
            query: {
                match: 'any',
                filters: JSON.stringify([
                    { field: 'status', op: 'eq', value: 'new' },
                    { field: 'status', op: 'eq', value: 'retry' },
                ]),
            },
        }));
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(res.body.rows.map(r => r.status).sort(), ['new', 'retry']);
        const list = seen.find(s => /SELECT \* FROM "any_list"/.test(s.sql));
        // `access OR status = ?` would hand every row of the table to anybody
        // who asked for the right status. The OR group has to be INSIDE the AND.
        assert.match(list.sql, /WHERE \("created_by" = \?\) AND \("status" = \? OR "status" = \?\)/);
    });
});

test('?q= searches the text columns and still cannot widen the scope', async () => {
    const id = await ownScopedTable('search_list', [
        { key: 'email', name: 'E-mail', type: 'text' },
        { key: 'note', name: 'Note', type: 'text' },
        { key: 'score', name: 'Score', type: 'number' },
    ]);
    await seedRows(id, [
        { email: 'ann@x.y', note: 'call back', score: 1 },
        { email: 'bo@x.y', note: 'nothing', score: 2 },
    ], COLLEAGUE);
    await withCapturedSql(async (seen) => {
        const res = await call('get', '/:id/rows', as(COLLEAGUE, { params: { id }, query: { q: 'call' } }));
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(res.body.rows.map(r => r.email), ['ann@x.y']);
        const list = seen.find(s => /SELECT \* FROM "search_list"/.test(s.sql));
        assert.match(list.sql, /WHERE \("created_by" = \?\) AND \("email" ILIKE .*OR "note" ILIKE /,
            'the search is its own ANDed group, and the numeric column is not in it');
    });
});

test('a filter naming an undeclared column is a 400 naming it, not a compiler 422', async () => {
    const id = await makeTable('closed_desc', [{ key: 'email', name: 'E-mail', type: 'text' }]);
    for (const query of [
        { filters: JSON.stringify([{ field: 'secret_column', op: 'eq', value: 'x' }]) },
        { sort: 'secret_column' },
    ]) {
        const res = await call('get', '/:id/rows', as(OWNER, { params: { id }, query }));
        assert.strictEqual(res.statusCode, 400, JSON.stringify(res.body));
        assert.match(res.body.error, /secret_column/);
    }
    // And an operator the compiler has never heard of.
    const badOp = await call('get', '/:id/rows', as(OWNER, {
        params: { id },
        query: { filters: JSON.stringify([{ field: 'email', op: 'REGEXP', value: 'x' }]) },
    }));
    assert.strictEqual(badOp.statusCode, 400);
    assert.strictEqual(badOp.body.code, 'unknown_filter_op');
    // Malformed JSON is a 400 too, never a 500.
    const badJson = await call('get', '/:id/rows', as(OWNER, { params: { id }, query: { filters: '{oops' } }));
    assert.strictEqual(badJson.statusCode, 400);
});

test('a page size that is not one is refused, and a real one is honest about what it sent', async () => {
    // The route used to derive its own limit: `Math.min(Number(-5) || 50, MAX)`
    // is -5, the compiler then ran at ITS default of 50, and the route sliced
    // `rows.slice(0, -5)` — 46 rows returned with hasMore true, for ever. The
    // fix was to stop deriving one; the schema now also stops the nonsense at
    // the door rather than letting the compiler's clamp quietly stand in for
    // the number the caller asked for.
    const id = await makeTable('limit_check', [{ key: 'n', name: 'N', type: 'number' }]);
    await seedRows(id, Array.from({ length: 60 }, (_, i) => ({ n: i })));
    for (const limit of ['-5', '0', 'abc', '']) {
        const res = await call('get', '/:id/rows', as(OWNER, { params: { id }, query: { limit } }));
        assert.strictEqual(res.statusCode, 400, `limit=${JSON.stringify(limit)} -> ${JSON.stringify(res.body)}`);
        assert.ok(res.body.details.some(d => d.path === 'query.limit'), JSON.stringify(res.body));
    }
    // A real page size, and the counts that go with it: whatever comes back,
    // `count` is the length of `rows` and `hasMore` is not a guess.
    const page = await call('get', '/:id/rows', as(OWNER, { params: { id }, query: { limit: '50' } }));
    assert.strictEqual(page.statusCode, 200, JSON.stringify(page.body));
    assert.strictEqual(page.body.rows.length, 50);
    assert.strictEqual(page.body.count, 50);
    assert.strictEqual(page.body.hasMore, true);
    assert.strictEqual(page.body.total, 60, 'the copy says "the 50 most recent of N"');
    // And the page cap is 500, not 50 — a 100k table at 50/page is 2,000
    // requests against a 120/minute limiter.
    const big = await call('get', '/:id/rows', as(OWNER, { params: { id }, query: { limit: '5000' } }));
    assert.strictEqual(big.body.rows.length, 60, 'clamped to the cap, and the table only has 60');
});

test('nextCursor reaches row 51 with no overlap and no gap', async () => {
    const id = await makeTable('paged', [{ key: 'n', name: 'N', type: 'number' }]);
    await seedRows(id, Array.from({ length: 60 }, (_, i) => ({ n: i })));

    const first = await call('get', '/:id/rows', as(OWNER, { params: { id }, query: { limit: '50' } }));
    assert.strictEqual(first.body.rows.length, 50);
    assert.ok(first.body.nextCursor, 'the route ACCEPTED a cursor and never produced one — page 2 was unreachable');

    const second = await call('get', '/:id/rows', as(OWNER, {
        params: { id }, query: { limit: '50', cursor: first.body.nextCursor },
    }));
    assert.strictEqual(second.body.rows.length, 10);
    assert.strictEqual(second.body.hasMore, false);
    assert.strictEqual(second.body.nextCursor, null);

    const ids = [...first.body.rows, ...second.body.rows].map(r => r.id);
    assert.strictEqual(new Set(ids).size, 60, 'no row appears twice');
    const all = await realRows(ORG, 'paged');
    assert.deepStrictEqual([...ids].sort(), all.map(r => r.id).sort(), 'and none is missed');
});

// ── One row, edited ─────────────────────────────────────────────────────────

test('GET then PUT a row round-trips, bumps updated_at and keeps id/created_at', async () => {
    // A row could not be edited ANYWHERE in the product, so fixing a typo was
    // delete-and-retype: a new id, a new created_at, a lost created_by.
    const id = await makeTable('editable', [
        { key: 'email', name: 'E-mail', type: 'text' },
        { key: 'status', name: 'Status', type: 'text' },
    ]);
    await seedRows(id, [{ email: 'a@b.c', status: 'new' }]);
    const [row] = await realRows(ORG, 'editable');

    const got = await call('get', '/:id/rows/:rowId', as(OWNER, { params: { id, rowId: row.id } }));
    assert.strictEqual(got.statusCode, 200, JSON.stringify(got.body));
    assert.strictEqual(got.body.row.email, 'a@b.c');

    const put = await call('put', '/:id/rows/:rowId', as(OWNER, {
        params: { id, rowId: row.id },
        body: { values: { status: 'done' }, expectedUpdatedAt: isoOf(got.body.row.updated_at) },
    }));
    assert.strictEqual(put.statusCode, 200, JSON.stringify(put.body));
    assert.strictEqual(put.body.row.status, 'done');
    assert.strictEqual(put.body.row.id, row.id, 'the id survives — automations key on it');
    assert.strictEqual(isoOf(put.body.row.created_at), isoOf(row.created_at));
    assert.strictEqual(put.body.row.created_by, OWNER);
    assert.notStrictEqual(isoOf(put.body.row.updated_at), isoOf(row.updated_at), 'updated_at has to move');

    const t = await datatableStore.getDatatable(id, SC);
    assert.strictEqual(t.rowCount, 1, 'an edit adds no rows');
});

test('a PUT with no expectedUpdatedAt is a 400, and a stale one is a 409', async () => {
    const id = await makeTable('optimistic', [{ key: 'status', name: 'Status', type: 'text' }]);
    await seedRows(id, [{ status: 'new' }]);
    const [row] = await realRows(ORG, 'optimistic');
    const stamp = isoOf(row.updated_at);

    const missing = await call('put', '/:id/rows/:rowId', as(OWNER, {
        params: { id, rowId: row.id }, body: { values: { status: 'x' } },
    }));
    assert.strictEqual(missing.statusCode, 400, JSON.stringify(missing.body));
    assert.strictEqual(missing.body.code, 'invalid_request');
    assert.ok(missing.body.details.some(d => d.path === 'body.expectedUpdatedAt'), JSON.stringify(missing.body));
    assert.strictEqual((await realRows(ORG, 'optimistic'))[0].status, 'new',
        'a refusal that had already written is no refusal');

    const ok = await call('put', '/:id/rows/:rowId', as(OWNER, {
        params: { id, rowId: row.id }, body: { values: { status: 'first' }, expectedUpdatedAt: stamp },
    }));
    assert.strictEqual(ok.statusCode, 200, JSON.stringify(ok.body));

    // The SAME token again — a second editor who loaded the row before the
    // first save landed.
    const stale = await call('put', '/:id/rows/:rowId', as(OWNER, {
        params: { id, rowId: row.id }, body: { values: { status: 'second' }, expectedUpdatedAt: stamp },
    }));
    assert.strictEqual(stale.statusCode, 409, JSON.stringify(stale.body));
    assert.strictEqual(stale.body.code, 'row_conflict');
    assert.strictEqual(stale.body.row.status, 'first', 'the conflict carries the row as it now is');
    assert.strictEqual((await realRows(ORG, 'optimistic'))[0].status, 'first');

    // A row that is not there at all is a 404, not a conflict — they need
    // different answers.
    const gone = await call('put', '/:id/rows/:rowId', as(OWNER, {
        params: { id, rowId: 'rec_nope' }, body: { values: { status: 'x' }, expectedUpdatedAt: stamp },
    }));
    assert.strictEqual(gone.statusCode, 404);
});

test('a viewer may read a row but not edit it', async () => {
    const id = await makeTable('read_only', [{ key: 'status', name: 'Status', type: 'text' }]);
    await seedRows(id, [{ status: 'new' }]);
    await call('put', '/:id/sharing', as(OWNER, { params: { id }, body: { audience: 'organisation' } }));
    const [row] = await realRows(ORG, 'read_only');

    const read = await call('get', '/:id/rows/:rowId', as(COLLEAGUE, { params: { id, rowId: row.id } }));
    assert.strictEqual(read.statusCode, 200);
    const write = await call('put', '/:id/rows/:rowId', as(COLLEAGUE, {
        params: { id, rowId: row.id },
        body: { values: { status: 'x' }, expectedUpdatedAt: isoOf(read.body.row.updated_at) },
    }));
    assert.strictEqual(write.statusCode, 403, 'published means readable, never writable');
    assert.strictEqual((await realRows(ORG, 'read_only'))[0].status, 'new');
});

test('a required column with no value is a 422 naming the column, not a 500', async () => {
    const id = await makeTable('strict', [
        { key: 'email', name: 'E-mail', type: 'text', required: true },
        { key: 'note', name: 'Note', type: 'text' },
    ]);
    const res = await call('post', '/:id/rows', as(OWNER, {
        params: { id }, body: { values: { note: 'no e-mail here' } },
    }));
    assert.strictEqual(res.statusCode, 422, JSON.stringify(res.body));
    assert.match(res.body.error, /email/, 'the person has to be told WHICH column');
    assert.strictEqual(res.body.code, 'required_value');
    const t = await datatableStore.getDatatable(id, SC);
    assert.strictEqual(t.rowCount, 0, 'a failed insert must not move the counter');
});

// ── Bulk import + CSV export ────────────────────────────────────────────────

test('POST /:id/rows/bulk imports a file and reports bad rows by line number', async () => {
    const id = await makeTable('import_me', [
        { key: 'email', name: 'E-mail', type: 'text' },
        { key: 'score', name: 'Score', type: 'number' },
    ]);
    const res = await call('post', '/:id/rows/bulk', as(OWNER, {
        params: { id },
        body: {
            rows: [
                { email: 'a@b.c', score: 1 },
                { email: 'd@e.f', nonexistent_column: 'x' },
                { email: 'g@h.i', score: 3 },
            ],
        },
    }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.inserted, 2);
    // Not one refusal for the whole file: a 400-row paste with two bad cells in
    // it is a fixable import, and the person needs the line.
    assert.deepStrictEqual(res.body.errors.map(e => e.line), [2]);
    assert.match(res.body.errors[0].error, /nonexistent_column/);

    const rows = await realRows(ORG, 'import_me');
    assert.deepStrictEqual(rows.map(r => r.email).sort(), ['a@b.c', 'g@h.i']);
    assert.strictEqual(rows[0].created_by, OWNER, 'the importer is stamped, never the client');
    const t = await datatableStore.getDatatable(id, SC);
    assert.strictEqual(t.rowCount, 2, 'row_count follows what actually landed');
});

test('a bulk import writes in ONE transaction per chunk — a failure leaves the chunk unapplied', async () => {
    const id = await makeTable('import_tx', [{ key: 'email', name: 'E-mail', type: 'text', unique: true }]);
    await seedRows(id, [{ email: 'taken@x.y' }]);
    const res = await call('post', '/:id/rows/bulk', as(OWNER, {
        params: { id },
        body: { rows: [{ email: 'fresh@x.y' }, { email: 'taken@x.y' }] },
    }));
    assert.strictEqual(res.statusCode, 422, JSON.stringify(res.body));
    assert.strictEqual(res.body.inserted, 0);
    const rows = await realRows(ORG, 'import_tx');
    assert.deepStrictEqual(rows.map(r => r.email), ['taken@x.y'],
        'the good row of a failed chunk must not land on its own');
    const t = await datatableStore.getDatatable(id, SC);
    assert.strictEqual(t.rowCount, 1, 'and the counter must not claim it did');
});

test('GET /:id/rows.csv streams every page in one response, access-filtered', async () => {
    const id = await makeTable('exportable', [
        { key: 'email', name: 'E-mail', type: 'text' },
        { key: 'note', name: 'Note', type: 'text' },
    ]);
    await seedRows(id, [
        { email: 'a@b.c', note: 'plain' },
        { email: 'd@e.f', note: 'has, a comma and "quotes"' },
        { email: 'g@h.i', note: '=1+1' },
    ]);
    const res = await call('get', '/:id/rows.csv', as(OWNER, { params: { id } }));
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/csv/);
    assert.match(res.headers['content-disposition'], /attachment; filename="exportable\.csv"/);
    const lines = res.text.replace(/^﻿/, '').trim().split('\n');
    assert.strictEqual(lines.length, 4, 'a header and three rows, in ONE response');
    assert.match(lines[0], /^id,created_at,updated_at,created_by,org_id,email,note$/);
    assert.ok(lines.some(l => l.includes('"has, a comma and ""quotes"""')), 'RFC4180 quoting');
    // A leading = makes Excel treat the cell as a FORMULA when the export is
    // opened, which is how a datatable column becomes code on a colleague's
    // machine.
    assert.ok(lines.some(l => l.includes("'=1+1")), 'formula injection is neutralised');

    // A colleague with no grade cannot export what they cannot read.
    const denied = await call('get', '/:id/rows.csv', as(COLLEAGUE, { params: { id } }));
    assert.strictEqual(denied.statusCode, 404);
});

// ── Indexes ─────────────────────────────────────────────────────────────────

test('every table is created with the index its default read order needs', async () => {
    // ddlForTable emitted only the primary key and the author's uniques, while
    // EVERY list is `ORDER BY created_at DESC, id DESC` — a 100k table sorted
    // its whole contents to answer "the 50 most recent". A row_scope:'own'
    // table additionally ANDs created_by into every statement.
    await makeTable('indexed', [{ key: 'email', name: 'E-mail', type: 'text' }]);
    const shared = await rawQuery(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'indexed'`, [schemaOf(ORG)]);
    const defs = shared.rows.map(r => r.indexdef).join('\n');
    assert.match(defs, /created_at DESC, id DESC/);
    assert.ok(!/created_by/.test(defs), 'a shared table pays for no owner index it never uses');

    // An own-scoped table gets the second one on its next schema save — every
    // statement is IF NOT EXISTS, so re-emitting is a no-op.
    const ownId = await makeTable('own_indexed', [{ key: 'email', name: 'E-mail', type: 'text' }]);
    await rawQuery(`UPDATE datatables SET row_scope = 'own' WHERE id = $1`, [ownId]);
    const repaired = await call('post', '/:id/repair', as(OWNER, { params: { id: ownId } }));
    assert.strictEqual(repaired.statusCode, 200, JSON.stringify(repaired.body));
    const own = await rawQuery(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'own_indexed'`, [schemaOf(ORG)]);
    const ownDefs = own.rows.map(r => r.indexdef).join('\n');
    assert.match(ownDefs, /created_by, created_at DESC/);
});

// ── The storage envelope ────────────────────────────────────────────────────

test('the 51st table is refused, and the count is taken inside the create transaction', async () => {
    // MAX_TABLES_PER_APP — a constant named, documented and sized for ONE App
    // Studio app — used to be spent as the per-organisation cap, and it was
    // counted by listing every table in the org OUTSIDE any lock: two replicas
    // could both see 49. createDatatable now counts with the scope's model row
    // FOR UPDATE-held.
    const filler = Array.from({ length: 50 }, (_, i) => `tbl_filler${String(i).padStart(3, '0')}`);
    for (const id of filler) {
        await rawQuery(
            `INSERT INTO datatables (id, scope_kind, scope_id, organization_id, owner_user_id, key, name, description)
             VALUES ($1, 'org', $2, $2, $3, $4, $4, 'filler')`,
            [id, ORG, OWNER, `filler_${id.slice(-3)}`],
        );
    }
    try {
        const res = await call('post', '/', as(OWNER, {
            body: { name: 'One too many', key: 'one_too_many', description: 'refused', fields: [] },
        }));
        assert.strictEqual(res.statusCode, 409, JSON.stringify(res.body));
        assert.strictEqual(res.body.code, 'quota_exceeded');
        assert.strictEqual(res.body.limit, 50);
        assert.ok(res.body.used >= 50, 'the refusal has to say how full it is');
        // And the refusal rolled the whole transaction back — a create that
        // committed the metadata and then refused would leave a table the
        // picker lists and every read 500s on.
        const left = await rawQuery(`SELECT id FROM datatables WHERE key = 'one_too_many'`);
        assert.strictEqual(left.rows.length, 0);
    } finally {
        await rawQuery(`DELETE FROM datatables WHERE key LIKE 'filler_%'`);
    }
});

test('a row write is refused when the SCOPE is over its byte ceiling, but a delete is not', async () => {
    // MAX_DB_BYTES was declared and inert and `size_bytes` was mirrored and read
    // by nobody: one organisation could grow the shared beeflow_core volume
    // without bound.
    const id = await makeTable('byte_capped', [{ key: 'note', name: 'Note', type: 'text' }]);
    await seedRows(id, [{ note: 'already here' }]);
    const [row] = await realRows(ORG, 'byte_capped');

    await rawQuery(
        `UPDATE datatable_models SET size_bytes = $1 WHERE scope_kind = 'org' AND scope_id = $2`,
        [256 * 1024 * 1024, ORG],
    );
    try {
        const blocked = await call('post', '/:id/rows', as(OWNER, {
            params: { id }, body: { values: { note: 'one more' } },
        }));
        assert.strictEqual(blocked.statusCode, 409, JSON.stringify(blocked.body));
        assert.strictEqual(blocked.body.code, 'quota_exceeded');
        assert.strictEqual(blocked.body.limit, 256 * 1024 * 1024);
        assert.strictEqual((await realRows(ORG, 'byte_capped')).length, 1);

        // Deleting is how a tenant gets back under the ceiling, so it must not
        // be gated on being under it.
        const del = await call('delete', '/:id/rows/:rowId', as(OWNER, { params: { id, rowId: row.id } }));
        assert.strictEqual(del.statusCode, 200, JSON.stringify(del.body));
        assert.strictEqual((await realRows(ORG, 'byte_capped')).length, 0);
    } finally {
        await rawQuery(
            `UPDATE datatable_models SET size_bytes = 0 WHERE scope_kind = 'org' AND scope_id = $1`, [ORG]);
    }
});

// ── Managed tables (the visible http_request cache tier) ────────────────────

/**
 * A MANAGED table is an ordinary table with one difference: its columns are the
 * platform's, because an automation writes them by name on a schedule. Everything
 * asserted here is that difference — the rest of this file already covers the
 * ordinary half, and a managed table takes every bit of it.
 */

let managedId = null;

test('POST /managed provisions the fixed columns, the marker and the retention rule', async () => {
    const res = await call('post', '/managed', as(OWNER, {
        body: { kind: 'http_cache', name: 'Keyword answers', key: 'keyword_answers' },
    }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    managedId = res.body.datatable.id;
    assert.strictEqual(res.body.datatable.managedKind, 'http_cache');
    // The expiry IS the ordinary retention sweeper. One mechanism, two features.
    assert.strictEqual(res.body.datatable.retentionField, 'fetched_at');
    assert.strictEqual(res.body.datatable.retentionDays, 30);
    // The warning rides back with the create, because the trade — plaintext
    // rows colleagues can read — is not discoverable from anywhere else.
    assert.match(res.body.warning, /plain text/i);

    const cols = await rawQuery(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'keyword_answers' ORDER BY ordinal_position`, [schemaOf(ORG)]);
    assert.deepStrictEqual(cols.rows.map(r => r.column_name), [
        'id', 'created_at', 'updated_at', 'created_by', 'org_id',
        'cache_key', 'request_host', 'request_path', 'request_method',
        'response_status', 'response_body', 'response_headers', 'fetched_at',
    ]);
});

test('the key column is really UNIQUE in Postgres — the upsert has a conflict target', async () => {
    // compileUpsertByKey checks that the MODEL says `unique`; this checks that
    // Postgres agrees. Without the index, `ON CONFLICT ("cache_key")` is not a
    // duplicate row — it is "no unique or exclusion constraint matching", a 500
    // from inside somebody's nightly automation.
    const idx = await rawQuery(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'keyword_answers'`, [schemaOf(ORG)]);
    assert.ok(idx.rows.some(r => /UNIQUE/i.test(r.indexdef) && /cache_key/.test(r.indexdef)),
        JSON.stringify(idx.rows));
});

test('the Art. 30 description is demanded here too, and defaults rather than being skipped', async () => {
    const res = await call('post', '/managed', as(OWNER, {
        body: { kind: 'http_cache', name: 'Defaulted', key: 'defaulted_answers' },
    }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok(res.body.datatable.description.length > 20,
        'the pre-filled purpose is a real sentence, not an empty string');

    const blank = await call('post', '/managed', as(OWNER, {
        body: { kind: 'http_cache', name: 'Blank', key: 'blank_answers', description: '   ' },
    }));
    assert.strictEqual(blank.statusCode, 400);
    assert.match(blank.body.error, /processing record/);
});

test('an unknown kind is refused rather than provisioned as something', async () => {
    const res = await call('post', '/managed', as(OWNER, {
        body: { kind: 'whatever', name: 'Nope', key: 'nope_answers' },
    }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'unknown_managed_kind');
});

test('a managed column cannot be dropped, renamed or retyped', async () => {
    const before = await call('get', '/:id/schema', as(OWNER, { params: { id: managedId } }));
    const fields = before.body.fields;
    const put = (next) => call('put', '/:id/schema', as(OWNER, {
        params: { id: managedId },
        body: { expectedVersion: before.body.modelVersion, fields: next },
    }));

    const dropped = await put(fields.filter(f => f.key !== 'response_body'));
    assert.strictEqual(dropped.statusCode, 409, JSON.stringify(dropped.body));
    assert.strictEqual(dropped.body.code, 'managed_column');

    // A rename is a drop under another name: normalizeFields matches by id
    // FIRST, so keeping the id and changing the key takes the column out from
    // under the writer without ever looking like a removal.
    const renamed = await put(fields.map(f => (f.key === 'cache_key' ? { ...f, key: 'answer_key' } : f)));
    assert.strictEqual(renamed.statusCode, 409, JSON.stringify(renamed.body));

    const retyped = await put(fields.map(f => (f.key === 'response_status' ? { ...f, type: 'text' } : f)));
    assert.strictEqual(retyped.statusCode, 409, JSON.stringify(retyped.body));

    // Dropping the unique flag does not break the next write loudly — it makes
    // every refresh append a SECOND row.
    const notUnique = await put(fields.map(f => (f.key === 'cache_key' ? { ...f, unique: false } : f)));
    assert.strictEqual(notUnique.statusCode, 409, JSON.stringify(notUnique.body));

    // And not one of the four touched the table.
    const after = await call('get', '/:id/schema', as(OWNER, { params: { id: managedId } }));
    assert.deepStrictEqual(after.body.fields.map(f => f.key), fields.map(f => f.key));
});

test('a column of your OWN may still be added to a managed table', async () => {
    const before = await call('get', '/:id/schema', as(OWNER, { params: { id: managedId } }));
    const res = await call('put', '/:id/schema', as(OWNER, {
        params: { id: managedId },
        body: {
            expectedVersion: before.body.modelVersion,
            fields: [...before.body.fields, { key: 'note', name: 'Note', type: 'text' }],
        },
    }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const cols = await rawQuery(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'keyword_answers' AND column_name = 'note'`, [schemaOf(ORG)]);
    assert.strictEqual(cols.rows.length, 1, 'the writer names its own columns, so an extra one costs it nothing');
});

test('the picker can tell a managed table from an ordinary one', async () => {
    const plainId = await makeTable('plain_for_picker', [{ key: 'note', name: 'Note', type: 'text' }]);
    const res = await call('get', '/', as(OWNER, {}));
    const managed = res.body.datatables.find(t => t.id === managedId);
    const ordinary = res.body.datatables.find(t => t.id === plainId);
    assert.strictEqual(managed.managedKind, 'http_cache');
    assert.strictEqual(ordinary.managedKind, null,
        'pointing the tick at a table without the fixed columns would fail once, at 3am');
});

test('managedKind cannot be PATCHed onto or off a table', async () => {
    const res = await call('patch', '/:id', as(OWNER, {
        params: { id: managedId }, body: { managedKind: null },
    }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'invalid_request');
    // Still told apart from a typo: the sentence is the one that says the key
    // names the table's own storage, not "there is no such setting".
    assert.match(res.body.error, /names the table's own storage/);
});

test('rows of a managed table are swept by the SAME retention job', async () => {
    // The whole expiry story, asserted from this side: there is no second,
    // invisible clock. A row past the table's window is removed by the ordinary
    // retention pass, which is deliberately NOT module-gated — see the job's
    // header, and jobs/datatableRetention.test.js for the pass itself.
    const { datatableRetentionPass } = require('../jobs/datatableRetention');
    const queryCompiler = require('../core/dataEngine/queryCompiler');
    const scopeKey = datatableDbStore.scopeKey(SC);
    const table = await datatableStore.getDatatable(managedId, SC);
    const meta = await datatableStore.getTableMeta(SC, managedId);
    assert.strictEqual(table.retentionField, 'fetched_at');

    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
    const fresh = new Date().toISOString();
    for (const [key, fetchedAt] of [['k-old', old], ['k-fresh', fresh]]) {
        const ins = queryCompiler.compileInsert(meta, {
            cache_key: key, request_host: 'https://api.example.com', request_path: '/rates',
            request_method: 'GET', response_status: 200, response_body: '{}',
            response_headers: '{}', fetched_at: fetchedAt,
        }, { createdBy: OWNER, orgId: ORG, dialect: 'pg' });
        await datatableDbStore.exec(scopeKey, scopeKey, ins.sql, ins.params);
    }
    await datatableStore.bumpAfterWrite(managedId, SC, 2);
    assert.strictEqual((await realRows(ORG, 'keyword_answers')).length, 2);

    const out = await datatableRetentionPass();
    assert.ok(out.deleted >= 1, JSON.stringify(out));
    const left = await realRows(ORG, 'keyword_answers');
    assert.deepStrictEqual(left.map(r => r.cache_key), ['k-fresh'],
        'the window is the retention rule on the table itself, aged by fetched_at');
    // And the counter is re-synced against the truth rather than merely
    // decremented, which is what makes the quota gate honest afterwards.
    const after = await datatableStore.getDatatable(managedId, SC);
    assert.strictEqual(after.rowCount, 1);
});
