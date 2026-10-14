// @typecheck
/**
 * The views of one agent the runtime and the Builder read: the published
 * runtime copy (tools clamped to what the owner still holds) or the draft,
 * with the persona attached.
 */

const log = require('../../telemetry/log');
const { projectRuntime, projectDraft, parseConfig } = require('./agentRows');
const { _loadAgentRow, _withPersona } = require('./agentReads');

/**
 * Clamp `config.tools` on the way OUT to the runtime.
 *
 * The write side (validateAgentConfigReferences) normalises too, but a row can
 * reach the runtime without ever passing it: written before this rule existed,
 * restored from a version snapshot, patched by the MCP builder, or copied. So
 * the runtime never trusts what is in the column — it re-clamps per read.
 *
 * Two properties this must not lose:
 *   - an agent WITHOUT a tools map is untouched, and pays nothing: the guard
 *     below returns before the tool registry is ever loaded;
 *   - it never throws. normaliseToolsConfig is written not to, and the try
 *     here is the second line of defence — a store read that threw would take
 *     the whole chat turn down over a config field.
 *
 * `lentProviders` decides whether `actAs:'owner'` survives. Resolving it costs
 * nothing while connection lending is off (the default): the probe returns
 * null without touching the database, and null means "could not check", which
 * downgrades to `viewer`.
 */
async function _clampRuntimeTools(agent) {
    if (!agent || !agent.config || typeof agent.config !== 'object') return agent;
    if (!agent.config.tools || typeof agent.config.tools !== 'object') return agent;
    try {
        const policy = require('../../core/agentRuntime/toolPolicy');
        const lentProviders = await policy.resolveLentProviders({
            agentId: agent.id, ownerId: agent.owner_id,
        });
        const { tools, warnings } = policy.normaliseToolsConfig(agent.config, {
            agentId: agent.id, ownerId: agent.owner_id, lentProviders,
        });
        if (!tools) return agent;
        if (warnings.length > 0) {
            log.warn(`[AgentCrud] Clamped tool grants for agent ${agent.id}: ${warnings.join('; ')}`);
        }
        // A map whose entries were junk clamps to a map of REFUSALS —
        // `{app: {actions: []}}`, one per unreadable entry — and handing that
        // to the runtime is deliberate: it is the narrowest true statement
        // about the row. It used to clamp to `{}` instead, by DROPPING those
        // entries, and that was the one clamp here that made a grant bigger:
        // a missing entry means "every action of this app" to every reader in
        // toolPolicy.js, so `{gmail: "nope"}` came back as the whole of Gmail.
        // Do not "fix" this back into dropping; a refusal has to survive, or
        // it is not a refusal.
        //
        // The cost is named rather than hidden: a map that holds nothing but
        // refusals now answers `hasCuratedGrants` with true, so an agent whose
        // ONLY tools map is junk enters the confirmation regime instead of
        // staying invisible. That is the fail-closed side of the same coin —
        // it holds a send back rather than granting one — and the warnings
        // above say exactly which entry caused it.
        return { ...agent, config: { ...agent.config, tools } };
    } catch (e) {
        // Unreachable policy module ⇒ serve the map AS STORED, loudly.
        //
        // Dropping it would look like the cautious move and is the opposite:
        // a missing map means "every action of every enabled app", so deleting
        // it here would hand the agent back the actions its owner unticked.
        // Keeping it can only ever narrow — and the two things a clamp exists
        // to stop are both re-derived downstream anyway: `confirmForTool`
        // forces `ask` on a send whatever the stored value says, and a lent
        // identity is re-checked per call at dispatch.
        log.warn(`[AgentCrud] Tool-grant normalisation unavailable for agent ${agent.id} — serving the stored grants unclamped:`, e.message);
        return agent;
    }
}

/**
 * The agent as the RUNTIME must see it: the published config/system_prompt
 * when the agent has been published at least once (and is not a system
 * agent), otherwise the live concept. Same shape as getAgent plus
 * `runtimeSource: 'published' | 'live'` — or, with `useDraft: true` (the
 * testchat, A4), unconditionally `'draft'`. That third value is what
 * `testChat.testChatConfigInfo` reads, and it is the ONLY one that path can
 * see: `projectDraft` stamps it without looking at anything else.
 *
 * Every consumer that runs an agent (agent chat, non-streaming chat, support
 * responder, embed, ai_step, app AI block, GET /agents/:id for non-editors)
 * loads through this; getAgent is for the editor and for access decisions
 * (owner_id / is_published / shared_groups are never split).
 *
 * The component tool grants (agent_tools table) are not part of the split:
 * they are read live here exactly as in getAgent.
 */
async function getForRuntime(id, { useDraft = false } = {}) {
    const loaded = await _loadAgentRow(id);
    if (!loaded) return null;
    const projected = useDraft === true ? projectDraft(loaded.row) : projectRuntime(loaded.row);
    const agent = { ...parseConfig(projected), tools: loaded.tools, tool_params: loaded.tool_params };
    return _clampRuntimeTools(agent);
}

/**
 * Both views of one agent from ONE load: `draft` (the concept, what the
 * editor edits) and `runtime` (what getForRuntime would serve). GET
 * /agents/:id needs both — the access decision and `unpublishedChanges` come
 * from the concept row, the body from the projection — and calling getAgent
 * plus getForRuntime would run the same three queries twice on the hottest
 * agent endpoint (and could straddle a save).
 *
 * `tools` / `tool_params` are shared by both views (the component grants are
 * not part of the split); treat them as read-only.
 *
 * @returns {Promise<{draft:object, runtime:object}|null>}
 */
async function getAgentViews(id) {
    const loaded = await _loadAgentRow(id);
    if (!loaded) return null;
    const { row, tools, tool_params } = loaded;
    return {
        // The draft is the EDITOR's copy and stays verbatim — the picker has
        // to be able to show what is stored, including a value the runtime
        // will clamp. The runtime view is clamped exactly as getForRuntime
        // would, so "what will actually run" is never a second opinion.
        //
        // `persona` rides on the DRAFT only. It describes the concept prompt,
        // and a published agent's runtime prompt is a different string — so
        // pairing the two would be a claim nobody checked. A reader that wants
        // "the role behind what is live" gets nothing rather than a guess.
        draft: { ..._withPersona(parseConfig(row), row), tools, tool_params },
        runtime: await _clampRuntimeTools({ ...parseConfig(projectRuntime(row)), tools, tool_params }),
    };
}

module.exports = { _clampRuntimeTools, getForRuntime, getAgentViews };
