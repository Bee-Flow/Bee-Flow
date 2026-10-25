/**
 * privacyLine.js: what the privacy line under a message MAY claim (C7).
 *
 * The screen has two different things to tell, and the mistake this module makes
 * impossible is mixing them up:
 *
 *   • DEMONSTRATION: "1 data item replaced by [email_1]. The real value stayed
 *     here." That is not a promise but an indication: the stand-in is there, and
 *     the real value is legible in the bubble above. That form may only render if
 *     it can really be shown.
 *   • UNPROVEN: the token map is missing (the org does not share it with the
 *     screen), so the stand-in is not known here. Then the line says THAT, and
 *     nothing more. A reassuring sentence without a measurement underneath is worse
 *     than no sentence: the user bases a decision on it.
 *
 * The measurement is deliberately literal. A token-map line only counts if the
 * REAL value literally appears in the visible message text. Then, and only then,
 * it is demonstrable that this message contained that value, that a token was
 * put in its place, and that the original still stands here. A conversation-wide
 * map (the vault carries tokens from earlier turns along) thus yields only the
 * lines that concern this message.
 *
 * That filter is necessary but not enough. That is the second rule here: that a
 * value stands here does not prove that the server replaced it in THIS turn. If
 * there are more demonstrable candidates than the server counted substitutions,
 * then at least one does not belong to this turn, and the screen does not know
 * which. Then it points to nothing. Where part of the turn was not checked at all
 * (fail_open), the description carries that as `incomplete`: the count is then a
 * lower bound, not a summary.
 *
 * No function here knows text or keys. This produces a description, and the
 * component chooses the sentence. The ternary belongs around the KEY, not around
 * the string.
 */

/** Hoeveel plaatsvervangers er hooguit op één regel passen. */
const DEFAULT_TOKEN_LIMIT = 3;

/**
 * Too-short values match everywhere ("NL", "an") and would hang a demonstration
 * on coincidence. It is better to degrade honestly than to prove falsely.
 */
const MIN_PROVABLE_VALUE = 3;

export interface PrivacyLineArgs {
    count?: number;
    messageText?: string;
    tokenMap?: unknown;
    limit?: number;
    scanIncomplete?: boolean;
}

export interface PrivacyLineDescription {
    form: 'demonstrated' | 'unproven';
    count: number;
    tokens: string[];
    shown: number;
    partial: boolean;
    incomplete: boolean;
}

/** De zichtbare tekst van een bericht — string of content-parts. */
export function messageTextOf(msg: { content?: unknown } | null | undefined): string {
    const content = msg?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter((p: { type?: string; text?: string } | null) => p && p.type === 'text' && typeof p.text === 'string')
            .map((p: { text: string }) => p.text)
            .join('\n');
    }
    return '';
}

/**
 * The scan warnings of a message, as a list.
 *
 * UNKNOWN NARROWS HERE. This field is the only surface in the chat that makes a
 * fail_open PASS-THROUGH visible: part of the upload was not checked and went to
 * the AI unredacted. For exactly this field, a shape we do not recognise must be
 * read as "we do not know whether the check got through", never as "there was
 * nothing to report". A bare `Array.isArray` gate did the reverse: one object
 * instead of a list, a `{count}` shape, or a JSON column that comes back as a
 * string, and the warning vanished without a trace.
 */
export function normaliseScanWarnings(value: unknown) {
    if (value == null || value === false || value === '') return [];
    if (Array.isArray(value)) {
        if (value.length === 0) return [];
        const kept = value
            .filter((w: unknown) => w != null && w !== false)
            .map((w: unknown) => (typeof w === 'object' ? w : {}));
        // A non-empty list that leaves nothing recognisable is still a non-empty list.
        // Something was reported, and that may not disappear.
        return kept.length > 0 ? kept : [{}];
    }
    if (typeof value === 'object') return [value];
    return [{}];
}

/**
 * The token map that belongs to THIS turn: the first assistant message after
 * `idx`. The map lands server-side on the answer (sseEvents.js:
 * `privacy_token_map` → assistantMsgId), not on the user message.
 *
 * At the next USER message we stop: a map from a later turn says nothing about
 * this message.
 */
export function findTurnTokenMap(messages: Array<{ role?: string; tokenisationInfo?: { tokenMap?: unknown } | null } | null> | null | undefined, idx: number): object | null {
    if (!Array.isArray(messages)) return null;
    for (let i = Number(idx) + 1; i < messages.length; i++) {
        const m = messages[i];
        if (!m) continue;
        if (m.role === 'user') break;
        const map = m.tokenisationInfo?.tokenMap;
        if (map && typeof map === 'object' && Object.keys(map).length > 0) return map;
    }
    return null;
}

/**
 * The lines from the token map that concern THIS message, in reading order.
 *
 * A line counts only if the real value literally appears in the visible text.
 * That is at the same time the proof under the sentence: the stand-in went out,
 * and the original still stands here.
 */
function provableTokens(messageText: unknown, tokenMap: unknown) {
    const text = typeof messageText === 'string' ? messageText : '';
    const entries = (tokenMap && typeof tokenMap === 'object') ? Object.entries(tokenMap) : [];
    const proven = [];
    for (const [token, value] of entries) {
        if (typeof token !== 'string' || !token) continue;
        if (typeof value !== 'string' || value.length < MIN_PROVABLE_VALUE) continue;
        const at = text.indexOf(value);
        if (at === -1) continue;          // not in this message → no proof
        proven.push({ token, at });
    }
    return proven.sort((a: { token: string; at: number }, b: { token: string; at: number }) => a.at - b.at);
}

/**
 * Describe the line.
 *
 * @param {object}  p
 * @param {number}  p.count           What the server counted (dlpRedactedCount / piiTokenizedCount).
 * @param {string}  p.messageText     The visible text of the message.
 * @param {object}  p.tokenMap        { token: real value }, or nothing.
 * @param {number} [p.limit]          How many tokens are shown at most.
 * @param {boolean}[p.scanIncomplete] Part of this turn was NOT checked and
 *   passed through unredacted under fail_open.
 * @returns {null|{form: 'demonstrated'|'unproven', count: number, tokens: string[],
 *   shown: number, partial: boolean, incomplete: boolean}}
 *   `null` if there is nothing to report. `shown` is never larger than `count`,
 *   `partial` says that more has been replaced than is demonstrated here, and
 *   `incomplete` that the count itself is not the whole story.
 */
export function describePrivacyLine({
    count, messageText, tokenMap, limit = DEFAULT_TOKEN_LIMIT, scanIncomplete = false,
}: PrivacyLineArgs = {}): PrivacyLineDescription | null {
    const n = Number(count) || 0;
    if (n <= 0) return null;
    const incomplete = !!scanIncomplete;
    const nothingShown = (form: PrivacyLineDescription['form']): PrivacyLineDescription => ({ form, count: n, tokens: [], shown: 0, partial: false, incomplete });

    const proven = provableTokens(messageText, tokenMap);

    // MORE CANDIDATES THAN SUBSTITUTIONS → POINT TO NOTHING.
    //
    // The vault map is CONVERSATION-WIDE: it carries tokens from earlier turns
    // along. A value that stands here literally therefore only proves that it is
    // here, not that the server replaced it in THIS turn. As long as there are no
    // more candidates than substitutions, each candidate may be one of them. If
    // there are MORE, then at least one candidate was NOT replaced here, and
    // nothing on this screen says which. Pointing at one of the two by text
    // position is then not "showing the best guess". It leaves the reader to
    // conclude that the OTHER one went out in the clear.
    if (proven.length > n) return nothingShown('unproven');

    const tokens = proven.slice(0, limit).map((p: { token: string; at: number }) => p.token);
    if (tokens.length === 0) return nothingShown('unproven');

    return {
        form: 'demonstrated',
        count: n,
        tokens,
        shown: tokens.length,
        partial: tokens.length < n,
        incomplete,
    };
}

