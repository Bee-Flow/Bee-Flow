/**
 * What the page hands the chat engine (useChatEngine): the agent or direct
 * mode, the conversation, the side-panel payloads and the callbacks the
 * stream reports to. Split out of useChatEngine.ts, which re-exports
 * `UseChatEngineOptions`.
 */
import type { ChatSignalsTurnSurface } from './turnEndpoint';
import type { TurnIncognito } from './turnRequest';
import type { ChatMessage } from './types';
import type { MemoryLock } from '../../utils/memoryMode';

/** The agent answering, as the page hands it over. */
interface ChatAgent {
    id?: string;
    name?: string;
    avatar?: string;
    [key: string]: unknown;
}

/** Direct (agent-less) chat: which model, and where to send the turn. */
interface DirectMode {
    enabled?: boolean;
    modelTier?: string;
    conversationId?: string;
    customEndpoint?: string;
    systemPrompt?: string;
    getExtraPayload?: () => Record<string, unknown>;
    [key: string]: unknown;
}

/**
 * The TEST CHAT (A4). One object instead of two loose flags, because `asGroup`
 * without a test chat is another, existing path, and the two may not accidentally
 * be half on at once.
 */
interface TestChatMode {
    enabled?: boolean;
    asGroup?: string;
    sessionId?: string;
    ephemeralConversationId?: string;
    [key: string]: unknown;
}

/** What the notebook panel contributes to a turn, when it is open. */
interface NotebookPayload {
    notebookspaceContent?: string;
    notebookspaceSelection?: string;
    [key: string]: unknown;
}

export interface UseChatEngineOptions {
    selectedAgent?: ChatAgent | null;
    currentConversation?: { id?: string | null;[key: string]: unknown } | null;
    /** Called when the stream creates or updates a conversation. */
    onConversationCreated?: (conversationId: string) => void;
    getNotebookPayload?: () => NotebookPayload | null;
    onNotebookUpdate?: (content?: string) => void;
    directMode?: DirectMode | null;
    /** Called with { conversationId, title } for direct chats. */
    onDirectConversationCreated?: (info: unknown) => void;
    activeProject?: { id?: string;[key: string]: unknown } | null;
    onNotebookDocUpdate?: (content: unknown, title?: unknown, version?: unknown) => void;
    onNotebookSourceAdded?: (source: unknown) => void;
    /**
     * The server refused to persist the turn because the stored encrypted
     * history can't be opened with this session's key (SSE `history_locked`).
     * Lets the page lock the composer.
     */
    onHistoryLocked?: (data: unknown) => void;
    onNotebookThemeUpdate?: (theme: unknown) => void;
    onWebpageDocUpdate?: (doc: { file: unknown; content: unknown; title: unknown }) => void;
    onWebpageSourceAdded?: (source: unknown) => void;
    onWebpageExtraUpdate?: (extra: { path: unknown; meta: unknown }) => void;
    onWebpageExtraDeleted?: (extra: { path: unknown }) => void;
    /** Gamma generation/preview data from Gamma tool results. */
    onGammaPreview?: (preview: unknown) => void;
    activeSkillIds?: string[];
    onSessionSkillsChanged?: (payload: unknown) => void;
    /**
     * Refetch the persisted conversation so a dropped stream can auto-recover
     * the saved reply (the server persists the finished message even when the
     * SSE connection drops mid/post-stream). Omitted → the interrupted notice
     * is shown as before.
     */
    reloadConversation?: () => Promise<ChatMessage[] | null | undefined>;
    testChat?: TestChatMode | null;
    /**
     * Chat signals: the fields to add to a turn on a counted endpoint (the
     * notice marker, and the opt-out when the person chose it). Asked only
     * for the endpoint the turn really goes to; a host that shows no notice
     * passes nothing, so its turns carry no marker and are not counted.
     */
    getChatSignalsPayload?: (surface: ChatSignalsTurnSurface) => Record<string, unknown> | null;
    /**
     * Only the main chat passes this. It switches on the "Remembered" chip: a
     * finished turn that could save memories gets a `memoryWatch` the message
     * row polls on. It answers why the person's memory is locked (paused by
     * them, off for the organisation), in which case nothing is watched.
     */
    getMemoryLock?: () => MemoryLock;
    /**
     * Incognito chat: set while it is on. Nothing of the conversation is stored
     * on the server; the whole history travels with every turn, memory is
     * neither read nor written, and no conversation id reaches the page (no
     * created callback, no URL, no list reload, no recovery poll). The
     * messages live in this hook's state only.
     */
    incognito?: TurnIncognito | null;
}
