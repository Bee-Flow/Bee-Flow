/**
 * Knowledge Base Authorization Policy Tests (BFSF-214)
 *
 * Covers the two pure policy predicates on the KB store:
 *   - canUserManageKB(kb, userId, orgIds, hasManagePermission)  [new]
 *   - canUserAccessKB(kb, userId, orgIds, userGroups)           [regression lock]
 *
 * Manage policy: settings may be updated by the owner, super admins, and
 * same-org manage_knowledge holders regardless of publish state. Read
 * policy: draft/group-restricted content is visible to the owner, super
 * admins, and admins of the KB's own organisation (opts.adminOrgIds); everyone
 * else, an admin of another organisation included, still needs publish + group
 * membership — locked here so reads can't silently widen.
 *
 * Run: node stores/knowledgeBases.authz.test.js
 */

const assert = require('assert');

process.env.NODE_ENV = 'test';

// ── Mock ../db so requiring the store is side-effect free ─────────
/** @type {(sql: string, params: unknown[]) => Promise<unknown[]>} */
let getAllHook = async () => [];
const mockDb = {
    run: async () => undefined,
    getOne: async () => null,
    // The store destructures getAll when it loads; a test swaps getAllHook.
    getAll: async (sql, params) => getAllHook(sql, params),
    exec: async () => undefined,
    getClient: async () => null,
};

const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (request === '../db') return 'mock-db';
    return originalResolve.call(this, request, parent, ...rest);
};
require.cache['mock-db'] = { id: 'mock-db', exports: mockDb };

const kbStore = require('./knowledgeBases');

// ── Fixtures ──────────────────────────────────────────────────────
const draftA = { id: 'kb-draft', tenant_id: 'alice', organization_id: 'orgA', is_published: false, shared_groups: '[]' };
const publishedA = { id: 'kb-pub', tenant_id: 'alice', organization_id: 'orgA', is_published: true, shared_groups: '[]' };
const publishedGroupA = { id: 'kb-grp', tenant_id: 'alice', organization_id: 'orgA', is_published: true, shared_groups: '["group-A1"]' };
const personalDraft = { id: 'kb-personal', tenant_id: 'alice', organization_id: null, is_published: false, shared_groups: '[]' };

const orgASet = new Set(['orgA']);
const orgBSet = new Set(['orgB']);

// ── Test scaffold ─────────────────────────────────────────────────
async function run() {
    let passed = 0, failed = 0;
    async function t(name, fn) {
        try { await fn(); console.log(`  ✅ ${name}`); passed++; }
        catch (e) { console.log(`  ❌ ${name}: ${e.message}`); failed++; }
    }

    console.log('\n🔐 KB Authorization Policy Tests (BFSF-214)\n');

    // ── canUserManageKB ─────────────────────────────────────────
    console.log('--- canUserManageKB ---');

    await t('owner on own draft → true', async () => {
        assert.strictEqual(kbStore.canUserManageKB(draftA, 'alice', orgASet, false), true);
    });

    await t('owner on own published → true', async () => {
        assert.strictEqual(kbStore.canUserManageKB(publishedA, 'alice', orgASet, false), true);
    });

    await t('super admin (orgIds === null) on foreign draft → true', async () => {
        assert.strictEqual(kbStore.canUserManageKB(draftA, 'root', null, false), true);
    });

    await t('same-org user with manage perm on foreign DRAFT → true (the BFSF-214 case)', async () => {
        assert.strictEqual(kbStore.canUserManageKB(draftA, 'bob', orgASet, true), true);
    });

    await t('same-org user with manage perm on foreign published+group-restricted → true', async () => {
        assert.strictEqual(kbStore.canUserManageKB(publishedGroupA, 'bob', orgASet, true), true);
    });

    await t('same-org user without manage perm → false', async () => {
        assert.strictEqual(kbStore.canUserManageKB(draftA, 'bob', orgASet, false), false);
        assert.strictEqual(kbStore.canUserManageKB(publishedA, 'bob', orgASet, false), false);
    });

    await t('cross-org user with manage perm → false', async () => {
        assert.strictEqual(kbStore.canUserManageKB(draftA, 'eve', orgBSet, true), false);
        assert.strictEqual(kbStore.canUserManageKB(publishedA, 'eve', orgBSet, true), false);
    });

    await t("foreign personal KB (organization_id null) with manage perm → false", async () => {
        assert.strictEqual(kbStore.canUserManageKB(personalDraft, 'bob', orgASet, true), false);
    });

    await t('kb = null → false', async () => {
        assert.strictEqual(kbStore.canUserManageKB(null, 'alice', orgASet, true), false);
    });

    // ── canUserAccessKB regression lock (read policy untouched) ─
    console.log('--- canUserAccessKB (read policy lock) ---');

    await t('non-owner same-org user on draft → false (drafts stay hidden)', async () => {
        assert.strictEqual(kbStore.canUserAccessKB(draftA, 'bob', orgASet, []), false);
    });

    await t('non-owner same-org user on published, no group restriction → true', async () => {
        assert.strictEqual(kbStore.canUserAccessKB(publishedA, 'bob', orgASet, []), true);
    });

    await t('non-owner on published group-restricted KB → only with group membership', async () => {
        assert.strictEqual(kbStore.canUserAccessKB(publishedGroupA, 'bob', orgASet, ['group-A1']), true);
        assert.strictEqual(kbStore.canUserAccessKB(publishedGroupA, 'bob', orgASet, []), false);
    });

    await t('cross-org user on published KB → false', async () => {
        assert.strictEqual(kbStore.canUserAccessKB(publishedA, 'eve', orgBSet, []), false);
    });

    await t('owner and super admin still read drafts', async () => {
        assert.strictEqual(kbStore.canUserAccessKB(draftA, 'alice', orgASet, []), true);
        assert.strictEqual(kbStore.canUserAccessKB(draftA, 'root', null, []), true);
    });

    // ── canUserAccessKB org-admin read access ───────────────────
    console.log('--- canUserAccessKB (org admin sees all KBs of the org they administer) ---');

    const adminOfA = { adminOrgIds: new Set(['orgA']) };
    const orgAB = new Set(['orgA', 'orgB']);

    await t('org admin sees foreign org DRAFT → true', async () => {
        assert.strictEqual(kbStore.canUserAccessKB(draftA, 'bob', orgASet, [], adminOfA), true);
        assert.strictEqual(kbStore.canUserAccessKB(draftA, 'bob', orgASet, [], { adminOrgIds: ['orgA'] }), true, 'an array is the same answer');
    });

    await t('org admin sees foreign group-restricted KB without group membership → true', async () => {
        assert.strictEqual(kbStore.canUserAccessKB(publishedGroupA, 'bob', orgASet, [], adminOfA), true);
    });

    await t('org admin does NOT see a KB outside their org → false', async () => {
        assert.strictEqual(kbStore.canUserAccessKB(draftA, 'eve', orgBSet, [], adminOfA), false);
    });

    await t("org admin does NOT see a member's personal (no-org) KB → false", async () => {
        assert.strictEqual(kbStore.canUserAccessKB(personalDraft, 'bob', orgASet, [], adminOfA), false);
    });

    await t('admin of orgB who is a plain member of orgA reads orgA as a member → drafts and group bases hidden', async () => {
        const adminOfB = { adminOrgIds: new Set(['orgB']) };
        assert.strictEqual(kbStore.canUserAccessKB(draftA, 'eve', orgAB, [], adminOfB), false);
        assert.strictEqual(kbStore.canUserAccessKB(publishedGroupA, 'eve', orgAB, [], adminOfB), false);
        assert.strictEqual(kbStore.canUserAccessKB(publishedGroupA, 'eve', orgAB, ['group-A1'], adminOfB), true, 'a group share still reads');
        assert.strictEqual(kbStore.canUserAccessKB(publishedA, 'eve', orgAB, [], adminOfB), true, 'a published base still reads');
    });

    await t('no admin organisations behaves exactly like before (drafts hidden) → false', async () => {
        assert.strictEqual(kbStore.canUserAccessKB(draftA, 'bob', orgASet, [], {}), false);
        assert.strictEqual(kbStore.canUserAccessKB(draftA, 'bob', orgASet, [], { adminOrgIds: [] }), false);
        // An unrecognised option grants nothing.
        assert.strictEqual(kbStore.canUserAccessKB(draftA, 'bob', orgASet, [], /** @type {any} */ ({ isOrgAdmin: true })), false);
    });

    await t('filterByGroupAccess applies the shortcut per organisation', async () => {
        const draftB = { ...draftA, id: 'kb-draft-b', organization_id: 'orgB' };
        const kept = kbStore.filterByGroupAccess([draftA, draftB], 'eve', [], { orgIds: orgAB, adminOrgIds: new Set(['orgB']) });
        assert.deepStrictEqual(kept.map((k) => k.id), ['kb-draft-b']);
    });

    // ── listKBs: the draft clause per organisation ──────────────
    console.log('--- listKBs (drafts only of the organisations administered) ---');

    await t('listKBs: drafts of the administered organisations only, as a bound parameter', async () => {
        /** @type {{ sql: string, params: unknown[] }[]} */
        const seen = [];
        const orig = getAllHook;
        getAllHook = async (sql, params) => { seen.push({ sql, params }); return []; };
        try {
            await kbStore.listKBs('eve', orgAB, { sourceKind: null, adminOrgIds: new Set(['orgB']) });
            await kbStore.listKBs('eve', orgAB, { sourceKind: null, adminOrgIds: new Set(['orgA', 'orgB']) });
            await kbStore.listKBs('eve', orgAB, { sourceKind: null });
        } finally { getAllHook = orig; }
        const [mixed, all, none] = seen;
        assert.ok(mixed.sql.includes('AND (kb.is_published = TRUE OR kb.organization_id = ANY($3))'), mixed.sql);
        assert.deepStrictEqual(mixed.params, ['eve', ['orgA', 'orgB'], ['orgB']]);
        assert.ok(!all.sql.includes('is_published'), 'admin of every org: no draft clause');
        assert.ok(none.sql.includes('AND kb.is_published = TRUE))'), 'admin of none: published only');
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
    process.exit(failed === 0 ? 0 : 1);
}

run().catch(e => { console.error(e); process.exit(1); });
