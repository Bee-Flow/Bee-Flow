// @typecheck strict
/**
 * The steps of one Azure directory sync (azureGroupSync.js runs them under
 * the sync lock, after the binding check): the directory snapshot, then the
 * groups and their members, then the removals. The order is the safety rule:
 * the complete snapshot is read before anything is written, and nothing is
 * removed before every read AND every provisioning step has succeeded.
 */

'use strict';

const crypto = require('crypto');

const { isMemberOfOrg } = require('../auth/orgMembership');
const { GUID } = require('../auth/microsoftIdentity');

/**
 * @typedef {{ principalType?: string, principalId: string }} Assignment  one app-role assignment; the id is checked before use
 * @typedef {{ id?: string, displayName?: string, description?: string }} GroupInfo
 * @typedef {{ id?: unknown, mail?: string, userPrincipalName?: string, displayName?: string, givenName?: string, surname?: string }} Member
 * @typedef {{ assignment: Assignment, info?: GroupInfo, members: Member[] }} DirectoryEntry
 * @typedef {{ id: string, source?: string, organizationId?: string | null, azureTenantId?: string | null, azureGroupId?: string | null, name?: string }} Group
 * @typedef {{ id: string, organizationId?: string | null, groups?: string | string[] | null, azureTenantId?: string | null, azureUserId?: string | null }} User
 * @typedef {{ group: Group, memberIds: Set<string | null | undefined> }} Cleanup  a group and who the directory says is in it
 * @typedef {{
 *   getAllGroups(): Promise<Group[]>,
 *   getAllUsers(): Promise<User[]>,
 *   getGroupByAzureId(oid: string, tenantId: string, orgId: string): Promise<Group | null | undefined>,
 *   getUserByAzureId(oid: string, tenantId: string): Promise<User | null | undefined>,
 *   getUserByEmail(email: string): Promise<unknown>,
 *   updateGroup(id: string, patch: Record<string, unknown>): Promise<unknown>,
 *   createGroup(group: Record<string, unknown>): Promise<unknown>,
 *   createUserWithSeatCheck(user: Record<string, unknown>, opts: { strict: boolean }): Promise<{ created?: boolean, reason?: string }>,
 * }} SyncUserStore
 * @typedef {{
 *   getClientCredentialsToken(clientId: string, clientSecret: string, tenantId: string): Promise<string>,
 *   getAppRoleAssignments(token: string, clientId: string): Promise<Array<{ principalType?: unknown, principalId?: unknown }>>,
 *   graphGet(path: string, token: string): Promise<unknown>,
 *   getGroupMembers(token: string, groupId: string): Promise<Array<{ id?: unknown }>>,
 * }} Graph
 * @typedef {{
 *   userStore: SyncUserStore,
 *   membershipStore: { add(userId: string, group: Group, oid: string): Promise<unknown>, remove(userId: string, group: Group, oid: string | null | undefined): Promise<unknown> },
 *   findUnboundIdentity(oid: string): Promise<unknown[]>,
 *   loadConfig(): Promise<{ providers: { microsoft?: { clientId?: string, clientSecret?: string, tenantId?: string } } }>,
 *   graph: Graph,
 * }} SyncDeps
 * @typedef {{ orgId: string, tenantId: string, settings: { destructiveSync?: boolean, autoActivateUsers?: boolean },
 *   details: string[], errors: string[], syncedGroups: number, syncedUsers: number, allGroups: Group[], managed: Group[] }} SyncRun
 *   one sync: its target, what it reports and the local groups it read
 */

/**
 * One assigned principal as the directory has it now: a group with its
 * members, a user as a single member, nothing for another kind.
 * @param {Graph} graph
 * @param {string} token
 * @param {Assignment} assignment
 * @returns {Promise<DirectoryEntry | null>}
 */
async function readPrincipal(graph, token, assignment) {
    if (assignment.principalType === 'Group') {
        const info = /** @type {GroupInfo} */ (await graph.graphGet(`groups/${assignment.principalId}?$select=id,displayName,description`, token));
        if (info.id?.toLowerCase() !== assignment.principalId.toLowerCase()) throw new Error('Graph group identity mismatch');
        return { assignment, info, members: await graph.getGroupMembers(token, assignment.principalId) };
    }
    if (assignment.principalType === 'User') {
        const member = /** @type {{ id?: string }} */ (await graph.graphGet(`users/${assignment.principalId}?$select=id,displayName,givenName,surname,mail,userPrincipalName`, token));
        if (member.id?.toLowerCase() !== assignment.principalId.toLowerCase()) throw new Error('Graph user identity mismatch');
        return { assignment, members: [member] };
    }
    return null;
}

/**
 * Read the complete snapshot before any destructive action. A principal that
 * cannot be read is an error on the run, which holds every removal back.
 * @param {Graph} graph
 * @param {string} token
 * @param {Assignment[]} assignments
 * @param {string[]} errors
 */
async function readDirectory(graph, token, assignments, errors) {
    /** @type {DirectoryEntry[]} */
    const directory = [];
    for (const assignment of assignments) {
        try {
            if (!GUID.test(assignment.principalId || '')) throw new Error('Invalid Graph principal ID');
            const entry = await readPrincipal(graph, token, assignment);
            if (entry) directory.push(entry);
        } catch (err) { errors.push(`Directory read failed for ${assignment.principalId}: ${err.message}`); }
    }
    return directory;
}

/**
 * A group this organisation synced before groups carried their tenant: bind
 * it to the tenant instead of creating a second one. The concrete directory
 * read verifies provenance.
 * @param {SyncUserStore} userStore
 * @param {SyncRun} run
 * @param {string} oid
 * @returns {Promise<Group | null>}
 */
async function adoptLegacyGroup(userStore, { allGroups, orgId, tenantId }, oid) {
    const legacy = allGroups.filter(g => g.source === 'azure' && g.organizationId === orgId && !g.azureTenantId && g.azureGroupId?.toLowerCase() === oid.toLowerCase());
    if (legacy.length > 1) throw new Error(`Ambiguous legacy Azure group ${oid}; administrator review required`);
    if (legacy.length !== 1) return null;
    if (!await userStore.updateGroup(legacy[0].id, { azureTenantId: tenantId, azureGroupId: oid })) throw new Error(`Could not bind legacy Azure group ${oid}`);
    return { ...legacy[0], azureTenantId: tenantId, azureGroupId: oid };
}

/**
 * The local group of a directory group: the bound one (or a legacy one,
 * bound now) with its name and description refreshed, else a new one.
 * @param {SyncUserStore} userStore
 * @param {SyncRun} run
 * @param {DirectoryEntry & { info: GroupInfo }} entry
 */
async function resolveGroup(userStore, run, entry) {
    const { orgId, tenantId } = run;
    const oid = entry.assignment.principalId;
    let group = await userStore.getGroupByAzureId(oid, tenantId, orgId);
    if (!group) group = await adoptLegacyGroup(userStore, run, oid);
    if (!group) {
        const id = `azure-${crypto.createHash('sha256').update(`${orgId}:${tenantId}:${oid}`).digest('hex').slice(0, 24)}`;
        const created = await userStore.createGroup({ id, organizationId: orgId, azureTenantId: tenantId, azureGroupId: oid,
            name: entry.info.displayName || oid, description: entry.info.description || '', source: 'azure', permissions: ['read', 'chat'], roles: [], lastSyncedAt: new Date().toISOString() });
        if (!created) throw new Error(`Could not create Azure group ${oid}`);
        group = await userStore.getGroupByAzureId(oid, tenantId, orgId);
    } else if (!await userStore.updateGroup(group.id, { name: entry.info.displayName || group.name, description: entry.info.description || '', lastSyncedAt: new Date().toISOString() })) throw new Error(`Could not update Azure group ${oid}`);
    run.syncedGroups++;
    return group;
}

/**
 * Why a directory member is left alone, if it is: an identity that an
 * administrator has to confirm first (a legacy Microsoft identity, or an
 * account that is only known by its e-mail address), or a known user who is
 * not a member of the sync organisation.
 * @param {SyncDeps} deps
 * @param {SyncRun} run
 * @param {{ member: Member & { id: string }, user: User | null | undefined, email: string }} who
 * @returns {Promise<string | null>}
 */
async function skipReason({ userStore, findUnboundIdentity }, run, { member, user, email }) {
    if (!user && (await findUnboundIdentity(member.id)).length) {
        return `Skipped ${member.id}: legacy Microsoft identity requires administrator confirmation`;
    }
    if (!user && email) {
        const legacy = await userStore.getUserByEmail(email);
        if (legacy) return `Skipped ${member.id}: Microsoft identity requires administrator confirmation`;
    }
    if (user && !isMemberOfOrg(user, [...run.allGroups, ...run.managed], run.orgId)) {
        return `Skipped ${member.id}: user is not an authorized member of the sync organization`;
    }
    return null;
}

/**
 * A directory member nobody here knows yet: an account (seat check included)
 * and, for a group's member, the membership.
 * @param {SyncDeps} deps
 * @param {SyncRun} run
 * @param {{ member: Member & { id: string }, email: string, group: Group | null | undefined }} who
 */
async function provisionUser({ userStore, membershipStore }, run, { member, email, group }) {
    const { orgId, tenantId, settings } = run;
    const id = `azure-${tenantId}-${member.id}`;
    const result = await userStore.createUserWithSeatCheck({ id, username: email || id,
        displayName: member.displayName || id, firstName: member.givenName || '', lastName: member.surname || '', email,
        organizationId: orgId, azureTenantId: tenantId, azureUserId: member.id, role: 'user',
        groups: [], orgRole: '', status: settings.autoActivateUsers ? 'active' : 'pending', passwordHash: '' }, { strict: false });
    if (!result.created) { run.errors.push(`User ${member.id} was not provisioned (${result.reason})`); return; }
    if (group) await membershipStore.add(id, group, member.id);
    run.syncedUsers++;
}

/**
 * One member of a directory entry.
 * @param {SyncDeps} deps
 * @param {SyncRun} run
 * @param {Member} rawMember
 * @param {Group | null | undefined} group  the entry's group; none for a directly assigned user
 */
async function syncMember(deps, run, rawMember, group) {
    const member = { ...rawMember, id: typeof rawMember.id === 'string' ? rawMember.id.toLowerCase() : null };
    if (!GUID.test(member.id || '')) { run.errors.push('Directory returned an invalid user object ID'); return; }
    const known = /** @type {Member & { id: string }} */ (member);
    const user = await deps.userStore.getUserByAzureId(known.id, run.tenantId);
    const email = member.mail || member.userPrincipalName || '';
    const skipped = await skipReason(deps, run, { member: known, user, email });
    if (skipped) { run.details.push(skipped); return; }
    if (!user) await provisionUser(deps, run, { member: known, email, group });
    else if (group) await deps.membershipStore.add(user.id, group, known.id);
}

/**
 * One directory entry: its group, then its members. Answers what the removal
 * pass needs of it, when it has a group.
 * @param {SyncDeps} deps
 * @param {SyncRun} run
 * @param {DirectoryEntry} entry
 * @returns {Promise<Cleanup | null>}
 */
async function syncEntry(deps, run, entry) {
    let group = null;
    if (entry.info) group = await resolveGroup(deps.userStore, run, { ...entry, info: entry.info });
    const memberIds = new Set(entry.members.map(m => typeof m.id === 'string' ? m.id.toLowerCase() : null));
    for (const rawMember of entry.members) await syncMember(deps, run, rawMember, group);
    return group ? { group, memberIds } : null;
}

/**
 * Remove the memberships the directory no longer has, from the groups it
 * still assigns and from the managed groups it no longer does. Every local
 * read is resolved before removing anything. Local group ids, shared
 * resources and manual grants are preserved on upgrade.
 * @param {SyncDeps} deps
 * @param {SyncRun} run
 * @param {Cleanup[]} cleanup
 * @param {Set<string>} assignedIds
 */
async function removeDeparted({ userStore, membershipStore }, run, cleanup, assignedIds) {
    for (const group of run.managed) if (!assignedIds.has(/** @type {string} */ (group.azureGroupId))) cleanup.push({ group, memberIds: new Set() });
    const users = await userStore.getAllUsers();
    for (const { group, memberIds } of cleanup) {
        for (const user of users) {
            if (user.azureTenantId !== run.tenantId || !isMemberOfOrg(user, run.allGroups, run.orgId)) continue;
            if (!memberIds.has(user.azureUserId)) await membershipStore.remove(user.id, group, user.azureUserId);
        }
    }
}

/**
 * The sync itself, from the Microsoft credentials to the removals. Throws the
 * failure that ends it; `run` holds what was done until then.
 * @param {SyncDeps} deps
 * @param {SyncRun} run
 */
async function syncDirectory(deps, run) {
    const { orgId, tenantId, settings, errors } = run;
    const { graph, userStore } = deps;
    const ms = (await deps.loadConfig()).providers.microsoft || {};
    if (!ms.clientId || !ms.clientSecret) throw new Error('Configure Microsoft SSO credentials first');
    if (GUID.test(ms.tenantId || '') && /** @type {string} */ (ms.tenantId).toLowerCase() !== tenantId) throw new Error('Azure sync tenant differs from the Microsoft SSO tenant');
    const token = await graph.getClientCredentialsToken(ms.clientId, ms.clientSecret, tenantId);
    const assignments = /** @type {Assignment[]} */ ((await graph.getAppRoleAssignments(token, ms.clientId)).map(assignment => ({ ...assignment,
        principalId: typeof assignment.principalId === 'string' ? assignment.principalId.toLowerCase() : assignment.principalId })));
    const directory = await readDirectory(graph, token, assignments, errors);
    run.allGroups = await userStore.getAllGroups();
    run.managed = run.allGroups.filter(g => g.source === 'azure' && g.organizationId === orgId && g.azureTenantId === tenantId);
    const assignedIds = new Set(assignments.filter(a => a.principalType === 'Group').map(a => a.principalId));
    /** @type {Cleanup[]} */
    const cleanup = [];
    for (const entry of directory) {
        const done = await syncEntry(deps, run, entry);
        if (done) cleanup.push(done);
    }
    // No removal before all reads AND provisioning have succeeded.
    if (settings.destructiveSync && !errors.length) await removeDeparted(deps, run, cleanup, assignedIds);
}

module.exports = { syncDirectory };
