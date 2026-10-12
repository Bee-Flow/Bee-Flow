/**
 * Self-service leave-org and Solution stages (design 3.4,
 * auth/admin/leaveOrgRoutes.js).
 *
 * Leaving re-parents every agent the leaver owns, in one bulk UPDATE, and then
 * moves the account out of the organisation. A Solution stage runs as one
 * account and every part deployed there is owned by it, so a run-as (or the
 * owner of a stage project) must be refused BEFORE that UPDATE: a refusal
 * after it would leave the agents moved and the account still in place.
 *
 * No module mocking: the database is recorded through `db.pool`
 * (core/http/routeHarness.js recordDb) and answers the stage read; the gates
 * are opened with openGates; the user lookups are swapped on the shared
 * userStore object (testUtils/swaps.js). The reassignment statement the route
 * sends is then run for real against pglite, so its stage exclusion is proven
 * on rows, not on text.
 *
 * Run: cd server && node --test auth/admin/leaveOrgRoutes.stageGuard.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');

const h = require('../../core/http/routeHarness');
const { makeSwaps } = require('../../testUtils/swaps');

// The stage rows the database answers for the leaver, per test.
let stageRows = [];
const db = h.recordDb((sql, params) => {
    if (/FROM solution_stages/i.test(sql) && params?.[0] === 'alice') return { rows: stageRows };
    return undefined;
});
h.openGates({ invalidatePermissionCache: async () => {} });

const userStore = require('../../stores/userStore');
const { swap, restore } = makeSwaps();
const touched = [];
swap(userStore, 'getUser', async (id) => ({ id, organizationId: 'org1', orgRole: id === 'admin1' ? 'org_admin' : 'member' }));
swap(userStore, 'updateUser', async (id, patch) => { touched.push(['updateUser', id, patch]); return true; });
swap(userStore, 'logAccessAudit', async () => {});

const api = h.serve('/api/admin', require('./leaveOrgRoutes'), { user: { id: 'alice', organizationId: 'org1' } });

test.before(() => db.settle());
test.after(async () => { restore(); await api.close(); });
test.beforeEach(() => { db.reset(); touched.length = 0; stageRows = []; });

const stageRow = (organizationId) => ({
    project_id: 'p-uat', solution_id: 'p-dev', stage: 'uat', organization_id: organizationId, run_as_user_id: 'alice',
    enabled: true, settings_version: 1, created_by: 'alice',
});
const reassigned = () => db.queries.filter((q) => /UPDATE agents/i.test(q));

test('the run-as of a stage in this organisation is refused before any agent moves', async () => {
    stageRows = [stageRow('org1')];
    const res = await api.call('POST', '/api/admin/users/me/leave-org', { body: { transferTo: 'admin1' } });
    assert.strictEqual(res.status, 409, res.text);
    assert.strictEqual(res.body.code, 'stage_run_as');
    assert.deepStrictEqual(reassigned(), [], 'no agent row was touched');
    assert.deepStrictEqual(touched, [], 'and the account did not leave');
});

test('a stage of another organisation does not hold the leaver here', async () => {
    stageRows = [stageRow('org2')];
    const res = await api.call('POST', '/api/admin/users/me/leave-org', { body: { transferTo: 'admin1' } });
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(reassigned().length, 1);
    assert.deepStrictEqual(touched.map(([what, id]) => [what, id]), [['updateUser', 'alice']]);
});

test('the reassignment leaves the agents of a stage project with their run-as', async () => {
    const res = await api.call('POST', '/api/admin/users/me/leave-org', { body: { transferTo: 'admin1' } });
    assert.strictEqual(res.status, 200, res.text);
    const [sql] = reassigned();
    assert.ok(sql, 'the reassignment ran');

    const pg = new PGlite();
    try {
        await pg.exec(`
            CREATE TABLE projects (id TEXT PRIMARY KEY, stage_of TEXT);
            CREATE TABLE agents (id TEXT PRIMARY KEY, owner_id TEXT, organization_id TEXT, project_id TEXT, updated_at TIMESTAMPTZ);
            INSERT INTO projects VALUES ('p-dev', NULL), ('p-uat', 'p-dev');
            INSERT INTO agents VALUES
                ('a-loose', 'alice', 'org1', NULL, NULL),
                ('a-dev',   'alice', 'org1', 'p-dev', NULL),
                ('a-stage', 'alice', 'org1', 'p-uat', NULL),
                ('a-other', 'alice', 'org2', NULL, NULL);
        `);
        await pg.query(sql, ['admin1', 'alice', 'org1']);
        const rows = (await pg.query('SELECT id, owner_id FROM agents ORDER BY id')).rows;
        assert.deepStrictEqual(Object.fromEntries(rows.map((r) => [r.id, r.owner_id])), {
            'a-dev': 'admin1', 'a-loose': 'admin1', 'a-other': 'alice', 'a-stage': 'alice',
        });
    } finally {
        await pg.close();
    }
});
