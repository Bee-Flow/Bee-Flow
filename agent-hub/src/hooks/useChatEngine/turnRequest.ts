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
interface TurnTestChat {
    asGroup?: string;
    sessionId: string | null;
    /** The outbox: decisions to send ONCE with this turn, keyed by argsKey. */
    toolDecisions: Record<string, string>;
}

/**
 * Incognito chat: nothing of the conversation is stored on the server. The
 * session id is the one key the agent route keeps its ephemeral turn under
 * (`testSessionId`, as the embed chat does); it is minted once per incognito
 * session and never stored.
 */
export interface TurnIncognito {
    sessionId: string;
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
    conversationId?: string | null;
    chatProjectId: string | null;
    getNotebookPayload?: () => Record<string, unknown> | null;
    activeSkillIds?: string[];
    /** Set only while the test chat is on. */
    testChat: TurnTestChat | null;
    getChatSignalsPayload?: (surface: ChatSignalsTurnSurface) => Record<string, unknown> | null;
    /** Set only while an incognito chat is on (wins over a test chat). */
    incognito?: TurnIncognito | null;
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
function directHistory({ historyOverride, conversationId, messages, incognito }: TurnRequestInput): HistoryEntry[] | undefined {
    if (historyOverride) return toHistory(historyOverride);
    if (!conversationId || incognito) return toHistory(messages);
    return undefined;
}

/**
 * What an incognito turn adds. The memory flags are false whatever the
 * composer's stored mode says (the server enforces the same); an incognito
 * turn carries no conversation id at all, the payload builders leave it out.
 */
function incognitoFields(incognito: TurnIncognito, isDirectMode: boolean): Record<string, unknown> {
    return {
        incognito: true,
        memoryReadEnabled: false,
        memoryWriteEnabled: false,
        ...(isDirectMode ? {} : { testSessionId: incognito.sessionId }),
    };
}

/**
 * The side panels (notebook, webpage, document) are workspaces stored next to
 * a conversation; an incognito chat has none, so it never offers them.
 */
function sidePanelPayload(input: TurnRequestInput): Record<string, unknown> {
    if (input.incognito) return {};
    return input.getNotebookPayload?.() || {};
}

function directPayload(input: TurnRequestInput, reasoningEffort: string | null): Record<string, unknown> {
    const { text, attachments, overrideTier, directMode, conversationId, chatProjectId, activeSkillIds, incognito } = input;
    const history = directHistory(input);
    return {
        message: text,
        ...(incognito ? {} : { conversationId }),
        modelTier: overrideTier || directMode?.modelTier || 'fast',
        attachments,
        ...(history !== undefined ? { history } : {}),
        ...sidePanelPayload(input),
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
        ...(incognito ? incognitoFields(incognito, true) : {}),
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
    const { text, attachments, isHidden, historyOverride, overrideTier, agentId, conversationId, chatProjectId, incognito } = input;
    // An incognito chat is never a test chat as well: `test: true` runs the draft.
    const testChat = incognito ? null : input.testChat;
    const wsPayload = sidePanelPayload(input);
    return {
        message: text,
        agentId,
        ...(incognito ? {} : { conversationId }),
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
        //   - Incognito: the same, for the same reason: nothing is stored, so
        //     the history only exists in this tab.
        //   - Otherwise: no history; the server reads the durable row.
        ...(historyOverride || testChat || incognito ? { history: toHistory(historyOverride || input.messages) } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(testChat ? testChatFields(testChat) : {}),
        ...(incognito ? incognitoFields(incognito, false) : {}),
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
        // A custom endpoint (the webpage panel) stores its own state; incognito
        // always goes to the plain direct route.
        customEndpoint: input.incognito ? undefined : input.directMode?.customEndpoint,
        agentId: input.agentId,
    });
    const payload = input.isDirectMode ? directPayload(input, reasoningEffort) : agentPayload(input, reasoningEffort);

    // Chat signals: only a counted endpoint asks for the marker, and a test
    // chat is never counted, so it carries none.
    const signalsSurface = input.testChat && !input.incognito ? null : chatSignalsSurfaceFor(turnPath);
    const signalsExtra = signalsSurface ? input.getChatSignalsPayload?.(signalsSurface) ?? null : null;
    if (signalsExtra) Object.assign(payload, signalsExtra);

    return { url: `${API_BASE}${turnPath}`, payload };
}
