// @typecheck
/**
 * Agent Tools - Manage which components an agent can use + param configs
 */

const { v4: uuidv4 } = require('uuid');
const { run, getAll, getOne } = require('../../db');
const { initDB } = require('./initSchema');
const log = require('../../telemetry/log');

async function addAgentTool(agentId, componentId, params = null) {
    await initDB();
    const id = uuidv4();
    log.info('[AgentTools] Adding tool:', componentId, 'with params:', params);
    await run('INSERT INTO agent_tools (id, agent_id, component_id, params_json) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [id, agentId, componentId, params ? JSON.stringify(params) : null]);
}

async function removeAgentTool(agentId, componentId) {
    await initDB();
    await run('DELETE FROM agent_tools WHERE agent_id = $1 AND component_id = $2', [agentId, componentId]);
}

async function getAgentTools(agentId) {
    await initDB();
    const rows = await getAll('SELECT component_id, params_json FROM agent_tools WHERE agent_id = $1', [agentId]);
    return rows.map(row => row.component_id);
}

async function getAgentToolsWithParams(agentId) {
    await initDB();
    const rows = await getAll('SELECT component_id, params_json FROM agent_tools WHERE agent_id = $1', [agentId]);
    return rows.map(row => ({
        componentId: row.component_id,
        params: row.params_json ? JSON.parse(row.params_json) : null
    }));
}

// ── Batch loaders (avoid N+1 when hydrating agent lists) ─────────────────────
// Both return a Map keyed by agent_id with an entry for EVERY requested id
// (empty array when an agent has no tools), so callers can do `map.get(id)`
// without null checks. Single query via `= ANY($1)` instead of one-per-agent.

async function getAgentToolsBatch(agentIds) {
    await initDB();
    const map = new Map();
    if (!Array.isArray(agentIds) || agentIds.length === 0) return map;
    for (const id of agentIds) map.set(id, []);
    const rows = await getAll('SELECT agent_id, component_id FROM agent_tools WHERE agent_id = ANY($1::text[])', [agentIds]);
    for (const row of rows) {
        const arr = map.get(row.agent_id);
        if (arr) arr.push(row.component_id); else map.set(row.agent_id, [row.component_id]);
    }
    return map;
}

async function getAgentToolsWithParamsBatch(agentIds) {
    await initDB();
    const map = new Map();
    if (!Array.isArray(agentIds) || agentIds.length === 0) return map;
    for (const id of agentIds) map.set(id, []);
    const rows = await getAll('SELECT agent_id, component_id, params_json FROM agent_tools WHERE agent_id = ANY($1::text[])', [agentIds]);
    for (const row of rows) {
        const entry = { componentId: row.component_id, params: row.params_json ? JSON.parse(row.params_json) : null };
        const arr = map.get(row.agent_id);
        if (arr) arr.push(entry); else map.set(row.agent_id, [entry]);
    }
    return map;
}

/**
 * Store-level lock on a managed agent's tool grants (design 5.2: `tools` is not
 * on ALLOWED.agent). The route gate (agentCrud.assertAgentToolsWrite) runs first;
 * this is the second line, so a tools-only write that skips the route cannot
 * reach the table. Diff-based: an unchanged list passes. An agent without a
 * project reads nothing.
 *
 * @param {string} agentId
 * @param {(current: Array<{ componentId: string, params: object|null }>) => Array<{ componentId: string, params?: object|null }>} nextOf
 * @param {{ deploymentId?: string }|null} managedWrite
 */
async function assertToolsWriteAllowed(agentId, nextOf, managedWrite) {
    const managedParts = require('../lib/managedParts');
    const row = await getOne('SELECT project_id FROM agents WHERE id = $1', [agentId]);
    const projectId = row && row.project_id;
    if (!projectId || !(await managedParts.managedInfo(projectId))) return;
    const current = await getAgentToolsWithParams(agentId);
    const asMap = (list) => Object.fromEntries((list || []).map((t) => [t.componentId, t.params || null]));
    if (managedParts.changedKeysOf({ tools: asMap(current) }, { tools: asMap(nextOf(current)) }).length === 0) return;
    await managedParts.assertManagedWrite({ kind: 'agent', projectId, changedKeys: ['tools'], managedWrite });
}

async function updateAgentToolParams(agentId, componentId, params, { managedWrite = null } = {}) {
    await initDB();
    await assertToolsWriteAllowed(agentId, (current) => current.map((t) => (
        t.componentId === componentId ? { componentId, params: params || null } : t)), managedWrite);
    await run('UPDATE agent_tools SET params_json = $1 WHERE agent_id = $2 AND component_id = $3', [params ? JSON.stringify(params) : null, agentId, componentId]);
}

async function setAgentTools(agentId, componentIds, toolParams = {}, { managedWrite = null } = {}) {
    await initDB();
    await assertToolsWriteAllowed(agentId, () => componentIds.map((componentId) => ({
        componentId, params: toolParams[componentId] || null })), managedWrite);
    await run('DELETE FROM agent_tools WHERE agent_id = $1', [agentId]);
    for (const componentId of componentIds) {
        const params = toolParams[componentId] || null;
        await addAgentTool(agentId, componentId, params);
    }
}

module.exports = {
    addAgentTool, removeAgentTool, getAgentTools,
    getAgentToolsWithParams, updateAgentToolParams, setAgentTools,
    getAgentToolsBatch, getAgentToolsWithParamsBatch,
};
