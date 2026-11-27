// @typecheck
/**
 * The shared set-up of the /api/studio/counts route tests (counts.test.js and its module half
 * counts.meetingNotes.test.js): a fully open, fully populated fake dependency set, and the
 * PGlite fixture the SQL COUNTs run on.
 */

'use strict';

const { ladderPglite } = require('../../testUtils/pgliteTemplate');
const { insertRow } = require('../../testUtils/pgliteSeed');

// ── A fully-open, fully-populated fake dependency set ───────────────────────
/** @param {Record<string, any>} [overrides] */
function makeDeps(overrides = {}) {
    const calls = {};
    const rec = (name) => { calls[name] = (calls[name] || 0) + 1; };
    let clock = 1_000_000;
    const deps = {
        now: () => clock,
        _tick: (ms) => { clock += ms; },
        _calls: calls,
        modules: { isModuleActive: async () => true },
        license: { featureAllowedForRequest: async () => ({ allowed: true, resolution: {} }) },
        entitlements: { hasCapability: async () => true },
        permissions: { hasPermission: async () => true },
        auth: {
            resolveUserOrgIds: async () => new Set(['orgA']),
            resolveUserGroups: async () => ['g1'],
        },
        audience: { resolveAudienceContext: async () => ({ userId: 'u1', orgIds: new Set(['orgA']), userGroups: ['g1'] }) },
        datatableAccess: {
            resolveDatatablePrincipal: async () => ({ userId: 'u1', orgId: 'orgA' }),
            datatableScopesFor: () => [{ kind: 'user', id: 'u1' }, { kind: 'org', id: 'orgA' }],
            gradeForPrincipal: (t) => (t.id === 'hidden' ? null : 'reader'),
        },
        automationCore: { getOne: async () => { rec('automations'); return { n: 9 }; } },
        automationStore: {
            // Studio → Runs & log counts the CALLER's runs in a 24h window.
            getRunCountForUserSince: async (userId, sinceTs) => { rec('runs'); return { userId, sinceTs, n: 12 }.n; },
            listFormPagesForOrg: async () => [
                // Two pages for the same form: the busiest wins, counted once.
                { id: 'p1', automationId: 'a1', triggerStepId: 'trg', submissions: 2, userId: 'u1', definition: { trigger: { id: 'trg', kind: 'form' } } },
                { id: 'p2', automationId: 'a1', triggerStepId: 'trg', submissions: 9, userId: 'u1', definition: { trigger: { id: 'trg', kind: 'form' } } },
                // A page whose trigger is not a form is dropped.
                { id: 'p3', automationId: 'a2', triggerStepId: null, submissions: 0, userId: 'u2', definition: { trigger: { id: 'trg', kind: 'manual' } } },
                // A secondary trigger that is a form.
                { id: 'p4', automationId: 'a3', triggerStepId: 't2', submissions: 0, userId: 'u3', definition: { trigger: { id: 'trg', kind: 'manual' }, triggers: [{ id: 't2', kind: 'form' }] } },
            ],
        },
        datatableStore: {
            listDatatablesForScope: async (scope) => (scope.kind === 'user'
                ? [{ id: 't1', ownerUserId: 'u1' }]
                : [{ id: 't2', ownerUserId: 'u2' }, { id: 'hidden', ownerUserId: 'u9' }]),
            listGrantsForTables: async (ids) => new Map(ids.map(id => [id, []])),
        },
        studioAppStore: { getAccessibleStudioApps: async () => [{ id: 'app1', userId: 'u1' }, { id: 'app2', userId: 'u4' }, { id: 'app3', userId: 'u4' }, { id: 'app4', userId: 'u5' }] },
        playbookStore: { listPlaybooksForUser: async (uid) => (uid ? [{ id: 'pb1', userId: uid }, { id: 'pb2', userId: uid }] : []) },
        webpageStore: { getAccessibleWebpages: async () => [{ id: 'w1', userId: 'u1' }, { id: 'w2', userId: 'u2' }] },
        skillStore: { getAvailableSkills: async () => Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, userId: 'u1' })) },
        userStore: { getUser: async () => ({ id: 'u1', organizationId: 'orgA' }) },
        kbStore: {
            listKBs: async () => [{ id: 'kb1', tenant_id: 'u1' }, { id: 'kb2', tenant_id: 'u7' }, { id: 'kb3', tenant_id: 'u7' }, { id: 'kbx', tenant_id: 'u8' }],
            filterByGroupAccess: (kbs) => kbs.filter(kb => kb.id !== 'kbx'),
        },
        kbShared: {
            resolveAdminOrgIds: async () => new Set(),
            resolveEnabledSystemSlugs: async () => [],
            listFilterFromQuery: () => ({ sourceKind: 'manual', usageContext: null, excludeContext: null }),
            resolveUserGroups: async () => ['g1'],
        },
        transcriptionsShared: { resolveAccessContext: async () => ({ orgIds: ['orgA'], userGroupIds: ['g1'], isSuperAdmin: false }) },
        // Two kinds share the core-DB pool: the agents COUNT (org-scoped in
        // the WHERE) and the transcriptions COUNT. Dispatch on the table.
        db: { getOne: async (sql) => (/FROM agents/.test(sql)
            ? { n: 2, owners: ['u1', 'u6'] }
            : { n: 13, owners: ['u1', 'u10'] }) },
        projectStore: { listUserProjects: async () => [{ id: 'pr1', ownerId: 'u1' }, { id: 'pr2', ownerId: 'u11' }, { id: 'pr3', ownerId: 'u11' }] },
        configStore: { getConfig: async () => null },
    };
    return Object.assign(deps, overrides);
}

/**
 * The boot ladder's schema on PGlite, handed in through the `db` dependency; the statements are
 * recorded so "no query" is a fact. `tables` are the ones resetCountTables() empties.
 * @param {typeof import('node:test')} test
 * @param {string[]} tables
 */
function countFixture(test, tables) {
    const pg = ladderPglite();
    test.after(() => pg.close());
    const sqlSeen = [];
    const realDb = { getOne: async (sql, params) => { sqlSeen.push(sql); return (await pg.query(sql, params)).rows[0] || null; } };
    async function resetCountTables() {
        await pg.exec(`TRUNCATE ${tables.join(', ')} CASCADE`);
        sqlSeen.length = 0;
    }
    const transcription = (over) => insertRow(pg, 'transcriptions', { id: `t-${Math.random().toString(36).slice(2)}`, user_id: 'u9', shared_with: [], is_published: false, shared_groups: [], ...over });
    const agentRow = (id, over) => insertRow(pg, 'agents', { id, name: id, owner_id: 'u1', ...over });
    return { pg, sqlSeen, realDb, resetCountTables, transcription, agentRow };
}

module.exports = { makeDeps, countFixture };
