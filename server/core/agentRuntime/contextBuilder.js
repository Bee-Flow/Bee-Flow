// @typecheck strict
const { processSystemPrompt } = require('../llm/promptUtils');
const { nowLine } = require('../llm/clock');
const { buildSkillInjection } = require('../tools/skillInjection');
const log = require('../../telemetry/log');
const {
    toolHintSection, scheduleSection, scheduleCoverageSection, houseStyleSection,
    notebookSections, sidePanelSections, STRICT_KNOWLEDGE_PREAMBLE,
} = require('./contextSections');
const { buildToolHint } = require('../integrations/integrationTools');

// What ./contextSections reads through, handed in: it sits in the server's
// large import cycle, which that module stays out of. The lazy ones stay lazy.
const SECTION_DEPS = {
    buildToolHint,
    memoryStore: () => require('../../stores/memoryStore'),
    sidePanelWebpageContext: () => require('../webpages/sidePanelWebpageContext'),
    sidePanelDocumentContext: () => require('../documents/sidePanelDocumentContext'),
};

/**
 * Build the agent's system prompt as two halves.
 *
 * PROMPT CACHING CONTRACT — read before adding anything here.
 *
 * Anthropic's prompt cache is a prefix match: one byte of drift anywhere in
 * the prefix invalidates everything after it. The Claude adapter puts a
 * 1-hour `cache_control` breakpoint on the FIRST system block only
 * (providers/claude.js → extractSystem), which caches `tools + system[0]` as
 * one durable prefix. So:
 *
 *   - `stable`   → system[0]. MUST be byte-identical for every turn of a
 *                  conversation. Identity, tool hints, static capability
 *                  rules, static skills. No clocks, no retrieval, no
 *                  per-message text.
 *   - `volatile` → a later, uncached system block. Timestamps, retrieved
 *                  memories, schedule coverage, notebook selection, side-panel
 *                  page content — anything that legitimately changes per turn.
 *
 * A single `Now:` line in the stable half is enough to drive the hit rate to
 * zero, and a 1h breakpoint costs 2x on write — so a churning prefix is more
 * expensive than no caching at all. When in doubt, put it in `volatile`.
 *
 * @param {{ agent: import('./chatStream/turnState').AgentRow, tools: import('./chatStream/turnState').ToolDef[], userId: string, messageMetadata: import('./chatStream/turnState').MessageMetadata, memoryContext: string, isStrictKnowledge: boolean, forceDynamicSkills?: boolean }} opts
 * @returns {Promise<{stable: string, volatile: string}>}
 */
async function buildSystemPrompt({ agent, tools, userId, messageMetadata, memoryContext, isStrictKnowledge, forceDynamicSkills = false }) {
    const defaultPrompt = tools.length > 0
        ? `You are a helpful AI assistant. You have access to the following tools to help accomplish tasks. Use them when appropriate.`
        : `You are a helpful AI assistant. Answer the user's questions to the best of your ability.`;

    let systemPrompt = agent.system_prompt || defaultPrompt;
    // Per-turn half. Never carries a cache breakpoint.
    let volatilePrompt = '';

    // Process dynamic tags in system prompt. `{Time}`/`{DateTime}` resolve at
    // second resolution and a user-authored agent prompt can place them
    // anywhere, so they are deferred to the volatile half and only `{Date}`
    // is expanded inline here.
    systemPrompt = processSystemPrompt(systemPrompt, { deferClockTags: true });

    systemPrompt += await toolHintSection(tools, userId, SECTION_DEPS);

    // Memory is relevance-retrieved against THIS turn's message, so it changes
    // almost every turn — volatile half.
    if (memoryContext) {
        volatilePrompt += '\n\n' + memoryContext;
    }

    systemPrompt += scheduleSection(messageMetadata?.scheduleText);
    volatilePrompt += await scheduleCoverageSection(agent, messageMetadata?.scheduleId, SECTION_DEPS);

    // ─── Writing style (BFSF-261) ────────────────────────────────
    // Unconditional so per-agent custom prompts get it too. Static text, so it
    // belongs in the cached half.
    const { buildWritingStyleAddendum, buildResponseLanguageRule } = require('../llm/promptStyle');
    systemPrompt += buildWritingStyleAddendum();
    // Agent chat had no reply-language rule at all (BFSF-387); a persona's fixed
    // language is part of the agent's own instructions and keeps winning.
    systemPrompt += buildResponseLanguageRule();

    // ─── Date/time context ───────────────────────────────────────
    // This is THE line that must never touch the cached half. Appended to
    // `systemPrompt` it would make every agent request a guaranteed
    // cache miss. Minute resolution (core/llm/clock.js): a self-hosted
    // runtime's prefix cache is a byte match, and a second-resolution clock
    // re-reads the whole prompt on every request.
    const tz = messageMetadata?.timezone || 'UTC';
    volatilePrompt += `\n${nowLine(tz)}`;

    systemPrompt += await houseStyleSection(messageMetadata?.orgId);
    const notebook = notebookSections(messageMetadata);
    systemPrompt += notebook.stable;
    volatilePrompt += notebook.volatile;
    volatilePrompt += await sidePanelSections(messageMetadata, userId, SECTION_DEPS);

    systemPrompt += await injectSkills({ agent, tools, userId, messageMetadata, forceDynamicSkills });

    if (isStrictKnowledge) systemPrompt = STRICT_KNOWLEDGE_PREAMBLE + systemPrompt;

    return { stable: systemPrompt, volatile: volatilePrompt };
}

/**
 * Skills injection. Delegates to the shared helper which splits skills into
 * static (full body injected here) and dynamic (manifest only; AI loads via
 * the `activate_skill` tool on demand). Returns the stable addendum; the
 * helper's extra tool definitions are pushed onto the caller's `tools` array
 * IN PLACE so the model sees activate_skill when any dynamic skills are in
 * play — safe because chatStream passes the same reference it later hands to
 * the LLM.
 * @param {{ agent: import('./chatStream/turnState').AgentRow, tools: import('./chatStream/turnState').ToolDef[], userId: string, messageMetadata: import('./chatStream/turnState').MessageMetadata, forceDynamicSkills: boolean }} opts
 */
async function injectSkills({ agent, tools, userId, messageMetadata, forceDynamicSkills }) {
    const sessionSkillIds = Array.isArray(messageMetadata?.activeSkillIds) ? messageMetadata.activeSkillIds : [];
    const attachedSkillIds = Array.isArray(agent?.config?.attachedSkillIds) ? agent.config.attachedSkillIds : [];
    const skillInjection = await buildSkillInjection(/** @type {any} */ ({
        sessionSkillIds,
        attachedSkillIds,
        orgId: messageMetadata?.orgId,
        userId,
        forceDynamicSkills,
        // Attribution for the fire-and-forget skill_activations row the static
        // path writes ("Laatste keer" in the Skills overview, the per-agent
        // lastAt in Used-by). Without agentId a static skill can never show a
        // last-used time; without conversationId the natural key collapses to
        // ('','') and every ephemeral chat shares one row.
        agentId: agent?.id || null,
        conversationId: messageMetadata?.conversationId || null,
    }));
    if (Array.isArray(tools) && skillInjection.tools.length > 0) {
        for (const t of skillInjection.tools) tools.push(t);
    }
    if (!skillInjection.systemPromptAddendum) return '';
    log.info(`[contextBuilder] Skills: ${skillInjection.staticCount} static, ${skillInjection.dynamicSkillIds.length} dynamic (attached=${attachedSkillIds.length}, session=${sessionSkillIds.length})`);
    return skillInjection.systemPromptAddendum;
}

module.exports = { buildSystemPrompt };
