/**
 * Chat shapes, taken from the server's own row definitions rather than guessed:
 *   server/stores/agent/directConversations.js listDirectConversations()
 *   server/routes/ai/directChat/streamTurn.js   (the SSE frames)
 *   agent-hub/src/hooks/useChatEngine/sseEvents.js (the 70 event names)
 */

import type {
    AudioFile,
    CurrentPhase,
    Drafts,
    GeneratedFile,
    KbSource,
    MapEmbed,
    PendingToolCall,
    PhaseTrailEntry,
    ThinkingPart,
    TokenisationInfo,
    ToolActivity,
    UserPrivacy,
    VideoFile,
} from '@/shared/stream';

// The streamed-turn shapes live with the stream stack; re-exported so chat
// code keeps one place to import its types from.
export type {
    AudioFile,
    CurrentPhase,
    DlpDecision,
    DlpFinding,
    DraftKind,
    DraftRecord,
    Drafts,
    GeneratedFile,
    KbSource,
    MapEmbed,
    PendingToolCall,
    PhaseTrailEntry,
    PrivacyAttachment,
    ScanWarning,
    StreamingTurn,
    SwarmProgress,
    ThinkingPart,
    TokenisationInfo,
    ToolActivity,
    UserPrivacy,
    VideoFile,
} from '@/shared/stream';

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

/**
 * What the assistant will read on the next turn — the composer's context row
 * and ＋ sheet edit it.
 */
export interface ChatContext {
    knowledgeBaseIds: string[];
    webSearchEnabled: boolean;
    modelTier: ModelTier;
}

export interface ComposerSettings extends ChatContext {
    /**
     * Per-question, never remembered: a stored "high" would quietly spend a
     * user's allowance on every trivial question they asked afterwards. Set
     * only by the re-ask actions under a finished answer.
     */
    reasoningEffort: ReasoningEffort | null;
}

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
    /** Model reasoning as one block — the non-redacted parts, joined. */
    thinking?: string;
    /** The reasoning as the model wrote it: timed parts, some redacted. */
    thinkingParts?: ThinkingPart[];
    /** The turn's phases with their durations (live only; the server keeps no trail). */
    phaseTrail?: PhaseTrailEntry[];
    /** The one live status line, while the answer streams. */
    currentPhase?: CurrentPhase;
    /** Tool activity for this turn, newest last. */
    tools?: ToolActivity[];
    /** Knowledge-base citations attached to this answer. */
    sources?: KbSource[];
    /** Generated images: inline while streaming, by URL once persisted. */
    images?: ChatImage[];
    audio?: AudioFile[];
    video?: VideoFile[];
    /** Files a tool built (a deck). */
    files?: GeneratedFile[];
    maps?: MapEmbed[];
    /** Drafts the assistant prepared for a person to send or save. */
    drafts?: Drafts;
    /** Actions the agent wanted to take and was held from. */
    pendingToolCalls?: PendingToolCall[];
    /** What the Privacy Shield did to this turn (on the answer). */
    tokenisation?: TokenisationInfo;
    /** What the Privacy Shield did to this question (on the user's message). */
    privacy?: UserPrivacy;
    /**
     * View-only, never read from the server: the token map of the answer to
     * this question, which is where the shield's placeholders are listed
     * (ChatTranscript derives it for the privacy line).
     */
    turnTokenMap?: Record<string, string> | null;
    /** View-only: the question an answer replied to, for its privacy sheet's "Original message". */
    questionText?: string;
    /**
     * Local only, on a question asked this session: the saved message it was
     * asked after (null: none). Tells the hand-back this turn's saved copy
     * from an earlier question with the same words ("yes", "continue").
     */
    sentAfter?: string | null;
    /**
     * Local only, on a question asked this session: it replaces saved
     * messages (an edit or a retry the server was told to truncate for).
     */
    replaces?: boolean;
    /** Rules a second model judged the answer to follow (test chat only). */
    ruleAttribution?: string[];
    modelId?: string;
    modelTier?: string;
    autoSelectedTier?: string;
    /** A reply inside a thread. The web never lists these in the main transcript. */
    parentId?: string | null;
    /** A hard error that replaced the answer. */
    error?: string;
}

/**
 * One generated image. The stream sends base64 `data`; the server then stores
 * the file and persists only `{url, mimeType, storageKey}`
 * (routes/ai/directChat/finalizeTurn.js), keeping `data` just for an image it
 * could not store. So a reloaded message has either one, never a guarantee of
 * both.
 */
export interface ChatImage {
    data?: string;
    /** Server-relative (`/api/storage/…`, `/uploads/…`) or absolute. */
    url?: string;
    mimeType: string;
}

export interface Conversation extends ConversationSummary {
    messages: ChatMessage[];
    workspace_content?: string | null;
    /**
     * The knowledge bases attached to this conversation, as the server
     * re-checked them for THIS reader on this read (conversationRoutes.js).
     */
    knowledgeBaseIds: string[];
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
    /** The image generator's defaults (the web's `imageGenSettings`). */
    imageGenSettings?: Record<string, unknown>;
    /** Every generator's defaults by section — image, video, lyria, elevenlabs, sfx. */
    nanoBananaSettings?: Record<string, unknown>;
    /** Generators switched off for this chat: `{ image, music, video, elevenlabs }`. */
    disabledMedia?: Record<string, boolean>;
    /** IANA zone — the server dates relative expressions with it. */
    timezone: string;
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
