/**
 * Project key derivation.
 *
 * What has to hold for shared project conversations to work at all:
 *
 *   - Two members resolve the SAME key, because it depends on the project, not
 *     on who is asking. That is the entire point.
 *   - Different projects, and the same project id in different orgs, resolve to
 *     DIFFERENT keys. A recycled UUID across tenants must not collide.
 *   - Org-less installs funnel through the same resolveOrgId sentinel as
 *     orgEscrow and orgVault. A divergent sentinel would derive a different key
 *     per code path — the failure stores/keyRotationEnvelopes.test.js exists to
 *     pin for wrapped envelopes, and derived keys have the same exposure.
 *   - Rotation is REFUSED while shared conversations exist, because project keys
 *     are derived from the ORK and rotating it orphans their ciphertext.
 *
 * Run: cd server && node --test auth/projectEscrow.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const Module = require('module');

const DEFAULT_SENTINEL = '__default__';

const fx = {
    orks: {},            // orgId -> Buffer
    orkCalls: [],
    sharedCount: 0,
    dbError: null,
    // Team chats (projects/chatCrypto.js) are sealed under the project key too.
    chatTable: false,     // does `project_chats` exist on this install?
    chatCount: 0,
    // Co-edited documents (core/collab) are sealed under the project key too.
    collabTable: false,   // does `collab_docs` exist on this install?
    collabCount: 0,
    // Comment threads (projects/comments/commentCrypto.js) are sealed under the project key too.
    commentTable: false,  // does `project_comment_threads` exist on this install?
    commentCount: 0,
    queries: [],
};

const MOCKS = {
    '../stores/integrationConnectionStore': {
        resolveOrgId: (raw) => (raw && String(raw).trim()) || DEFAULT_SENTINEL,
    },
    // Zeroes in place, like the real one: a caller must never hold the Buffer it clears.
    './encryption': { secureClear: (buf) => { if (Buffer.isBuffer(buf)) buf.fill(0); } },
    './orgEscrow': {
        getOrgRootKey: async (orgId) => {
            fx.orkCalls.push(orgId);
            if (!fx.orks[orgId]) fx.orks[orgId] = crypto.randomBytes(32);
            return fx.orks[orgId];
        },
    },
    '../db': {
        getOne: async (sql, params) => {
            fx.queries.push({ sql, params });
            if (fx.dbError) throw fx.dbError;
            if (/to_regclass\('project_chats'\)/.test(sql)) return { present: fx.chatTable };
            if (/FROM project_chats/.test(sql)) return { n: fx.chatCount };
            if (/to_regclass\('collab_docs'\)/.test(sql)) return { present: fx.collabTable };
            if (/FROM collab_docs/.test(sql)) return { n: fx.collabCount };
            if (/to_regclass\('project_comment_threads'\)/.test(sql)) return { present: fx.commentTable };
            if (/FROM project_comment_threads/.test(sql)) return { n: fx.commentCount };
            return { n: fx.sharedCount };
        },
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:project-escrow:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /auth[\\/]projectEscrow\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const projectEscrow = require('./projectEscrow');

test.after(() => { Module._resolveFilename = originalResolve; });

function resetFx() {
    fx.orks = {};
    fx.orkCalls.length = 0;
    fx.sharedCount = 0;
    fx.dbError = null;
    fx.chatTable = false;
    fx.chatCount = 0;
    fx.collabTable = false;
    fx.collabCount = 0;
    fx.commentTable = false;
    fx.commentCount = 0;
    fx.queries.length = 0;
    projectEscrow.invalidateProjectKeyCache();
}

// ═══ Derivation ══════════════════════════════════════════════════════

test('derivation is deterministic and 32 bytes', () => {
    const ork = crypto.randomBytes(32);
    const a = projectEscrow.deriveProjectKey(ork, 'org1', 'p1');
    const b = projectEscrow.deriveProjectKey(ork, 'org1', 'p1');

    assert.strictEqual(a.length, 32);
    assert.ok(a.equals(b), 'same inputs must give the same key');
});

test('different projects in one org derive different keys', () => {
    const ork = crypto.randomBytes(32);
    const a = projectEscrow.deriveProjectKey(ork, 'org1', 'p1');
    const b = projectEscrow.deriveProjectKey(ork, 'org1', 'p2');

    assert.ok(!a.equals(b));
});

test('the SAME project id in different orgs derives different keys', () => {
    const ork = crypto.randomBytes(32);
    const a = projectEscrow.deriveProjectKey(ork, 'org1', 'shared-uuid');
    const b = projectEscrow.deriveProjectKey(ork, 'org2', 'shared-uuid');

    assert.ok(!a.equals(b), 'a recycled project UUID must not collide across tenants');
});

test('a different org root key derives a different project key', () => {
    const a = projectEscrow.deriveProjectKey(crypto.randomBytes(32), 'org1', 'p1');
    const b = projectEscrow.deriveProjectKey(crypto.randomBytes(32), 'org1', 'p1');

    assert.ok(!a.equals(b), 'this is exactly why rotation orphans shared conversations');
});

test('derivation rejects a malformed root key', () => {
    assert.throws(() => projectEscrow.deriveProjectKey(Buffer.alloc(16), 'org1', 'p1'), /32-byte/);
    assert.throws(() => projectEscrow.deriveProjectKey('not-a-buffer', 'org1', 'p1'), /32-byte/);
    assert.throws(() => projectEscrow.deriveProjectKey(crypto.randomBytes(32), 'org1', ''), /projectId/);
});

// ═══ getProjectKey: reader-independent ═══════════════════════════════

test('two different members resolve the identical key', async () => {
    resetFx();
    // Nothing about the call identifies a user — that IS the property.
    const alice = await projectEscrow.getProjectKey('p1', 'org1');
    const bob = await projectEscrow.getProjectKey('p1', 'org1');

    assert.ok(alice.equals(bob));
});

test('an org-less project uses the shared sentinel, not a per-call value', async () => {
    resetFx();
    const a = await projectEscrow.getProjectKey('p1', '');
    projectEscrow.invalidateProjectKeyCache();
    const b = await projectEscrow.getProjectKey('p1', null);
    projectEscrow.invalidateProjectKeyCache();
    const c = await projectEscrow.getProjectKey('p1', undefined);

    assert.ok(a.equals(b), "'' and null must resolve identically");
    assert.ok(a.equals(c), "'' and undefined must resolve identically");
    assert.ok(fx.orkCalls.every(o => o === DEFAULT_SENTINEL),
        'every org-less lookup must use the same sentinel as orgEscrow');
});

test('an org-less project does not share a key with a named org', async () => {
    resetFx();
    const orgless = await projectEscrow.getProjectKey('p1', '');
    const named = await projectEscrow.getProjectKey('p1', 'org1');

    assert.ok(!orgless.equals(named));
});

test('getProjectKey requires a project id', async () => {
    resetFx();
    await assert.rejects(() => projectEscrow.getProjectKey('', 'org1'), /projectId/);
    await assert.rejects(() => projectEscrow.getProjectKey(null, 'org1'), /projectId/);
});

test('a failure to reach the org root key PROPAGATES — it never degrades', async () => {
    resetFx();
    MOCKS['./orgEscrow'].getOrgRootKey = async () => { throw new Error('MASTER_ENCRYPTION_KEY missing'); };
    try {
        await assert.rejects(() => projectEscrow.getProjectKey('p1', 'org1'), /MASTER_ENCRYPTION_KEY/);
    } finally {
        MOCKS['./orgEscrow'].getOrgRootKey = async (orgId) => {
            fx.orkCalls.push(orgId);
            if (!fx.orks[orgId]) fx.orks[orgId] = crypto.randomBytes(32);
            return fx.orks[orgId];
        };
    }
});

// ═══ Caching ═════════════════════════════════════════════════════════

test('the key is cached — the ORK is not re-read per message', async () => {
    resetFx();
    await projectEscrow.getProjectKey('p1', 'org1');
    await projectEscrow.getProjectKey('p1', 'org1');
    await projectEscrow.getProjectKey('p1', 'org1');

    assert.strictEqual(fx.orkCalls.length, 1);
});

test('invalidation is scoped to one org', async () => {
    resetFx();
    await projectEscrow.getProjectKey('p1', 'org1');
    await projectEscrow.getProjectKey('p1', 'org2');
    assert.strictEqual(fx.orkCalls.length, 2);

    projectEscrow.invalidateProjectKeyCache('org1');
    await projectEscrow.getProjectKey('p1', 'org1');   // re-derives
    await projectEscrow.getProjectKey('p1', 'org2');   // still cached

    assert.strictEqual(fx.orkCalls.length, 3);
});

test('a rotated ORK yields a new key once the cache is dropped', async () => {
    resetFx();
    const before = await projectEscrow.getProjectKey('p1', 'org1');

    fx.orks.org1 = crypto.randomBytes(32);            // "rotation"
    projectEscrow.invalidateProjectKeyCache('org1');
    const after = await projectEscrow.getProjectKey('p1', 'org1');

    assert.ok(!before.equals(after),
        'proves rotation changes project keys — hence the rotation guard below');
});

test('a key handed out survives the cache entry expiring (every caller gets its own copy)', async () => {
    resetFx();
    const realNow = Date.now;
    try {
        const fresh = await projectEscrow.getProjectKey('p1', 'org1');
        const first = await projectEscrow.getProjectKey('p1', 'org1');   // a cache hit
        const expected = projectEscrow.deriveProjectKey(fx.orks.org1, 'org1', 'p1');
        const t0 = realNow();
        Date.now = () => t0 + 5 * 60_000 + 1;
        // Request B after the TTL: the cache clears its entry and re-derives.
        const second = await projectEscrow.getProjectKey('p1', 'org1');
        assert.ok(fresh.equals(expected) && first.equals(expected), 'request A still holds the real key, not 32 zero bytes');
        assert.ok(second.equals(expected));
        assert.notStrictEqual(first, second, 'never the same Buffer object');
    } finally {
        Date.now = realNow;
    }
});

test('a key handed out survives invalidation and FIFO eviction', async () => {
    resetFx();
    const fresh = await projectEscrow.getProjectKey('p1', 'org1');
    const held = await projectEscrow.getProjectKey('p1', 'org1');   // a cache hit
    const expected = projectEscrow.deriveProjectKey(fx.orks.org1, 'org1', 'p1');
    for (let i = 0; i < 501; i++) await projectEscrow.getProjectKey(`evict-${i}`, 'org1');
    projectEscrow.invalidateProjectKeyCache();
    assert.ok(fresh.equals(expected) && held.equals(expected));
    assert.ok(held.some((b) => b !== 0));
});

// ═══ Rotation guard ══════════════════════════════════════════════════

test('rotation is refused while shared conversations exist', async () => {
    resetFx();
    fx.sharedCount = 3;

    await assert.rejects(
        () => projectEscrow.assertNoSharedConversations('org1'),
        (err) => {
            assert.match(err.message, /Refusing to rotate/);
            assert.match(err.message, /3 shared project conversation/);
            return true;
        }
    );
});

test('rotation is allowed when no shared conversations exist', async () => {
    resetFx();
    fx.sharedCount = 0;

    await assert.doesNotReject(() => projectEscrow.assertNoSharedConversations('org1'));
});

test('a pre-migration schema does not block rotation', async () => {
    resetFx();
    // An install that never ran the Phase-1 migration has no crypto_scope column
    // and therefore cannot have shared conversations to strand.
    fx.dbError = new Error('column "crypto_scope" does not exist');

    await assert.doesNotReject(() => projectEscrow.assertNoSharedConversations('org1'));
});

test('an unrelated DB failure is NOT swallowed', async () => {
    resetFx();
    fx.dbError = new Error('connection terminated unexpectedly');

    await assert.rejects(
        () => projectEscrow.assertNoSharedConversations('org1'),
        /connection terminated/,
        'only a missing-column error means "nothing to protect"'
    );
});

test('team chats block a rotation too: their titles and messages are sealed under the project key', async () => {
    resetFx();
    fx.chatTable = true;
    fx.chatCount = 2;

    await assert.rejects(
        () => projectEscrow.assertNoSharedConversations('org1'),
        (err) => {
            assert.match(err.message, /Refusing to rotate/);
            assert.match(err.message, /2 project team chat/);
            return true;
        }
    );
    const counted = fx.queries.find(q => /FROM project_chats/.test(q.sql));
    assert.deepStrictEqual(counted.params, ['org1', DEFAULT_SENTINEL], 'counted for THIS org only');
});

test('an install without the team chat table is not asked to count it', async () => {
    resetFx();
    fx.chatTable = false;
    fx.chatCount = 5;   // would block, if the count ran against a missing table

    await assert.doesNotReject(() => projectEscrow.assertNoSharedConversations('org1'));
    assert.ok(!fx.queries.some(q => /FROM project_chats/.test(q.sql)));
});

test('an org with a team chat table but no chats may rotate', async () => {
    resetFx();
    fx.chatTable = true;
    fx.chatCount = 0;
    await assert.doesNotReject(() => projectEscrow.assertNoSharedConversations('org1'));
});

test('co-edited documents block a rotation too: their update logs are sealed under the project key', async () => {
    resetFx();
    fx.chatTable = true;
    fx.collabTable = true;
    fx.collabCount = 3;

    await assert.rejects(
        () => projectEscrow.assertNoSharedConversations('org1'),
        (err) => {
            assert.match(err.message, /Refusing to rotate/);
            assert.match(err.message, /3 co-edited project document/);
            return true;
        }
    );
    const counted = fx.queries.find(q => /FROM collab_docs/.test(q.sql));
    assert.deepStrictEqual(counted.params, ['org1', DEFAULT_SENTINEL], 'counted for THIS org only');
    assert.match(counted.sql, /key_scope = 'project'/);
});

test('an install without the co-editing table is not asked to count it', async () => {
    resetFx();
    fx.collabTable = false;
    fx.collabCount = 9;
    await assert.doesNotReject(() => projectEscrow.assertNoSharedConversations('org1'));
    assert.ok(!fx.queries.some(q => /FROM collab_docs/.test(q.sql)));
});

test('comment threads block a rotation too: their anchors and comments are sealed under the project key', async () => {
    resetFx();
    fx.commentTable = true;
    fx.commentCount = 4;

    await assert.rejects(
        () => projectEscrow.assertNoSharedConversations('org1'),
        (err) => {
            assert.match(err.message, /Refusing to rotate/);
            assert.match(err.message, /4 project comment thread/);
            return true;
        }
    );
    const counted = fx.queries.find(q => /FROM project_comment_threads/.test(q.sql));
    assert.deepStrictEqual(counted.params, ['org1', DEFAULT_SENTINEL], 'counted for THIS org only');
});

test('an install without the comment table is not asked to count it', async () => {
    resetFx();
    fx.commentTable = false;
    fx.commentCount = 9;
    await assert.doesNotReject(() => projectEscrow.assertNoSharedConversations('org1'));
    assert.ok(!fx.queries.some(q => /FROM project_comment_threads/.test(q.sql)));
});
