// @typecheck
/**
 * Shared fixtures of the organisation-scope tests of GET /agents/all
 * (published.orgScope.test.js) and GET /agents/categories
 * (crud.categoriesOrgScope.test.js): two organisations, a platform admin, an
 * organisation admin of A who is also in a plain group of B, and a plain
 * member of A.
 *
 * `resolveUserOrgIds` stands in for auth/permissions' union (null for a
 * platform admin, else the home organisation plus the organisations of the
 * caller's groups); everything the real resolveAdminOrgId reads goes through
 * the swapped userStore.
 */

'use strict';

const ORGS = [
    { id: 'orgA', name: 'Organisation A' },
    { id: 'orgB', name: 'Organisation B' },
];

const GROUPS = [
    { id: 'g_b_plain', organizationId: 'orgB', permissions: [], roles: [] },
];

/** @type {Record<string, { id: string, role: string, organizationId: string | null, orgRole: string, groups: string[] }>} */
const USERS = {
    plat: { id: 'plat', role: 'admin', organizationId: null, orgRole: '', groups: [] },
    annA: { id: 'annA', role: 'user', organizationId: 'orgA', orgRole: 'org_admin', groups: ['g_b_plain'] },
    memberA: { id: 'memberA', role: 'user', organizationId: 'orgA', orgRole: 'member', groups: [] },
};

const counters = { listOrganizations: 0, getOrganization: 0 };
let organizationsFail = false;

function resetCounters() {
    counters.listOrganizations = 0;
    counters.getOrganization = 0;
}

/** @param {boolean} on */
function failOrganizations(on) {
    organizationsFail = on;
}

/**
 * @param {{ session?: { user?: { id?: string } } }} req
 * @returns {Promise<Set<string> | null>}
 */
async function resolveUserOrgIds(req) {
    const id = req?.session?.user?.id;
    const user = id ? USERS[id] : undefined;
    if (!user || user.role === 'admin') return user ? null : new Set();
    const ids = new Set(user.organizationId ? [user.organizationId] : []);
    for (const gid of user.groups) {
        const group = GROUPS.find((g) => g.id === gid);
        if (group) ids.add(group.organizationId);
    }
    return ids;
}

/**
 * @param {{ swap: (obj: any, name: string, fn: Function) => unknown }} swaps
 * @param {Record<string, unknown>} userStore the module object of stores/userStore
 */
function swapUserStore(swaps, userStore) {
    swaps.swap(userStore, 'getUser', async (/** @type {string} */ id) => (USERS[id] ? { ...USERS[id], groups: [...USERS[id].groups] } : null));
    swaps.swap(userStore, 'getAllGroups', async () => GROUPS.map((g) => ({ ...g })));
    swaps.swap(userStore, 'getOrganization', async (/** @type {string} */ id) => {
        counters.getOrganization += 1;
        if (organizationsFail) throw new Error('organisations unavailable');
        return ORGS.find((o) => o.id === id) || null;
    });
    swaps.swap(userStore, 'getAllOrganizations', async () => {
        counters.listOrganizations += 1;
        if (organizationsFail) throw new Error('organisations unavailable');
        return ORGS.map((o) => ({ ...o }));
    });
}

module.exports = { USERS, counters, resetCounters, failOrganizations, resolveUserOrgIds, swapUserStore };
