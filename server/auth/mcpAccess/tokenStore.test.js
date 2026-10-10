'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const tokenStore = require('./tokenStore');

/** An in-memory stand-in for stores/mcpTokenStore.js with the same contract. */
function fakeRepo() {
    const rows = new Map();
    const calls = { touch: [] };
    return {
        rows, calls,
        async insert(r) {
            const row = { ...r, createdAt: '2026-10-10T12:00:00.000Z', lastUsedAt: null, revokedAt: null };
            rows.set(r.id, row);
            const { secretHash, ...record } = row;
            return record;
        },
        async listByUser(userId) {
            return [...rows.values()].filter((r) => r.userId === userId).map(({ secretHash, ...rec }) => rec);
        },
        async countActiveByUser(userId) {
            return [...rows.values()].filter((r) => r.userId === userId && !r.revokedAt).length;
        },
        async getWithHash(id) {
            const row = rows.get(id);
            if (!row) return null;
            const { secretHash, ...record } = row;
            return { record, secretHash };
        },
        async revoke(userId, id) {
            const row = rows.get(id);
            if (!row || row.userId !== userId) return null;
            row.revokedAt = row.revokedAt || '2026-10-10T13:00:00.000Z';
            const { secretHash, ...record } = row;
            return record;
        },
        async setEnabled(userId, id, enabled) {
            const row = rows.get(id);
            if (!row || row.userId !== userId) return null;
            if (!row.revokedAt) row.disabledAt = enabled ? null : (row.disabledAt || '2026-10-10T14:00:00.000Z');
            const { secretHash, ...record } = row;
            return { ...record, enabled: !row.disabledAt };
        },
        async touch(id) { calls.touch.push(id); },
    };
}

let repo;
test.beforeEach(() => {
    repo = fakeRepo();
    tokenStore._test.setRepo(repo);
});
test.after(() => tokenStore._test.setRepo(null));

const input = (over = {}) => ({ userId: 'u1', orgId: 'org1', name: 'CI', scopes: { studio: { level: 'read' } }, ...over });

test('createToken: the format is bfmcp_<32 hex>_<64 hex> and only the sha256 is stored', async () => {
    const { token, record } = await tokenStore.createToken(input());
    const m = /^bfmcp_([a-f0-9]{32})_([a-f0-9]{64})$/.exec(token);
    assert.ok(m, token);
    assert.equal(record.id.replace(/-/g, ''), m[1]);
    const stored = repo.rows.get(record.id);
    assert.equal(stored.secretHash, crypto.createHash('sha256').update(m[2]).digest('hex'));
    assert.equal(JSON.stringify([...repo.rows.values()]).includes(m[2]), false, 'the secret is nowhere in the stored row');
    assert.equal('secretHash' in record, false);
    assert.equal(JSON.stringify(record).includes(m[2]), false);
});

test('createToken: validated, canonical scopes and IP list are what get stored', async () => {
    const { record } = await tokenStore.createToken(input({
        scopes: { cms: { level: 'write' } }, ipAllowlist: ['::ffff:203.0.113.0/120'], name: '  Deploy  ',
    }));
    assert.equal(record.name, 'Deploy');
    assert.deepEqual(record.scopes, { cms: { level: 'write', publish: false } });
    assert.deepEqual(record.ipAllowlist, ['203.0.113.0/24']);
    assert.equal(record.orgId, 'org1');
});

test('createToken: bad input is a 400 and nothing is stored', async () => {
    const now = Date.parse('2026-10-10T12:00:00Z');
    const bad = [
        input({ name: '' }), input({ name: '   ' }), input({ name: 'x'.repeat(81) }), input({ name: 5 }),
        input({ scopes: {} }), input({ scopes: { nope: { level: 'read' } } }),
        input({ ipAllowlist: ['not-an-ip'] }),
        input({ expiresAt: 'not a date' }), input({ expiresAt: '2026-10-10T11:00:00Z' }), input({ expiresAt: '2040-01-01T00:00:00Z' }),
    ];
    for (const b of bad) {
        await assert.rejects(tokenStore.createToken({ ...b, now }), (e) => e.status === 400, JSON.stringify(b));
    }
    assert.equal(repo.rows.size, 0);
});

test('createToken: an expiry in the future is kept as an ISO string', async () => {
    const now = Date.parse('2026-10-10T12:00:00Z');
    const { record } = await tokenStore.createToken({ ...input({ expiresAt: '2026-12-01T00:00:00Z' }), now });
    assert.equal(record.expiresAt, '2026-12-01T00:00:00.000Z');
    const none = await tokenStore.createToken({ ...input({ expiresAt: null }), now });
    assert.equal(none.record.expiresAt, null);
});

test('createToken: a user holds at most 25 active tokens', async () => {
    for (let i = 0; i < tokenStore.MAX_ACTIVE_PER_USER; i++) await tokenStore.createToken(input({ name: `t${i}` }));
    await assert.rejects(tokenStore.createToken(input()), (e) => e.status === 400 && e.code === 'too_many_tokens');
    const first = (await tokenStore.listTokens('u1'))[0];
    await tokenStore.revokeToken('u1', first.id);
    await tokenStore.createToken(input({ name: 'after revoke' }));
});

test('findByPresented: the minted token resolves to its record', async () => {
    const { token, record } = await tokenStore.createToken(input());
    const found = await tokenStore.findByPresented(token);
    assert.equal(found.id, record.id);
    assert.equal(found.userId, 'u1');
});

test('findByPresented: a wrong secret, an unknown id and malformed strings are null', async () => {
    const { token } = await tokenStore.createToken(input());
    const [, idHex] = /^bfmcp_([a-f0-9]{32})_/.exec(token);
    assert.equal(await tokenStore.findByPresented(`bfmcp_${idHex}_${'0'.repeat(64)}`), null, 'wrong secret');
    assert.equal(await tokenStore.findByPresented(`bfmcp_${'0'.repeat(32)}_${'0'.repeat(64)}`), null, 'unknown id');
    for (const bad of [undefined, null, '', 'bfmcp_', 'bfmcp_x_y', `bfmcp_${idHex}_short`, token.toUpperCase(), 42, `${token}x`]) {
        assert.equal(await tokenStore.findByPresented(bad), null, String(bad));
    }
});

test('findByPresented: a revoked token is still returned, marked revoked, for the gate to refuse', async () => {
    const { token, record } = await tokenStore.createToken(input());
    await tokenStore.revokeToken('u1', record.id);
    const found = await tokenStore.findByPresented(token);
    assert.equal(found.id, record.id);
    assert.ok(found.revokedAt);
});

test('listTokens / revokeToken: a user sees and revokes only their own', async () => {
    const mine = await tokenStore.createToken(input({ userId: 'u1', name: 'mine' }));
    const theirs = await tokenStore.createToken(input({ userId: 'u2', name: 'theirs' }));
    assert.deepEqual((await tokenStore.listTokens('u1')).map((t) => t.name), ['mine']);
    assert.equal(await tokenStore.revokeToken('u1', theirs.record.id), null);
    assert.equal((await tokenStore.findByPresented(theirs.token)).revokedAt, null);
    const revoked = await tokenStore.revokeToken('u1', mine.record.id);
    assert.ok(revoked.revokedAt);
    assert.equal(await tokenStore.revokeToken('u1', 'no-such-id'), null);
});

test('touchLastUsed: written at most once a minute per token, and never throws', async () => {
    const flush = () => new Promise((r) => setImmediate(r));
    const t0 = Date.parse('2026-10-10T12:00:00Z');
    tokenStore.touchLastUsed('tok', t0);
    tokenStore.touchLastUsed('tok', t0 + 10_000);
    tokenStore.touchLastUsed('tok', t0 + 59_999);
    await flush();
    assert.equal(repo.calls.touch.length, 1);
    tokenStore.touchLastUsed('tok', t0 + 60_000);
    tokenStore.touchLastUsed('other', t0 + 60_001);
    await flush();
    assert.deepEqual(repo.calls.touch, ['tok', 'tok', 'other']);

    tokenStore._test.setRepo({ touch: async () => { throw new Error('db down'); } });
    tokenStore.touchLastUsed('boom', t0);
    tokenStore.touchLastUsed(null);
    await flush();
});

test('parsePresented / isNamedTokenFormat', () => {
    const id = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const p = tokenStore.parsePresented(`bfmcp_${id}_${'c'.repeat(64)}`);
    assert.equal(p.id, 'a1b2c3d4-e5f6-0718-293a-4b5c6d7e8f90');
    assert.equal(p.secret, 'c'.repeat(64));
    assert.equal(tokenStore.isNamedTokenFormat('bfmcp_anything'), true);
    assert.equal(tokenStore.isNamedTokenFormat('bfmcp.legacy.token'), false);
    assert.equal(tokenStore.isNamedTokenFormat(undefined), false);
});

test('getTokenById: returns the record without secret material, revoked ones included; junk is null', async () => {
    const { record } = await tokenStore.createToken({ userId: 'u1', name: 'laptop', scopes: { cms: { level: 'write' } } });
    const found = await tokenStore.getTokenById(record.id);
    assert.equal(found.id, record.id);
    assert.equal(found.secretHash, undefined);
    await tokenStore.revokeToken('u1', record.id);
    assert.ok((await tokenStore.getTokenById(record.id)).revokedAt);
    assert.equal(await tokenStore.getTokenById('nope'), null);
    assert.equal(await tokenStore.getTokenById(crypto.randomUUID()), null);
    assert.equal(await tokenStore.getTokenById(undefined), null);
});

test('setTokenEnabled switches a token off and on, only for its owner, and never revives a revoked one', async () => {
    const { record } = await tokenStore.createToken({ userId: 'u1', name: 'a', scopes: { studio: { level: 'read' } } });
    const off = await tokenStore.setTokenEnabled('u1', record.id, false);
    assert.equal(off.enabled, false);
    assert.ok(off.disabledAt);
    const found = await tokenStore.getTokenById(record.id);
    assert.ok(found.disabledAt, 'the gate sees the switch');
    assert.equal((await tokenStore.setTokenEnabled('u1', record.id, true)).enabled, true);
    assert.equal(await tokenStore.setTokenEnabled('u2', record.id, false), null, 'not their token');
    await tokenStore.revokeToken('u1', record.id);
    await assert.rejects(() => tokenStore.setTokenEnabled('u1', record.id, true), (e) => e.status === 400 && e.code === 'token_revoked');
});
