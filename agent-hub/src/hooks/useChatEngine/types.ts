import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { ContentFlusher } from './contentFlusher';
import type { PhaseTrailEntry } from './phaseTrail';
import type { WorkItem } from './workSummary';
import type { TranslateFn } from '../useTranslation';

/**
 * The chat stream's vocabulary: the rows the engine renders, and the payloads
 * the server's SSE events carry.
 *
 * `SseEventData` names every field the dispatcher reads, and nothing else — a
 * field the server adds is invisible here until somebody writes it down, and a
 * typo in a field name stops being a silent `undefined`. The types are what
 * this client does with each field, not a claim about the server's schema:
 * anything the dispatcher only forwards stays `unknown`, so the screen that
 * renders it is the one that has to say what it is.
 */

/** The live status line above the typing dots. */
export interface CurrentPhase {
    stage?: string;
    detail?: string | null;
    startedAt?: number;
}

/** One sub-agent of a swarm turn, and what it is doing. */
export interface SwarmWorker {
    workerId?: string;
    role?: string;
    name?: string;
    tier?: string;
    modelId?: string;
    status?: string;
    content?: string;
    tools?: Array<{ name?: string; status?: string; at?: number }>;
    startedAt?: number;
    durationMs?: number | null;
    /** Whatever the worker failed with — a sentence or an upstream object. */
    error?: unknown;
    [key: string]: unknown;
}

/** A swarm turn's plan, phases and workers, as the panel renders them. */
export interface SwarmState {
    phaseStates?: Record<string, Record<string, unknown>>;
    workers?: Record<string, SwarmWorker>;
    [key: string]: unknown;
}

/** Which session skills this turn activated, and what they finished. */
export interface SessionSkillsSnapshot {
    activatedSkillIds?: unknown[];
    completedSkillIds?: unknown[];
    completions?: unknown[];
    [key: string]: unknown;
}

/** A live browser session the answer is driving. */
export interface BrowserPreview {
    sessionId?: string;
    url?: string;
    task?: string;
    queued?: boolean;
    queuePosition?: number | null;
    frame?: string | null;
    action?: string | null;
    ended?: boolean;
    [key: string]: unknown;
}

/**
 * One row of the transcript.
 *
 * The named fields are the ones the engine and its dispatcher read; a screen
 * hangs more off a message than this (previews per integration, per-tool
 * cards), and those travel through the index signature untyped — the component
 * that renders one is where its shape belongs.
 */
export interface ChatMessage {
    id: string;
    role?: string;
    content?: string;
    parentId?: string | null;
    isStreaming?: boolean;
    isError?: boolean;
    modelId?: string;
    modelTier?: string;
    autoSelectedTier?: string;
    // reasoning
    thinking?: string;
    thinkingParts?: ThinkingPart[];
    thinkingStartedAt?: number;
    thinkingSteps?: Array<Record<string, unknown>>;
    // progress
    currentPhase?: CurrentPhase | null;
    phaseTrail?: PhaseTrailEntry[];
    swarm?: SwarmState;
    // tools and their results
    toolCall?: Record<string, unknown> | null;
    toolHistory?: Array<Record<string, unknown>>;
    toolResults?: Array<Record<string, unknown>>;
    pendingToolCalls?: Array<Record<string, unknown>>;
    browserPreview?: BrowserPreview | null;
    // knowledge and skills
    kbSources?: KbSource[];
    /** The memories this turn drew on (SSE `memory_used`, persisted on the message). */
    memoryUsed?: MemoryUsedItem[];
    /** Set when the finished turn may have saved memories; the "Remembered" chip polls on it. */
    memoryWatch?: { conversationId: string; since: string; until?: string } | null;
    sessionSkillsSnapshot?: SessionSkillsSnapshot;
    // media and files the turn produced or carried
    attachments?: unknown[];
    files?: unknown[];
    images?: unknown[];
    audioFiles?: unknown[];
    videoFiles?: unknown[];
    mapEmbeds?: unknown[];
    // drafts the user can confirm
    calendarDrafts?: Array<Record<string, unknown>>;
    contactsDrafts?: Array<Record<string, unknown>>;
    emailDrafts?: Array<Record<string, unknown>>;
    keepDrafts?: Array<Record<string, unknown>>;
    linkedInDrafts?: Array<Record<string, unknown>>;
    // privacy shield
    piiCategories?: unknown[];
    piiScanWarnings?: unknown[];
    piiTokenizedCount?: number;
    tokenisationInfo?: TokenisationInfo | null;
    // what this turn is credited with creating
    workItem?: WorkItem | null;
    // a turn that failed AFTER some of its tools finished (BFSF-349): how many
    // finished, and the error alone (the content also carries the reply so far)
    completedToolCount?: number;
    errorDetail?: string;
    [key: string]: unknown;
}

/** One reasoning block of an assistant turn. */
export interface ThinkingPart {
    id: string;
    text: string;
    startedAt?: number;
    endedAt?: number | null;
    [key: string]: unknown;
}

/** A skill as the session-skills events describe it. */
export interface SkillSummary {
    id?: string;
    name?: string;
    description?: string;
    icon?: string;
    [key: string]: unknown;
}

/** One scanned attachment, as the Privacy Shield reports it. */
export interface PiiAttachment {
    filename?: string;
    reason?: string;
    timeout?: boolean;
    overflow?: boolean;
    action?: string;
    scannedPages?: number;
    [key: string]: unknown;
}

/** What the shield replaced on this turn, merged across the message-level and
 *  attachment-level passes (both can fire on one turn). */
export interface TokenisationInfo {
    source?: string;
    action?: string;
    count?: number;
    categories?: unknown[];
    provider?: unknown;
    automatic?: boolean;
    attachments?: unknown[];
    tokenMap?: unknown;
    tokenizedPrompt?: unknown;
    rawResponse?: unknown;
    rawTruncated?: unknown;
    [key: string]: unknown;
}

/** One memory the answer drew on: id, type and a preview of at most 120 characters. */
export interface MemoryUsedItem {
    id: string;
    type: string;
    /** Live (SSE) items carry a preview; the persisted list on a reload does not. */
    preview?: string;
    /** 'profile' = standing instructions and preferences; 'relevant' = picked for this message. Older messages have none. */
    why?: 'profile' | 'relevant';
}

/** A knowledge-base chunk cited by the answer; deduplicated on `content`. */
export interface KbSource {
    content?: string;
    [key: string]: unknown;
}

export interface SseEventData {
    // ── content and reasoning ──────────────────────────────────────────
    text?: string;
    delta?: string;
    content?: string;
    partId?: string;
    role?: string;
    respondingAgentName?: string;
    respondingAgentAvatar?: string;

    // ── phases ─────────────────────────────────────────────────────────
    stage?: string;
    status?: string;
    detail?: string | null;
    durationMs?: number;
    phaseId?: string;
    phases?: unknown;
    message?: string;

    // ── plans and questions ────────────────────────────────────────────
    planId?: string;
    plan?: unknown;
    questions?: unknown;
    appliedChoice?: unknown;

    // ── swarm workers ──────────────────────────────────────────────────
    workerId?: string;
    worker?: unknown;
    swarmId?: string;
    swarmName?: string;
    depth?: number;
    instanceId?: string;

    // ── tools ──────────────────────────────────────────────────────────
    name?: string;
    toolName?: string;
    tool?: string;
    args?: Record<string, unknown>;
    argsKey?: string;
    result?: unknown;
    /** A sentence, or the object an upstream failure came back as. */
    error?: string | { message?: string } | null;

    // ── skills ─────────────────────────────────────────────────────────
    skills?: SkillSummary[];
    skillId?: string;
    activatedSkillIds?: unknown;
    completedSkillIds?: unknown;

    // ── browser preview ────────────────────────────────────────────────
    sessionId?: string;
    task?: string;
    queuePosition?: number | null;
    b64?: string;
    summary?: string;

    // ── drafts the chat can act on ─────────────────────────────────────
    to?: unknown;
    subject?: string;
    body?: unknown;
    email?: string;
    phone?: string;
    title?: string;
    // a calendar draft's own fields — the pair this turn is deduplicated on
    action?: string;
    startTime?: string;
    endTime?: string;
    eventId?: string;

    // ── documents, webpages, notebooks, slides, sheets ─────────────────
    url?: string;
    webUrl?: string;
    path?: string;
    file?: unknown;
    meta?: unknown;
    mimeType?: string;
    data?: unknown;
    documentId?: string;
    /** document_suggestions: the batch the AI proposed and how many changes it holds. */
    batchId?: string;
    count?: number;
    version?: string | number;
    theme?: unknown;
    slides?: unknown;
    blocks?: unknown;
    cells?: unknown;
    sheetIndex?: number;
    notebookspaceContent?: string;
    attachments?: PiiAttachment[];

    // ── knowledge and attribution ──────────────────────────────────────
    sources?: KbSource[];
    /** `memory_used`: the memories retrieved for this turn. */
    items?: MemoryUsedItem[];
    rules?: unknown[];

    // ── privacy shield / DLP ───────────────────────────────────────────
    redacted?: boolean;
    redactedCount?: number;
    redactedMessage?: string;
    entities?: Array<{ label?: string; category?: string; [key: string]: unknown }>;
    categories?: string[];
    tokenMap?: unknown;
    violation?: unknown;
    framework?: string;
    automatic?: boolean;
    autoRedactSeconds?: number;
    autoDeleteSeconds?: number;

    // ── attachment scanning ────────────────────────────────────────────
    filename?: string;
    kind?: string;
    reason?: string;
    tokenCount?: number;
    tokenizedPrompt?: unknown;
    rawResponse?: unknown;
    refinedQuery?: string;
    truncated?: boolean;
    paused?: boolean;

    // ── session and model ──────────────────────────────────────────────
    conversationId?: string;
    modelId?: string;
    tier?: string;
    /** A name on the model events, the provider record on the shield ones. */
    provider?: string | { displayName?: string } | null;
    runtime?: string;
    source?: string;
    fromAuto?: boolean;
    originalTokens?: number;
    keptTokens?: number;
}

/** The engine's own state setters and the stable refs that always point at the
 *  latest callback props. The hook builds this; the dispatcher only reads it. */
export interface SseDispatchContext {
    setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
    onConversationCreated?: (conversationId: string) => void;
    onNotebookUpdate?: (content?: string) => void;
    onSessionSkillsChanged?: (payload: unknown) => void;
    tRef: RefObject<TranslateFn>;
    onGammaPreviewRef: CallbackRef<(preview: unknown) => void>;
    onNotebookDocUpdateRef: CallbackRef<(content: unknown, title?: unknown, version?: unknown) => void>;
    onNotebookSourceAddedRef: CallbackRef<(source: unknown) => void>;
    onHistoryLockedRef: CallbackRef<(data: unknown) => void>;
    onNotebookThemeUpdateRef: CallbackRef<(theme: unknown) => void>;
    onWebpageDocUpdateRef: CallbackRef<(doc: { file: unknown; content: unknown; title: unknown }) => void>;
    onWebpageSourceAddedRef: CallbackRef<(source: unknown) => void>;
    onWebpageExtraUpdateRef: CallbackRef<(extra: { path: unknown; meta: unknown }) => void>;
    onWebpageExtraDeletedRef: CallbackRef<(extra: { path: unknown }) => void>;
}

/** A ref holding a callback prop that may not have been passed. */
export type CallbackRef<F> = RefObject<F | undefined>;

/** Per-stream identifiers and mutable state for one turn. */
export interface SseDispatchIds {
    assistantMsgId: string;
    userMsgId: string;
    activeIdRef: RefObject<string | null>;
    contentRef: RefObject<string>;
    flusher: ContentFlusher;
    workRef: RefObject<WorkItem | null>;
}
