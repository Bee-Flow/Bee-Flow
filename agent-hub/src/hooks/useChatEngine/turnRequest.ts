/**
 * Phase 1 of a chat turn: what goes on the wire. Builds the URL and the JSON
 * body for the direct and the agent endpoint; the hook only posts it.
 */
import { API_BASE } from '../../utils/helpers';
import scopedStorage from '../../utils/scopedStorage';
import { readStoredMemoryFlags } from '../../utils/memoryMode';
import { toHistoryAttachment, type ChatAttachment, type HistoryAttachment } from './historyAttachment';
import { chatSignalsSurfaceFor, resolveTurnEndpoint, type ChatSignalsTurnSurface } from './turnEndpoint';
import type { ChatMessage } from './types';

/** One message of the history a turn may carry. */
export interface HistoryEntry {
    role: string | undefined;
    content: string | undefined;
    attachments?: HistoryAttachment[];
}

/** The user and assistant messages with text, stripped to what history may carry. */
export function toHistory(messages: ChatMessage[]): HistoryEntry[] {
    return messages
        .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content?.trim())
        .map(m => ({
            role: m.role,
            content: m.content,
            ...(m.attachments && m.attachments.length > 0 ? { attachments: (m.attachments as ChatAttachment[]).map(toHistoryAttachment) } : {}),
        }));
}

function readWebSearchEnabled(): boolean {
    const v = scopedStorage.getItem('webSearchEnabled');
    return v === null ? true : v === 'true';
}

/** The test-chat mode as the request needs it. */
export interface TurnTestChat {
    asGroup?: string;
    sessionId: string | null;
    /** The outbox: decisions to send ONCE with this turn, keyed by argsKey. */
    toolDecisions: Record<string, string>;
}

export interface TurnRequestInput {
    text: string;
    attachments: ChatAttachment[];
    isHidden: boolean;
    historyOverride: ChatMessage[] | null;
    overrideTier: string | null;
    /** The in-memory conversation (messagesRef.current). */
    messages: ChatMessage[];
    isDirectMode: boolean;
    directMode?: {
        modelTier?: string;
        customEndpoint?: string;
        systemPrompt?: string;
        getExtraPayload?: () => Record<string, unknown>;
    } | null;
    agentId?: string;
    conversationId?: string;
    chatProjectId: string | null;
    getNotebookPayload?: () => Record<string, unknown> | null;
    activeSkillIds?: string[];
    /** Set only while the test chat is on. */
    testChat: TurnTestChat | null;
    getChatSignalsPayload?: (surface: ChatSignalsTurnSurface) => Record<string, unknown> | null;
}

export interface TurnRequest {
    url: string;
    payload: Record<string, unknown>;
}

/**
 * Direct chat: post to a custom endpoint or /ai/chat/direct/stream.
 * History rule:
 *   - Edit/retry flow: send `historyOverride` so the server can truncate the
 *     conversation to the edit point.
 *   - Brand-new conversation (no conversationId): send the current in-memory
 *     history so the very first turn has it.
 *   - Persisted conversation, no override: send NO history. The server loads
 *     from `conversation_messages` instead, which is the durable source of
 *     truth and avoids drift (stripped tool messages, page-reload gaps, etc).
 */
function directHistory({ historyOverride, conversationId, messages }: TurnRequestInput): HistoryEntry[] | undefined {
    if (historyOverride) return toHistory(historyOverride);
    if (!conversationId) return toHistory(messages);
    return undefined;
}

function directPayload(input: TurnRequestInput, reasoningEffort: string | null): Record<string, unknown> {
    const { text, attachments, overrideTier, directMode, conversationId, chatProjectId, activeSkillIds } = input;
    const history = directHistory(input);
    return {
        message: text,
        conversationId,
        modelTier: overrideTier || directMode?.modelTier || 'fast',
        attachments,
        ...(history !== undefined ? { history } : {}),
        ...input.getNotebookPayload?.(),
        ...(directMode?.systemPrompt ? { systemPrompt: directMode.systemPrompt } : {}),
        imageGenSettings: scopedStorage.getJSON('imageGenSettings', {}),
        nanoBananaSettings: scopedStorage.getJSON('nanoBananaSettings', {}),
        disabledMedia: scopedStorage.getJSON('disabledMedia', {}),
        webSearchEnabled: readWebSearchEnabled(),
        ...readStoredMemoryFlags(),
        ...(chatProjectId ? { projectId: chatProjectId } : {}),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(typeof directMode?.getExtraPayload === 'function' ? directMode.getExtraPayload() : {}),
        ...(Array.isArray(activeSkillIds) && activeSkillIds.length > 0 ? { activeSkillIds } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
    };
}

/**
 * Test chat (A4). `test: true` runs this turn on the DRAFT and keeps it out of
 * the history; `asGroup` is the existing A1c path and rides in the same body.
 *
 * `testSessionId` is the key the server keeps its ephemeral conversation id
 * STABLE with across the turns of one test conversation. Without it the
 * server mints a new id per REQUEST, and `COUNT(DISTINCT conversation_id)`
 * then counts turns instead of conversations.
 *
 * The decisions go along ONCE: the caller empties the outbox right after, as
 * the server consumes them per action and a client that kept repeating them
 * would buy every later turn with one click.
 */
function testChatFields(testChat: TurnTestChat): Record<string, unknown> {
    return {
        test: true,
        testSessionId: testChat.sessionId,
        ...(testChat.asGroup ? { asGroup: testChat.asGroup } : {}),
        ...(Object.keys(testChat.toolDecisions).length > 0 ? {
            toolDecisions: Object.entries(testChat.toolDecisions)
                .map(([argsKey, decision]) => ({ argsKey, decision })),
        } : {}),
    };
}

/** Agent chat: post to /agents/:id/chat/stream. */
function agentPayload(input: TurnRequestInput, reasoningEffort: string | null): Record<string, unknown> {
    const { text, attachments, isHidden, historyOverride, overrideTier, agentId, conversationId, chatProjectId, testChat } = input;
    const wsPayload = input.getNotebookPayload?.() || {};
    return {
        message: text,
        agentId,
        conversationId,
        attachments,
        isHidden,
        stream: true,
        ...readStoredMemoryFlags(),
        webSearchEnabled: readWebSearchEnabled(),
        ...wsPayload,
        ...(chatProjectId ? { projectId: chatProjectId } : {}),
        ...(overrideTier ? { modelTier: overrideTier } : {}),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        // History rule, agent path:
        //   - Edit/retry: send `historyOverride` so the server can truncate the
        //     conversation to the edit point.
        //   - Test chat: send the in-memory history. A test chat is EPHEMERAL:
        //     the server writes no row and builds the conversation as
        //     `{ …, messages: [] }`, so without this every test turn starts from
        //     zero: turn 3 cannot refer to turn 1, a held action is never
        //     proposed again and its approval is never consumed. EmbedChat, the
        //     other ephemeral surface, does the same for exactly this reason.
        //   - Otherwise: no history; the server reads the durable row.
        ...(historyOverride || testChat ? { history: toHistory(historyOverride || input.messages) } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(testChat ? testChatFields(testChat) : {}),
    };
}

/** URL and body of one turn, chat-signals marker included. */
export function buildTurnRequest(input: TurnRequestInput): TurnRequest {
    // Thinking-effort override from the composer (persisted in scopedStorage so
    // user A's choice doesn't follow user B after an account switch). Valid
    // values: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'. When unset,
    // the server falls back to the tier default.
    const reasoningEffort = scopedStorage.getItem('reasoningEffort') || null;

    // One path for the request and for the chat-signals marker below.
    const turnPath = resolveTurnEndpoint({
        isDirectMode: input.isDirectMode,
        customEndpoint: input.directMode?.customEndpoint,
        agentId: input.agentId,
    });
    const payload = input.isDirectMode ? directPayload(input, reasoningEffort) : agentPayload(input, reasoningEffort);

    // Chat signals: only a counted endpoint asks for the marker, and a test
    // chat is never counted, so it carries none.
    const signalsSurface = input.testChat ? null : chatSignalsSurfaceFor(turnPath);
    const signalsExtra = signalsSurface ? input.getChatSignalsPayload?.(signalsSurface) ?? null : null;
    if (signalsExtra) Object.assign(payload, signalsExtra);

    return { url: `${API_BASE}${turnPath}`, payload };
}
