'use strict';
/**
 * Who a project chat answer is visible to, and which agents it may answer as.
 *
 * Split from chatAssistant.js, which re-exports all three: a chat answer is read by the
 * whole project, so both questions are about the audience, not about producing an answer.
 */

const log = require('../telemetry/log');

/** Past this many people the audience is not expanded: unknown narrows. */
const AUDIENCE_CAP = 200;

/**
 * The people a chat answer is visible to: the project owner, the members it
 * is shared with, and the members of the groups it is shared with. Null when
 * that cannot be known exactly (a lookup failed, or more than AUDIENCE_CAP
 * people): the caller then narrows to what everyone can read for certain.
 *
 * @param {{ id: string, ownerId?: string|null }} project
 * @param {{ getProjectShares?: Function, groupMemberIds?: Function }} [deps]
 * @returns {Promise<string[]|null>}
 */
async function listProjectAudience(project, deps = {}) {
    const getProjectShares = deps.getProjectShares || ((id) => require('../stores/projectStore').getProjectShares(id));
    const groupMemberIds = deps.groupMemberIds
        || ((groupId, cap) => require('../core/automationRunner/approvalLifecycle').groupMemberIds(groupId, cap));
    try {
        const ownerId = project?.ownerId || null;
        const ids = new Set(ownerId ? [ownerId] : []);
        for (const share of (await getProjectShares(project.id)) || []) {
            if (share.sharedWithType === 'user' && share.sharedWithId) ids.add(share.sharedWithId);
            else if (share.sharedWithType === 'group' && share.sharedWithId) {
                const members = await groupMemberIds(share.sharedWithId, AUDIENCE_CAP + 1);
                if (!members || members.total > AUDIENCE_CAP) return null;
                for (const id of members.ids) ids.add(id);
            }
            if (ids.size > AUDIENCE_CAP) return null;
        }
        return ids.size > 0 ? [...ids] : null;
    } catch (err) {
        log.warn(`[ProjectChat] project audience of ${project && project.id} unknown: ${err && err.message}`);
        return null;
    }
}

/**
 * The agents a project chat may answer as: ones EVERY member of the project
 * may use, never a system agent. A chat answer is read by the whole project,
 * so an agent one member owns as a draft, or shares with a group the others
 * are not in, is not a choice. An audience we cannot list (too large, or a
 * lookup failed) narrows to agents published organisation-wide.
 *
 * @param {object} project
 * @param {{ userId: string }} p  the member choosing
 * @param {object} [deps]
 * @returns {Promise<Array<{ id: string, name: string, icon?: string }>>}
 */
async function listChatAgents(project, { userId }, deps = {}) {
    const agentStore = deps.agentStore || require('../stores/agentStore');
    const getUser = deps.getUser || ((id) => require('../stores/userStore').getUser(id));
    const resolveUserGroups = deps.resolveUserGroups || ((id) => require('../auth/audience').resolveUserGroups(id));
    const audienceOf = deps.listAudience || ((proj) => listProjectAudience(proj));
    const { mayRoutineUseAgent } = require('../automation/agentCatalog');
    const SYSTEM_OWNERS = ['system', 'swarm'];

    const identityOf = async (id) => {
        const user = await getUser(id);
        return { userId: id, orgId: user?.organizationId || null, groups: (await resolveUserGroups(id)) || [] };
    };
    const me = await identityOf(userId);
    const [own, published] = await Promise.all([
        agentStore.getAgents(userId),
        agentStore.getPublishedAgentsForUser(me.groups, me.orgId),
    ]);
    const byId = new Map();
    for (const a of [...(own || []), ...(published || [])]) {
        if (a && a.id && !SYSTEM_OWNERS.includes(a.owner_id)) byId.set(a.id, a);
    }

    const audience = await audienceOf(project);
    let members = null;
    if (audience) {
        try { members = await Promise.all(audience.map(identityOf)); } catch (err) {
            log.warn(`[ProjectChat] members of ${project.id} unreadable for the agent list: ${err && err.message}`);
        }
    }
    const usable = [...byId.values()].filter((agent) => (members
        ? members.every((m) => mayRoutineUseAgent(agent, m))
        : agent.is_published && !(Array.isArray(agent.shared_groups) && agent.shared_groups.length)
            && mayRoutineUseAgent(agent, me)));
    return usable
        .map((a) => ({ id: a.id, name: a.name || a.id, icon: a.icon }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** Is this agent one the whole project may chat with? */
async function isChatAgentAllowed(project, { agentId, userId }, deps = {}) {
    const list = await (deps.listChatAgents || listChatAgents)(project, { userId }, deps);
    return list.some((a) => a.id === agentId);
}

module.exports = { listProjectAudience, listChatAgents, isChatAgentAllowed, AUDIENCE_CAP };
