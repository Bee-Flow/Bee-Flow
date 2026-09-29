/**
 * `usableKbIdsForRequest` — the retrieval question, request-shaped.
 *
 * It sits next to `partitionAccessibleKBIds` and answers a DIFFERENT question,
 * which is the whole reason it exists. `canAccessKB` deliberately lets an org
 * admin reach every base in their organisation — right for a management
 * screen, wrong the moment a base is about to be quoted into somebody's
 * answer. And it says nothing about `usage_contexts`, the owner's setting for
 * where a base may be used at all.
 *
 * So what is pinned here is that this wrapper is NEVER WIDER than the linker's
 * check, and that it fails closed:
 *
 *   - an org admin gets no bypass (the base they can only reach
 *     administratively is refused)
 *   - a super admin's `null` org ids must not read as "allow everything"
 *   - a base its owner switched off for this surface is refused even when
 *     readable
 *   - a resolver that throws yields NOTHING
 *
 * Runs against the REAL canUserAccessKB and the REAL kbSelection — only the
 * row lookup and the session resolvers are fixtures, so it cannot pass by
 * re-implementing the policy it tests.
 *
 * Run: cd server && node --test --test-force-exit support/kbAccess.usable.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

// ── Fixture knowledge bases ───────────────────────────────────────
const KBS = {
    'kb-mine': { id: 'kb-mine', tenant_id: 'alice', organization_id: 'org-1', is_published: true, shared_groups: '[]', usage_contexts: ['direct_chat'] },
    'kb-chat-off': { id: 'kb-chat-off', tenant_id: 'alice', organization_id: 'org-1', is_published: true, shared_groups: '[]', usage_contexts: ['ai_step'] },
    // Another member's unpublished draft in the same org: an ORG ADMIN can read
    // it through canAccessKB. It must still never answer their chat.
    'kb-org-draft': { id: 'kb-org-draft', tenant_id: 'bob', organization_id: 'org-1', is_published: false, shared_groups: '[]', usage_contexts: null },
    'kb-foreign': { id: 'kb-foreign', tenant_id: 'carol', organization_id: 'org-2', is_published: true, shared_groups: '[]', usage_contexts: null },
};

const fx = {
    orgIds: new Set(['org-1']),
    groups: [],
    orgRole: 'member',
    resolverThrows: false,
    kbStoreThrows: false,
};

const kbStorePath = require.resolve('../stores/knowledgeBases');
const realKbStore = require('../stores/knowledgeBases');
require.cache[kbStorePath] = {
    id: kbStorePath, filename: kbStorePath, loaded: true,
    exports: {
        getKB: async (id) => {
            if (fx.kbStoreThrows) throw new Error('knowledge_bases is down');
            return KBS[id] || null;
        },
        canUserAccessKB: realKbStore.canUserAccessKB, // the REAL policy
    },
};

const userStorePath = require.resolve('../stores/userStore');
require.cache[userStorePath] = {
    id: userStorePath, filename: userStorePath, loaded: true,
    exports: { getUser: async () => ({ orgRole: fx.orgRole }) },
};

const authPath = require.resolve('../auth');
const realAuth = require('../auth');
require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: {
        resolveUserOrgIds: async () => {
            if (fx.resolverThrows) throw new Error('org resolver unavailable');
            return fx.orgIds;
        },
        resolveUserGroups: async () => fx.groups,
        isOrgAdminRole: realAuth.isOrgAdminRole,
    },
};

const { usableKbIdsForRequest, partitionAccessibleKBIds } = require('./kbAccess');

const req = { session: { user: { id: 'alice', organizationId: 'org-1' } } };

function reset() {
    fx.orgIds = new Set(['org-1']);
    fx.groups = [];
    fx.orgRole = 'member';
    fx.resolverThrows = false;
    fx.kbStoreThrows = false;
}

test('a base the caller owns and that allows chat comes back', async () => {
    reset();
    assert.deepStrictEqual(await usableKbIdsForRequest(req, ['kb-mine']), ['kb-mine']);
});

test('an org admin gets NO bypass here, even though the linker grants them one', async () => {
    reset();
    fx.orgRole = 'org_admin';
    // The linker's check says yes — administrative reach over the org.
    const { allowed } = await partitionAccessibleKBIds(req, ['kb-org-draft']);
    assert.deepStrictEqual(allowed, ['kb-org-draft'], 'precondition: canAccessKB allows it');
    // Retrieval says no: an answer built from a base they only have
    // administrative reach into is a leak with an audit trail saying "the AI
    // said it".
    assert.deepStrictEqual(await usableKbIdsForRequest(req, ['kb-org-draft']), []);
});

test('this wrapper is never wider than the linker\'s check', async () => {
    reset();
    fx.orgRole = 'org_admin';
    const ids = Object.keys(KBS);
    const { allowed } = await partitionAccessibleKBIds(req, ids);
    const usable = await usableKbIdsForRequest(req, ids);
    for (const id of usable) {
        assert.ok(allowed.includes(id), `${id} passed retrieval but not the read check — that direction is a bug`);
    }
});

test('a super admin\'s null org ids must not read as "allow everything"', async () => {
    reset();
    fx.orgIds = null; // what resolveUserOrgIds returns for a super admin
    const out = await usableKbIdsForRequest(req, ['kb-foreign', 'kb-mine']);
    assert.ok(!out.includes('kb-foreign'), 'a null must narrow, never widen');
});

test('a base its owner switched off for chat is refused', async () => {
    reset();
    assert.deepStrictEqual(await usableKbIdsForRequest(req, ['kb-chat-off']), []);
    // ...and accepted on the surface it was meant for, so this is the surface
    // question and not an access failure in disguise.
    assert.deepStrictEqual(
        await usableKbIdsForRequest(req, ['kb-chat-off'], { surface: 'ai_step' }),
        ['kb-chat-off']
    );
});

test('a session that cannot be resolved yields NOTHING', async () => {
    reset();
    fx.resolverThrows = true;
    assert.deepStrictEqual(await usableKbIdsForRequest(req, ['kb-mine']), []);
});

test('a knowledge-base store that is down yields NOTHING', async () => {
    reset();
    fx.kbStoreThrows = true;
    assert.deepStrictEqual(await usableKbIdsForRequest(req, ['kb-mine']), []);
});

test('junk and empty input yield an empty list', async () => {
    reset();
    for (const input of [undefined, null, [], 'kb-mine', {}, [null, 1, '']]) {
        assert.deepStrictEqual(await usableKbIdsForRequest(req, input), [], JSON.stringify(input));
    }
});
