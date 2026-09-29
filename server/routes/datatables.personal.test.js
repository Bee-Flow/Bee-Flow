'use strict';

/**
 * PERSONAL datatables, END TO END, against a REAL Postgres — BFSF-412 closed
 * for the account that filed it.
 *
 * The reporter is the built-in `admin` operator, whose `organizationId` is the
 * EMPTY STRING (stores/user/users.createUser writes `organizationId || ''`).
 * Before this, `POST /api/datatables` answered 400 `no_organisation` for that
 * account and the Studio still offered "New table". So the scenario below is
 * the ticket, in order: create, add a column, add a row, read it back, delete.
 *
 * The second half is the privacy rule that makes "personal" mean anything: a
 * colleague — including an ORG ADMIN — must not see the table, must not reach
 * it by id, and the owner must not be able to share it even if they try.
 *
 * Same harness as routes/datatables.integration.test.js: @electric-sql/pglite
 * (real Postgres, WASM, in-process), the genuine store, engine, migration
 * planner and query compiler; only the gate chain and `users` are mocked.
 *
 * Run: cd server && node --test --test-force-exit routes/datatables.personal.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const SERVER = path.resolve(__dirname, '..');

// ── A db.js facade over one pglite connection ───────────────────────────────

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

const ORG = 'org-personal-a';
const OPERATOR = 'u-operator';   // the built-in admin: organizationId === ''
const ADMIN = 'u-org-admin';
const MEMBER = 'u-member';

const USERS = {
    // The reporter's account, reproduced exactly: '' and not null, because the
    // two take different branches in several truthiness checks.
    [OPERATOR]: { id: OPERATOR, organizationId: '', orgRole: null, groups: [] },
    [ADMIN]: { id: ADMIN, organizationId: ORG, orgRole: 'org_admin', groups: [] },
    [MEMBER]: { id: MEMBER, organizationId: ORG, orgRole: 'member', groups: [] },
};
mock(path.join(SERVER, 'stores/userStore'), {
    getUser: async (id) => USERS[id] || null,
    getAllGroups: async () => [],
});
mock(path.join(SERVER, 'stores/projectStore'), {});

// ── The gate chain, which is not what this file is about ────────────────────

const pass = () => (req, res, next) => next();
// `manage_datatables` lives under org_admin/agent_admin only, so the operator
// account genuinely does NOT hold it. Answering honestly here is the point:
// requiring it for a personal table is what would 403 this whole scenario.
const PERMS = { [ADMIN]: ['manage_datatables'], [MEMBER]: [], [OPERATOR]: [] };
mock(path.join(SERVER, 'auth'), {
    requirePermission: (perm) => async (req, res, next) => (
        (PERMS[req.session?.user?.id] || []).includes(perm)
            ? next()
            : res.status(403).json({ error: `Permission '${perm}' required` })
    ),
    requireActiveOrgForMutations: pass,
    assertUserCanUseOrg: async () => true,
    validateSharedGroupsForOrg: async (_req, groups) => groups || [],
    hasPermission: async (userId, perm) => (PERMS[userId] || []).includes(perm),
    Permissions: { MANAGE_DATATABLES: 'manage_datatables' },
});
mock(path.join(SERVER, 'core/entitlements/betaFeatures'), { requireBetaFeature: pass });
mock(path.join(SERVER, 'core/entitlements/entitlements'), { requireCapability: pass });
mock(path.join(SERVER, 'utils/perUserRateLimit'), { perUserRateLimit: pass });

const router = require('./datatables');
const datatableStore = require('../stores/datatableStore');
const datatableDbStore = require('../stores/datatableDbStore');

// ── Harness ─────────────────────────────────────────────────────────────────

function routeStack(method, routePath) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
            return layer.route.stack.map(l => l.handle);
        }
    }
    throw new Error(`route not found: ${method} ${routePath}`);
}

async function call(method, routePath, req) {
    const res = { statusCode: 200, body: null, sent: false };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; res.sent = true; return res; };
    const full = { params: {}, query: {}, body: {}, headers: {}, ...req };
    for (const handle of routeStack(method, routePath)) {
        let advanced = false;
        await handle(full, res, () => { advanced = true; });
        if (res.sent || !advanced) break;
    }
    return res;
}

/** The returning-user session shape: an id, and nothing else. */
const as = (userId, over = {}) => ({ session: { user: { id: userId } }, ...over });

let tableId = null;

before(async () => {
    await pg.exec("SET TIME ZONE 'UTC'");
    await datatableStore.initDB();
    // The columns listUsage's per-kind JOIN reads: name, owner, definition
    // (step position) and last run. automationStore owns the real DDL.
    await pg.exec(`CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY, user_id TEXT, title TEXT, definition_json JSONB, last_run_at TIMESTAMPTZ)`);
});

after(async () => { await pg.close(); });

// ── The ticket, in order ────────────────────────────────────────────────────

test('the org-less operator is offered a PERSONAL scope, not an empty dead end', async () => {
    const res = await call('get', '/', as(OPERATOR));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.datatables, []);
    assert.deepStrictEqual(res.body.scope, { kind: 'user', id: OPERATOR, label: 'this account' });
});

test('POST / creates a personal table WITHOUT manage_datatables', async () => {
    // The permission lives under org_admin/agent_admin, so requiring it would
    // 403 this account before the scope was even looked at.
    assert.strictEqual((PERMS[OPERATOR] || []).length, 0, 'the operator must genuinely not hold it');
    const res = await call('post', '/', as(OPERATOR, {
        body: {
            name: 'My notes', key: 'notes', description: 'things I want to remember between runs',
            fields: [{ key: 'topic', name: 'Topic', type: 'text' }],
        },
    }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    tableId = res.body.datatable.id;
    assert.strictEqual(res.body.datatable.grade, 'owner');
    assert.strictEqual(res.body.datatable.scopeKind, 'user');

    // The metadata says PERSONAL, with no organisation invented for it.
    const row = (await rawQuery('SELECT scope_kind, scope_id, organization_id FROM datatables WHERE id = $1', [tableId])).rows[0];
    assert.deepStrictEqual(row, { scope_kind: 'user', scope_id: OPERATOR, organization_id: null });

    // And the physical table really exists, in the account's own schema.
    const schema = datatableDbStore.schemaNameFor('user', OPERATOR);
    const cols = await rawQuery(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'notes' ORDER BY ordinal_position`, [schema]);
    assert.deepStrictEqual(cols.rows.map(r => r.column_name),
        ['id', 'created_at', 'updated_at', 'created_by', 'org_id', 'topic']);
});

test('adding a column runs real DDL for an account that holds no org permission', async () => {
    const before = await call('get', '/:id/schema', as(OPERATOR, { params: { id: tableId } }));
    assert.strictEqual(before.statusCode, 200, JSON.stringify(before.body));

    const res = await call('put', '/:id/schema', as(OPERATOR, {
        params: { id: tableId },
        body: {
            expectedVersion: before.body.modelVersion,
            fields: [...before.body.fields, { key: 'done', name: 'Done', type: 'bool' }],
        },
    }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));

    const schema = datatableDbStore.schemaNameFor('user', OPERATOR);
    const cols = await rawQuery(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'notes'`, [schema]);
    assert.ok(cols.rows.some(r => r.column_name === 'done'), 'the ALTER must actually have run');
});

test('adding and reading a row works, and org_id stays NULL', async () => {
    const add = await call('post', '/:id/rows', as(OPERATOR, {
        params: { id: tableId }, body: { values: { topic: 'BFSF-412', done: false } },
    }));
    assert.strictEqual(add.statusCode, 200, JSON.stringify(add.body));

    const list = await call('get', '/:id/rows', as(OPERATOR, { params: { id: tableId } }));
    assert.strictEqual(list.statusCode, 200);
    assert.deepStrictEqual(list.body.rows.map(r => r.topic), ['BFSF-412']);
    // A personal row belongs to no organisation. Stamping one would make it
    // look like a shared record to every org-scoped query that comes later.
    assert.strictEqual(list.body.rows[0].org_id, null);
    assert.strictEqual(list.body.rows[0].created_by, OPERATOR);

    const t = await datatableStore.getDatatable(tableId, datatableStore.userScope(OPERATOR));
    assert.strictEqual(t.rowCount, 1);
});

// ── The privacy rule ────────────────────────────────────────────────────────

test('an ORG ADMIN cannot see it, reach it by id, or read its rows', async () => {
    const list = await call('get', '/', as(ADMIN));
    assert.deepStrictEqual(list.body.datatables, [],
        'an org admin browsing their own organisation must not find somebody\'s personal table');

    // 404, never 403: the existence of the table is not probeable either.
    for (const [verb, p] of [['get', '/:id'], ['get', '/:id/rows'], ['get', '/:id/schema'], ['get', '/:id/usage']]) {
        const res = await call(verb, p, as(ADMIN, { params: { id: tableId } }));
        assert.strictEqual(res.statusCode, 404, `${verb} ${p} -> ${JSON.stringify(res.body)}`);
    }
    const write = await call('post', '/:id/rows', as(ADMIN, {
        params: { id: tableId }, body: { values: { topic: 'sneak' } },
    }));
    assert.strictEqual(write.statusCode, 404);
    const del = await call('delete', '/:id', as(ADMIN, { params: { id: tableId } }));
    assert.strictEqual(del.statusCode, 404);
});

test('a plain colleague fares no better', async () => {
    const res = await call('get', '/:id/rows', as(MEMBER, { params: { id: tableId } }));
    assert.strictEqual(res.statusCode, 404);
});

test('the owner cannot share it either — sharing and grants are refused by name', async () => {
    for (const body of [{ audience: 'organisation' }, { audience: 'groups', sharedGroups: ['g1'] },
        { writeMode: 'audience' }]) {
        const res = await call('put', '/:id/sharing', as(OPERATOR, { params: { id: tableId }, body }));
        assert.strictEqual(res.statusCode, 400, JSON.stringify(body));
        assert.strictEqual(res.body.code, 'personal_table_not_shareable');
    }
    const grant = await call('post', '/:id/grants', as(OPERATOR, {
        params: { id: tableId }, body: { granteeType: 'user', granteeId: MEMBER, grade: 'viewer' },
    }));
    assert.strictEqual(grant.statusCode, 400, JSON.stringify(grant.body));
    assert.strictEqual(grant.body.code, 'personal_table_not_shareable');

    // Nothing was written by any of them, so the colleague still sees nothing.
    const row = (await rawQuery('SELECT is_published, shared_groups, write_mode FROM datatables WHERE id = $1', [tableId])).rows[0];
    assert.strictEqual(row.is_published, false);
    assert.strictEqual(row.write_mode, 'grants');
    assert.strictEqual((await rawQuery('SELECT COUNT(*)::int AS n FROM datatable_grants')).rows[0].n, 0);
    const stillHidden = await call('get', '/:id/rows', as(MEMBER, { params: { id: tableId } }));
    assert.strictEqual(stillHidden.statusCode, 404);
});

// ── Two accounts, two tenancies ─────────────────────────────────────────────

test('two accounts may each own a table with the SAME key, in separate schemas', async () => {
    const mine = await call('post', '/', as(MEMBER, {
        body: {
            scope: 'personal', name: 'My notes', key: 'notes', description: 'my own notes',
            fields: [{ key: 'topic', name: 'Topic', type: 'text' }],
        },
    }));
    assert.strictEqual(mine.statusCode, 200, JSON.stringify(mine.body));

    await call('post', '/:id/rows', as(MEMBER, {
        params: { id: mine.body.datatable.id }, body: { values: { topic: 'not yours' } },
    }));

    const mineSchema = datatableDbStore.schemaNameFor('user', MEMBER);
    const opSchema = datatableDbStore.schemaNameFor('user', OPERATOR);
    assert.notStrictEqual(mineSchema, opSchema);
    assert.deepStrictEqual(
        (await rawQuery(`SELECT topic FROM "${opSchema}"."notes"`)).rows.map(r => r.topic), ['BFSF-412']);
    assert.deepStrictEqual(
        (await rawQuery(`SELECT topic FROM "${mineSchema}"."notes"`)).rows.map(r => r.topic), ['not yours']);
});

test('a member sees the organisation\'s tables AND their own, in one list', async () => {
    // An org table nobody shared is invisible; one published to the org is not.
    const orgTable = await call('post', '/', as(ADMIN, {
        body: {
            name: 'Customers', key: 'customers', description: 'the shared customer list',
            fields: [{ key: 'email', name: 'E-mail', type: 'text' }],
        },
    }));
    assert.strictEqual(orgTable.statusCode, 200, JSON.stringify(orgTable.body));
    await call('put', '/:id/sharing', as(ADMIN, {
        params: { id: orgTable.body.datatable.id }, body: { audience: 'organisation' },
    }));

    const res = await call('get', '/', as(MEMBER));
    const byScope = res.body.datatables.map(t => [t.key, t.scopeKind]).sort();
    assert.deepStrictEqual(byScope, [['customers', 'org'], ['notes', 'user']]);
    assert.deepStrictEqual(res.body.scope, { kind: 'org', id: ORG, label: 'your organisation' },
        'a new table still defaults to the organisation for a member who has one');
});

test('creating an ORG table without manage_datatables is still 403', async () => {
    // The permission did not become optional — it became scope-appropriate.
    const res = await call('post', '/', as(MEMBER, {
        body: { scope: 'organisation', name: 'Leads', key: 'leads', description: 'inbound leads' },
    }));
    assert.strictEqual(res.statusCode, 403, JSON.stringify(res.body));
    assert.strictEqual(
        (await rawQuery('SELECT COUNT(*)::int AS n FROM datatables WHERE key = $1', ['leads'])).rows[0].n, 0);
});

// ── Erasure ─────────────────────────────────────────────────────────────────

test('DELETE /:id drops the personal metadata AND the rows', async () => {
    const schema = datatableDbStore.schemaNameFor('user', OPERATOR);
    const exists = async () => (await rawQuery('SELECT to_regclass($1) AS t', [`"${schema}"."notes"`])).rows[0].t;
    assert.ok(await exists());

    const res = await call('delete', '/:id', as(OPERATOR, { params: { id: tableId } }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(await exists(), null, 'an orphaned table is un-erasable personal data');
    assert.strictEqual(await datatableStore.getDatatable(tableId, datatableStore.userScope(OPERATOR)), null);
});
