// @typecheck strict
/**
 * Organisation-wide agent maintenance: dropping a deleted skill from every
 * agent, and moving an agent to a new owner.
 */

const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./initSchema');
const managedParts = require('../managedPartsDefault');
const { buildUpdate } = require('../lib/sqlBuilder');
const { _notifySync } = require('./agentSync');

const SCRUB_COLUMNS = {
    config: { col: 'config', transform: (/** @type {unknown} */ v) => JSON.stringify(v) },
    publishedConfig: { col: 'published_config', cast: 'jsonb', transform: (/** @type {unknown} */ v) => JSON.stringify(v) },
};

// Remove a skill id from every agent's config.attachedSkillIds — in the
// concept AND in published_config. The runtime reads the published copy once
// an agent is in split mode, so scrubbing only the concept would leave the
// deleted skill referenced by exactly the config that runs.
// Called when a skill is deleted so dangling references don't linger in agent configs.
/**
 * @param {string | null | undefined} orgId
 * @param {string | null | undefined} skillId
 */
async function scrubSkillFromAllAgents(orgId, skillId) {
    await initDB();
    if (!skillId) return 0;
    const query = orgId
        ? "SELECT id, config, published_config FROM agents WHERE organization_id = $1 AND (config::text LIKE $2 OR published_config::text LIKE $2)"
        : "SELECT id, config, published_config FROM agents WHERE config::text LIKE $1 OR published_config::text LIKE $1";
    const params = orgId ? [orgId, `%${skillId}%`] : [`%${skillId}%`];
    const rows = await getAll(query, params);
    let scrubbed = 0;
    /** @param {string} raw */
    const without = (raw) => {
        let cfg;
        try { cfg = typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch (_) { cfg = {}; }
        const ids = Array.isArray(cfg.attachedSkillIds) ? cfg.attachedSkillIds : null;
        if (!ids || !ids.includes(skillId)) return null;
        return { ...cfg, attachedSkillIds: ids.filter((/** @type {string} */ x) => x !== skillId) };
    };
    for (const row of rows) {
        const cfg = without(row.config);
        const pub = row.published_config == null ? null : without(row.published_config);
        if (!cfg && !pub) continue;
        // The published copy is patched in place, not re-published: a skill
        // deletion is a hotfix of what runs, not a new version of the agent.
        const built = buildUpdate({
            table: 'agents',
            updates: { config: cfg ?? undefined, publishedConfig: pub ?? undefined },
            columnMap: SCRUB_COLUMNS,
            extraSet: ['rev = rev + 1', 'updated_at = NOW()'],
            where: [{ col: 'id', value: row.id }],
        });
        if (!built) continue;
        await run(built.sql, built.params);
        scrubbed++;
    }
    return scrubbed;
}

/**
 * Reassign an agent's owner. Returns true on success, false if the agent
 * doesn't exist or the new owner isn't in the agent's org (caller is
 * responsible for that check too; we double-check here as a safety net).
 *
 * @param {string} agentId
 * @param {string} newOwnerId
 * @param {string} expectedOrgId  agent.organization_id (refuses if mismatch)
 */
async function transferAgentOwner(agentId, newOwnerId, expectedOrgId) {
    await initDB();
    const agent = await getOne('SELECT organization_id, project_id FROM agents WHERE id = $1', [agentId]);
    if (!agent) return false;
    // A managed agent runs as the stage's run-as user: ownership is never
    // handed over on a stage, not even by a deploy (no capability is passed).
    if (agent.project_id) {
        await managedParts.assertManagedWrite({ kind: 'agent', projectId: agent.project_id, changedKeys: ['ownerId'] });
    }
    if (expectedOrgId && agent.organization_id && agent.organization_id !== expectedOrgId) {
        return false;
    }
    const { rowCount } = await run(
        'UPDATE agents SET owner_id = $1, rev = rev + 1, updated_at = NOW() WHERE id = $2',
        [newOwnerId, agentId]
    );
    if (rowCount > 0 && agent.organization_id) _notifySync(agent.organization_id, agentId);
    return rowCount > 0;
}

module.exports = { scrubSkillFromAllAgents, transferAgentOwner };
