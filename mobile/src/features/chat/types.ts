/**
 * Chat shapes, taken from the server's own row definitions rather than guessed:
 *   server/stores/agent/directConversations.js listDirectConversations()
 *   server/routes/ai/directChat/streamTurn.js   (the SSE frames)
 *   agent-hub/src/hooks/useChatEngine/sseEvents.js (the 70 event names)
 */

/**
 * A tier key. NOT an enum: the set is fetched per user and per task type, and
 * org-defined tiers arrive as `custom:<id>`. See tiers.ts for why hardcoding
 * this was wrong.
 */
export type ModelTier = string;

/**
 * Thinking effort. Sent as `reasoningEffort`; when omitted the tier's own
 * configured effort applies. Deliberately NOT persisted across sessions — a
 * stale stored value silently pins Deep Thinking to 'low' forever, which is
 * the bug TierSlider on the web exists to clear.
 */
export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ConversationSummary {
    id: string;
    title: string | null;
    model_tier?: string | null;
    project_id?: string | null;
    shared_scope?: string | null;
    pinned?: boolean;
    /** JSON string of label ids — the column is `labels_json`. */
    labels_json?: string | null;
    created_at: string;
    updated_at: string;
}

export interface Attachment {
    /** Server-assigned id once uploaded; a local uri before that. */
    id?: string;
    name: string;
    mimeType?: string;
    size?: number;
    /** Local file uri, before the file is read and encoded. */
    uri?: string;
    /**
     * The base64 data URL sent to the server as `content`. Filled in by
     * attachments.ts at send time, not at pick time — see that file for why
     * the resize has to happen first.
     */
    dataUrl?: string;
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ChatMessage {
    id: string;
    role: MessageRole;
    content: string;
    attachments?: Attachment[];
    createdAt?: string;
    /** Set while the assistant turn is still streaming. */
    streaming?: boolean;
    /** The turn was cut off — by the user, a disconnect, or a server error. */
    interrupted?: boolean;
    /** Model reasoning, when the model emits it and the user has it shown. */
    thinking?: string;
    /** Tool activity for this turn, newest last. */
    tools?: ToolActivity[];
    /** Knowledge-base citations attached to this answer. */
    sources?: KbSource[];
    /** Generated images, as data URIs. */
    images?: { data: string; mimeType: string }[];
    /** A hard error that replaced the answer. */
    error?: string;
}

export interface ToolActivity {
    id: string;
    name: string;
    status: 'running' | 'done' | 'error';
    /** Short human summary — "Searched the web for …". */
    detail?: string;
}

/**
 * One citation, as `server/core/kb/citation.js` builds it.
 *
 * Everything past the title is optional, on the server side too: a document
 * ingested before the chunker stamped pages has no page, and one that is not a
 * table has no rows. A card renders what it was given and says less otherwise
 * — it never shows a gap where a number would have gone.
 *
 * `snippet` is this app's name for the passage; the server sends it as
 * `content` (with `preview` as a one-release alias). `kbSources.ts` is where
 * the two meet — nothing else should read the raw payload.
 */
export interface KbSource {
    id?: string;
    title?: string;
    url?: string;
    snippet?: string;
    score?: number;
    /** Retrieval kind — 'kb_chunk' | 'meeting' | 'datatable' | 'webpage' | … */
    kind?: string;
    /** The heading the passage sits under. */
    section?: string;
    /** 1-based page, when the chunker knew one. */
    page?: number;
    /** First and last table row this passage covers, 1-based and inclusive. */
    rowStart?: number;
    rowEnd?: number;
    /** When the cited thing happened (a meeting's own date), ISO. */
    occurredAt?: string;
    /** What a tap would open, once these cards can be tapped. */
    documentId?: string;
    chunkId?: string;
}

export interface Conversation extends ConversationSummary {
    messages: ChatMessage[];
    workspace_content?: string | null;
}

export interface ChatLabel {
    id: string;
    name: string;
    color?: string | null;
}

/**
 * What the composer sends. Mirrors the payload agent-hub's useChatEngine
 * builds for /ai/chat/direct/stream — the field names are the contract.
 */
export interface SendTurnPayload {
    message: string;
    conversationId?: string;
    modelTier: ModelTier;
    /**
     * Inline, base64 data URLs. There is NO separate upload endpoint for chat
     * attachments; they ride in this body, under Express's 20 MB limit.
     */
    attachments: { name: string; type: string; size: number; content: string }[];
    /** Only for a brand-new conversation, or an edit/retry. */
    history?: { role: MessageRole; content: string }[];
    projectId?: string;
    webSearchEnabled: boolean;
    memoryWriteEnabled: boolean;
    reasoningEffort?: ReasoningEffort;
    activeSkillIds?: string[];
    /** Knowledge bases to retrieve from for this turn. */
    knowledgeBaseIds?: string[];
    /** IANA zone — the server dates relative expressions with it. */
    timezone: string;
}

/**
 * The live state of one streaming turn.
 *
 * Kept separate from ChatMessage so the reducer can update the in-flight turn
 * at 60fps without touching the persisted message list — the whole list would
 * otherwise re-render on every token.
 */
export interface StreamingTurn {
    text: string;
    thinking: string;
    thinkingActive: boolean;
    phase: string | null;
    tools: ToolActivity[];
    sources: KbSource[];
    images: { data: string; mimeType: string }[];
    modelId: string | null;
    /** Set when the server refuses on DLP/guardrail grounds. */
    blocked: { reason: string; detail?: string } | null;
    /**
     * A data-loss-prevention decision the server is BLOCKED on, waiting for a
     * human answer. The stream does not advance until the app POSTs to
     * /api/chat/dlp-decision — a client that ignores this appears to hang
     * forever with no error, which is exactly what the first version did.
     */
    dlpDecision: DlpDecision | null;
    /** Live swarm progress; only ever populated on a `swarm` tier turn. */
    swarm: SwarmProgress | null;
    /** The server assigns this mid-stream via `conversation_created`. */
    conversationId: string | null;
    /** Auto-generated title, arriving on the `title` event. */
    title: string | null;
    error: string | null;
    done: boolean;
}

export interface DlpDecision {
    decisionId: string;
    /** What the scanner found, as the server described it. */
    summary: string;
    /** Category counts, when the server sends them. */
    findings?: { category: string; count: number }[];
}

export interface SwarmProgress {
    phase: string | null;
    workers: {
        id: string;
        name: string;
        status: 'running' | 'done';
        /** Accumulated output from this worker. */
        text: string;
    }[];
    completed: boolean;
}

/** One chat-local skill (server/core/tools/sessionSkillRuntime.js). */
export interface SessionSkill {
    id: string;
    name: string;
    description?: string;
    instructions?: string;
    workflow?: string;
}

/** GET /ai/direct/conversations/:id/session-skills. */
export interface SessionSkillsResponse {
    skills: SessionSkill[];
    activatedSkillIds: string[];
    modelTier: string;
}
