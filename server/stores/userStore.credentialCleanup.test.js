/**
 * Account/org deletion must take the credential vault with it.
 *
 * deleteUser cleaned automation_credentials but left integration_connections and
 * connection_grants behind. Three consequences, all bad for a privacy product:
 *   - a departed employee's encrypted API keys stayed in the vault forever;
 *   - any org-wide lend they had made KEPT RESOLVING, so their credentials went
 *     on running colleagues' automations after the account was gone;
 *   - a user re-created with the same id silently inherited both.
 *
 * No real DB: every `db` module in the require graph is redirected to an
 * in-memory double via testUtils/stubRequire, and every db.run() is captured so
 * we can assert on the statements issued.
 *
 * Two things make this file DB-free and, just as importantly, EXIT-free:
 *
 *  1. `db` is stubbed under all four specifier depths that occur in the tree
 *     ('./db', '../db', '../../db', '../../../db'). installResolveStub matches
 *     the require string AS WRITTEN in the requiring module, and deleteUser
 *     pulls in a wide cascade (core/kb/notebookCascade → notebook/KB stores),
 *     whose members sit at different depths. A depth we miss does not error —
 *     it silently loads the real db.js and reopens a pg pool.
 *
 *  2. auth/decryptAudit installs a module-level, NON-unref'd setInterval at
 *     require time (5-minute cleanup sweep). It is reached through
 *     stores/agent/messageEncryption.js, which requires it as
 *     '../../auth/decryptAudit' — that exact string is the stub key. Without
 *     it all three tests pass and the runner then hangs until the file-level
 *     timeout, because a ref'd timer keeps the loop alive. (Note it does not
 *     show up in process._getActiveHandles(); timers never do.)
 *
 *  3. stores/configStore.js opens a pg LISTEN/NOTIFY client at require time
 *     for cross-replica cache invalidation, guarded by NODE_ENV !== 'test'.
 *     The cascade reaches the real module through specifiers other than the
 *     './configStore' stubbed below, so the flag has to be set before the
 *     first require or the run ends with a live ECONNREFUSED to :5432 and a
 *     ref'd reconnect-backoff timer. (Same line 96 other suites here use.)
 *
 * Run: cd server && node --test stores/userStore.credentialCleanup.test.js
 */

process.env.NODE_ENV = 'test';   // must precede every require — see note 3

const assert = require('assert');
const { test, after } = require('node:test');
const { installResolveStub } = require('../testUtils/stubRequire');

const runCalls = [];
let getOneImpl = () => null;
let getAllImpl = () => [];

// Datatable erasure fixtures — the stubs below close over these.
const cachePurges = [];
const datatableCalls = [];
const teamChatErasures = [];
let ownedTables = [];

const dbStub = {
    pool: {},
    run: async (sql, params) => { runCalls.push({ sql, params }); return { rowCount: 1 }; },
    getOne: async (sql, params) => getOneImpl(sql, params),
    getAll: async (sql, params) => getAllImpl(sql, params),
    exec: async () => {},
    getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
    withTransaction: async (fn) => fn({ query: async () => ({ rows: [] }) }),
    getRedis: () => null,
    redisHealthy: () => false,
    disconnectRedis: async () => {},
    getPoolStats: () => ({}),
};

let hasPersonalModel = false;

const restore = installResolveStub({
    // Every depth the cascade requires the db from — see note 1 above.
    './db': dbStub,
    '../db': dbStub,
    '../../db': dbStub,
    '../../../db': dbStub,

    // Collaborators of the userStore aggregates, keyed exactly as the modules
    // write them. The implementation lives in stores/user/*.js (one level below
    // this facade), so the same collaborator is stubbed under BOTH the legacy
    // './x' spelling (other stores in the cascade) and the '../x' spelling the
    // user/ aggregates use.
    './configStore': {
        getConfig: async () => null,
        getSecret: async () => null,
        setConfig: async () => {},
        deleteConfig: async () => {},
    },
    '../configStore': {
        getConfig: async () => null,
        getSecret: async () => null,
        setConfig: async () => {},
        deleteConfig: async () => {},
    },
    // Datatables. `integration_response_cache` and the datatable tables are the
    // half of erasure this suite did not reach: the cache was an inline DELETE
    // nothing asserted, and the store's three erasure helpers had no callers at
    // all, so a departed user stayed the owner of a shared table and kept every
    // grant they had been given.
    '../integrationCacheStore': {
        purgeForUser: async (userId) => { cachePurges.push(userId); return 4; },
        purgeForOrg: async () => 0,
    },
    // Team chat messages the leaver wrote in colleagues' projects.
    '../projectChatStore': {
        eraseAuthor: async (userId) => { teamChatErasures.push(userId); return { messages: 3, reads: 1 }; },
    },
    '../datatableStore': {
        purgeGrantsForUser: async (userId) => { datatableCalls.push({ fn: 'purgeGrantsForUser', userId }); return 2; },
        listOwnedBy: async (userId) => { datatableCalls.push({ fn: 'listOwnedBy', userId }); return ownedTables; },
        transferOwner: async (id, scope, heir) => { datatableCalls.push({ fn: 'transferOwner', id, scope, heir }); },
    },
    '../datatableDbStore': {
        scopeKey: (scope) => `${scope.kind}:${scope.id}`,
        orgScopeKey: (orgId) => `org:${orgId}`,
        dropDatatable: async (id, scope) => { datatableCalls.push({ fn: 'dropDatatable', id, scope }); return true; },
        reset: async (ownerId, entityId) => { datatableCalls.push({ fn: 'reset', ownerId, entityId }); },
        invalidate: (key) => { datatableCalls.push({ fn: 'invalidate', key }); },
    },

    './notificationStore': { deleteNotificationsForUser: async () => {} },
    '../notificationStore': { deleteNotificationsForUser: async () => {} },
    '../services/planEntitlements': { applyPlanToOrg: async () => {} },
    '../../services/planEntitlements': { applyPlanToOrg: async () => {} },
    './usageStore': { invalidatePaygCache: () => {} },
    '../usageStore': { invalidatePaygCache: () => {} },

    // Keyed as stores/agent/messageEncryption.js writes it — see note 2 above.
    '../../auth/decryptAudit': {
        trackDecrypt: () => {},
        getDecryptStats: () => null,
    },
});
after(restore);

const userStore = require('./userStore');

const sqlOf = (c) => String(c.sql).replace(/\s+/g, ' ').trim();
const deletesFrom = (table) => runCalls.filter(c =>
    /DELETE\s+FROM/i.test(c.sql) && new RegExp(`\\b${table}\\b`, 'i').test(c.sql));

test('deleteUser removes the user\'s integration connections and grants', async () => {
    runCalls.length = 0;
    getOneImpl = (sql) => (/FROM users WHERE id/i.test(sql) ? { id: 'u1', email: 'gone@acme.test' } : null);
    getAllImpl = () => [];

    await userStore.deleteUser('u1');

    const connDeletes = deletesFrom('integration_connections');
    assert.strictEqual(connDeletes.length, 1, 'integration_connections must be cleaned');
    assert.match(sqlOf(connDeletes[0]), /owner_user_id = \$1/);
    assert.deepStrictEqual(connDeletes[0].params, ['u1']);

    const grantDeletes = deletesFrom('connection_grants');
    assert.strictEqual(grantDeletes.length, 1, 'connection_grants must be cleaned');
    assert.deepStrictEqual(grantDeletes[0].params, ['u1']);

    // Both directions: lends they MADE (which would keep resolving for the
    // whole org) and lends they RECEIVED (which a recycled id would inherit).
    const grantSql = sqlOf(grantDeletes[0]);
    assert.match(grantSql, /grantor_user_id = \$1/);
    assert.match(grantSql, /grantee_id = \$1/);

    // grantee_id also holds GROUP ids, so the grantee arm must be type-qualified
    // or deleting a user could take an unrelated group grant with it.
    assert.match(grantSql, /grantee_type = 'user'/,
        'the grantee arm must be restricted to user grants');

    // The pre-existing OAuth-token cleanup must still be there.
    assert.strictEqual(deletesFrom('automation_credentials').length, 1);
});

test('deleteUser deletes grants BEFORE connections (FK cascade ordering)', async () => {
    runCalls.length = 0;
    getOneImpl = (sql) => (/FROM users WHERE id/i.test(sql) ? { id: 'u1' } : null);
    getAllImpl = () => [];

    await userStore.deleteUser('u1');

    const grantIdx = runCalls.findIndex(c => /DELETE FROM connection_grants/i.test(c.sql));
    const connIdx = runCalls.findIndex(c => /DELETE FROM integration_connections/i.test(c.sql));
    assert.ok(grantIdx >= 0 && connIdx >= 0);
    assert.ok(grantIdx < connIdx, 'grants first, so the FK cascade has nothing left to do');
});

test('deleteOrganization sweeps connections, grants and automation credentials by org', async () => {
    runCalls.length = 0;
    getOneImpl = (sql) => (/FROM organizations WHERE id/i.test(sql) ? { id: 'orgA', name: 'Acme' } : null);
    getAllImpl = () => [];

    await userStore.deleteOrganization('orgA');

    for (const table of ['connection_grants', 'integration_connections', 'automation_credentials']) {
        const hits = deletesFrom(table).filter(c => /org_id = \$1/i.test(c.sql));
        assert.strictEqual(hits.length, 1, `${table} must be swept on org delete`);
        assert.deepStrictEqual(hits[0].params, ['orgA']);
    }
});

// ── Datatables ──────────────────────────────────────────────────────────────
//
// datatableStore shipped three helpers under an "── Erasure ──" banner —
// listOwnedBy, transferOwner, purgeGrantsForUser — with ZERO callers, while
// deleteUser left `datatables.owner_user_id` and `datatable_grants` naming a
// dead id. That is the BFSF-181 shape the agents cascade above already guards
// against: a user re-created with the same id resolves as `owner` on a
// colleague's HR table.

/** Fresh state for one deleteUser call. `admin` is who the heir lookup finds. */
function forDeleteUser({ owned = [], admin = null, personalModel = false } = {}) {
    runCalls.length = 0;
    cachePurges.length = 0;
    datatableCalls.length = 0;
    ownedTables = owned;
    hasPersonalModel = personalModel;
    getOneImpl = (sql) => {
        if (/orgRole.*org_admin/is.test(sql)) return admin ? { id: admin } : null;
        if (/FROM users WHERE id/i.test(sql)) return { id: 'u1' };
        // "does this account have a personal datatable tenancy" — off unless a
        // test says otherwise.
        if (/FROM datatable_models WHERE scope_kind = 'user'/i.test(sql)) {
            return hasPersonalModel ? { present: 1 } : null;
        }
        return null;
    };
    getAllImpl = () => [];
}

test('deleteUser purges every datatable grant the account held or was given', async () => {
    forDeleteUser();
    await userStore.deleteUser('u1');
    assert.deepStrictEqual(
        datatableCalls.filter(c => c.fn === 'purgeGrantsForUser'),
        [{ fn: 'purgeGrantsForUser', userId: 'u1' }],
        'left behind, a re-created id silently re-inherits them',
    );
});

test('deleteUser transfers a SHARED table to the org\'s oldest remaining admin', async () => {
    forDeleteUser({
        owned: [{
            id: 'tbl_hr', organizationId: 'orgA', scope: { kind: 'org', id: 'orgA' },
            key: 'hr', isPublished: true, grantCount: 0,
        }],
        admin: 'admin1',
    });
    await userStore.deleteUser('u1');

    assert.deepStrictEqual(
        datatableCalls.filter(c => c.fn === 'transferOwner'),
        [{ fn: 'transferOwner', id: 'tbl_hr', scope: { kind: 'org', id: 'orgA' }, heir: 'admin1' }],
    );
    // A published table is the ORGANISATION's record under its own lawful
    // basis — erasing it because an employee left is data loss, not erasure.
    assert.strictEqual(datatableCalls.filter(c => c.fn === 'dropDatatable').length, 0);
});

test('the heir is picked deterministically and never the account being deleted', async () => {
    let heirSql = null;
    forDeleteUser({
        owned: [{
            id: 'tbl_hr', organizationId: 'orgA', scope: { kind: 'org', id: 'orgA' },
            key: 'hr', isPublished: true, grantCount: 1,
        }],
        admin: 'admin1',
    });
    const base = getOneImpl;
    getOneImpl = (sql, params) => {
        if (/orgRole.*org_admin/is.test(sql)) heirSql = { sql: String(sql).replace(/\s+/g, ' '), params };
        return base(sql, params);
    };
    await userStore.deleteUser('u1');

    assert.ok(heirSql, 'a shared table must trigger the heir lookup');
    // "An admin" would hand a colleague's HR table to whichever row Postgres
    // returned first, and the ops line naming the new owner would differ on a
    // replay — the opposite of an audit trail.
    assert.match(heirSql.sql, /ORDER BY "createdAt" ASC NULLS LAST, id ASC/);
    assert.match(heirSql.sql, /id <> \$2/);
    assert.deepStrictEqual(heirSql.params, ['orgA', 'u1']);
});

test('a shared table with no admin left is kept, loudly — never deleted', async () => {
    forDeleteUser({
        owned: [{
            id: 'tbl_hr', organizationId: 'orgA', scope: { kind: 'org', id: 'orgA' },
            key: 'hr', isPublished: true, grantCount: 0,
        }],
        admin: null,
    });
    await userStore.deleteUser('u1');
    assert.strictEqual(datatableCalls.filter(c => c.fn === 'dropDatatable').length, 0,
        'no heir is not a licence to delete the organisation\'s records');
    assert.strictEqual(datatableCalls.filter(c => c.fn === 'transferOwner').length, 0);
});

test('a private table goes with the account — ROWS included', async () => {
    forDeleteUser({
        owned: [{
            id: 'tbl_scratch', organizationId: 'orgA', scope: { kind: 'org', id: 'orgA' },
            key: 'scratch', isPublished: false, grantCount: 0,
        }],
        admin: 'admin1',
    });
    await userStore.deleteUser('u1');

    // dropDatatable, not a metadata delete: the rows live in a Postgres schema
    // no foreign key reaches, so a metadata-only delete would leave them there
    // with nothing describing them. And it is dropped in the scope the row
    // carries — a rebuilt one would name a different schema.
    assert.deepStrictEqual(
        datatableCalls.filter(c => c.fn === 'dropDatatable'),
        [{ fn: 'dropDatatable', id: 'tbl_scratch', scope: { kind: 'org', id: 'orgA' } }],
    );
    assert.strictEqual(datatableCalls.filter(c => c.fn === 'transferOwner').length, 0);
});

test('a PERSONAL table and the tenancy it lived in both go with the account', async () => {
    // A user-scoped table is unreachable by anyone else, so it is always the
    // "goes with the account" kind. Dropping the tables alone would leave the
    // account's own Postgres schema and its `datatable_models` row standing —
    // and that row is keyed on the user id of somebody who asked to be erased.
    forDeleteUser({
        owned: [{
            id: 'tbl_mine', organizationId: null, scope: { kind: 'user', id: 'u1' },
            key: 'mine', isPublished: false, grantCount: 0,
        }],
        admin: 'admin1',
        personalModel: true,
    });
    await userStore.deleteUser('u1');

    assert.deepStrictEqual(
        datatableCalls.filter(c => c.fn === 'dropDatatable'),
        [{ fn: 'dropDatatable', id: 'tbl_mine', scope: { kind: 'user', id: 'u1' } }],
    );
    const reset = datatableCalls.find(c => c.fn === 'reset');
    assert.deepStrictEqual(reset, { fn: 'reset', ownerId: 'user:u1', entityId: 'user:u1' });
    const meta = runCalls.find(c => /DELETE FROM datatable_models/i.test(c.sql));
    assert.ok(meta, 'the model row is itself an identifier of the erased account');
    assert.deepStrictEqual(meta.params, ['u1']);
    // Rows first, metadata second — inverted, a crash leaves rows that nothing
    // describes.
    assert.ok(datatableCalls.findIndex(c => c.fn === 'reset')
        < datatableCalls.findIndex(c => c.fn === 'invalidate'));
});

test('an account that never made a personal table is not asked to drop a schema', async () => {
    forDeleteUser({ personalModel: false });
    await userStore.deleteUser('u1');
    assert.strictEqual(datatableCalls.filter(c => c.fn === 'reset').length, 0,
        'no model row means no schema; asking the engine for one 404s and logs noise');
});

test('cached integration answers go through the store, not an inline DELETE', async () => {
    forDeleteUser();
    await userStore.deleteUser('u1');
    // purgeForUser also drops the memoised per-org counters, and it is the
    // tested helper written for exactly this erasure — the inline SQL string it
    // replaces was the only Art. 17 guarantee that cache made.
    assert.deepStrictEqual(cachePurges, ['u1']);
    assert.strictEqual(deletesFrom('integration_response_cache').length, 0,
        'the raw DELETE must be gone, or the two paths can drift');
});

test('deleteUser erases the team chat messages the leaver wrote', async () => {
    runCalls.length = 0;
    teamChatErasures.length = 0;
    getOneImpl = (sql) => (/FROM users WHERE id/i.test(sql) ? { id: 'u1' } : null);
    getAllImpl = () => [];

    await userStore.deleteUser('u1');
    assert.deepStrictEqual(teamChatErasures, ['u1']);
});

test('deleteUser deletes owned projects through the project teardown, never a bare DELETE by owner', async () => {
    // A bare `DELETE FROM projects WHERE owner_id = $1` cascaded the co-editing
    // log away with colleagues' edits not yet written back, and left the
    // project's files base behind (stores/user/projectErasure.js).
    runCalls.length = 0;
    getOneImpl = (sql) => (/FROM users WHERE id/i.test(sql) ? { id: 'u1' } : null);
    getAllImpl = (sql) => (/SELECT id FROM projects WHERE owner_id/i.test(sql) ? [{ id: 'p-owned' }] : []);

    await userStore.deleteUser('u1');

    assert.strictEqual(runCalls.filter(c => /DELETE\s+FROM\s+projects\s+WHERE\s+owner_id/i.test(c.sql)).length, 0,
        'the owner-wide DELETE must be gone');
    const byId = deletesFrom('projects').filter(c => /DELETE\s+FROM\s+projects\s+WHERE id = \$1/i.test(c.sql));
    assert.deepStrictEqual(byId.map(c => c.params), [['p-owned']], 'each owned project is deleted on its own');
});
