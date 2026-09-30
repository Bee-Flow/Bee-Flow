/**
 * The shapes a streamed chat turn is made of, shared by every surface that
 * streams one (direct chat, agents, notebooks, the meeting assistant).
 *
 * Written from the server's frames rather than guessed:
 *   server/routes/ai/directChat/streamTurn.js     (direct chat)
 *   server/core/agentRuntime/**                    (agents)
 *   agent-hub/src/hooks/useChatEngine/sseEvents.ts (the web's switch)
 * features/chat/model/types.ts re-exports them under the same names.
 */

export interface ToolActivity {
    id: string;
    name: string;
    status: 'running' | 'done' | 'error';
    /** Short human summary — "Searched the web for …". */
    detail?: string;
    /** The call's arguments (`tool_start.args`, and `args` on a saved toolHistory row). */
    args?: Record<string, unknown>;
    /** When the call started and ended, ms since the epoch — the row's duration pill. */
    startTime?: number;
    endTime?: number;
    /** The result cut to a line, which is all a saved turn keeps. */
    resultPreview?: string;
    /** The whole result, while the turn is live. A reloaded turn has only the preview. */
    result?: unknown;
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
    /**
     * Whether the server sent the passage itself (`content`), not just the
     * one-release `preview`. Only then is there something to open: the web's
     * citationIsOpenable reads `content` and nothing else.
     */
    openable?: boolean;
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
    /** What a tap would open. */
    documentId?: string;
    chunkId?: string;
    /** A live table row: the table it came from, its name and the row's id. */
    datatableId?: string;
    rowId?: string;
    sourceName?: string;
}

/** One finding in a message under review, with where it sits in `reviewText`. */
export interface DlpFinding {
    id: string;
    label?: string;
    category?: string;
    /** 'pii' | 'custom' | 'manual' */
    source?: string;
    confidenceBand?: string | null;
    offset?: number;
    length?: number;
    text?: string;
}

export interface DlpDecision {
    decisionId: string;
    /** What the scanner found, as the server described it. */
    summary: string;
    /** The typed message, or an attachment, waiting on a person. */
    kind: 'chat_text' | 'attachment';
    /** The text the findings' offsets count into. Absent on an older server. */
    reviewText?: string;
    /** The attachment's name, on `dlp_attachment_preview`. */
    filename?: string;
    findings: DlpFinding[];
    /** Where the prompt is going: `{ displayName, isExternal }`. */
    provider?: { displayName?: string; isExternal?: boolean };
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

/** A generated image as the stream sends it: inline base64. */
export interface TurnImage {
    data: string;
    mimeType: string;
}

/** The server stopped for a policy reason. Not an error — it gets its own UI. */
export interface TurnBlock {
    reason: string;
    detail?: string;
}

/** What every streamed turn has, whatever surface it is on. */
export interface TurnBase {
    error: string | null;
    done: boolean;
    /**
     * A privacy question the server is holding this turn open for, on the
     * surfaces that can ask one (direct chat, agents). Only a LIVE turn can
     * hold one: the runner drops it when the turn ends, because the server
     * forgets the question with the turn and answers every late reply 404.
     */
    dlpDecision?: DlpDecision | null;
}

// ── The anatomy of an answer (the web's ChatMessage fields) ───────────────

/** One reasoning block, timed. A redacted part has no readable text. */
export interface ThinkingPart {
    id: string;
    text: string;
    startedAt: number | null;
    endedAt: number | null;
    redacted?: boolean;
    phase?: string;
}

/** One step of the durable phase trail (the port of phaseTrail.ts). */
export interface PhaseTrailEntry {
    stage: string;
    detail: string | null;
    startedAt: number;
    endedAt: number | null;
    durationMs: number | null;
}

/** The one live status line above the typing dots. */
export interface CurrentPhase {
    stage: string;
    detail: string | null;
    startedAt: number;
}

/** A tool the agent wanted to run and did not, waiting on a person. */
export interface PendingToolCall {
    callId?: string;
    /** Name plus arguments, hashed by the server: what a decision quotes back. */
    argsKey?: string;
    toolName: string;
    /** 'sends' when the action leaves the workspace. */
    effect?: string;
    /** The server's bounded, flat view of the arguments. */
    preview?: Record<string, unknown>;
    /** 'pending' | 'approved' | 'declined' — or anything else, read as unknown. */
    status: string;
}

/** A draft the assistant prepared: the server's record, posted back on approval. */
export type DraftRecord = Readonly<Record<string, unknown>>;

export type DraftKind = 'email' | 'calendar' | 'linkedin' | 'contacts' | 'keep';

export type Drafts = Readonly<Record<DraftKind, readonly DraftRecord[]>>;

export interface AudioFile {
    url: string;
    mimeType: string;
    /** 'elevenlabs_music' | 'elevenlabs_tts' | 'elevenlabs_sfx' | 'lyria' | … */
    source?: string;
}

export interface VideoFile {
    url: string;
    mimeType: string;
}

/** A file a tool built (a deck): where it lives and what it is. */
export interface GeneratedFile {
    url?: string;
    webUrl?: string;
    name?: string;
    kind?: string;
    slideCount?: number;
    size?: number;
    path?: string;
    documentId?: string;
}

export interface MapEmbed {
    embedUrl?: string;
    title?: string;
    mapsLink?: string;
}

/** One scanned attachment, as the Privacy Shield reports it. */
export interface PrivacyAttachment {
    filename?: string;
    reason?: string;
    timeout?: boolean;
    overflow?: boolean;
    truncated?: boolean;
    action?: string;
    scannedPages?: number;
    totalPages?: number;
    byCategory?: Record<string, number>;
    pages?: Record<string, Record<string, number>>;
}

/** What the shield replaced on this turn, and — when the org opted in — what the model saw. */
export interface TokenisationInfo {
    source?: string;
    action?: string;
    count?: number;
    categories: string[];
    provider?: string | null;
    automatic?: boolean;
    attachments?: PrivacyAttachment[];
    tokenMap?: Record<string, string>;
    tokenizedPrompt?: string;
    rawResponse?: string;
    rawTruncated?: boolean;
}

/** A scan that did not cover the whole upload: the amber "Scan incomplete". */
export interface ScanWarning {
    filename?: string;
    reason?: string;
    scannedPages?: number;
    totalPages?: number;
}

/** What the shield did to the QUESTION — it lands on the user's message. */
export interface UserPrivacy {
    tokenizedCount: number;
    dlpRedactedCount: number;
    categories: string[];
    scanWarnings: ScanWarning[];
}

/**
 * Everything an assistant turn can carry besides its text, shared by direct
 * chat and agents so the transcript draws one anatomy from either.
 */
export interface AnswerParts {
    thinking: string;
    thinkingActive: boolean;
    thinkingParts: ThinkingPart[];
    thinkingStartedAt: number | null;
    thinkingEndedAt: number | null;
    currentPhase: CurrentPhase | null;
    phaseTrail: PhaseTrailEntry[];
    tools: ToolActivity[];
    sources: KbSource[];
    images: TurnImage[];
    audio: AudioFile[];
    video: VideoFile[];
    files: GeneratedFile[];
    maps: MapEmbed[];
    drafts: Drafts;
    pendingToolCalls: PendingToolCall[];
    tokenisation: TokenisationInfo | null;
    userPrivacy: UserPrivacy | null;
    /** The rules a second model judged this answer to follow (test chat only). */
    ruleAttribution: string[] | null;
    modelId: string | null;
    modelTier: string | null;
    /** The tier Auto picked, when the person was on Auto. */
    autoSelectedTier: string | null;
    /** The server could not open this conversation's history: the composer locks. */
    historyLocked: boolean;
}

export const NO_DRAFTS: Drafts = { email: [], calendar: [], linkedin: [], contacts: [], keep: [] };

export function emptyAnswerParts(): AnswerParts {
    return {
        thinking: '',
        thinkingActive: false,
        thinkingParts: [],
        thinkingStartedAt: null,
        thinkingEndedAt: null,
        currentPhase: null,
        phaseTrail: [],
        tools: [],
        sources: [],
        images: [],
        audio: [],
        video: [],
        files: [],
        maps: [],
        drafts: NO_DRAFTS,
        pendingToolCalls: [],
        tokenisation: null,
        userPrivacy: null,
        ruleAttribution: null,
        modelId: null,
        modelTier: null,
        autoSelectedTier: null,
        historyLocked: false,
    };
}
