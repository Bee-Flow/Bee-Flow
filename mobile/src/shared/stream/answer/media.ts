/**
 * What an answer brings besides its words: citations, the media and files a
 * tool made, the drafts the assistant prepared for a person to send, and the
 * actions it wanted to take and was stopped from — the web's cases of the
 * same names in agent-hub/src/hooks/useChatEngine/sseEvents.ts.
 */

import type { FrameData, FrameHandler } from '../chatFrameReducer';
import { recordOf, str } from '../handlers';
import { mergeKbSources, toKbSources } from '../kbSources';
import type { AnswerParts, DraftKind, DraftRecord, GeneratedFile, PendingToolCall } from '../types';

/** A whole number above zero, or nothing. */
function count(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Every round of a turn sends its own citations; the web keeps them all, minus repeats. */
export const kbSourcesMerged: FrameHandler<Pick<AnswerParts, 'sources'>> = (turn, d) => {
    const incoming = toKbSources(d.sources);
    if (!incoming.length) return false;
    turn.sources = mergeKbSources(turn.sources, incoming);
};

/** Speech, music or a sound a tool generated. Its album art is the turn's first image. */
export const audioAdded: FrameHandler<Pick<AnswerParts, 'audio'>> = (turn, d) => {
    const url = str(d.url);
    if (!url) return false;
    turn.audio = [...turn.audio, { url, mimeType: str(d.mimeType) || 'audio/mpeg', source: str(d.source) || 'elevenlabs' }];
};

export const videoAdded: FrameHandler<Pick<AnswerParts, 'video'>> = (turn, d) => {
    const url = str(d.url);
    const mimeType = str(d.mimeType);
    if (!url || !mimeType) return false;
    turn.video = [...turn.video, { url, mimeType }];
};

/** A file as `file` sends it (a deck the presentation renderer built), or as a saved turn keeps it. */
export function readGeneratedFile(raw: unknown): GeneratedFile | null {
    const d = recordOf(raw);
    if (!d) return null;
    const file: GeneratedFile = {
        url: str(d.url) || undefined,
        webUrl: str(d.webUrl) || undefined,
        name: str(d.name) || undefined,
        kind: str(d.kind) || undefined,
        slideCount: count(d.slideCount),
        size: count(d.size),
        path: str(d.path) || undefined,
        documentId: str(d.documentId) || undefined,
    };
    return file.url || file.webUrl ? file : null;
}

/** Shown whether or not the model remembers to write the link. */
export const fileAdded: FrameHandler<Pick<AnswerParts, 'files'>> = (turn, d) => {
    const file = readGeneratedFile(d);
    if (!file) return false;
    turn.files = [...turn.files, file];
};

export const mapEmbedded: FrameHandler<Pick<AnswerParts, 'maps'>> = (turn, d) => {
    const map = { embedUrl: str(d.embedUrl) || undefined, title: str(d.title) || undefined, mapsLink: str(d.mapsLink) || undefined };
    if (!map.embedUrl && !map.mapsLink) return false;
    turn.maps = [...turn.maps, map];
};

/**
 * Which fields make two drafts the same draft, per kind — the web's dedupe
 * keys. A LinkedIn post has none: the web stacks every one it is sent.
 * (Calendar keys on the real draft fields, BFSF-123.)
 */
const SAME_DRAFT: Record<DraftKind, readonly string[] | null> = {
    email: ['to', 'subject', 'body'],
    calendar: ['action', 'title', 'startTime', 'endTime', 'eventId'],
    linkedin: null,
    contacts: ['name', 'email', 'phone'],
    keep: ['title', 'content'],
};

export function draftKey(kind: DraftKind, draft: DraftRecord): string | null {
    const fields = SAME_DRAFT[kind];
    return fields ? JSON.stringify(fields.map((f) => draft[f] ?? null)) : null;
}

/** One `*_draft` frame: the record as sent, which the card posts back on approval. */
export function draftAdded(kind: DraftKind): FrameHandler<Pick<AnswerParts, 'drafts'>> {
    return (turn, d) => {
        const draft: DraftRecord = { ...d };
        const key = draftKey(kind, draft);
        if (key !== null && turn.drafts[kind].some((x) => draftKey(kind, x) === key)) return false;
        turn.drafts = { ...turn.drafts, [kind]: [...turn.drafts[kind], draft] };
    };
}

/** A held call as the server describes it (toolRoundExecutor.js `pending`). */
export function readPendingCall(d: FrameData): PendingToolCall {
    return {
        callId: str(d.callId) || undefined,
        argsKey: str(d.argsKey) || undefined,
        toolName: str(d.toolName) || str(d.name) || 'tool',
        effect: str(d.effect) || undefined,
        preview: recordOf(d.preview),
        status: str(d.status) || 'pending',
    };
}

/**
 * A call the agent did NOT run because a person has to say yes. Keyed on
 * `argsKey` — name plus arguments, hashed by the server — so the same action
 * proposed again updates its card, and a decision about one e-mail is never
 * read as a decision about another.
 */
export const toolConfirmed: FrameHandler<Pick<AnswerParts, 'pendingToolCalls'>> = (turn, d) => {
    const argsKey = str(d.argsKey);
    if (!argsKey) return false;
    const call = readPendingCall(d);
    const list = turn.pendingToolCalls.slice();
    const at = list.findIndex((c) => c.argsKey === argsKey);
    if (at >= 0) list[at] = { ...list[at], ...definedOnly(call) } as PendingToolCall;
    else list.push(call);
    turn.pendingToolCalls = list;
};

function definedOnly<T extends object>(value: T): Partial<T> {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
