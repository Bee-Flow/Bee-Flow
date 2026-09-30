/**
 * One persisted message, read through the contract.
 *
 * The server saves a turn with the names finalizeTurn.js writes (the direct
 * chat's and the agent runtime's), which are not all the names this app uses:
 * reading only the app's names is how a reopened chat once lost its tool
 * steps, its citations and its dates. Every field an answer can carry on the
 * web — reasoning parts, drafts, media, held actions, the privacy record — is
 * read here, so a reopened chat draws what the streamed one did.
 */

import { field, shapeOf } from '@/core/api/contract';
import {
    readGeneratedFile,
    readPendingCall,
    readPrivacyAttachment,
    readTokenMap,
    recordOf,
    toKbSources,
    type DraftRecord,
    type Drafts,
    type ScanWarning,
    type ThinkingPart,
    type TokenisationInfo,
    type UserPrivacy,
} from '@/shared/stream';

import type { ChatImage, ChatMessage, KbSource, ToolActivity } from '../model/types';

const readAttachment = shapeOf({
    id: field.optStr,
    name: field.str(''),
    mimeType: field.optStr,
    size: field.optNum,
    uri: field.optStr,
    dataUrl: field.optStr,
});

const readTool = shapeOf({
    id: field.str(''),
    name: field.str('Tool'),
    status: field.oneOf(['running', 'done', 'error'] as const, 'done'),
    detail: field.optStr,
    args: recordOf,
    startTime: field.optNum,
    endTime: field.optNum,
    resultPreview: field.optStr,
});

/**
 * Tool steps. The server persists `{name, args, status, resultPreview}` rows
 * with no id (routes/ai/directChat/toolExec.js), so the position stands in
 * for one — every row needs a key, and a list of '' keys is not a list.
 */
function tools(value: unknown): ToolActivity[] | undefined {
    if (!Array.isArray(value)) return undefined;
    return value.map((raw, i) => {
        const tool = readTool(raw);
        return tool.id ? tool : { ...tool, id: `tool-${i}` };
    });
}

/**
 * Generated images: `{data}` inline, or `{url, storageKey}` once the server
 * stored the file (see ChatImage). One with neither has nothing to draw.
 */
const readImage = shapeOf({ data: field.optStr, url: field.optStr, mimeType: field.str('image/png') });

function images(value: unknown): ChatImage[] | undefined {
    if (!Array.isArray(value)) return undefined;
    return value.map(readImage).filter((image) => Boolean(image.data || image.url));
}

function sources(value: unknown): KbSource[] | undefined {
    return Array.isArray(value) ? toKbSources(value) : undefined;
}

function isTextBlock(value: unknown): value is { type: 'text'; text: string } {
    const block = value as { type?: unknown; text?: unknown } | null;
    return block?.type === 'text' && typeof block.text === 'string';
}

/**
 * Message text. A turn stored with provider content blocks (BFSF-307) arrives
 * as `[{type:'text',text}, {type:'image_url',…}]`; flattened the way the web's
 * messageContentToText does it (agent-hub/src/utils/messageShape.js).
 */
function content(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.filter(isTextBlock).map((b) => b.text).join('\n\n');
    return isTextBlock(value) ? value.text : '';
}

const readPart = shapeOf({
    id: field.str(''),
    text: field.str(''),
    startedAt: field.numOrNull,
    endedAt: field.numOrNull,
    redacted: field.optBool,
    phase: field.optStr,
});

/**
 * Reasoning. Persisted as an ARRAY of parts `{id, text, startedAt, endedAt,
 * redacted, phase}` (finalizeTurn.js), as a plain string only on older rows.
 */
function thinkingParts(value: unknown): ThinkingPart[] | undefined {
    if (typeof value === 'string') return value ? [{ id: 'legacy-0', text: value, startedAt: null, endedAt: null }] : undefined;
    if (!Array.isArray(value)) return undefined;
    const parts = value.map((raw, i) => {
        const part = readPart(raw);
        return part.id ? part : { ...part, id: `part-${i}` };
    });
    return parts.length ? parts : undefined;
}

/** The readable reasoning as one block. A redacted part is ciphertext, left out rather than shown as a gap. */
function thinking(value: unknown): string | undefined {
    const text = (thinkingParts(value) ?? [])
        .flatMap((part) => (!part.redacted && part.text.trim() ? [part.text] : []))
        .join('\n\n');
    return text || undefined;
}

function records(value: unknown): DraftRecord[] {
    return Array.isArray(value) ? value.flatMap((raw) => { const r = recordOf(raw); return r ? [r] : []; }) : [];
}

/** The five draft lists, under the names finalizeTurn.js saves them. Absent when there are none. */
function drafts(source: Record<string, unknown>): Drafts | undefined {
    const out: Drafts = {
        email: records(source.emailDrafts),
        calendar: records(source.calendarDrafts),
        linkedin: records(source.linkedInDrafts),
        contacts: records(source.contactsDrafts),
        keep: records(source.keepDrafts),
    };
    return Object.values(out).some((list) => list.length) ? out : undefined;
}

function tokenisation(value: unknown): TokenisationInfo | undefined {
    const t = recordOf(value);
    if (!t) return undefined;
    return {
        source: field.optStr(t.source),
        action: field.optStr(t.action),
        count: field.optNum(t.count),
        categories: field.strArray(t.categories),
        provider: field.strOrNull(t.provider),
        automatic: field.optBool(t.automatic),
        attachments: Array.isArray(t.attachments) ? t.attachments.map(readPrivacyAttachment) : undefined,
        tokenMap: t.tokenMap ? readTokenMap(t.tokenMap) : undefined,
        tokenizedPrompt: field.optStr(t.tokenizedPrompt),
        rawResponse: field.optStr(t.rawResponse),
        rawTruncated: field.optBool(t.rawTruncated),
    };
}

const readWarning: (raw: unknown) => ScanWarning = shapeOf({
    filename: field.optStr,
    reason: field.optStr,
    scannedPages: field.optNum,
    totalPages: field.optNum,
});

/** The shield's record on a QUESTION (inputGates.js `_userPrivacyMeta`). Absent when it did nothing. */
function privacy(source: Record<string, unknown>): UserPrivacy | undefined {
    const tokenizedCount = field.optNum(source.piiTokenizedCount) ?? 0;
    const dlpRedactedCount = field.optNum(source.dlpRedactedCount) ?? 0;
    const scanWarnings = Array.isArray(source.piiScanWarnings) ? source.piiScanWarnings.map(readWarning) : [];
    if (!tokenizedCount && !dlpRedactedCount && !scanWarnings.length) return undefined;
    const categories = [...field.strArray(source.piiCategories), ...field.strArray(source.dlpCategories)];
    return { tokenizedCount, dlpRedactedCount, categories: [...new Set(categories)], scanWarnings };
}

const listOf = <T>(read: (raw: unknown) => T | null) => (value: unknown): T[] | undefined => {
    const out = Array.isArray(value) ? value.flatMap((raw) => { const v = read(raw); return v ? [v] : []; }) : [];
    return out.length ? out : undefined;
};

const readMedia = shapeOf({ url: field.str(''), mimeType: field.str(''), source: field.optStr });
const media = (fallbackMime: string) =>
    listOf((raw) => { const m = readMedia(raw); return m.url ? { ...m, mimeType: m.mimeType || fallbackMime } : null; });
const readMap = shapeOf({ embedUrl: field.optStr, title: field.optStr, mapsLink: field.optStr });

const readMessageFields = shapeOf({
    id: field.str(''),
    role: field.oneOf(['user', 'assistant', 'system', 'tool'] as const, 'assistant'),
    content,
    attachments: field.optList(readAttachment),
    createdAt: field.optStr,
    thinking,
    thinkingParts,
    tools,
    sources,
    images,
    audio: media('audio/mpeg'),
    video: media('video/mp4'),
    files: listOf(readGeneratedFile),
    maps: listOf((raw) => { const m = readMap(raw); return m.embedUrl || m.mapsLink ? m : null; }),
    pendingToolCalls: listOf((raw) => { const r = recordOf(raw); return r ? readPendingCall(r) : null; }),
    tokenisation,
    ruleAttribution: field.optStrArray,
    modelId: field.optStr,
    modelTier: field.optStr,
    autoSelectedTier: field.optStr,
    parentId: field.strOrNull,
    error: field.optStr,
    // The server does save a turn that died after a side-effecting tool had
    // run, marked as such (routes/ai/directChat/interruptedTurn.js).
    interrupted: field.optBool,
});

/**
 * The names the server persists fields under, where they are not the names
 * this app uses (finalizeTurn.js — the direct-chat one and the agent-runtime
 * one). The app's own name still counts when the persisted one is absent:
 * older rows carry it.
 */
const PERSISTED_AS = {
    tools: 'toolHistory',
    sources: 'kbSources',
    createdAt: 'timestamp',
    thinkingParts: 'thinking',
    audio: 'audioFiles',
    video: 'videoFiles',
    maps: 'mapEmbeds',
    tokenisation: 'tokenisationInfo',
} as const;

/**
 * One persisted message. `streaming` is client-side state and never arrives
 * from the server, so it is not in the spec.
 */
export function readMessage(raw: unknown): ChatMessage {
    const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const renamed: Record<string, unknown> = { ...source };
    for (const [ours, theirs] of Object.entries(PERSISTED_AS)) {
        if (source[theirs] !== undefined) renamed[ours] = source[theirs];
    }
    const message: ChatMessage = readMessageFields(renamed);
    const extra = { drafts: drafts(source), privacy: privacy(source) };
    return {
        ...message,
        ...(extra.drafts ? { drafts: extra.drafts } : {}),
        ...(extra.privacy ? { privacy: extra.privacy } : {}),
    };
}
