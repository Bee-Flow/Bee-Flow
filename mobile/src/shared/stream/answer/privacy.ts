/**
 * What the Privacy Shield did to a turn, and what the turn says about itself:
 * tokenisation counts and categories (on the QUESTION and the answer), the
 * opt-in transparency of what the model actually saw, the model that
 * answered, a judged rule attribution, and a history the server could not
 * open — the web's cases of the same names in useChatEngine/sseEvents.ts.
 */

import type { FrameData, FrameHandler } from '../chatFrameReducer';
import { recordOf, str } from '../handlers';
import type { AnswerParts, DlpDecision, PrivacyAttachment, ScanWarning, TokenisationInfo, UserPrivacy } from '../types';

const EMPTY_INFO: TokenisationInfo = { categories: [] };
const NO_PRIVACY: UserPrivacy = { tokenizedCount: 0, dlpRedactedCount: 0, categories: [], scanWarnings: [] };

function num(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
}

const union = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])];

/** A `{ token: realValue }` map, strings only. */
export function readTokenMap(value: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(recordOf(value) ?? {})) if (typeof v === 'string') out[k] = v;
    return out;
}

export function readPrivacyAttachment(raw: unknown): PrivacyAttachment {
    const a = recordOf(raw) ?? {};
    return {
        filename: str(a.filename) || undefined,
        reason: str(a.reason) || undefined,
        timeout: a.timeout === true || undefined,
        overflow: a.overflow === true || undefined,
        truncated: a.truncated === true || undefined,
        action: str(a.action) || undefined,
        scannedPages: num(a.scannedPages),
        totalPages: num(a.totalPages),
        byCategory: recordOf(a.byCategory) as Record<string, number> | undefined,
        pages: recordOf(a.pages) as Record<string, Record<string, number>> | undefined,
    };
}

/**
 * A large upload that went through only partly scanned (fail-open) — the
 * amber pill under the question. A row that WAS fully tokenised is not one.
 */
export function scanWarningsOf(attachments: readonly PrivacyAttachment[]): ScanWarning[] {
    return attachments
        .filter((a) => (a.reason || a.timeout || a.overflow) && a.action !== 'tokenize')
        .map((a) => ({
            filename: a.filename,
            reason: a.reason || (a.timeout ? 'timeout' : a.overflow ? 'overflow' : 'degraded'),
            scannedPages: a.scannedPages,
            totalPages: a.totalPages,
        }));
}

type Privacy = Pick<AnswerParts, 'tokenisation' | 'userPrivacy'>;

/**
 * `pii_tokenized` fires for the typed message AND for an attachment on the
 * same turn, so it MERGES: counts add up, categories and per-file rows join.
 */
export const piiTokenized: FrameHandler<Privacy> = (turn, d) => {
    const entities = Array.isArray(d.entities) ? d.entities.map((e) => recordOf(e) ?? {}) : [];
    const found: Found = {
        categories: union([], entities.map((e) => str(e.label) || str(e.category)).filter(Boolean)),
        count: num(d.tokenCount) || entities.length,
        attachments: Array.isArray(d.attachments) ? d.attachments.map(readPrivacyAttachment) : null,
    };
    turn.userPrivacy = questionAfter(turn.userPrivacy ?? NO_PRIVACY, found);
    turn.tokenisation = answerAfter(turn.tokenisation, found, str(d.source));
};

interface Found {
    categories: string[];
    count: number;
    attachments: PrivacyAttachment[] | null;
}

/** The question's side: what was replaced in it, and which uploads were only partly checked. */
function questionAfter(user: UserPrivacy, found: Found): UserPrivacy {
    return {
        ...user,
        tokenizedCount: user.tokenizedCount + found.count,
        categories: union(user.categories, found.categories),
        scanWarnings: [...user.scanWarnings, ...scanWarningsOf(found.attachments ?? [])],
    };
}

/** The answer's side: the turn's tokenisation info, added to what an earlier frame reported. */
function answerAfter(prev: TokenisationInfo | null, found: Found, source: string): TokenisationInfo {
    if (!prev) {
        return { ...EMPTY_INFO, source: source || 'pii', action: 'redact', count: found.count, categories: found.categories, provider: null, automatic: true, attachments: found.attachments ?? undefined };
    }
    return {
        ...prev,
        source: source || prev.source || 'pii',
        action: prev.action || 'redact',
        count: (prev.count ?? 0) + found.count,
        categories: union(prev.categories, found.categories),
        provider: prev.provider ?? null,
        automatic: Boolean(prev.automatic),
        attachments: found.attachments ? [...(prev.attachments ?? []), ...found.attachments] : prev.attachments,
    };
}

/** One field of the answer's tokenisation info, set from a frame. */
function tokenisationSet(read: (d: FrameData, prev: TokenisationInfo) => Partial<TokenisationInfo> | null): FrameHandler<Privacy> {
    return (turn, d) => {
        const prev = turn.tokenisation ?? EMPTY_INFO;
        const patch = read(d, prev);
        if (!patch) return false;
        turn.tokenisation = { ...prev, ...patch };
    };
}

/** The exact tokenised prompt the model received. Org opt-in (`showRawPayload`). */
export const privacyPayload = tokenisationSet((d, prev) => ({
    tokenizedPrompt: str(d.tokenizedPrompt),
    provider: str(d.provider) || prev.provider || null,
}));

/** The model's reply before un-tokenising. Same opt-in. */
export const privacyResponseRaw = tokenisationSet((d) => ({ rawResponse: str(d.rawResponse), rawTruncated: d.truncated === true }));

/** `{ token: realValue }`, so the privacy sheet can show "[name_1] → Gerard". Same opt-in. */
export const privacyTokenMap = tokenisationSet((d, prev) => {
    const incoming = readTokenMap(d.tokenMap);
    return Object.keys(incoming).length ? { tokenMap: { ...prev.tokenMap, ...incoming } } : null;
});

/** Server-synthesised info for a restore or a protected conversation (no `dlp_resolved` then). */
export const tokenisationInfo = tokenisationSet((d, prev) => ({
    source: str(d.source) || prev.source,
    action: str(d.action) || prev.action,
    count: num(d.count) ?? prev.count,
    categories: Array.isArray(d.categories) ? strings(d.categories) : prev.categories,
    provider: str(d.provider) || prev.provider,
    automatic: typeof d.automatic === 'boolean' ? d.automatic : prev.automatic,
    tokenMap: { ...prev.tokenMap, ...readTokenMap(d.tokenMap) },
}));

/**
 * The person answered a DLP question. The pause is over; and when they chose
 * to redact, the count lands on the question and the info on the answer.
 */
export const dlpResolvedWithInfo: FrameHandler<Privacy & { dlpDecision: DlpDecision | null }> = (turn, d) => {
    turn.dlpDecision = null;
    const redacted = num(d.redactedCount) ?? 0;
    if (str(d.appliedChoice) !== 'redact' || redacted <= 0) return;
    const categories = strings(d.categories);
    const provider = recordOf(d.provider);
    turn.userPrivacy = { ...(turn.userPrivacy ?? NO_PRIVACY), dlpRedactedCount: redacted, categories };
    turn.tokenisation = {
        source: 'dlp',
        action: 'redact',
        count: redacted,
        categories,
        provider: (provider && str(provider.displayName)) || null,
        automatic: d.automatic === true,
    };
};

/**
 * Which of the role's rules a second model judged this answer to follow.
 * Only a non-empty list lands: an empty one would read as "nothing was
 * followed", the one claim the pass may not make.
 */
export const ruleAttributed: FrameHandler<Pick<AnswerParts, 'ruleAttribution'>> = (turn, d) => {
    if (!Array.isArray(d.rules) || d.rules.length === 0) return false;
    turn.ruleAttribution = d.rules
        .map((r) => (typeof r === 'string' ? r : str(recordOf(r)?.rule)))
        .filter((r): r is string => Boolean(r && r.trim()));
};

/** Every turn names its model; `fromAuto` says Auto picked the tier. */
export const modelChosen: FrameHandler<Pick<AnswerParts, 'modelId' | 'modelTier' | 'autoSelectedTier'>> = (turn, d) => {
    turn.modelId = str(d.modelId) || turn.modelId;
    turn.modelTier = str(d.tier) || turn.modelTier;
    if (d.fromAuto === true) turn.autoSelectedTier = str(d.tier) || turn.autoSelectedTier;
};

/** The store could not open this conversation's encrypted history: the composer locks. */
export const historyLocked: FrameHandler<Pick<AnswerParts, 'historyLocked'>> = (turn) => {
    turn.historyLocked = true;
};
