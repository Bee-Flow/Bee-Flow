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
 * membership — locked here so reads can't silently widen. listKBs, the SQL
 * side of the same rule, runs against a real Postgres.
 *
 * Run: node stores/knowledgeBases.authz.test.js
 */

const assert = require('assert');

process.env.NODE_ENV = 'test';

// listKBs runs on a real Postgres: the boot ladder's schema on PGlite
// (testUtils/pgliteTemplate.js ladderPglite) behind db.js's pool.
const { usePglitePool } = require('../testUtils/pglitePool');
const { ladderPglite } = require('../testUtils/pgliteTemplate');

const { pg, close } = usePglitePool(ladderPglite());
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

    await t('listKBs: drafts of the administered organisations only', async () => {
        await pg.exec(`
            INSERT INTO knowledge_bases (tenant_id, name, organization_id, is_published) VALUES
                ('alice', 'A draft', 'orgA', FALSE),
                ('alice', 'A published', 'orgA', TRUE),
                ('bob', 'B draft', 'orgB', FALSE),
                ('bob', 'B published', 'orgB', TRUE),
                ('carol', 'C draft', 'orgC', FALSE),
                ('eve', 'Eve own draft', NULL, FALSE)
        `);
        const names = async (opts) => (await kbStore.listKBs('eve', orgAB, { sourceKind: null, ...opts })).map(k => k.name).sort();
        assert.deepStrictEqual(await names({ adminOrgIds: new Set(['orgB']) }),
            ['A published', 'B draft', 'B published', 'Eve own draft']);
        assert.deepStrictEqual(await names({ adminOrgIds: new Set(['orgA', 'orgB']) }),
            ['A draft', 'A published', 'B draft', 'B published', 'Eve own draft'], 'admin of every org: every draft of those orgs');
        assert.deepStrictEqual(await names({}), ['A published', 'B published', 'Eve own draft'], 'admin of none: published only');
        assert.deepStrictEqual(await names({ adminOrgIds: new Set(['orgC']) }), ['A published', 'B published', 'Eve own draft'],
            'administering an org the caller is not a member of lists nothing of it');
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
    await close();
    process.exit(failed === 0 ? 0 : 1);
}

run().catch(e => { console.error(e); process.exit(1); });
