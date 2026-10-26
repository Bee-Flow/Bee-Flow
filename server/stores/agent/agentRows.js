// @typecheck strict
/**
 * Agent row projections: the draft/published split (runtime vs draft view),
 * the persona strip, config parsing and the tool-parameter map.
 */

const { getAgentToolsWithParams } = require('./agentTools');

// The two published blobs never leave the store as-is: every read hands out
// ONE config / ONE system_prompt (the concept, or the published projection —
// see projectRuntime), so no API payload doubles in size and no client can
// pick the wrong one by accident. The scalar published_* columns
// (published_version / published_rev / published_at) DO pass through: they
// are what "Saved · v8" and "n unpublished changes" are computed from.
/**
 * @param {AgentDbRow} row
 * @returns {AgentDbRow}
 */
function _stripPublishedBlobs(row) {
    if (!row) return row;
    const { published_config, published_system_prompt, ...rest } = row;
    return rest;
}

// Does the runtime serve this row's published_* columns instead of its
// concept? Three conditions, all load-bearing:
//   - owner_id='system' agents (support singleton, system agents) have no
//     publish button and always follow live — PUT /api/support/agent must keep
//     reaching users.
//   - published_version > 0: an agent that was never published follows live
//     (new agents, and every existing agent until the A2 backfill runs).
//   - published_config IS NOT NULL: belt-and-braces against a half-written
//     row; a NULL blob can never be served as "the published config".
/** @param {AgentDbRow | null | undefined} row */
function isSplitActive(row) {
    if (!row) return false;
    if (row.owner_id === 'system' || row.owner_id === 'swarm') return false;
    if (!(Number(row.published_version) > 0)) return false;
    return row.published_config !== null && row.published_config !== undefined;
}

// Raw row → raw row whose config/system_prompt are what the RUNTIME must use,
// plus `runtimeSource: 'published' | 'live'` so a consumer (and a test) can
// tell which one it got. Applied BEFORE parseConfig.
/**
 * @param {AgentDbRow} row
 * @returns {AgentDbRow & { runtimeSource: 'published' | 'live' }}
 */
function projectRuntime(row) {
    if (!row) return row;
    if (!isSplitActive(row)) return { ..._stripPublishedBlobs(row), runtimeSource: 'live' };
    return {
        ..._stripPublishedBlobs(row),
        config: row.published_config,
        // A published row always carries its prompt (publish copies both), but
        // never serve NULL for a prompt that was '' at publish time.
        system_prompt: row.published_system_prompt ?? row.system_prompt,
        runtimeSource: 'published',
    };
}

// Same shape as projectRuntime, but the CONCEPT on purpose — the testchat
// (A4) runs what you are making, not what is published. Marked `'draft'` and
// never `'live'`: 'live' means "there is nothing published to differ from",
// and a screen that says "you are testing your concept" has to be able to tell
// those two apart. The published blobs are stripped here exactly as everywhere
// else, so asking for the draft never doubles the payload.
/**
 * @param {AgentDbRow} row
 * @returns {AgentDbRow & { runtimeSource: 'draft' }}
 */
function projectDraft(row) {
    if (!row) return row;
    return { ..._stripPublishedBlobs(row), runtimeSource: 'draft' };
}

// `persona` is an EDITOR artefact and leaves the store only where an editor
// asks for it (getAgent, getAgentViews().draft). parseConfig — which every
// list read and the runtime projection go through — strips the raw column, so
// a persona can never ride along by accident on a payload built from
// `SELECT *`: not the published library, not `GET /agents/:id` for someone who
// may only chat with the agent, not `getForRuntime`. Stripping here rather
// than deleting at each call site means a NEW reader inherits the narrow
// answer instead of the wide one.
/**
 * @param {AgentDbRow} row
 * @returns {AgentDbRow}
 */
function _stripPersona(row) {
    if (!row || !('persona' in row)) return row;
    const { persona, ...rest } = row;
    return rest;
}

/**
 * @param {AgentDbRow} row
 * @returns {ParsedAgent}
 */
function parseConfig(row) {
    const agent = _stripPersona(_stripPublishedBlobs(row));
    if (!agent) throw new TypeError('parseConfig needs an agent row');
    const config = agent.config ? (typeof agent.config === 'string' ? JSON.parse(agent.config) : agent.config) : {};
    // Legacy agents stored their picture inside config.avatar instead of the
    // dedicated column. Fall through on read so the UI keeps showing them
    // until a one-shot backfill migrates the values into the column.
    const avatar = agent.avatar || config.avatar || null;
    return {
        ...agent,
        avatar,
        config,
        shared_groups: (() => { try { return JSON.parse(agent.shared_groups || '[]'); } catch (_) { return []; } })()
    };
}

// Convert a list of { componentId, params } (from getAgentToolsWithParams or its
// batch variant) into the tool_params shape the API exposes:
//   { [componentId]: { [paramName]: { value, fixed: true } } }
/** @param {Array<{ componentId: string, params: object | null }>} toolsWithParams */
function buildToolParamsFromList(toolsWithParams) {
    /** @type {Record<string, Record<string, { value: unknown, fixed: true }>>} */
    const tool_params = {};
    for (const t of toolsWithParams) {
        if (t.params) {
            tool_params[t.componentId] = {};
            for (const [paramName, value] of Object.entries(t.params)) {
                tool_params[t.componentId][paramName] = { value, fixed: true };
            }
        }
    }
    return tool_params;
}

/** @param {string} agentId */
async function buildToolParams(agentId) {
    const toolsWithParams = await getAgentToolsWithParams(agentId);
    return buildToolParamsFromList(toolsWithParams);
}

module.exports = { _stripPublishedBlobs, isSplitActive, projectRuntime, projectDraft, _stripPersona, parseConfig, buildToolParamsFromList, buildToolParams };

/**
 * A raw `agents` row as the store reads it (`SELECT *`). The JSON columns are
 * TEXT on older installs and parsed objects on newer ones, hence `unknown`.
 * @typedef {{
 *   [column: string]: unknown,
 *   id: string,
 *   owner_id?: string,
 *   organization_id?: string | null,
 *   project_id?: string | null,
 *   system_prompt?: string | null,
 *   avatar?: string | null,
 *   config?: unknown,
 *   shared_groups?: string | null,
 *   persona?: unknown,
 *   published_config?: unknown,
 *   published_system_prompt?: string | null,
 *   published_version?: number | null,
 *   name?: string,
 *   description?: string | null,
 *   model?: string | null,
 *   rev?: number,
 *   is_published?: boolean,
 *   published_rev?: number | null,
 *   category_id?: string | null,
 *   starter_prompts?: unknown,
 *   threads_enabled?: boolean | null,
 *   copy_enabled?: boolean | null,
 *   workspace_enabled?: boolean | null,
 *   embed_enabled?: boolean | null,
 * }} AgentDbRow
 */

/**
 * An agent's parsed `config` column. Free-form JSON; these are the keys readers use.
 * @typedef {{
 *   [key: string]: unknown,
 *   tools?: unknown,
 *   avatar?: string | null,
 *   enabledIntegrations?: string[],
 *   memoryEnabled?: boolean,
 *   knowledge_base_ids?: string[],
 *   allowCopy?: boolean,
 * }} AgentConfig
 */

/**
 * An agents row after parseConfig: published blobs and persona stripped, `config`
 * parsed, `shared_groups` an array, `avatar` resolved.
 * @typedef {{
 *   [column: string]: unknown,
 *   id: string,
 *   owner_id?: string,
 *   organization_id?: string | null,
 *   project_id?: string | null,
 *   system_prompt?: string | null,
 *   avatar: string | null,
 *   config: AgentConfig,
 *   shared_groups: string[],
 *   published_version?: number | null,
 *   name?: string,
 *   description?: string | null,
 *   model?: string | null,
 *   rev?: number,
 *   is_published?: boolean,
 *   published_rev?: number | null,
 *   category_id?: string | null,
 *   starter_prompts?: unknown,
 *   threads_enabled?: boolean | null,
 *   copy_enabled?: boolean | null,
 *   workspace_enabled?: boolean | null,
 *   embed_enabled?: boolean | null,
 *   runtimeSource?: 'published' | 'live' | 'draft',
 * }} ParsedAgent
 */

/**
 * A parsed agent with its component tool grants attached (what getAgent and getForRuntime hand out).
 * @typedef {ParsedAgent & { tools: string[], tool_params: Record<string, Record<string, { value: unknown, fixed: true }>> }} AgentWithTools
 */
