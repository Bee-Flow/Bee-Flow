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
 * The rotation guard counts real rows: the boot ladder's schema on PGlite
 * (testUtils/pgliteTemplate.js) behind db.js's pool.
 *
 * Run: cd server && node --test auth/projectEscrow.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const Module = require('module');
const { usePglitePool } = require('../testUtils/pglitePool');
const { ladderPglite } = require('../testUtils/pgliteTemplate');
const { insertRow } = require('../testUtils/pgliteSeed');
const { hideTable, failReads } = require('../testUtils/pgliteFaults');

const { pg, close } = usePglitePool(ladderPglite());

const DEFAULT_SENTINEL = '__default__';

const fx = {
    orks: {},            // orgId -> Buffer
    orkCalls: [],
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

test.after(async () => { Module._resolveFilename = originalResolve; await close(); });

function resetFx() {
    fx.orks = {};
    fx.orkCalls.length = 0;
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

test('a cached key answers up to and including five minutes, and is derived again after that', async () => {
    resetFx();
    const realNow = Date.now;
    const t0 = realNow();
    try {
        Date.now = () => t0;
        await projectEscrow.getProjectKey('p1', 'org1');
        Date.now = () => t0 + 5 * 60_000;
        await projectEscrow.getProjectKey('p1', 'org1');
        assert.strictEqual(fx.orkCalls.length, 1, 'at five minutes exactly: still the cached key');
        Date.now = () => t0 + 5 * 60_000 + 1;
        await projectEscrow.getProjectKey('p1', 'org1');
        assert.strictEqual(fx.orkCalls.length, 2, 'one millisecond later: derived again');
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

const SEALED_TABLES = ['direct_conversations', 'agent_conversations', 'project_chats', 'collab_docs', 'project_comment_threads', 'kb_query_log'];
const guard = (org = 'org1') => projectEscrow.assertNoSharedConversations(org);
const refused = (re) => (err) => { assert.match(err.message, /Refusing to rotate/); assert.match(err.message, re); return true; };

/** org1 owns p1, org2 owns p2, an org-less project is p0. */
async function resetDb() {
    resetFx();
    await pg.exec(`TRUNCATE ${SEALED_TABLES.join(', ')}, projects, agents CASCADE`);
    await insertRow(pg, 'projects', { id: 'p1', name: 'P1', owner_id: 'u1', organization_id: 'org1' });
    await insertRow(pg, 'projects', { id: 'p2', name: 'P2', owner_id: 'u2', organization_id: 'org2' });
    await insertRow(pg, 'projects', { id: 'p0', name: 'P0', owner_id: 'u3', organization_id: '' });
    await insertRow(pg, 'agents', { id: 'ag', name: 'A', owner_id: 'u1' });
}
let seq = 0;
const sharedConversation = (projectId, table = 'direct_conversations') => insertRow(pg, table, {
    id: `c${++seq}`, user_id: 'u1', project_id: projectId, crypto_scope: 'project', shared_scope: 'project',
    ...(table === 'agent_conversations' ? { agent_id: 'ag' } : {}),
});

test('rotation is refused while shared conversations exist, counted for THIS org only', async () => {
    await resetDb();
    await sharedConversation('p1');
    await sharedConversation('p1', 'agent_conversations');
    await sharedConversation('p1');
    await sharedConversation('p2');
    await assert.rejects(() => guard('org1'), refused(/3 shared project conversation/));
    await assert.rejects(() => guard('org2'), refused(/1 shared project conversation/));
    await assert.doesNotReject(() => guard('org3'));
});

test('an org-less install counts the org-less projects under the shared sentinel', async () => {
    await resetDb();
    await sharedConversation('p0');
    await assert.rejects(() => guard(null), refused(/1 shared project conversation/));
    await assert.rejects(() => guard(''), refused(/1 shared project conversation/));
    await assert.doesNotReject(() => guard('org1'));
});

test('rotation is allowed when no shared conversations exist', async () => {
    await resetDb();
    // A private conversation inside a project is the owner's, not the project's.
    await insertRow(pg, 'direct_conversations', { id: 'own', user_id: 'u1', project_id: 'p1', crypto_scope: 'user' });
    await assert.doesNotReject(() => guard('org1'));
});

test('a pre-migration schema does not block rotation', async () => {
    await resetDb();
    // An install that never ran the Phase-1 migration has no crypto_scope column
    // and therefore cannot have shared conversations to strand.
    await pg.exec('ALTER TABLE direct_conversations RENAME COLUMN crypto_scope TO crypto_scope_aside');
    try {
        await assert.doesNotReject(() => guard('org1'));
    } finally {
        await pg.exec('ALTER TABLE direct_conversations RENAME COLUMN crypto_scope_aside TO crypto_scope');
    }
});

test('an unrelated DB failure is NOT swallowed', async () => {
    await resetDb();
    const restore = await failReads(pg, 'direct_conversations', '08006', 'connection terminated unexpectedly');
    try {
        await assert.rejects(() => guard('org1'), /connection terminated/, 'only a missing column or table means "nothing to protect"');
    } finally { await restore(); }
});

/** Rows of `table` under project `projectId`. */
async function sealed(table, projectId, n, over = {}) {
    const base = {
        project_chats: () => ({ created_by: 'u1', title: 'x' }),
        collab_docs: () => ({ key_scope: 'project', resource_kind: 'notebook', resource_id: `r${seq}` }),
        project_comment_threads: () => ({ created_by: 'u1', target_type: 'notebook', target_id: 'n1' }),
    }[table];
    for (let i = 0; i < n; i++) await insertRow(pg, table, { id: `${table}-${++seq}`, project_id: projectId, ...base(), ...over });
}

test('team chats block a rotation too, counted for THIS org only', async () => {
    await resetDb();
    await sealed('project_chats', 'p1', 2);
    await sealed('project_chats', 'p2', 5);
    await assert.rejects(() => guard('org1'), refused(/2 project team chat/));
});

test('an install without the team chat table is not asked to count it', async () => {
    await resetDb();
    const restore = await hideTable(pg, 'project_chats');
    try {
        await assert.doesNotReject(() => guard('org1'));
    } finally { await restore(); }
});

test('co-edited documents block a rotation too, but only the project-keyed ones', async () => {
    await resetDb();
    await sealed('collab_docs', 'p1', 2, { key_scope: 'none' });
    await assert.doesNotReject(() => guard('org1'), 'a document under no project key is not counted');
    await sealed('collab_docs', 'p1', 3);
    await sealed('collab_docs', 'p2', 1);
    await assert.rejects(() => guard('org1'), refused(/3 co-edited project document/));
});

test('an install without the co-editing table is not asked to count it', async () => {
    await resetDb();
    const restore = await hideTable(pg, 'collab_docs');
    try {
        await assert.doesNotReject(() => guard('org1'));
    } finally { await restore(); }
});

test('comment threads block a rotation too, counted for THIS org only', async () => {
    await resetDb();
    await sealed('project_comment_threads', 'p1', 4);
    await sealed('project_comment_threads', 'p2', 1);
    await assert.rejects(() => guard('org1'), refused(/4 project comment thread/));
    await assert.rejects(() => guard('org2'), refused(/1 project comment thread/));
});

test('an install without the comment table is not asked to count it', async () => {
    await resetDb();
    const restore = await hideTable(pg, 'project_comment_threads');
    try {
        await assert.doesNotReject(() => guard('org1'));
    } finally { await restore(); }
});
