// @typecheck
/**
 * The shared set-up of the /api/studio/search route tests (search.test.js and its module
 * halves search.automation.test.js and search.meetingNotes.test.js): a fully open, fully
 * populated fake dependency set, and the PGlite fixture the raw-SQL kinds run on.
 */

'use strict';

const { ladderPglite } = require('../../testUtils/pgliteTemplate');
const { insertRow } = require('../../testUtils/pgliteSeed');

// ── A fully-open, fully-populated fake dependency set ───────────────────────
/** @param {Record<string, any>} [overrides] */
function makeDeps(overrides = {}) {
    const calls = { sql: [] };
    const bump = (name) => { calls[name] = (calls[name] || 0) + 1; };
    const deps = {
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
            // 'nogrant' is a table whose NAME matches but on which this
            // principal holds nothing.
            gradeForPrincipal: (t) => (t.id === 'nogrant' ? null : 'reader'),
        },
        automationCore: {
            getAll: async (sql, params) => {
                bump('automations');
                calls.sql.push({ sql, params });
                return [{ id: 'a1', title: 'Invoice reminder' }];
            },
        },
        datatableStore: {
            listDatatablesForScope: async (scope) => (scope.kind === 'user'
                ? [{ id: 't1', name: 'Invoices' }]
                : [{ id: 'nogrant', name: 'Invoices (finance)' }, { id: 't2', name: 'Suppliers' }]),
            listGrantsForTables: async (ids) => { bump('grants'); calls.grantIds = ids; return new Map(ids.map((id) => [id, []])); },
        },
        studioAppStore: { getAccessibleStudioApps: async () => [{ id: 'app1', name: 'Invoice portal' }, { id: 'app2', name: 'Holiday planner' }] },
        webpageStore: { getAccessibleWebpages: async () => [{ id: 'w1', name: 'Invoice help' }, { id: 'w2', name: 'About us' }] },
        skillStore: { getAvailableSkills: async () => [{ id: 's1', name: 'Invoice parsing' }, { id: 's2', name: 'Translate' }] },
        userStore: { getUser: async () => ({ id: 'u1', organizationId: 'orgA' }) },
        kbStore: {
            listKBs: async () => [{ id: 'kb1', name: 'Invoice archive' }, { id: 'kbx', name: 'Invoice secrets' }, { id: 'kb2', name: 'Handbook' }],
            // The group filter removes a base whose name matches — the check
            // that org scoping alone is not the visibility answer.
            filterByGroupAccess: (kbs) => kbs.filter((kb) => kb.id !== 'kbx'),
        },
        kbShared: {
            resolveAdminOrgIds: async () => new Set(),
            resolveEnabledSystemSlugs: async () => [],
            listFilterFromQuery: () => ({ sourceKind: 'manual' }),
            resolveUserGroups: async () => ['g1'],
        },
        transcriptionsShared: { resolveAccessContext: async () => ({ orgIds: ['orgA'], userGroupIds: ['g1'], isSuperAdmin: false }) },
        db: {
            getAll: async (sql, params) => {
                calls.sql.push({ sql, params });
                if (/FROM agents/.test(sql)) { bump('agents'); return [{ id: 'ag1', name: 'Invoice bot' }]; }
                bump('meetingNotes');
                return [{ id: 'm1', title: 'Invoice call', file_name: 'call.m4a' }];
            },
        },
        projectStore: { listUserProjects: async () => [{ id: 'pr1', name: 'Invoice rollout' }, { id: 'pr2', name: 'Onboarding' }] },
        configStore: { getConfig: async () => null },
    };
    return Object.assign(deps, overrides);
}

/**
 * The boot ladder's schema on PGlite, handed in as `db` and `automationCore`; the statements are
 * recorded so "no query" is a fact. `tables` are the ones resetTables() empties.
 * @param {typeof import('node:test')} test
 * @param {string[]} tables
 */
function sqlFixture(test, tables) {
    const pg = ladderPglite();
    test.after(() => pg.close());
    const sqlSeen = [];
    const realGetAll = async (sql, params) => { sqlSeen.push(sql); return (await pg.query(sql, params)).rows; };
    const realDeps = (over = {}) => makeDeps({ db: { getAll: realGetAll }, automationCore: { getAll: realGetAll }, ...over });
    async function resetTables() {
        await pg.exec(`TRUNCATE ${tables.join(', ')} CASCADE`);
        sqlSeen.length = 0;
    }
    let seq = 0;
    const automation = (title, over = {}) => insertRow(pg, 'automations', { id: `au${++seq}`, user_id: 'u1', title, definition_json: {}, ...over });
    const transcription = (title, over = {}) => insertRow(pg, 'transcriptions', { id: `t${++seq}`, user_id: 'u9', title, shared_with: [], is_published: false, shared_groups: [], ...over });
    const agentRow = (name, over = {}) => insertRow(pg, 'agents', { id: `ag${++seq}`, name, owner_id: 'u1', ...over });
    const ids = (rows) => rows.map((r) => r.id).sort();
    return { pg, sqlSeen, realDeps, resetTables, automation, transcription, agentRow, ids };
}

module.exports = { makeDeps, sqlFixture };
