// @typecheck
/**
 * The Feature-C access helpers on integrationConnectionStore, against a real
 * Postgres (the boot ladder's schema on PGlite, testUtils/pgliteTemplate.js
 * ladderPglite, behind db.js's pool):
 * authorizeConnectionUse (own-or-grant gate for ONE connection id) and
 * listAccessibleConnections (own + lent union with `access` flags).
 *
 * Run: node --test stores/integrationConnectionStore.httpAccess.test.js
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';
process.env.MASTER_ENCRYPTION_KEY = 'test-master-key-for-unit-tests-32chars!!';
process.env.INTEGRATION_CONNECTIONS_BACKFILL = '0'; // no boot timer in tests

const { usePglitePool } = require('../testUtils/pglitePool');
const { ladderPglite } = require('../testUtils/pgliteTemplate');

const { pg, close } = usePglitePool(ladderPglite());
const store = require('./integrationConnectionStore');

before(() => store.initDB());
after(close);
beforeEach(() => pg.exec('DELETE FROM connection_grants; DELETE FROM integration_connections'));

const C1 = '00000000-0000-4000-8000-0000000000c1';

/** @param {Record<string, unknown>} [over] */
async function connection(over = {}) {
    const r = { id: C1, owner_user_id: 'owner1', org_id: 'orgA', provider: 'http', label: 'Billing API', kind: 'bearer', status: 'active', is_default: false, ...over };
    const cols = Object.keys(r);
    await pg.query(`INSERT INTO integration_connections (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(r));
    return /** @type {string} */ (r.id);
}

/** @param {Record<string, unknown>} over */
async function grant(over) {
    const r = { connection_id: C1, org_id: 'orgA', grantor_user_id: 'owner1', grantee_type: 'user', grantee_id: 'u2', ...over };
    const cols = Object.keys(r);
    const { rows } = await pg.query(`INSERT INTO connection_grants (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(r));
    return rows[0].id;
}

/** @param {Partial<Parameters<typeof store.authorizeConnectionUse>[0]>} over */
const authorize = (over) => store.authorizeConnectionUse({ connectionId: C1, runningUserId: 'u2', runningUserOrgId: 'orgA', ...over });

// ── authorizeConnectionUse ──────────────────────────────────────

test('unknown id → not_found', async () => {
    assert.deepStrictEqual(await authorize({ runningUserId: 'u1' }), { ok: false, reason: 'not_found' });
});

test('owner → ok, mode own, shaped connection with NO secret field', async () => {
    await connection();
    const r = await authorize({ runningUserId: 'owner1' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.mode, 'own');
    assert.strictEqual(r.connection.id, C1);
    assert.strictEqual(r.connection.label, 'Billing API');
    assert.ok(!('secret' in r.connection), 'shapeConnection must not expose the secret blob');
});

test('non-owner with a matching grant → delegated, by user, by group or org-wide', async () => {
    await connection();
    const byUser = await grant({ grantee_type: 'user', grantee_id: 'u2' });
    const r = await authorize({ runningUserId: 'u2' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.mode, 'delegated');
    assert.strictEqual(r.grantId, byUser);

    await pg.exec('DELETE FROM connection_grants');
    await grant({ grantee_type: 'group', grantee_id: 'grp1' });
    assert.strictEqual((await authorize({ runningUserId: 'u3', runningUserGroups: ['grp0', 'grp1'] })).mode, 'delegated');
    assert.deepStrictEqual(await authorize({ runningUserId: 'u3', runningUserGroups: ['grp2'] }), { ok: false, reason: 'forbidden' });

    await pg.exec('DELETE FROM connection_grants');
    await grant({ grantee_type: 'org', grantee_id: null });
    assert.strictEqual((await authorize({ runningUserId: 'anyone' })).mode, 'delegated');
});

test('a grant is bound to the RUNNING user\'s org (structural isolation)', async () => {
    await connection({ org_id: 'orgA' });
    await grant({ org_id: 'orgA', grantee_type: 'org', grantee_id: null });
    assert.deepStrictEqual(await authorize({ runningUserId: 'u2', runningUserOrgId: 'orgB' }), { ok: false, reason: 'forbidden' },
        'an orgA grant can never match a runner of orgB');
});

test('revoked and expired grants never authorize', async () => {
    await connection();
    await grant({ revoked_at: new Date().toISOString() });
    await grant({ expires_at: new Date(Date.now() - 1000).toISOString() });
    assert.deepStrictEqual(await authorize({}), { ok: false, reason: 'forbidden' });
    await grant({ expires_at: new Date(Date.now() + 3600_000).toISOString() });
    assert.strictEqual((await authorize({})).mode, 'delegated', 'a grant that has not expired yet does');
});

test('only UNSCOPED grants authorize (resource-scoped lends never authorize automations)', async () => {
    await connection();
    await grant({ resource_type: 'studio_app', resource_id: 'app1' });
    await grant({ resource_type: 'studio_app', resource_id: null });
    assert.deepStrictEqual(await authorize({}), { ok: false, reason: 'forbidden' },
        'a lend scoped to e.g. one studio_app must not authorize free-standing http_request use');
});

test('a grant on another connection does not authorize this one', async () => {
    await connection();
    const other = await connection({ id: '00000000-0000-4000-8000-0000000000c2', label: 'Other' });
    await grant({ connection_id: other });
    assert.deepStrictEqual(await authorize({}), { ok: false, reason: 'forbidden' });
});

test('non-owner without a grant → forbidden (no status leak)', async () => {
    await connection({ status: 'needs_reauth' });
    assert.deepStrictEqual(await authorize({ runningUserId: 'u9' }), { ok: false, reason: 'forbidden' });
});

test('own but needs_reauth → surfaced as reason with shaped connection', async () => {
    await connection({ status: 'needs_reauth' });
    const r = await authorize({ runningUserId: 'owner1' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'needs_reauth');
    assert.strictEqual(r.connection.label, 'Billing API');
    assert.ok(!('secret' in r.connection));
});

test('granted but revoked-status connection → reason revoked', async () => {
    await connection({ status: 'revoked' });
    await grant({});
    const r = await authorize({});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'revoked');
});

// ── listAccessibleConnections ───────────────────────────────────

test('own + lent union with access flags; own rows are never doubled via a self-grant', async () => {
    const mine = await connection({ id: '00000000-0000-4000-8000-00000000000a', owner_user_id: 'u1', label: 'Mine' });
    const lent = await connection({ id: '00000000-0000-4000-8000-00000000000b', owner_user_id: 'owner2', label: 'Shared' });
    await grant({ connection_id: lent, grantee_type: 'group', grantee_id: 'g1' });
    await grant({ connection_id: lent, grantee_type: 'user', grantee_id: 'u1' });   // the same lend twice
    await grant({ connection_id: mine, grantee_type: 'user', grantee_id: 'u1' });   // a self-grant
    const list = await store.listAccessibleConnections({ userId: 'u1', orgId: 'orgA', groups: ['g1'], provider: 'http' });
    assert.deepStrictEqual(list.map(c => `${c.label}:${c.access}`).sort(), ['Mine:own', 'Shared:lent']);
    assert.ok(list.every(c => !('secret' in c)), 'no secret blob in any listed connection');
});

test('the lent branch is bound to the caller\'s org and provider, and skips revoked, expired and scoped lends', async () => {
    const ids = ['0d', '0e', '0f', '10', '11'].map(s => `00000000-0000-4000-8000-0000000000${s}`);
    await connection({ id: ids[0], owner_user_id: 'o2', label: 'Other org', org_id: 'orgB' });
    await grant({ connection_id: ids[0], org_id: 'orgB', grantee_type: 'org', grantee_id: null });
    await connection({ id: ids[1], owner_user_id: 'o2', label: 'Smtp', provider: 'smtp' });
    await grant({ connection_id: ids[1], grantee_type: 'org', grantee_id: null });
    await connection({ id: ids[2], owner_user_id: 'o2', label: 'Revoked' });
    await grant({ connection_id: ids[2], grantee_id: 'u1', revoked_at: new Date().toISOString() });
    await connection({ id: ids[3], owner_user_id: 'o2', label: 'Scoped' });
    await grant({ connection_id: ids[3], grantee_id: 'u1', resource_type: 'studio_app', resource_id: 'app1' });
    await connection({ id: ids[4], owner_user_id: 'o2', label: 'Expired' });
    await grant({ connection_id: ids[4], grantee_id: 'u1', expires_at: new Date(Date.now() - 1000).toISOString() });
    assert.deepStrictEqual(await store.listAccessibleConnections({ userId: 'u1', orgId: 'orgA', groups: [], provider: 'http' }), []);
});

test('an empty org funnels through the sentinel', async () => {
    const lent = await connection({ owner_user_id: 'o2', org_id: store.DEFAULT_ORG_SENTINEL });
    await grant({ connection_id: lent, org_id: store.DEFAULT_ORG_SENTINEL, grantee_type: 'org', grantee_id: null });
    const list = await store.listAccessibleConnections({ userId: 'u1', orgId: '', provider: 'http' });
    assert.deepStrictEqual(list.map(c => c.access), ['lent']);
});
