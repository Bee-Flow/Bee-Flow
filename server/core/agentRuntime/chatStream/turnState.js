// @typecheck noImplicitAny
/**
 * The per-turn mutable state the agentic loop (./turnLoop) carries from round
 * to round, and the one-off notebook seed that runs before the first round.
 *
 * Everything here is TURN-scoped: the phases (./nativeAdapterStream,
 * ./rawSseStream, ./toolRoundGate, ../finalizeTurn) write into these arrays
 * and counters, and the loop reads them back between rounds.
 */
const log = require('../../../telemetry/log');

/**
 * The shapes the turn's phases pass to each other.
 * @typedef {Record<string, any>} AgentRow  a raw agents row (agentStore.getForRuntime)
 * @typedef {Record<string, any>} ConversationRow  a raw conversations row (or the in-memory ephemeral one)
 * @typedef {import('../../providers/base').OnEvent} OnEvent
 * @typedef {{ type?: string, text?: string, [key: string]: unknown }} ContentPart
 * @typedef {{ role: string, content?: string | ContentPart[], attachments?: Attachment[], tool_calls?: ToolCall[], tool_call_id?: string, [key: string]: unknown }} ChatMessage  a message in the turn's prompt or durable history
 * @typedef {import('../assistantMessageExtras').ThinkingPart} ThinkingPart
 * @typedef {{ id?: string, type?: string, function?: { name?: string, arguments?: string }, [key: string]: unknown }} ToolCall
 * @typedef {{ type?: string, function?: { name?: string, description?: string, parameters?: unknown }, [key: string]: unknown }} ToolDef
 * @typedef {{ orgId?: string | null, groups?: string[] }} RunningUserContext
 * @typedef {{ document_id?: string, kb_id?: string, title?: string, source_uri?: string, score?: number, snippet?: string, [key: string]: unknown }} KbSource  a knowledge-base citation the turn persists
 * @typedef {{ session?: Express.Session, encryptionKey?: string | null, extraTools?: ToolDef[], integrationOrgId?: string | null, integrationUserId?: string | null, piiActionOverride?: string | null, __runCtx?: RunningUserContext, supportThreadId?: string | null, userId?: string, userOrgId?: string | null }} UserAuth
 * @typedef {{ name?: string, type?: string, url?: string, size?: number, content?: string, [key: string]: unknown }} Attachment
 * @typedef {{ activeSkillIds?: string[], attachments?: Attachment[], autoSend?: boolean, chatSignals?: Record<string, unknown>, conversationId?: string, ephemeral?: boolean, ephemeralKey?: string, memoryReadEnabled?: boolean, memoryWriteEnabled?: boolean, messageId?: string, modelTier?: string, nanoBananaSettings?: Record<string, unknown>, notebookspaceAvailable?: boolean, notebookspaceContent?: string, notebookspaceSelection?: string, orgId?: string | null, parentCallId?: string, parentId?: string, projectId?: string, reasoningEffort?: string, req?: import('express').Request, scheduleId?: string, scheduleText?: string, sidePanelDocument?: Record<string, unknown>, sidePanelWebpage?: Record<string, unknown>, signal?: AbortSignal, timezone?: string, toolChoice?: unknown, toolDecisions?: unknown[] | Map<string, 'approve'|'decline'>, unattended?: boolean, userOrgId?: string | null, verbosity?: string, webSearchEnabled?: boolean, testAs?: Parameters<typeof import('../testAs').coerceTestAs>[0], testSandbox?: boolean, testChat?: unknown, [key: string]: unknown }} MessageMetadata
 */

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
        parts: /** @type {ThinkingPart[]} */ ([]),
        snapshotFrom: 0,
        // Look up / create a thinking part by provider-supplied partId.
        getPart: (/** @type {string} */ partId) => {
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
        toolCalls: /** @type {Record<string, unknown>[]} */ ([]),
        emailDrafts: /** @type {Record<string, unknown>[]} */ ([]),
        calendarDrafts: /** @type {Record<string, unknown>[]} */ ([]),
        linkedInDrafts: /** @type {Record<string, unknown>[]} */ ([]),
        mapEmbeds: /** @type {Record<string, unknown>[]} */ ([]),
        audioFiles: /** @type {Record<string, unknown>[]} */ ([]),
        generatedFiles: /** @type {Record<string, unknown>[]} */ ([]), // decks and other files a tool built — shown as a card, persisted
        pendingToolCalls: /** @type {Record<string, unknown>[]} */ ([]),
        toolHistory: /** @type {Record<string, unknown>[]} */ ([]), // Track tool calls for persistence
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
 * exactly without re-running the checks. `workspaceTools` loads
 * integrations/workspaceTools (handed in: it sits in the server's large
 * import cycle, which this module stays out of).
 */
/**
 * @param {{ messageMetadata: MessageMetadata, tools: ToolDef[], conversation: ConversationRow, userId: string, workspaceTools: () => typeof import('../../../integrations/workspaceTools') }} opts
 */
async function seedNotebookFromEditor({ messageMetadata, tools, conversation, userId, workspaceTools }) {
    const _seedNbContent = messageMetadata?.notebookspaceContent;
    const _hasNotebookTools = Array.isArray(tools) && tools.some(t =>
        t.function?.name === 'notebook_read' || t.function?.name === 'notebook_write');
    if (!_hasNotebookTools || typeof _seedNbContent !== 'string' || _seedNbContent.trim() === '' || !conversation?.id) return;
    try {
        const { syncClientWorkspaceContent } = workspaceTools();
        const _seedRes = await syncClientWorkspaceContent(conversation.id, userId, _seedNbContent);
        if (_seedRes?.seeded) log.info(`[AgentRuntime] Seeded notebook from live editor content (${_seedNbContent.length} chars, ${_seedRes.reason})`);
    } catch (e) {
        log.warn('[AgentRuntime] notebook seed-on-entry failed:', e.message);
    }
}

module.exports = { MAX_TOOL_REPEAT, createThinkingState, createTurnLoopState, seedNotebookFromEditor };
