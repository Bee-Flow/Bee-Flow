/**
 * The line under a question the Privacy Shield touched: how many values were
 * replaced, and — only where this screen can PROVE it — which placeholder
 * stood in for which. The port of agent-hub/src/components/chat/MessageItem/
 * privacyLine.js (pinned by privacyLine.lockstep.test.ts).
 *
 * The token map is conversation-wide: it carries tokens of earlier turns. A
 * value found verbatim in THIS message proves only that it is here, so when
 * there are more candidates than replacements, pointing at any of them would
 * let the reader conclude the other went out in the clear — so nothing is
 * pointed at.
 */

import type { ChatMessage, ScanWarning } from './types';

/** How many placeholders fit on one line. */
export const DEFAULT_TOKEN_LIMIT = 3;

/** A value this short proves nothing by being found ("a", "12"). */
const MIN_PROVABLE_VALUE = 3;

/**
 * The scan warnings of a question, read so an unknown shape is "we do not
 * know", never "there was nothing": a non-empty list that yields nothing
 * recognisable still yields one warning.
 */
export function normaliseScanWarnings(value: unknown): ScanWarning[] {
    if (value == null || value === false || value === '') return [];
    if (Array.isArray(value)) {
        if (value.length === 0) return [];
        const kept = value.filter((w) => w != null && w !== false).map((w) => (typeof w === 'object' ? (w as ScanWarning) : {}));
        return kept.length > 0 ? kept : [{}];
    }
    if (typeof value === 'object') return [value as ScanWarning];
    return [{}];
}

/** The token map of the turn a question started: on the answer after it, before the next question. */
export function findTurnTokenMap(messages: readonly ChatMessage[], idx: number): Record<string, string> | null {
    for (let i = Number(idx) + 1; i < messages.length; i++) {
        const m = messages[i];
        if (!m) continue;
        if (m.role === 'user') break;
        const map = m.tokenisation?.tokenMap;
        if (map && typeof map === 'object' && Object.keys(map).length > 0) return map;
    }
    return null;
}

function provableTokens(messageText: string, tokenMap: Record<string, string> | null | undefined): { token: string; at: number }[] {
    const text = typeof messageText === 'string' ? messageText : '';
    const entries = tokenMap && typeof tokenMap === 'object' ? Object.entries(tokenMap) : [];
    const proven: { token: string; at: number }[] = [];
    for (const [token, value] of entries) {
        if (typeof token !== 'string' || !token) continue;
        if (typeof value !== 'string' || value.length < MIN_PROVABLE_VALUE) continue;
        const at = text.indexOf(value);
        if (at === -1) continue;
        proven.push({ token, at });
    }
    return proven.sort((a, b) => a.at - b.at);
}

export interface PrivacyLine {
    /** `demonstrated`: the tokens shown stand for values in this message. `unproven`: none can be shown. */
    form: 'demonstrated' | 'unproven';
    count: number;
    tokens: string[];
    shown: number;
    partial: boolean;
    incomplete: boolean;
}

export function describePrivacyLine({
    count,
    messageText,
    tokenMap,
    limit = DEFAULT_TOKEN_LIMIT,
    scanIncomplete = false,
}: {
    count: number;
    messageText: string;
    tokenMap?: Record<string, string> | null;
    limit?: number;
    scanIncomplete?: boolean;
}): PrivacyLine | null {
    const n = Number(count) || 0;
    if (n <= 0) return null;
    const incomplete = Boolean(scanIncomplete);
    const nothingShown = (): PrivacyLine => ({ form: 'unproven', count: n, tokens: [], shown: 0, partial: false, incomplete });
    const proven = provableTokens(messageText, tokenMap);
    if (proven.length > n) return nothingShown();
    const tokens = proven.slice(0, limit).map((p) => p.token);
    if (tokens.length === 0) return nothingShown();
    return { form: 'demonstrated', count: n, tokens, shown: tokens.length, partial: tokens.length < n, incomplete };
}
