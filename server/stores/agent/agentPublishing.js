// @typecheck strict
/**
 * Published agents: the gallery listings (all, per user's groups and orgs),
 * publishing a version to it, system agents and placeholders.
 */

const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./initSchema');
const { getAgentToolsBatch, getAgentToolsWithParamsBatch } = require('./agentTools');
const { projectRuntime, parseConfig, buildToolParamsFromList } = require('./agentRows');
const log = require('../../telemetry/log');

async function getPublishedAgents() {
    await initDB();
    const agents = await getAll("SELECT * FROM agents WHERE is_published = TRUE AND owner_id NOT IN ('system', 'swarm') ORDER BY name ASC");
    const twpByAgent = await getAgentToolsWithParamsBatch(agents.map(a => a.id));
    // The library is what users chat with → the runtime projection.
    return agents.map(agent => {
        const twp = twpByAgent.get(agent.id) || [];
        return { ...parseConfig(projectRuntime(agent)), tools: twp.map(t => t.componentId), tool_params: buildToolParamsFromList(twp) };
    });
}

/**
 * @param {string} id
 * @param {boolean | null | undefined} isPublished
 * @param {string} ownerId
 * @param {string[] | null | undefined} sharedGroups
 */
async function setAgentPublished(id, isPublished, ownerId, sharedGroups = undefined) {
    await initDB();
    // When sharedGroups is undefined, preserve the existing DB value — do NOT
    // overwrite with []. Previously a toggle-publish with no sharedGroups in the
    // request body silently wiped any group restrictions.
    let rowCount;
    if (sharedGroups === undefined) {
        ({ rowCount } = await run(
            'UPDATE agents SET is_published = $1, rev = rev + 1, updated_at = NOW() WHERE id = $2 AND owner_id = $3',
            [!!isPublished, id, ownerId]
        ));
    } else {
        ({ rowCount } = await run(
            'UPDATE agents SET is_published = $1, shared_groups = $2, rev = rev + 1, updated_at = NOW() WHERE id = $3 AND owner_id = $4',
            [!!isPublished, JSON.stringify(sharedGroups || []), id, ownerId]
        ));
    }
    return rowCount > 0;
}

/**
 * @param {string[]} userGroups
 * @param {string | null | undefined} userOrgId
 * @param {Set<string> | null | undefined} resolvedOrgIds
 */
async function getPublishedAgentsForUser(userGroups = [], userOrgId = null, resolvedOrgIds = null) {
    await initDB();
    // Defensive: exclude orphaned agents whose owner no longer exists (e.g. left
    // behind by a pre-fix user deletion) so they can't surface as ghost agents in
    // a re-created user's library (BFSF-181).
    const allPublished = await getAll("SELECT a.* FROM agents a WHERE a.is_published = TRUE AND a.owner_id NOT IN ('system', 'swarm') AND EXISTS (SELECT 1 FROM users u WHERE u.id = a.owner_id) ORDER BY a.name ASC");

    // Use pre-resolved org IDs if provided (from resolveUserOrgIds), otherwise build from params
    /** @type {Set<string>} */
    let userOrgIds;
    if (resolvedOrgIds instanceof Set) {
        userOrgIds = resolvedOrgIds;
    } else {
        // Pre-load group→org mapping
        const groupsData = await getAll('SELECT id, "organizationId" FROM groups');
        /** @type {Record<string, string | null>} */
        const groupOrgMap = {};
        for (const g of groupsData) { groupOrgMap[g.id] = g.organizationId || null; }

        userOrgIds = new Set();
        if (userOrgId) userOrgIds.add(userOrgId);
        for (const gid of userGroups) { const orgId = groupOrgMap[gid]; if (orgId) userOrgIds.add(orgId); }
    }
    const hasOrgMembership = userOrgIds.size > 0;

    const filtered = allPublished.filter(agent => {
        if (hasOrgMembership) {
            // Strict isolation: org users ONLY see agents belonging to their org(s)
            if (!agent.organization_id) return false;
            if (!userOrgIds.has(agent.organization_id)) return false;
        } else {
            // Users without any org only see global (non-org) agents
            if (agent.organization_id) return false;
        }
        /** @type {string[]} */
        let sharedGroups = [];
        // Unreadable restriction: fail closed. Treating it as "no restriction" would show the agent to the whole org.
        try { sharedGroups = JSON.parse(agent.shared_groups || '[]'); } catch (err) { log.warn('shared_groups is not valid JSON, hiding the agent', err); return false; }
        // If agent has group restrictions, user must be in at least one shared group
        if (sharedGroups.length > 0) return sharedGroups.some((sg) => userGroups.includes(sg));
        return true;
    });

    const twpByAgent = await getAgentToolsWithParamsBatch(filtered.map(a => a.id));
    // Same projection as getPublishedAgents: the library serves what runs.
    return filtered.map(agent => {
        const twp = twpByAgent.get(agent.id) || [];
        return { ...parseConfig(projectRuntime(agent)), tools: twp.map(t => t.componentId), tool_params: buildToolParamsFromList(twp) };
    });
}

async function getAllAgents() {
    await initDB();
    const agents = await getAll("SELECT * FROM agents WHERE owner_id NOT IN ('system', 'swarm') ORDER BY updated_at DESC");
    const toolsByAgent = await getAgentToolsBatch(agents.map(a => a.id));
    return agents.map(agent => ({ ...parseConfig(agent), tools: toolsByAgent.get(agent.id) || [] }));
}

async function getSystemAgents() {
    await initDB();
    const agents = await getAll("SELECT * FROM agents WHERE owner_id = 'system' ORDER BY name ASC");
    const toolsByAgent = await getAgentToolsBatch(agents.map(a => a.id));
    return agents.map(agent => ({ ...parseConfig(agent), tools: toolsByAgent.get(agent.id) || [] }));
}

/**
 * @param {string} id
 * @param {string} name
 * @param {string | null | undefined} description
 */
async function ensurePlaceholderAgent(id, name, description) {
    await initDB();
    const existing = await getOne('SELECT id FROM agents WHERE id = $1', [id]);
    if (!existing) {
        await run(`INSERT INTO agents (id, name, description, system_prompt, model, owner_id, is_published, created_at, updated_at)
            VALUES ($1,$2,$3,'','virtual','swarm',TRUE,NOW(),NOW())`, [id, name, description || 'Swarm Virtual Agent']);
    }
}

module.exports = { getPublishedAgents, setAgentPublished, getPublishedAgentsForUser, getAllAgents, getSystemAgents, ensurePlaceholderAgent };
