/**
 * Shared project conversations — the property that makes them possible, and the
 * boundary that keeps private ones private.
 *
 * A shared thread is encrypted with a key derived from the ORG ROOT KEY and the
 * PROJECT id, not from whoever is holding the request. Everything here is a
 * restatement of that one fact:
 *
 *   - Alice writes, Bob reads. On `managed` AND on `zk`.
 *   - A 3am automation with no session reads it too — that is why the key is
 *     derived from the ORK rather than wrapped per member.
 *   - Bob still cannot read Alice's PRIVATE conversation. The weakening is
 *     scoped to what a user explicitly shared.
 *   - Two projects do not share a key, so a member of one cannot open the
 *     other's ciphertext even inside the same org.
 *
 * See the PROJECT_SHARED_MESSAGES note in messageCrypto.js for why this trade
 * was made on `zk` at all.
 *
 * Run: cd server && node --test stores/agent/messageCrypto.shared.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.MASTER_ENCRYPTION_KEY = 'msgcrypto-shared-test-master-key-32b!';

const SERVER = path.join(__dirname, '..', '..');

const orgs = new Map();
const users = new Map();

function mockModule(absPath, exports) {
    require.cache[require.resolve(absPath)] = { id: absPath, filename: absPath, loaded: true, exports };
}

mockModule(path.join(SERVER, 'db'), {
    async getOne(sql, params) {
        if (/FROM organizations/i.test(sql)) {
            const o = orgs.get(params[0]);
            return o ? { ...o } : null;
        }
        // projectEscrow.assertNoSharedConversations
        if (/crypto_scope/i.test(sql)) return { n: 0 };
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

const { resolveCrypto } = require('./messageCrypto');
const { messagesToRows, rowToMessage } = require('./conversationMessages');
const { invalidatePolicyCache } = require('../encryptionPolicy');
const { invalidateOrgKeyCache } = require('../../auth/orgEscrow');
const { invalidateProjectKeyCache } = require('../../auth/projectEscrow');

const ALICE_DEK = crypto.randomBytes(32).toString('base64');
const BOB_DEK = crypto.randomBytes(32).toString('base64');

function reset(tier) {
    orgs.clear();
    users.clear();
    orgs.set('org-a', { id: 'org-a', encryption_tier: tier, encryption_scope: null, org_root_key: null });
    orgs.set('org-b', { id: 'org-b', encryption_tier: tier, encryption_scope: null, org_root_key: null });
    users.set('alice', { id: 'alice', organizationId: 'org-a' });
    users.set('bob', { id: 'bob', organizationId: 'org-a' });
    invalidatePolicyCache();
    invalidateOrgKeyCache();
    invalidateProjectKeyCache();
}

const SHARED = { projectId: 'proj-1', orgId: 'org-a' };
const MSG = [{ role: 'user', content: 'Q3 severance figures' }];

// ═══ The core property, on both tiers ════════════════════════════════

for (const tier of ['managed', 'zk']) {
    test(`${tier}: Alice writes a shared thread and Bob reads it`, async () => {
        reset(tier);

        const aliceCtx = await resolveCrypto({ userId: 'alice', encryptionKey: ALICE_DEK, projectKeyFor: SHARED });
        assert.strictEqual(aliceCtx.encryptMessages, true, 'the thread really is encrypted');
        assert.strictEqual(aliceCtx.sharedProject, true);

        const rows = messagesToRows('conv-1', 'direct', MSG, aliceCtx);
        assert.notStrictEqual(rows[0].content, 'Q3 severance figures', 'not stored in the clear');

        const bobCtx = await resolveCrypto({ userId: 'bob', encryptionKey: BOB_DEK, projectKeyFor: SHARED });
        assert.strictEqual(rowToMessage(rows[0], bobCtx).content, 'Q3 severance figures');
    });

    test(`${tier}: a keyless background job can read a shared thread`, async () => {
        reset(tier);

        const writeCtx = await resolveCrypto({ userId: 'alice', encryptionKey: ALICE_DEK, projectKeyFor: SHARED });
        const rows = messagesToRows('conv-1', 'direct', MSG, writeCtx);

        // A 3am automation: no user, no session, just the project.
        const jobCtx = await resolveCrypto({ userId: null, orgId: 'org-a', projectKeyFor: SHARED });
        assert.strictEqual(rowToMessage(rows[0], jobCtx).content, 'Q3 severance figures',
            'unattended automations must be able to act on shared threads');
    });

    test(`${tier}: the key does not depend on who asks`, async () => {
        reset(tier);
        const a = await resolveCrypto({ userId: 'alice', encryptionKey: ALICE_DEK, projectKeyFor: SHARED });
        const b = await resolveCrypto({ userId: 'bob', encryptionKey: BOB_DEK, projectKeyFor: SHARED });

        assert.ok(a.key.equals(b.key));
        assert.ok(a.backgroundKey.equals(a.key), 'shared threads use one key for both surfaces');
    });
}

// ═══ The boundary: private stays private ═════════════════════════════

test('zk: Bob CANNOT read Alice\'s private conversation', async () => {
    reset('zk');

    const aliceCtx = await resolveCrypto({ userId: 'alice', encryptionKey: ALICE_DEK });
    assert.strictEqual(aliceCtx.encryptMessages, true);
    assert.ok(!aliceCtx.sharedProject, 'a private conversation is not flagged shared');

    const rows = messagesToRows('conv-private', 'direct', MSG, aliceCtx);

    const bobCtx = await resolveCrypto({ userId: 'bob', encryptionKey: BOB_DEK });
    assert.throws(() => rowToMessage(rows[0], bobCtx),
        'the zk guarantee holds for anything the user did not share');
});

test('zk: a shared-project key does NOT open a private conversation', async () => {
    reset('zk');

    const privateCtx = await resolveCrypto({ userId: 'alice', encryptionKey: ALICE_DEK });
    const rows = messagesToRows('conv-private', 'direct', MSG, privateCtx);

    const projectCtx = await resolveCrypto({ userId: 'bob', projectKeyFor: SHARED });
    assert.throws(() => rowToMessage(rows[0], projectCtx));
});

test('a shared thread is NOT readable with the author\'s personal key', async () => {
    reset('managed');

    const sharedCtx = await resolveCrypto({ userId: 'alice', encryptionKey: ALICE_DEK, projectKeyFor: SHARED });
    const rows = messagesToRows('conv-1', 'direct', MSG, sharedCtx);

    // This is why crypto_scope is stored on the row: a reader must know which
    // key applies rather than guessing and catching the failure.
    const personalCtx = await resolveCrypto({ userId: 'alice', encryptionKey: ALICE_DEK });
    assert.throws(() => rowToMessage(rows[0], personalCtx));
});

// ═══ Project and tenant isolation ════════════════════════════════════

test('two projects in one org do not share a key', async () => {
    reset('managed');

    const p1 = await resolveCrypto({ userId: 'alice', projectKeyFor: { projectId: 'proj-1', orgId: 'org-a' } });
    const p2 = await resolveCrypto({ userId: 'alice', projectKeyFor: { projectId: 'proj-2', orgId: 'org-a' } });

    assert.ok(!p1.key.equals(p2.key));

    const rows = messagesToRows('conv-1', 'direct', MSG, p1);
    assert.throws(() => rowToMessage(rows[0], p2),
        'membership of one project must not open another');
});

test('the same project id in two orgs does not share a key', async () => {
    reset('managed');

    const a = await resolveCrypto({ userId: 'alice', orgId: 'org-a', projectKeyFor: { projectId: 'same-uuid', orgId: 'org-a' } });
    const b = await resolveCrypto({ userId: 'alice', orgId: 'org-b', projectKeyFor: { projectId: 'same-uuid', orgId: 'org-b' } });

    assert.ok(!a.key.equals(b.key));
});

// ═══ Failure modes ═══════════════════════════════════════════════════

test('encryption off: a shared thread is plaintext, like everything else', async () => {
    reset('none');

    const ctx = await resolveCrypto({ userId: 'alice', projectKeyFor: SHARED });
    assert.strictEqual(ctx.encryptMessages, false);

    const rows = messagesToRows('conv-1', 'direct', MSG, ctx);
    assert.strictEqual(rowToMessage(rows[0], ctx).content, 'Q3 severance figures');
});

test('a project key that cannot be produced THROWS — it never degrades to plaintext', async () => {
    reset('managed');
    // Corrupt the stored ORK envelope so getOrgRootKey refuses.
    orgs.get('org-a').org_root_key = 'not-a-valid-envelope';
    invalidateOrgKeyCache();
    invalidateProjectKeyCache();

    await assert.rejects(
        () => resolveCrypto({ userId: 'alice', projectKeyFor: SHARED }),
        'a shared write rewrites already-encrypted rows, so silent plaintext here would strip protection'
    );
});

test('resolveCrypto without projectKeyFor is byte-for-byte the old behaviour', async () => {
    reset('managed');

    const a = await resolveCrypto({ userId: 'alice', encryptionKey: ALICE_DEK });
    const b = await resolveCrypto({ userId: 'alice', encryptionKey: ALICE_DEK, projectKeyFor: null });

    assert.ok(a.key.equals(b.key));
    assert.strictEqual(a.sharedProject, undefined);
    assert.strictEqual(b.sharedProject, undefined);
});
