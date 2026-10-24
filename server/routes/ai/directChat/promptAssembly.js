// @typecheck
/**
 * Direct Chat — system-prompt and message-array assembly: the stable/volatile
 * system-block split, tool hints, project instructions + KB retrieval,
 * attached KBs, memory injection (with PII scrub), house style, notebook and
 * side-panel webpage context, skills injection, the Now: timestamp,
 * capability-honesty addenda and conversation-history resolution/hydration.
 * The context blocks are built in promptContext.js, the history in
 * promptHistory.js; this file decides which block goes where.
 */

const configStore = require('../../../stores/configStore');
const { protectMemoryContext } = require('./memoryProtection');
const { buildToolHint } = require('../../../core/integrations/integrationTools');
const { emitPhase, emitPhaseEnd } = require('../../../core/agentRuntime/phaseEvents');
const { DEFAULT_SYSTEM_PROMPT } = require('./systemPrompt');
const { formatLocalNow } = require('../../../core/llm/clock');
const {
    makeKbPassagesText, projectContextFor, attachedKbContext, retrieveMemories, houseStyleContextFor,
    notebookContextFor, sidePanelContext, skillsContextFor, capabilityContextFor,
} = require('./promptContext');
const { resolveHistory, appendHistory } = require('./promptHistory');

/**
 * The stable head of the system prompt. BFSF-261: the style layer is appended
 * unconditionally (custom admin prompts included). `basePrompt` opens the
 * CACHED system block, so it carries no date: `Today is …` used to sit here,
 * ahead of the tool hint, and rewrote the whole prefix at midnight. It now
 * rides the volatile block next to the `Now:` line.
 */
async function basePromptFor({ requestSystemPrompt, notebooksEnabled }) {
    const customPrompt = await configStore.getConfig('direct_chat_system_prompt');
    let systemPromptText = customPrompt || DEFAULT_SYSTEM_PROMPT;
    // Strip notebook instructions from prompt when feature is disabled
    if (!notebooksEnabled) {
        systemPromptText = systemPromptText.replace(/\n*When the user has a notebook open[^\n]*\n*/g, '\n');
    }
    const { buildWritingStyleAddendum, buildResponseLanguageRule } = require('../../../core/llm/promptStyle');
    return (requestSystemPrompt ? requestSystemPrompt + '\n\n' : '')
        + systemPromptText
        + buildWritingStyleAddendum()
        + buildResponseLanguageRule();
}

/**
 * Plan-execution turn: the user clicked Approve & build on a previously
 * proposed webpage plan. Authorise the AI to proceed straight to
 * webpage_file_* / create_webpage without proposing a new plan (the
 * propose_webpage_plan tool is also stripped from the toolset). It rides on
 * the volatile block: a third leading system message hangs llama-server
 * outright (local.js), and this text is one-turn-only anyway.
 */
function planExecutionNote(webpagePlanExecution) {
    if (!(webpagePlanExecution && webpagePlanExecution.action === 'execute' && webpagePlanExecution.planId)) return '';
    return `\n\nThe user APPROVED your previously proposed webpage plan (planId=${webpagePlanExecution.planId}). Execute it now using create_webpage / webpage_file_write / webpage_file_replace / webpage_file_patch. Do NOT call propose_webpage_plan again — the plan is already locked in.`;
}

/**
 * Build the two system messages and the history.
 *
 * The system prompt is split into two messages so per-provider caching can
 * place a long-lived breakpoint on the stable portion. Everything that varies
 * per turn goes in the second message: a single changing byte in the first
 * invalidates the entire cached prefix.
 *   1. stable: identity / tool hint / house style / notebook rules / project
 *      instructions / skills / capability honesty
 *   2. volatile: timestamp, today's date, retrieved memories, per-query KB
 *      chunks, notebook selection, side-panel page content
 * Providers that join system messages (Gemini, OpenAI Responses) still see
 * the same effective prompt; Claude's extractSystem emits per-message blocks
 * with the right cache_control on the stable one.
 *
 * The volatile block is a NAMED object (`volatileMessage`) returned alongside
 * `messages`: every later per-turn addendum (PII tokens, moderation flag,
 * session-skill state, step-machine guard) appends to it, and the turn
 * handler moves it behind the history just before the first model call
 * (core/llm/promptLayout.js) so a self-hosted prefix cache keeps the history
 * too. It stays at index 1 here because compaction hoists system messages in
 * order and several checks read messages[0].role === 'system'.
 *
 * Attached KBs: what this turn may search comes from the REQUEST, never from
 * the stored column. `direct_conversations.knowledge_base_ids` remembers the
 * selection so the composer can restore it; it is NOT read back here: today's
 * web and mobile clients OMIT the key when the list is empty, so "fall back to
 * what is stored" would turn "I unticked every base" into "keep answering
 * from them". The access rule is core/kb/kbVisibility, one answer on every
 * surface (the hand-rolled copy here once read `orgIdsForTiers === null` as
 * super admin and let any base through).
 */
async function buildPromptAndHistory({ req, send, userId, message, conversationId, history, timezone, requestSystemPrompt, activeSkillIds, requestedKbIds, projectId, notebookspaceAvailable, notebookspaceContent, notebookspaceSelection, sidePanelWebpage, sidePanelDocument, webpagePlanExecution, userOrgForTiers, orgIdsForTiers, notebooksEnabled, canUseNotebooks, toolCatalogText, directChatTools }) {
    emitPhase(send, 'building_prompt');
    const _spT = Date.now();
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const basePrompt = await basePromptFor({ requestSystemPrompt, notebooksEnabled });
    // Per-turn system context, kept out of the first system block so the 1h
    // cache breakpoint the Claude adapter places there stays valid for the
    // whole conversation (core/agentRuntime/contextBuilder.js has the contract).
    let volatileContext = `\n\nToday is ${today}.`;
    // With disclosure on, buildToolHint only describes the eager/loaded tools
    // still in directChatTools; toolCatalogText advertises the rest.
    const toolHint = (await buildToolHint(directChatTools, userId)) + toolCatalogText;
    const kbPassagesText = makeKbPassagesText({ userOrgForTiers, userId });

    const project = await projectContextFor({ req, userId, projectId, message, kbPassagesText });
    volatileContext += project.volatile;
    const attached = await attachedKbContext({ req, userId, message, requestedKbIds, orgIdsForTiers, kbPassagesText });
    volatileContext += attached.volatile;

    const memory = await retrieveMemories({ req, send, userId, message, userOrgForTiers, validProjectId: project.validProjectId });
    // Who the user is (from the account) goes in front, then the memory block
    // is tokenised or scrubbed (memoryProtection.js). A first message of a new
    // chat has no conversation id yet: the block carries labels now and is
    // swapped for reversible tokens once the id exists (applyMemorySwap).
    const { memoryContext, memorySwap } = await protectMemoryContext({ memoryContext: memory.memoryContext, userId, conversationId });

    const houseStyleContext = await houseStyleContextFor(userOrgForTiers);
    const notebook = notebookContextFor({ canUseNotebooks, notebookspaceAvailable, notebookspaceContent, notebookspaceSelection });
    volatileContext += notebook.volatile;
    volatileContext += await sidePanelContext({ sidePanelWebpage, sidePanelDocument, userId });
    const skillsContext = await skillsContextFor({ activeSkillIds, userOrgForTiers, userId, conversationId, directChatTools });

    // Local time with explicit UTC offset, at MINUTE resolution (see
    // core/llm/clock.js for why seconds were the enemy of every prompt cache
    // in front of a self-hosted model).
    const _nowStr = formatLocalNow(timezone);
    const capabilityContext = capabilityContextFor(directChatTools);

    emitPhaseEnd(send, 'building_prompt', Date.now() - _spT);
    const volatileMessage = { role: 'system', content: `Now: ${_nowStr}` + volatileContext + memoryContext };
    const messages = [
        { role: 'system', content: basePrompt + toolHint + houseStyleContext + notebook.stable + project.stable + skillsContext + capabilityContext },
        volatileMessage,
    ];
    volatileMessage.content += planExecutionNote(webpagePlanExecution);

    const { resolvedHistory, clientHistoryProvided } = await resolveHistory({ req, userId, conversationId, history });
    await appendHistory(messages, resolvedHistory, userId);
    return {
        messages, volatileMessage, resolvedHistory, clientHistoryProvided, validProjectId: project.validProjectId,
        extractMemoriesEnabled: project.extractMemoriesEnabled, usableKbIds: attached.usableKbIds,
        memoryPolicy: memory.memoryPolicy, memoryUsed: memory.memoryUsed, memorySwap,
    };
}

/**
 * Swap the label-scrubbed memory block of a brand-new chat for reversible
 * conversation tokens, now that the conversation exists. Runs before the
 * input gates, so the token-preservation addendum is built from a map that
 * already holds the memory tokens. Labels stay on any failure.
 */
async function applyMemorySwap(turn, userId) {
    const swap = turn.memorySwap;
    turn.memorySwap = null;
    if (!swap || !turn.convId || !turn.volatileMessage || typeof turn.volatileMessage.content !== 'string') return false;
    const { tokenizeMemoryContext } = require('../../../core/memory/scrubMemoryContext');
    const r = await tokenizeMemoryContext(swap.raw, swap.orgShield, { conversationId: turn.convId, userId, knownEntities: swap.knownEntities || [] });
    if (r.mode !== 'tokens' || !turn.volatileMessage.content.includes(swap.labelled)) return false;
    turn.volatileMessage.content = turn.volatileMessage.content.replace(swap.labelled, () => r.text);
    return true;
}

module.exports = { buildPromptAndHistory, applyMemorySwap };

