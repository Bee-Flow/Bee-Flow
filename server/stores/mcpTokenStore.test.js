'use strict';

/**
 * mcp_tokens: row mapping and the shape of the SQL. Postgres itself is not
 * here (pool.query is replaced), so what is checked is that the secret hash
 * never comes back in a record and that every statement is scoped the way the
 * token store relies on (a user can only revoke their own token).
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db');
const queries = [];
let answer = () => ({ rows: [] });
const query = async (sql, params) => {
    const text = typeof sql === 'string' ? sql : sql.text;
    if (!/^\s*(CREATE|ALTER|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET|SELECT pg_advisory)/i.test(text)) queries.push({ text, params });
    const out = answer(text, params);
    return { rowCount: out.rows.length, ...out };
};
db.pool.query = query;
db.pool.connect = async () => ({ query, release() {} });

const store = require('./mcpTokenStore');

const ROW = {
    id: 'id-1', user_id: 'u1', org_id: 'org1', name: 'CI', secret_hash: 'deadbeef',
    scopes: { studio: { level: 'read' } }, ip_allowlist: ['203.0.113.0/24'],
    expires_at: new Date('2026-12-01T00:00:00Z'), last_used_at: null,
    created_at: new Date('2026-10-10T12:00:00Z'), revoked_at: null, disabled_at: null,
};

test.beforeEach(() => { queries.length = 0; answer = () => ({ rows: [] }); });

test('toRecord maps columns to camelCase, dates to ISO strings, and drops the hash', () => {
    const rec = store.toRecord(ROW);
    assert.deepEqual(rec, {
        id: 'id-1', userId: 'u1', orgId: 'org1', name: 'CI',
        scopes: { studio: { level: 'read' } }, ipAllowlist: ['203.0.113.0/24'],
        expiresAt: '2026-12-01T00:00:00.000Z', lastUsedAt: null, createdAt: '2026-10-10T12:00:00.000Z', revokedAt: null,
        disabledAt: null, enabled: true,
    });
    assert.equal('secret_hash' in rec || 'secretHash' in rec, false);
    assert.equal(store.toRecord(null), null);
});

test('insert stores the hash, returns a record without it', async () => {
    answer = (text) => (/^\s*INSERT/i.test(text) ? { rows: [ROW] } : { rows: [] });
    const rec = await store.insert({
        id: 'id-1', userId: 'u1', orgId: 'org1', name: 'CI', secretHash: 'deadbeef',
        scopes: { studio: { level: 'read' } }, ipAllowlist: [], expiresAt: null,
    });
    assert.equal(rec.id, 'id-1');
    assert.equal(JSON.stringify(rec).includes('deadbeef'), false);
    const q = queries.find((x) => /INSERT INTO mcp_tokens/.test(x.text));
    assert.ok(q.params.includes('deadbeef'));
    assert.ok(q.params.includes(JSON.stringify({ studio: { level: 'read' } })));
});

test('getWithHash returns the hash beside the record, for the constant-time compare', async () => {
    answer = () => ({ rows: [ROW] });
    const found = await store.getWithHash('id-1');
    assert.equal(found.secretHash, 'deadbeef');
    assert.equal(found.record.id, 'id-1');
    answer = () => ({ rows: [] });
    assert.equal(await store.getWithHash('missing'), null);
});

test('revoke is scoped to the owner and idempotent', async () => {
    answer = () => ({ rows: [{ ...ROW, revoked_at: new Date('2026-10-11T00:00:00Z') }] });
    const rec = await store.revoke('u1', 'id-1');
    assert.equal(rec.revokedAt, '2026-10-11T00:00:00.000Z');
    const q = queries.find((x) => /UPDATE mcp_tokens/.test(x.text));
    assert.match(q.text, /WHERE id = \$1 AND user_id = \$2/);
    assert.match(q.text, /COALESCE\(revoked_at, NOW\(\)\)/);
    assert.deepEqual(q.params, ['id-1', 'u1']);
    answer = () => ({ rows: [] });
    assert.equal(await store.revoke('u2', 'id-1'), null);
});

test('setEnabled is scoped to the owner, keeps a revoked token as it is, and maps disabledAt', async () => {
    answer = () => ({ rows: [{ ...ROW, disabled_at: new Date('2026-10-11T00:00:00Z') }] });
    const off = await store.setEnabled('u1', 'id-1', false);
    assert.equal(off.disabledAt, '2026-10-11T00:00:00.000Z');
    assert.equal(off.enabled, false);
    const q = queries.find((x) => /UPDATE mcp_tokens/.test(x.text));
    assert.match(q.text, /WHERE id = \$1 AND user_id = \$2/);
    assert.match(q.text, /revoked_at IS NOT NULL THEN disabled_at/);
    assert.deepEqual(q.params, ['id-1', 'u1', false]);
    answer = () => ({ rows: [] });
    assert.equal(await store.setEnabled('u2', 'id-1', true), null);
});

test('listByUser reads only that user\'s rows', async () => {
    answer = () => ({ rows: [ROW] });
    const list = await store.listByUser('u1');
    assert.equal(list.length, 1);
    assert.deepEqual(queries.at(-1).params, ['u1']);
    assert.doesNotMatch(queries.at(-1).text, /secret_hash/, 'the list query never selects the hash');
});
