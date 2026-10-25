// @typecheck strict
/**
 * Direct Chat — everything the streamed turn prepares between the input gates
 * and its first LLM round: the round cap, the volatile step-machine guard,
 * the cleaned and sorted tool set, the mid-turn tool refresh hooks, the PII
 * token-preservation addendum, the un-tokeniser sink, the tool-context
 * factory, the notebook seed and the volatile-block placement. Split out of
 * streamTurn.js; behaviour unchanged.
 */

const log = require('../../../telemetry/log');
const configStore = require('../../../stores/configStore');
const { toolSetFingerprint } = require('../../../core/llm/promptCacheStability');
const { syncClientWorkspaceContent } = require('../../../integrations/workspaceTools');
const { buildTokenPreservationAddendum } = require('../../../core/dlp/tokenPreservationPrompt');
const {
    layoutVolatile: layoutVolatileBlock,
    createVolatileGuard,
    traceStablePrefix: traceTurnPrefix,
} = require('./volatileLayout');
const { applyLoadTools, onSkillsActivated } = require('./toolRefresh');
const { createToolContextFactory } = require('./toolContext');
const { createUntokeniserSink } = require('./streamCallbacks');
const { bestEffort } = require('../../../utils/bestEffort');

/** @typedef {ReturnType<typeof import('./turnState').createTurnState>} Turn */

/**
 * Strip internal metadata (_mcp etc.) before sending tools to the LLM
 * (providers may reject unknown fields), then sort by name. Tools are
 * serialised ahead of the system prompt, so the same tool SET in a different
 * ORDER produces a different cache prefix and rebuilds the whole cache;
 * assembly order depends on integration timing and Set iteration.
 * @param {Turn} turn
 */
function cleanAndSortTools(turn) {
    turn.directChatTools = turn.directChatTools.map(t => {
        const { _mcp, _n8n, ...clean } = t;
        return clean;
    });
    turn.directChatTools.sort((a, b) =>
        /** @type {string} */ (a.function?.name || a.name || '').localeCompare(/** @type {string} */ (b.function?.name || b.name || '')));
    log.info(`[DirectChat] Tool set for this turn: ${turn.directChatTools.length} tools, fingerprint=${toolSetFingerprint(turn.directChatTools)}`);
}

/**
 * PII token-preservation system-prompt addendum. For message-level PII and
 * DLP the addendum is appended inside those blocks at tokenisation time.
 * Attachment-only turns (tokens came only from a PDF/Office scan) never enter
 * those blocks, so without this fallback the model has no idea what
 * `[person_N]` placeholders mean and volunteers meta-commentary ("these
 * names were anonymised") that confuses the end user, who sees the real
 * names. Mirrors the agent runtime (chatStream/roundRequest.js). Idempotent:
 * skips when the tag is already on the volatile block. The token list grows
 * over a conversation, so it lives on the per-turn block, never on the
 * cached prefix.
 * @param {Turn} turn
 */
function addTokenPreservationAddendum(turn) {
    try {
        const { volatileMessage } = turn;
        if (volatileMessage && typeof volatileMessage.content === 'string'
            && !volatileMessage.content.includes('[PII TOKEN PRESERVATION')) {
            const convMap = require('../../../core/dlp/dlpRunner').getConversationTokenMap(turn.convId);
            const add = buildTokenPreservationAddendum(convMap);
            if (add) volatileMessage.content += add;
        }
    } catch (err) { bestEffort('routes/ai/directChat/toolLoopSetup:addTokenPreservationAddendum', err); }
}

/**
 * Seed the notebook store from the live client editor content (BFSF-287).
 * Same rationale as the agent runtime (chatStream.js). Gated on
 * canUseNotebooks (the authoritative entitlement/permission gate, also used
 * to inject WORKSPACE_TOOLS) and non-empty live content.
 * @param {Turn} turn
 * @param {string} notebookspaceContent
 */
async function seedNotebook(turn, notebookspaceContent) {
    if (!(turn.canUseNotebooks && typeof notebookspaceContent === 'string' && notebookspaceContent.trim() !== '' && turn.convId)) return;
    try {
        const seedRes = await syncClientWorkspaceContent(turn.convId, turn.userId, notebookspaceContent);
        if (seedRes?.seeded) log.info(`[DirectChat] Seeded notebook from live editor content (${notebookspaceContent.length} chars, ${seedRes.reason})`);
    } catch (e) {
        log.warn('[DirectChat] notebook seed-on-entry failed:', /** @type {Error} */ (e).message);
    }
}

/**
 * Prepare the tool loop. `armInterruptedTurnHook` is called at the point the
 * handler used to arm its interrupted-turn hook (after the tool-context
 * factory exists). Returns what the rounds need: the round cap, the tool
 * context factory and the volatile-block helpers.
 * @param {Turn} turn
 * @param {{ notebookspaceContent: string, armInterruptedTurnHook: () => void }} opts
 */
async function prepareToolLoop(turn, { notebookspaceContent, armInterruptedTurnHook }) {
    // Skipping the non-streaming tool pre-check per provider is decided per
    // round at the call site (skipToolPrecheck in ./volatileLayout.js),
    // because `adapter`/`config` are reassigned by swapModelForActiveStage.
    const maxToolRounds = parseInt(await configStore.getConfig('max_tool_rounds_chat'), 10) || 15;

    // The step-machine guard is written onto the VOLATILE block as base +
    // guard, REPLACED every round, never appended. Appending it to
    // messages[0], the provider-cached prefix, changed that prefix every
    // round and re-read the entire prompt on a self-hosted model.
    const volatileGuard = createVolatileGuard(turn);
    /**
     * @param {string | null} text
     */
    const setVolatileGuard = (text) => volatileGuard.set(text);

    cleanAndSortTools(turn);

    // The tool dispatcher calls these when the model asks for more tools
    // mid-turn; both push onto the live turn.directChatTools.
    turn.applyLoadTools = /** @param {{ groups?: string[] }} toolArgs */ (toolArgs) => applyLoadTools(turn, toolArgs);
    turn.onSkillsActivated = /** @param {string[]} justActivatedIds */ (justActivatedIds) => onSkillsActivated(turn, justActivatedIds);

    addTokenPreservationAddendum(turn);

    // Streamed text passes through the PII un-tokeniser before it reaches
    // the user; see ./streamCallbacks.js.
    createUntokeniserSink(turn);

    // The tool dispatcher's view of this turn; see ./toolContext.js.
    const mkToolCtx = createToolContextFactory(turn);
    armInterruptedTurnHook();

    await seedNotebook(turn, notebookspaceContent);

    // Volatile block behind the history. Assembly kept the per-turn block at
    // index 1 (compaction and the messages[0] checks rely on that). From here
    // on nothing else appends to it except the step-machine guard, so move it
    // to just before the current user message: a self-hosted prefix cache
    // then keeps the stable prompt AND the history, and only the folded
    // volatile+user tail is re-read. Hosted adapters that fold system
    // messages are indifferent; for strict templates (Scaleway) the block is
    // hoisted back to index 1. Re-run before every stream call because
    // swapModelForActiveStage can change the adapter mid-turn.
    const layoutVolatile = () => layoutVolatileBlock(turn);
    layoutVolatile();
    // The guard's base is the block as it stands once it has been moved.
    volatileGuard.capture();
    // Stable-prefix trace: the same fingerprint on consecutive turns is what
    // a prefix cache needs; a drifting one names the culprit in the app log.
    const traceStablePrefix = (/** @type {string} */ label) => traceTurnPrefix(turn, label);
    traceStablePrefix('placed');

    return { maxToolRounds, mkToolCtx, setVolatileGuard, layoutVolatile, traceStablePrefix };
}

module.exports = { prepareToolLoop };
