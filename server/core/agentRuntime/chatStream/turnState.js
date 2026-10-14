/**
 * The per-turn mutable state the agentic loop (./turnLoop) carries from round
 * to round, and the one-off notebook seed that runs before the first round.
 *
 * Everything here is TURN-scoped: the phases (./nativeAdapterStream,
 * ./rawSseStream, ./toolRoundGate, ../finalizeTurn) write into these arrays
 * and counters, and the loop reads them back between rounds.
 */
const log = require('../../../telemetry/log');

/** How many times the same failing (or held) tool call may repeat before the loop bails. */
const MAX_TOOL_REPEAT = 3;

/**
 * The reasoning produced this turn: the legacy string form plus the
 * structured parts (signature for Claude, timing for the UI).
 *
 * `snapshotFrom` is a plain property because the native adapter round reads
 * it and hands back a (possibly lowered) value after a retried attempt; the
 * loop writes that back here so `snapshot()` slices from the right place.
 */
function createThinkingState() {
    const state = {
        text: '',
        parts: [],
        snapshotFrom: 0,
        // Look up / create a thinking part by provider-supplied partId.
        getPart: (partId) => {
            if (!partId) return null;
            let part = state.parts.find(p => p.id === partId);
            if (!part) {
                part = { id: partId, text: '', startedAt: Date.now(), endedAt: null };
                state.parts.push(part);
            }
            return part;
        },
        // Replay-shaped copy of the reasoning produced so far this turn. Only parts
        // that can actually be sent back are worth carrying: a signed thinking block
        // or a redacted block with its payload. Everything else is UI-only.
        snapshot: () => {
            const slice = state.parts.slice(state.snapshotFrom);
            state.snapshotFrom = state.parts.length;
            const replayable = slice
                // A signature alone is enough: under `display: 'omitted'` the text
                // is empty and the signature carries the reasoning.
                .filter(p => p.signature || (p.redacted && p.redactedData))
                .map(p => ({
                    id: p.id,
                    text: p.text,
                    redacted: p.redacted || undefined,
                    signature: p.signature || undefined,
                    redactedData: p.redactedData || undefined,
                }));
            return replayable.length > 0 ? replayable : undefined;
        },
    };
    return state;
}

/**
 * The counters and collections of one turn.
 *
 * The draft arrays ride out on the final assistant message; a client that
 * does not draw one simply shows nothing. `pendingToolCalls` are tool calls
 * held back for a person to approve — the same mechanism: the turn runs on
 * to `done` and the pending call rides out on the assistant message, exactly
 * how email_draft degrades today.
 */
function createTurnLoopState() {
    return {
        iterations: 0,
        promptTokens: 0,
        completionTokens: 0,
        toolCalls: [],
        emailDrafts: [],
        calendarDrafts: [],
        linkedInDrafts: [],
        mapEmbeds: [],
        audioFiles: [],
        generatedFiles: [], // decks and other files a tool built — shown as a card, persisted
        pendingToolCalls: [],
        toolHistory: [], // Track tool calls for persistence
        thinking: createThinkingState(),
        // Track repeated failing tool calls so the loop breaks instead of burning
        // the full max-iterations budget on a deterministic failure (e.g. permission
        // denied). Key: tool-name + stable JSON of args; value: failure count.
        failingToolCounts: new Map(),
        // The same guard for calls that are HELD rather than failing: key → how many
        // rounds that action has sat waiting for approval. A held call is not a
        // failure (it has not run at all), but a model that keeps re-asking for one
        // burns the same budget, so it bails on the same threshold.
        pendingToolCounts: new Map(),
    };
}

/**
 * Seed the notebook store from the live client editor content (BFSF-287).
 *
 * notebookspaceContent is the freshest editor Markdown; historically used
 * only as an "is the panel open" flag (see buildSystemPrompt in
 * ../contextBuilder). Seed the SAME store the notebook tools read
 * (document_content when linked, else workspace_content) ONCE, before the
 * loop, so notebook_read/replace/write build on the user's current edits
 * instead of the agent's last write. Gated on the notebook tools actually
 * being present — that array is only populated when the notebooks
 * entitlement + use_notebooks permission pass, so this mirrors the tool gate
 * exactly without re-running the checks.
 */
async function seedNotebookFromEditor({ messageMetadata, tools, conversation, userId }) {
    const _seedNbContent = messageMetadata?.notebookspaceContent;
    const _hasNotebookTools = Array.isArray(tools) && tools.some(t =>
        t.function?.name === 'notebook_read' || t.function?.name === 'notebook_write');
    if (!_hasNotebookTools || typeof _seedNbContent !== 'string' || _seedNbContent.trim() === '' || !conversation?.id) return;
    try {
        const { syncClientWorkspaceContent } = require('../../../integrations/workspaceTools');
        const _seedRes = await syncClientWorkspaceContent(conversation.id, userId, _seedNbContent);
        if (_seedRes?.seeded) log.info(`[AgentRuntime] Seeded notebook from live editor content (${_seedNbContent.length} chars, ${_seedRes.reason})`);
    } catch (e) {
        log.warn('[AgentRuntime] notebook seed-on-entry failed:', e.message);
    }
}

module.exports = { MAX_TOOL_REPEAT, createThinkingState, createTurnLoopState, seedNotebookFromEditor };
