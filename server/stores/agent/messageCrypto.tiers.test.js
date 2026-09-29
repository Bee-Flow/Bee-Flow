/**
 * Tier semantics of resolveCrypto — the two bugs this file exists to prevent.
 *
 * B3 (managed): the escrow used to mint a RANDOM DEK while resolveCrypto
 * preferred whatever session key happened to be present. A logged-in user
 * therefore wrote under one key and every keyless caller read under another, so
 * `managed` delivered neither admin-recoverable data nor working automations —
 * the only two reasons the tier exists.
 *
 * B4 (zk): `zk` has no escrow, so every keyless caller resolved no key at all
 * and wrote plaintext. The Privacy Shield token map — the dictionary that
 * reverses every redaction — is written from the DLP runner with no session, so
 * on the tier advertising the strongest protection it could not be encrypted at
 * all.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.MASTER_ENCRYPTION_KEY = 'msgcrypto-tiers-test-master-key-32b!!';

const HERE = __dirname;
const SERVER = path.join(HERE, '..', '..');

// ── Fixtures ────────────────────────────────────────────────────────────────

const orgs = new Map();   // orgId -> { id, encryption_tier, encryption_scope, org_root_key }
const users = new Map();  // userId -> row

function mockModule(absPath, exports) {
    require.cache[require.resolve(absPath)] = {
        id: absPath, filename: absPath, loaded: true, exports,
    };
}

mockModule(path.join(SERVER, 'db'), {
    async getOne(sql, params) {
        if (/FROM organizations/i.test(sql)) {
            const o = orgs.get(params[0]);
            return o ? { ...o } : null;
        }
        return null;
    },
    async getAll() { return []; },
    async run(sql, params) {
        if (/UPDATE organizations/i.test(sql)) {
            const o = orgs.get(params[1]);
            if (!o) return { rowCount: 0 };
            if (/org_root_key" IS NULL/i.test(sql) && o.org_root_key) return { rowCount: 0 };
            o.org_root_key = params[0];
            return { rowCount: 1 };
        }
        if (/UPDATE users/i.test(sql) && /"orgWrappedDEK"/i.test(sql)) {
            const u = users.get(params[1]);
            if (!u) return { rowCount: 0 };
            if (/orgWrappedDEK" IS NULL/i.test(sql) && u.orgWrappedDEK) return { rowCount: 0 };
            u.orgWrappedDEK = params[0];
            return { rowCount: 1 };
        }
        return { rowCount: 0 };
    },
});

mockModule(path.join(SERVER, 'stores', 'userStore'), {
    async getUser(id) { const u = users.get(id); return u ? { ...u } : null; },
    async updateUser(id, updates) {
        const u = users.get(id);
        if (!u) return false;
        Object.assign(u, updates);
        return true;
    },
});

const { resolveCrypto, PLAINTEXT_CONTEXT } = require('./messageCrypto');
const { invalidatePolicyCache } = require('../encryptionPolicy');
const { invalidateOrgKeyCache } = require('../../auth/orgEscrow');

const SESSION_DEK = crypto.randomBytes(32).toString('base64');

function reset(tier, { scope = null } = {}) {
    orgs.clear();
    users.clear();
    orgs.set('org-a', { id: 'org-a', encryption_tier: tier, encryption_scope: scope, org_root_key: null });
    users.set('u-1', { id: 'u-1', organizationId: 'org-a' });
    invalidatePolicyCache();
    invalidateOrgKeyCache();
}

// ── managed: one key per user ───────────────────────────────────────────────

test('managed: keyed and keyless callers resolve the SAME key', async () => {
    reset('managed');
    // Establish the escrow first, the way a background job would.
    const escrowOnly = await resolveCrypto({ userId: 'u-1' });
    assert.ok(escrowOnly.key, 'a key must resolve without any session');

    // Now a logged-in user arrives carrying an unrelated session DEK. Before
    // this fix, resolveCrypto preferred that key and the two callers diverged.
    const withSession = await resolveCrypto({ userId: 'u-1', encryptionKey: SESSION_DEK });
    assert.ok(
        !withSession.key.equals(Buffer.from(SESSION_DEK, 'base64')),
        'an established escrow must not be displaced by whatever session shows up',
    );
    assert.ok(
        withSession.key.equals(escrowOnly.key),
        'keyed and keyless callers must land on one key — this is the whole point of the tier',
    );
});

test('managed: a keyed write is readable by a keyless caller (the tier\'s purpose)', async () => {
    reset('managed');
    const { messagesToRows, rowToMessage } = require('./conversationMessages');

    // A logged-in user writes.
    const writeCtx = await resolveCrypto({ userId: 'u-1', encryptionKey: SESSION_DEK });
    const rows = messagesToRows('conv-1', 'agent', [{ role: 'user', content: 'Q3 severance figures' }], writeCtx);

    // A 3am automation, holding no session, reads.
    const readCtx = await resolveCrypto({ userId: 'u-1' });
    const back = rowToMessage(rows[0], readCtx);
    assert.strictEqual(back.content, 'Q3 severance figures');
});

test('managed adopts an existing login DEK the first time an escrow is created', async () => {
    reset('managed');
    const ctx = await resolveCrypto({ userId: 'u-1', encryptionKey: SESSION_DEK });
    // Seeding means content already written under the login key stays readable
    // once the escrow becomes authoritative.
    assert.ok(
        ctx.key.equals(Buffer.from(SESSION_DEK, 'base64')),
        'the first escrow should adopt the session DEK rather than mint an unrelated key',
    );
});

test('managed: once escrowed, a different session DEK cannot change the key', async () => {
    reset('managed');
    const first = await resolveCrypto({ userId: 'u-1', encryptionKey: SESSION_DEK });
    invalidateOrgKeyCache();
    const otherSession = crypto.randomBytes(32).toString('base64');
    const second = await resolveCrypto({ userId: 'u-1', encryptionKey: otherSession });
    assert.ok(first.key.equals(second.key), 'the stored escrow is authoritative forever after');
});

// ── zk: narrow escrow for the background surfaces ───────────────────────────

test('zk uses the SESSION key for message content', async () => {
    reset('zk');
    const ctx = await resolveCrypto({ userId: 'u-1', encryptionKey: SESSION_DEK });
    assert.ok(ctx.key.equals(Buffer.from(SESSION_DEK, 'base64')));
    assert.strictEqual(ctx.encryptMessages, true);
});

test('zk WITHOUT a session cannot encrypt message content — and says so', async () => {
    reset('zk');
    const ctx = await resolveCrypto({ userId: 'u-1' });
    assert.strictEqual(ctx.key, null, 'no content key without a session — zk means zk');
    assert.strictEqual(ctx.encryptMessages, false, 'must not claim to encrypt what it cannot');
});

test('zk still protects the token map and conversation meta via the escrow', async () => {
    reset('zk');
    // The DLP runner's exact call shape: a user, an org, and no session at all.
    const ctx = await resolveCrypto({ userId: 'u-1', orgId: 'org-a' });
    assert.ok(ctx.backgroundKey, 'the token map must have a key on zk, or it is stored in the clear');
    assert.strictEqual(ctx.encryptConversationMeta, true);
});

test('zk: the content key and the background key are different keys', async () => {
    reset('zk');
    const ctx = await resolveCrypto({ userId: 'u-1', encryptionKey: SESSION_DEK });
    assert.ok(ctx.key && ctx.backgroundKey);
    assert.ok(!ctx.key.equals(ctx.backgroundKey),
        'the escrow must not be able to open message content on zk — that would make zk meaningless');
});

// ── none / failure ──────────────────────────────────────────────────────────

test('tier none encrypts nothing regardless of available keys', async () => {
    reset('none');
    const ctx = await resolveCrypto({ userId: 'u-1', encryptionKey: SESSION_DEK });
    assert.strictEqual(ctx, PLAINTEXT_CONTEXT);
});

test('an unknown org falls back to plaintext rather than throwing', async () => {
    reset('managed');
    const ctx = await resolveCrypto({ userId: 'nobody', orgId: 'org-does-not-exist' });
    assert.strictEqual(ctx.encryptMessages, false);
});

// ── Scope still applies on top of the key selection ─────────────────────────

test('a disabled surface stays plaintext even though a key resolved', async () => {
    reset('managed', { scope: { messages: false } });
    const ctx = await resolveCrypto({ userId: 'u-1' });
    assert.ok(ctx.key, 'the key still resolves');
    assert.strictEqual(ctx.encryptMessages, false, 'but the surface is off');
    assert.strictEqual(ctx.encryptMeta, true, 'and the others are unaffected');
});
