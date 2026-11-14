// @typecheck
'use strict';

/**
 * mcp_tokens against a real Postgres (PGlite behind db.js's pool,
 * testUtils/pglitePool.js): the secret hash never comes back in a record,
 * revoke and enable/disable only touch the caller's own token, a revoked token
 * stays as it is, and the active count leaves revoked and expired tokens out.
 *
 * Run: cd server && node --test stores/mcpTokenStore.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const store = require('./mcpTokenStore');

test.before(() => store.initDB());
test.after(close);

let seq = 0;
async function token(userId = 'u1', extra = {}) {
    seq += 1;
    return store.insert({
        id: `id-${seq}`, userId, orgId: 'org1', name: 'CI', secretHash: `hash-${seq}`,
        scopes: { studio: { level: 'read' } }, ipAllowlist: ['203.0.113.0/24'], expiresAt: null, ...extra,
    });
}
const rowOf = async (id) => (await pg.query('SELECT revoked_at, disabled_at FROM mcp_tokens WHERE id = $1', [id])).rows[0];

test('toRecord maps columns to camelCase, dates to ISO strings, and drops the hash', () => {
    const rec = store.toRecord({
        id: 'id-1', user_id: 'u1', org_id: 'org1', name: 'CI', secret_hash: 'deadbeef',
        scopes: { studio: { level: 'read' } }, ip_allowlist: ['203.0.113.0/24'],
        expires_at: new Date('2026-12-01T00:00:00Z'), last_used_at: null,
        created_at: new Date('2026-10-10T12:00:00Z'), revoked_at: null, disabled_at: null,
    });
    assert.deepEqual(rec, {
        id: 'id-1', userId: 'u1', orgId: 'org1', name: 'CI',
        scopes: { studio: { level: 'read' } }, ipAllowlist: ['203.0.113.0/24'],
        expiresAt: '2026-12-01T00:00:00.000Z', lastUsedAt: null, createdAt: '2026-10-10T12:00:00.000Z', revokedAt: null,
        disabledAt: null, enabled: true,
    });
    assert.equal(store.toRecord(null), null);
});

test('insert stores the hash and the scopes, and returns a record without the hash', async () => {
    const rec = await token();
    assert.equal(JSON.stringify(rec).includes(`hash-${seq}`), false);
    assert.deepEqual(rec.scopes, { studio: { level: 'read' } });
    const { rows } = await pg.query('SELECT secret_hash, scopes FROM mcp_tokens WHERE id = $1', [rec.id]);
    assert.equal(rows[0].secret_hash, `hash-${seq}`);
    assert.deepEqual(rows[0].scopes, { studio: { level: 'read' } });
});

test('getWithHash returns the hash beside the record, for the constant-time compare', async () => {
    const rec = await token();
    const found = await store.getWithHash(rec.id);
    assert.equal(found.secretHash, `hash-${seq}`);
    assert.equal(found.record.id, rec.id);
    assert.equal('secretHash' in found.record, false);
    assert.equal(await store.getWithHash('missing'), null);
});

test('revoke is scoped to the owner and idempotent', async () => {
    const rec = await token();
    assert.equal(await store.revoke('u2', rec.id), null, 'not theirs');
    assert.equal((await rowOf(rec.id)).revoked_at, null);
    const first = await store.revoke('u1', rec.id);
    assert.ok(first.revokedAt);
    const again = await store.revoke('u1', rec.id);
    assert.equal(again.revokedAt, first.revokedAt, 'a second revoke keeps the first time');
});

test('setEnabled is scoped to the owner, round-trips disabledAt and leaves a revoked token as it is', async () => {
    const rec = await token();
    assert.equal(await store.setEnabled('u2', rec.id, false), null);
    assert.equal((await rowOf(rec.id)).disabled_at, null);
    const off = await store.setEnabled('u1', rec.id, false);
    assert.equal(off.enabled, false);
    assert.ok(off.disabledAt);
    assert.equal((await store.setEnabled('u1', rec.id, false)).disabledAt, off.disabledAt, 'off twice keeps the time');
    const on = await store.setEnabled('u1', rec.id, true);
    assert.equal(on.enabled, true);
    assert.equal(on.disabledAt, null);

    const revoked = await token();
    await store.revoke('u1', revoked.id);
    const after = await store.setEnabled('u1', revoked.id, false);
    assert.equal(after.disabledAt, null, 'a revoked token is not switched');
});

test("listByUser reads only that user's rows, never the hash", async () => {
    const mine = await token('u-list');
    await token('u-other');
    const list = await store.listByUser('u-list');
    assert.deepEqual(list.map((r) => r.id), [mine.id]);
    assert.equal(JSON.stringify(list).includes('hash-'), false);
});

test('countActiveByUser leaves revoked and expired tokens out', async () => {
    await token('u-count');
    const revoked = await token('u-count');
    await store.revoke('u-count', revoked.id);
    await token('u-count', { expiresAt: new Date(Date.now() - 60_000).toISOString() });
    await token('u-count', { expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    assert.equal(await store.countActiveByUser('u-count'), 2);
});

test('touch stamps last_used_at on that token only', async () => {
    const a = await token();
    const b = await token();
    await store.touch(a.id);
    const { rows } = await pg.query('SELECT id, last_used_at FROM mcp_tokens WHERE id = ANY($1::text[]) ORDER BY id', [[a.id, b.id]]);
    assert.ok(rows.find((r) => r.id === a.id).last_used_at);
    assert.equal(rows.find((r) => r.id === b.id).last_used_at, null);
});
