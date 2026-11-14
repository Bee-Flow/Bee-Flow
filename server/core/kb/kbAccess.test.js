/**
 * KB access authorization tests.
 *
 * `partitionAccessibleKBIds` is what stops a client from naming a knowledge base
 * it may not read. It matters because the retrieval layer (core/localKBIngest)
 * deliberately performs NO tenant filtering — its documented access boundary is
 * the kb id list, on the assumption that callers authorized those ids upstream.
 * Notebooks persisted whatever the client sent, so that assumption was false.
 *
 * Run: node --test core/kb/kbAccess.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

// ── Fixture knowledge bases ───────────────────────────────────────
const KBS = {
    'kb-mine': { id: 'kb-mine', tenant_id: 'alice', organization_id: 'org-1', is_published: true, shared_groups: '[]' },
    'kb-theirs': { id: 'kb-theirs', tenant_id: 'bob', organization_id: 'org-2', is_published: true, shared_groups: '[]' },
    'kb-same-org-published': { id: 'kb-same-org-published', tenant_id: 'bob', organization_id: 'org-1', is_published: true, shared_groups: '[]' },
    'kb-same-org-draft': { id: 'kb-same-org-draft', tenant_id: 'bob', organization_id: 'org-1', is_published: false, shared_groups: '[]' },
    'kb-group-restricted': { id: 'kb-group-restricted', tenant_id: 'bob', organization_id: 'org-1', is_published: true, shared_groups: '["group-x"]' },
    'kb-system': { id: 'kb-system', tenant_id: 'system', organization_id: null, is_published: true, source_kind: 'system_managed', shared_groups: '[]' },
};

// The caller's organisations and the ones they administer, per test.
const fx = { orgIds: new Set(['org-1']), adminOrgIds: new Set(), adminThrows: false };
// A fresh request per test: the resolver memoises the caller's organisations and groups on the request.
let req;
test.beforeEach(() => { fx.orgIds = new Set(['org-1']); fx.adminOrgIds = new Set(); fx.adminThrows = false; req = { session: { user: { id: 'alice', organizationId: 'org-1' } } }; });

// ── Stub the modules kbAccess pulls in ────────────────────────────
const kbStorePath = require.resolve('../../stores/knowledgeBases');
const realKbStore = require('../../stores/knowledgeBases');
require.cache[kbStorePath] = {
    id: kbStorePath,
    filename: kbStorePath,
    loaded: true,
    exports: {
        getKB: async (id) => KBS[id] || null,
        // Reuse the REAL policy function — this test must not re-implement it.
        canUserAccessKB: realKbStore.canUserAccessKB,
    },
};

const userStorePath = require.resolve('../../stores/userStore');
require.cache[userStorePath] = {
    id: userStorePath,
    filename: userStorePath,
    loaded: true,
    exports: { getUser: async () => ({ orgRole: 'member' }) },
};

// kbAccess imports its auth helpers from auth/permissions and auth/audience.
const permissionsPath = require.resolve('../../auth/permissions');
require.cache[permissionsPath] = {
    id: permissionsPath,
    filename: permissionsPath,
    loaded: true,
    exports: {
        resolveUserOrgIds: async () => fx.orgIds,
        isOrgAdminRole: () => false,
        resolveAdminOrgIds: async () => { if (fx.adminThrows) throw new Error('down'); return fx.adminOrgIds; },
    },
};
const audiencePath = require.resolve('../../auth/audience');
require.cache[audiencePath] = {
    id: audiencePath,
    filename: audiencePath,
    loaded: true,
    exports: {
        resolveUserGroups: async () => [],
    },
};

const { partitionAccessibleKBIds, canAccessKB } = require('./kbAccess');

test('own KB is allowed', async () => {
    const { allowed, denied } = await partitionAccessibleKBIds(req, ['kb-mine']);
    assert.deepStrictEqual(allowed, ['kb-mine']);
    assert.deepStrictEqual(denied, []);
});

test("another tenant's KB in another org is denied", async () => {
    const { allowed, denied } = await partitionAccessibleKBIds(req, ['kb-theirs']);
    assert.deepStrictEqual(allowed, [], 'a foreign-org KB must never be usable');
    assert.deepStrictEqual(denied, ['kb-theirs']);
});

test('a same-org published KB is allowed, a same-org draft is not', async () => {
    const { allowed, denied } = await partitionAccessibleKBIds(req, ['kb-same-org-published', 'kb-same-org-draft']);
    assert.deepStrictEqual(allowed, ['kb-same-org-published']);
    assert.deepStrictEqual(denied, ['kb-same-org-draft'], 'drafts stay hidden from non-owners');
});

test('a group-restricted KB is denied when the user is in no group', async () => {
    const { denied } = await partitionAccessibleKBIds(req, ['kb-group-restricted']);
    assert.deepStrictEqual(denied, ['kb-group-restricted']);
});

test('an unknown / deleted id is denied, not silently allowed', async () => {
    const { allowed, denied } = await partitionAccessibleKBIds(req, ['kb-does-not-exist']);
    assert.deepStrictEqual(allowed, []);
    assert.deepStrictEqual(denied, ['kb-does-not-exist']);
});

test('a mixed list is partitioned, not all-or-nothing', async () => {
    const { allowed, denied } = await partitionAccessibleKBIds(req, ['kb-mine', 'kb-theirs', 'kb-same-org-published']);
    assert.deepStrictEqual(allowed, ['kb-mine', 'kb-same-org-published']);
    assert.deepStrictEqual(denied, ['kb-theirs']);
});

test('system-managed reference KBs stay readable', async () => {
    const { allowed } = await partitionAccessibleKBIds(req, ['kb-system']);
    assert.deepStrictEqual(allowed, ['kb-system']);
});

test('non-array and junk input degrade to empty rather than throwing', async () => {
    assert.deepStrictEqual(await partitionAccessibleKBIds(req, undefined), { allowed: [], denied: [] });
    assert.deepStrictEqual(await partitionAccessibleKBIds(req, 'kb-mine'), { allowed: [], denied: [] });
    assert.deepStrictEqual(await partitionAccessibleKBIds(req, [null, 42, '']), { allowed: [], denied: [] });
});

test('canAccessKB returns false for a null kb', async () => {
    assert.strictEqual(await canAccessKB(req, null), false);
});

test('an admin of the KB\'s organisation reads its drafts and group-restricted bases', async () => {
    fx.adminOrgIds = new Set(['org-1']);
    const { allowed } = await partitionAccessibleKBIds(req, ['kb-same-org-draft', 'kb-group-restricted']);
    assert.deepStrictEqual(allowed, ['kb-same-org-draft', 'kb-group-restricted']);
});

test('an admin of another organisation reads a member organisation\'s bases as a member', async () => {
    // Admin of org-2, plain group member of org-1.
    fx.orgIds = new Set(['org-2', 'org-1']);
    fx.adminOrgIds = new Set(['org-2']);
    const { allowed, denied } = await partitionAccessibleKBIds(req, ['kb-same-org-draft', 'kb-group-restricted', 'kb-same-org-published', 'kb-theirs']);
    assert.deepStrictEqual(allowed, ['kb-same-org-published', 'kb-theirs']);
    assert.deepStrictEqual(denied, ['kb-same-org-draft', 'kb-group-restricted']);
});

test('an unreadable admin answer is no organisation', async () => {
    fx.adminThrows = true;
    const { denied } = await partitionAccessibleKBIds(req, ['kb-same-org-draft']);
    assert.deepStrictEqual(denied, ['kb-same-org-draft']);
});
