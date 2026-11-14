// @typecheck
'use strict';

/**
 * Characterisation (golden) test for syncAzureGroupsToOrg: for each scenario
 * the result or the thrown error (status, code), every call on its
 * collaborators in order with what it was given (the binding and settings
 * reads, the lock, Graph, the group and user stores, the membership store, the
 * status write) and the groups and users it leaves behind. The clock stands
 * still.
 *
 * Scenarios reach each branch: the binding checks, the Microsoft credentials
 * and tenant, a token that cannot be had, group, user and other assignments,
 * principal ids that are invalid or spelled in capitals, directory reads that
 * fail or answer another identity, a group that exists, a legacy group to
 * bind (one, several, a failing write), a group to create, members that are
 * invalid, known, outside the organisation, unbound, known by e-mail only or
 * new (activated or pending, over the seat limit, with and without a group),
 * and the removal pass (off, held back by an error, departed members, groups
 * no longer assigned, users of another tenant or organisation).
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test integrations/azureGroupSync.characterisation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-03-01T10:00:00.000Z') });

const { createAzureGroupSync } = require('./azureGroupSync');

const GOLDEN = path.join(__dirname, 'azureGroupSync.characterisation.golden.json');

const guid = (/** @type {string} */ d) => `${d.repeat(8)}-${d.repeat(4)}-${d.repeat(4)}-${d.repeat(4)}-${d.repeat(12)}`;
const TID = guid('1');
const OTHER_TID = guid('9');
const [GA, GB, GC] = [guid('a'), guid('b'), guid('c')];
const [U1, U2, U3, U4, U5] = [guid('2'), guid('3'), guid('4'), guid('5'), guid('6')];
// An id with letters, so its spelling in capitals differs.
const UE = guid('e');
const USER_E = { id: 'ue', email: 'e@example.test', azureTenantId: TID, azureUserId: UE, organizationId: 'B', groups: ['azure-ga', 'azure-gb'] };

const GROUPS = [
    { id: 'manual-A', organizationId: 'A', source: 'manual' },
    { id: 'manual-B', organizationId: 'B', source: 'manual' },
    { id: 'azure-ga', organizationId: 'B', azureTenantId: TID, azureGroupId: GA, source: 'azure', name: 'Old A' },
    { id: 'azure-gb', organizationId: 'B', azureTenantId: TID, azureGroupId: GB, source: 'azure', name: 'Old B' },
    { id: 'other-org-azure', organizationId: 'A', azureTenantId: TID, azureGroupId: GA, source: 'azure' },
];
const USERS = [
    { id: 'u1', email: 'one@example.test', azureTenantId: TID, azureUserId: U1, organizationId: 'B', groups: ['azure-ga', 'azure-gb'] },
    { id: 'u2', email: 'two@example.test', azureTenantId: TID, azureUserId: U2, organizationId: 'A', groups: ['manual-B', 'azure-ga'] },
    { id: 'u3', email: 'three@example.test', azureTenantId: TID, azureUserId: U3, organizationId: 'A', groups: ['manual-A', 'azure-ga'] },
    { id: 'u4', email: 'four@example.test', azureTenantId: OTHER_TID, azureUserId: U4, organizationId: 'B', groups: ['azure-ga'] },
    { id: 'legacy', email: 'legacy@example.test', organizationId: 'B', groups: [] },
];
const GROUP_ASSIGNMENTS = [{ principalType: 'Group', principalId: GA }, { principalType: 'Group', principalId: GB }];
const NEW_MEMBER = { id: U5, displayName: 'New Person', givenName: 'New', surname: 'Person', mail: 'new@example.test' };

/**
 * name → the world of one run. orgId (default 'B'), binding, settings, ms
 * (the Microsoft provider config), assignments, members per group id,
 * directory objects per id (groupInfo / userInfo), groups and users (default
 * GROUPS / USERS), and what fails.
 * @type {Record<string, Record<string, any>>}
 */
const CASES = {
    // binding and credentials
    unbound: { binding: null },
    bindingWithoutTenant: { binding: { syncOrganizationId: 'B', syncTenantId: 'common' } },
    otherOrganisation: { orgId: 'A' },
    bindingChangesBeforeTheLock: { bindingUnderLock: { syncOrganizationId: 'A', syncTenantId: TID } },
    credentialsMissing: { ms: { clientId: 'app' } },
    providerNotConfigured: { ms: undefined },
    tenantDiffers: { ms: { clientId: 'app', clientSecret: 's', tenantId: OTHER_TID } },
    tenantInCapitals: { binding: { syncOrganizationId: 'B', syncTenantId: guid('d') }, ms: { clientId: 'app', clientSecret: 's', tenantId: guid('D') }, assignments: [] },
    tenantNotConcrete: { ms: { clientId: 'app', clientSecret: 's', tenantId: 'organizations' }, assignments: [] },
    tokenFails: { tokenThrows: true },
    assignmentsFail: { assignmentsThrow: true },
    // the directory snapshot
    noAssignments: { assignments: [] },
    twoGroups: { members: { [GA]: [{ id: U1 }], [GB]: [{ id: U1 }, { id: U2 }] } },
    principalInCapitals: { assignments: [{ principalType: 'Group', principalId: GA.toUpperCase() }], members: { [GA]: [{ id: U1.toUpperCase() }] }, settings: { destructiveSync: true } },
    principalInvalid: { assignments: [{ principalType: 'Group', principalId: 'not-a-guid' }, { principalType: 'User', principalId: 42 }, { principalType: 'Group' }] },
    principalOfAnotherType: { assignments: [{ principalType: 'ServicePrincipal', principalId: GA }], settings: { destructiveSync: true } },
    groupIdentityMismatch: { assignments: [{ principalType: 'Group', principalId: GA }], groupInfo: { [GA]: { id: GB, displayName: 'Other' } } },
    groupWithoutIdentity: { assignments: [{ principalType: 'Group', principalId: GA }], groupInfo: { [GA]: { displayName: 'No id' } } },
    groupIdentityInCapitals: { assignments: [{ principalType: 'Group', principalId: GA }], groupInfo: { [GA]: { id: GA.toUpperCase(), displayName: 'Capitals' } } },
    groupMembersFail: { failGroup: GB, settings: { destructiveSync: true }, members: { [GA]: [] } },
    userAssignment: { assignments: [{ principalType: 'User', principalId: U1 }] },
    userAssignmentNew: { assignments: [{ principalType: 'User', principalId: U5 }], userInfo: { [U5]: NEW_MEMBER } },
    userAssignmentWithRemoval: { assignments: [{ principalType: 'User', principalId: U1 }, { principalType: 'Group', principalId: GA }, { principalType: 'Group', principalId: GB }], members: { [GA]: [{ id: U1 }, { id: U2 }, { id: U3 }], [GB]: [{ id: U1 }, { id: U2 }, { id: U3 }] }, settings: { destructiveSync: true } },
    userIdentityMismatch: { assignments: [{ principalType: 'User', principalId: U1 }], userInfo: { [U1]: { id: U2 } } },
    graphReadFails: { assignments: [{ principalType: 'User', principalId: U1 }, { principalType: 'Group', principalId: GA }], graphGetThrows: U1, members: { [GA]: [{ id: U1 }] } },
    // groups
    groupUpdated: { assignments: [{ principalType: 'Group', principalId: GA }], groupInfo: { [GA]: { id: GA, displayName: 'Finance', description: 'Money' } } },
    groupUpdateKeepsName: { assignments: [{ principalType: 'Group', principalId: GA }], groupInfo: { [GA]: { id: GA } } },
    groupUpdateFails: { assignments: [{ principalType: 'Group', principalId: GA }, { principalType: 'Group', principalId: GB }], updateGroupFails: 'azure-ga', settings: { destructiveSync: true } },
    groupCreated: { assignments: [{ principalType: 'Group', principalId: GC }], groupInfo: { [GC]: { id: GC, displayName: 'Created', description: 'Fresh' } }, members: { [GC]: [{ id: U1 }, NEW_MEMBER] } },
    groupCreatedBare: { assignments: [{ principalType: 'Group', principalId: GC }] },
    groupCreatedWithoutAName: { assignments: [{ principalType: 'Group', principalId: GC }], groupInfo: { [GC]: { id: GC } } },
    groupCreateFails: { assignments: [{ principalType: 'Group', principalId: GC }], createGroupFails: true },
    legacyGroupBound: { assignments: [{ principalType: 'Group', principalId: GC }], groups: [...GROUPS, { id: 'legacy-c', organizationId: 'B', azureGroupId: GC.toUpperCase(), source: 'azure', name: 'Legacy C' }], members: { [GC]: [{ id: U1 }] } },
    legacyGroupBindFails: { assignments: [{ principalType: 'Group', principalId: GC }], groups: [...GROUPS, { id: 'legacy-c', organizationId: 'B', azureGroupId: GC, source: 'azure' }], updateGroupFails: 'legacy-c' },
    legacyGroupAmbiguous: { assignments: [{ principalType: 'Group', principalId: GC }], groups: [...GROUPS, { id: 'legacy-c1', organizationId: 'B', azureGroupId: GC, source: 'azure' }, { id: 'legacy-c2', organizationId: 'B', azureGroupId: GC, source: 'azure' }] },
    legacyGroupOfAnotherOrganisation: { assignments: [{ principalType: 'Group', principalId: GC }], groups: [...GROUPS, { id: 'legacy-c', organizationId: 'A', azureGroupId: GC, source: 'azure' }, { id: 'manual-c', organizationId: 'B', azureGroupId: GC, source: 'manual' }, { id: 'bound-c', organizationId: 'B', azureTenantId: OTHER_TID, azureGroupId: GC, source: 'azure' }] },
    // members
    memberInvalid: { assignments: [{ principalType: 'Group', principalId: GA }], members: { [GA]: [{ id: 'nope' }, { id: 7 }, {}, { id: U1 }] } },
    memberKnown: { assignments: [{ principalType: 'Group', principalId: GB }], members: { [GB]: [{ id: U2 }] } },
    memberKnownWithAnotherAccountsMail: { assignments: [{ principalType: 'Group', principalId: GB }], members: { [GB]: [{ id: U2, mail: 'legacy@example.test' }] } },
    memberSpelledInCapitals: { assignments: [{ principalType: 'Group', principalId: GA }], members: { [GA]: [{ id: UE.toUpperCase() }] }, users: [...USERS, USER_E], settings: { destructiveSync: true } },
    memberStoredInCapitals: { assignments: [{ principalType: 'Group', principalId: GA }], members: { [GA]: [{ id: UE }] }, users: [...USERS, { ...USER_E, azureUserId: UE.toUpperCase() }] },
    memberOutsideTheOrganisation: { assignments: [{ principalType: 'Group', principalId: GA }], members: { [GA]: [{ id: U3 }] }, users: USERS.map((u) => (u.id === 'u3' ? { ...u, groups: ['manual-A'] } : u)) },
    memberInOrganisationThroughAManagedGroup: { assignments: [{ principalType: 'Group', principalId: GB }], members: { [GB]: [{ id: U3 }] } },
    memberUnboundIdentity: { assignments: [{ principalType: 'Group', principalId: GA }], members: { [GA]: [{ id: U5, mail: 'x@example.test' }] }, unbound: { [U5]: [{ id: 'old' }] } },
    memberKnownByMail: { assignments: [{ principalType: 'Group', principalId: GA }], members: { [GA]: [{ id: U5, mail: 'legacy@example.test' }] } },
    memberKnownByPrincipalName: { assignments: [{ principalType: 'Group', principalId: GA }], members: { [GA]: [{ id: U5, userPrincipalName: 'legacy@example.test' }] } },
    memberNew: { assignments: [{ principalType: 'Group', principalId: GA }], members: { [GA]: [NEW_MEMBER] } },
    memberNewBare: { assignments: [{ principalType: 'Group', principalId: GA }], members: { [GA]: [{ id: U5 }] } },
    memberNewByPrincipalName: { assignments: [{ principalType: 'Group', principalId: GA }], members: { [GA]: [{ id: U5, userPrincipalName: 'upn@example.test' }] } },
    memberNewMailBeforePrincipalName: { assignments: [{ principalType: 'Group', principalId: GA }], members: { [GA]: [{ id: U5, mail: 'new@example.test', userPrincipalName: 'legacy@example.test' }] } },
    memberNewPending: { assignments: [{ principalType: 'Group', principalId: GA }], members: { [GA]: [NEW_MEMBER] }, settings: { autoActivateUsers: false } },
    memberNewOverTheSeatLimit: { assignments: [{ principalType: 'Group', principalId: GA }, { principalType: 'Group', principalId: GB }], members: { [GA]: [NEW_MEMBER], [GB]: [{ id: U1 }] }, seatCap: true, settings: { destructiveSync: true } },
    membershipWriteFails: { assignments: [{ principalType: 'Group', principalId: GA }, { principalType: 'Group', principalId: GB }], members: { [GA]: [{ id: U1 }], [GB]: [{ id: U1 }] }, addThrows: true, settings: { destructiveSync: true } },
    // removal
    removalOff: { members: { [GA]: [], [GB]: [] } },
    removalOfDepartedMembers: { members: { [GA]: [{ id: U1 }], [GB]: [] }, settings: { destructiveSync: true } },
    removalFromGroupsNoLongerAssigned: { assignments: [{ principalType: 'Group', principalId: GB }], members: { [GB]: [{ id: U1 }] }, settings: { destructiveSync: true } },
    removalWithNoAssignments: { assignments: [], settings: { destructiveSync: true } },
    removalLeavesGroupsItDoesNotManage: { assignments: [], settings: { destructiveSync: true }, groups: [...GROUPS, { id: 'manual-with-azure-id', organizationId: 'B', azureTenantId: TID, azureGroupId: GC, source: 'manual' }, { id: 'azure-other-tenant', organizationId: 'B', azureTenantId: OTHER_TID, azureGroupId: GC, source: 'azure' }], users: [{ ...USERS[0], groups: ['manual-with-azure-id', 'azure-other-tenant'] }] },
    removalSkipsUsersOutsideTheOrganisation: { assignments: [], settings: { destructiveSync: true }, users: [{ ...USERS[2], groups: ['manual-A'] }, USERS[0]] },
    removalKeepsMembersSpelledInCapitals: { assignments: [{ principalType: 'Group', principalId: GA }], members: { [GA]: [{ id: U1.toUpperCase() }, { id: U2 }, { id: U3 }] }, settings: { destructiveSync: true } },
    removalHeldBackByAnError: { members: { [GA]: [{ id: 'nope' }], [GB]: [] }, settings: { destructiveSync: true } },
    removalUserListFails: { members: { [GA]: [], [GB]: [] }, settings: { destructiveSync: true }, getAllUsersThrows: true },
    removalWriteFails: { members: { [GA]: [], [GB]: [] }, settings: { destructiveSync: true }, removeThrows: true },
    statusWriteFails: { assignments: [], setConfigThrows: true },
};

/** @param {string} name */
async function runCase(name) {
    const w = CASES[name];
    /** @type {unknown[][]} */
    const calls = [];
    const record = (/** @type {string} */ what, /** @type {unknown[]} */ ...args) => { calls.push(JSON.parse(JSON.stringify([what, ...args], (_k, v) => (v === undefined ? '<undefined>' : v instanceof Set ? [...v] : v)))); };
    const groups = structuredClone(w.groups || GROUPS);
    const users = structuredClone(w.users || USERS);
    const before = structuredClone({ groups, users });
    const config = new Map(/** @type {[string, unknown][]} */ ([
        ['azure_group_sync_binding', 'binding' in w ? w.binding : { syncOrganizationId: 'B', syncTenantId: TID }],
        ['azure_group_sync_B', w.settings],
    ]));
    const userStore = {
        getAllGroups: async () => { record('users.getAllGroups'); return structuredClone(groups); },
        getAllUsers: async () => { record('users.getAllUsers'); if (w.getAllUsersThrows) throw new Error('user list unavailable'); return structuredClone(users); },
        getGroupByAzureId: async (/** @type {string} */ oid, /** @type {string} */ tenant, /** @type {string} */ org) => {
            record('users.getGroupByAzureId', oid, tenant, org);
            return structuredClone(groups.find((/** @type {any} */ g) => g.azureGroupId === oid && g.azureTenantId === tenant && g.organizationId === org));
        },
        getUserByAzureId: async (/** @type {string} */ oid, /** @type {string} */ tenant) => {
            record('users.getUserByAzureId', oid, tenant);
            // Whatever the spelling, as a case-insensitive lookup would.
            return structuredClone(users.find((/** @type {any} */ u) => String(u.azureUserId).toLowerCase() === oid.toLowerCase() && u.azureTenantId === tenant));
        },
        getUserByEmail: async (/** @type {string} */ email) => { record('users.getUserByEmail', email); return structuredClone(users.find((/** @type {any} */ u) => u.email === email)); },
        updateGroup: async (/** @type {string} */ id, /** @type {object} */ patch) => {
            record('users.updateGroup', id, patch);
            if (w.updateGroupFails === id) return false;
            Object.assign(groups.find((/** @type {any} */ g) => g.id === id), patch);
            return true;
        },
        createGroup: async (/** @type {object} */ group) => { record('users.createGroup', group); if (w.createGroupFails) return false; groups.push(structuredClone(group)); return true; },
        createUserWithSeatCheck: async (/** @type {object} */ user, /** @type {unknown} */ opts) => {
            record('users.createUserWithSeatCheck', user, opts);
            if (w.seatCap) return { created: false, reason: 'seat_cap' };
            users.push(structuredClone(user));
            return { created: true };
        },
    };
    const membershipStore = {
        add: async (/** @type {string} */ id, /** @type {{ id: string }} */ group, /** @type {string} */ oid) => {
            record('membership.add', id, group.id, oid);
            if (w.addThrows) throw new Error('membership write failed');
            const u = users.find((/** @type {any} */ x) => x.id === id);
            if (u && !u.groups.includes(group.id)) u.groups.push(group.id);
        },
        remove: async (/** @type {string} */ id, /** @type {{ id: string }} */ group, /** @type {string} */ oid) => {
            record('membership.remove', id, group.id, oid);
            if (w.removeThrows) throw new Error('membership write failed');
            const u = users.find((/** @type {any} */ x) => x.id === id);
            if (u) u.groups = u.groups.filter((/** @type {string} */ g) => g !== group.id);
        },
    };
    const principal = (/** @type {string} */ p) => p.split('/')[1].split('?')[0];
    const sync = createAzureGroupSync({
        userStore, membershipStore,
        configStore: {
            getConfigFresh: async (/** @type {string} */ key) => {
                record('config.getConfigFresh', key);
                const value = structuredClone(config.get(key));
                if (w.bindingUnderLock) config.set(key, w.bindingUnderLock); // the next read sees another binding
                return value;
            },
            getConfig: async (/** @type {string} */ key) => { record('config.getConfig', key); return structuredClone(config.get(key)); },
            setConfig: async (/** @type {string} */ key, /** @type {unknown} */ value) => { record('config.setConfig', key, value); if (w.setConfigThrows) throw new Error('config write failed'); config.set(key, structuredClone(value)); },
        },
        loadConfig: async () => { record('loadConfig'); return { providers: { microsoft: 'ms' in w ? w.ms : { clientId: 'app', clientSecret: 'stored-secret', tenantId: TID } } }; },
        withSyncLock: async (/** @type {() => Promise<unknown>} */ fn) => { record('lock.acquire'); try { return await fn(); } finally { record('lock.release'); } },
        findUnboundIdentity: async (/** @type {string} */ oid) => { record('findUnboundIdentity', oid); return (w.unbound && w.unbound[oid]) || []; },
        log: { warn: (/** @type {unknown[]} */ ...a) => record('log.warn', ...a) },
        graph: {
            getClientCredentialsToken: async (/** @type {unknown[]} */ ...a) => { record('graph.getClientCredentialsToken', a[0], a[1] ? '<secret>' : a[1], a[2]); if (w.tokenThrows) throw new Error('AADSTS7000215'); return 'token-1'; },
            getAppRoleAssignments: async (/** @type {unknown[]} */ ...a) => { record('graph.getAppRoleAssignments', ...a); if (w.assignmentsThrow) throw new Error('Graph 403'); return structuredClone(w.assignments || GROUP_ASSIGNMENTS); },
            graphGet: async (/** @type {string} */ p, /** @type {string} */ token) => {
                record('graph.graphGet', p, token);
                const id = principal(p);
                if (w.graphGetThrows === id) throw new Error('Graph 404');
                if (p.startsWith('groups/')) return (w.groupInfo && w.groupInfo[id]) || { id, displayName: `Group ${id.slice(0, 4)}` };
                return (w.userInfo && w.userInfo[id]) || { id };
            },
            getGroupMembers: async (/** @type {string} */ token, /** @type {string} */ id) => {
                record('graph.getGroupMembers', token, id);
                if (w.failGroup === id) throw new Error('partial Graph read');
                return structuredClone((w.members && w.members[id]) || []);
            },
        },
    });
    /** @type {Record<string, unknown>} */
    let outcome;
    try {
        outcome = { result: await sync.syncAzureGroupsToOrg(w.orgId || 'B') };
    } catch (err) {
        const e = /** @type {any} */ (err);
        outcome = { threw: { message: e.message, ...(e.status ? { status: e.status } : {}), ...(e.code ? { code: e.code } : {}) } };
    }
    // What changed: groups and users that differ from the start, by id.
    const changed = (/** @type {any[]} */ now, /** @type {any[]} */ then) => now.filter((row) => JSON.stringify(row) !== JSON.stringify(then.find((/** @type {any} */ t) => t.id === row.id)));
    return { ...outcome, calls, groupsChanged: changed(groups, before.groups), usersChanged: changed(users, before.users), status: config.get('azure_group_sync_status_B') ?? null };
}

test('syncAzureGroupsToOrg: result, collaborator calls and what is left behind per scenario match the golden file', async () => {
    /** @type {Record<string, unknown>} */
    const actual = {};
    for (const name of Object.keys(CASES)) actual[name] = await runCase(name);
    const text = `${JSON.stringify(actual, null, 1)}\n`;
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, text);
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    for (const name of Object.keys(CASES)) {
        assert.deepStrictEqual(JSON.parse(JSON.stringify(actual[name])), golden[name], `scenario ${name}`);
    }
    assert.deepStrictEqual(Object.keys(golden), Object.keys(CASES));
});
