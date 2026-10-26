// @typecheck strict
/**
 * Reading agents: by owner, one row, and one agent with its tools and params.
 */

const { getOne, getAll } = require('../../db');
const { initDB } = require('./initSchema');
const { getAgentTools, getAgentToolsBatch } = require('./agentTools');
const log = require('../../telemetry/log');
const { parseConfig, buildToolParams } = require('./agentRows');

/** @param {string} ownerId */
async function getAgents(ownerId) {
    await initDB();
    const agents = await getAll("SELECT * FROM agents WHERE owner_id = $1 OR owner_id = 'system' ORDER BY updated_at DESC", [ownerId]);
    const toolsByAgent = await getAgentToolsBatch(agents.map(a => a.id));
    return agents.map(agent => ({ ...parseConfig(agent), tools: toolsByAgent.get(agent.id) || [] }));
}

// One load, three queries (row + component tools + their fixed params) —
// every agent-by-id read goes through this so a caller that needs BOTH views
// (GET /agents/:id) does not pay for the row twice, and both views are
// guaranteed to describe the SAME snapshot.
/** @param {string} id */
async function _loadAgentRow(id) {
    await initDB();
    const row = await getOne('SELECT * FROM agents WHERE id = $1', [id]);
    if (!row) return null;
    const tools = await getAgentTools(id);
    const tool_params = await buildToolParams(id);
    return { row, tools, tool_params };
}

/**
 * Attach the projected persona — and, when the projection is unavailable,
 * attach NOTHING.
 *
 * Lazy + guarded because a read of the agents table must not become the thing
 * that takes a chat turn down over a role field. The key is OMITTED rather
 * than set to null on failure, and that is the whole point of the helper: a
 * client re-syncs from this payload and sends it back, so a `persona: null`
 * born from a failed read would come back as an explicit "clear the column"
 * and delete a role nobody touched. A missing key means "preserve" all the way
 * down to the SET list.
 */
/**
 * @template {object} B
 * @param {B} base
 * @param {AgentDbRow} row
 * @returns {B & { persona?: unknown }}
 */
function _withPersona(base, row) {
    try {
        return { ...base, persona: require('../../core/agentRuntime/personaPrompt').personaOf(row) };
    } catch (e) {
        log.warn(`[AgentCrud] persona projection unavailable for agent ${row?.id}:`, /** @type {Error} */ (e).message);
        return base;
    }
}

/**
 * The CONCEPT view of one agent — what the editor edits and what every write
 * path reads before it writes. Carries `persona` (the structured role); the
 * runtime views deliberately do not. See `_stripPersona` and `personaOf`.
 * @param {string} id
 */
async function getAgent(id) {
    const loaded = await _loadAgentRow(id);
    if (!loaded) return null;
    return {
        ..._withPersona(parseConfig(loaded.row), loaded.row),
        tools: loaded.tools,
        tool_params: loaded.tool_params,
    };
}

module.exports = { getAgents, _loadAgentRow, _withPersona, getAgent };

/** @typedef {import('../../routes/agents/crud').AgentRow} AgentRow */

/** @typedef {import('./agentRows').AgentDbRow} AgentDbRow */
