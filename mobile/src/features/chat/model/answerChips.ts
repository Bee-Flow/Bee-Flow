/**
 * The chip row under one answer — which chips, and of which KIND of claim.
 * The port of agent-hub/src/components/chat/MessageItem/answerChips.js
 * (pinned by answerChips.lockstep.test.ts).
 *
 * A chip says "this answer came from here", and the claims are not equally
 * strong. A citation is RECORDED: the server wrote `kb_sources` while the
 * answer was made, and there is a passage behind it to read. "Rule followed:
 * …" is JUDGED: a second model laid the role beside the answer afterwards
 * (core/agentRuntime/ruleAttribution.js). The two never share a shape, an
 * order or a word on screen.
 *
 * Session-skill chips are the web's third kind; the phone never has the
 * catalogue they are named from on a message, and the web shows them only in
 * the Studio test chat, so they are not ported.
 */

import { groupByDocument } from './citationGroups';
import type { CitationChip } from './citationLabel';
import type { ChatMessage, KbSource } from './types';

/** How many judged chips fit under one answer. */
export const MAX_JUDGED_CHIPS = 6;
/**
 * How many recorded chips show before a "+N more" count. Citations stack over
 * every round of a turn, and one table query can bring fifty.
 */
export const MAX_RECORDED_CHIPS = 6;

function text(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
}

/**
 * The citations of this turn: passages and live table rows. One with neither
 * a title nor a passage (`content`; a bare `preview` is not one) is no
 * citation, just an empty space with a border.
 *
 * One chip per DOCUMENT, not per passage (BFSF-352): several passages of one
 * meeting note used to render as a row of identical chips. The chip opens the
 * document's best passage and says how many it folds (`passageCount`, only
 * when more than one).
 */
export function citationChipsOf(message: Pick<ChatMessage, 'sources'>): CitationChip[] {
    const cited = (message.sources ?? []).filter((s) => s && (text(s.title) || citationIsOpenable(s)));
    return groupByDocument(cited).map(({ best, passages }) =>
        passages.length > 1 ? { ...best, passageCount: passages.length } : best,
    );
}

/**
 * Is there anything behind this chip to open? Only a passage the server sent
 * as `content`: without it the sheet would promise a passage and show none,
 * and "not sent" cannot be told apart from "you may not read it" from here.
 */
export function citationIsOpenable(source: KbSource | null | undefined): boolean {
    return Boolean(source?.openable && text(source.snippet));
}

/** The rules the attribution pass named as followed, deduplicated and bounded. */
export function ruleChipsOf(message: Pick<ChatMessage, 'ruleAttribution'>): { rule: string }[] {
    const rules = message.ruleAttribution;
    if (!Array.isArray(rules)) return [];
    const seen = new Set<string>();
    const out: { rule: string }[] = [];
    for (const entry of rules) {
        const rule = text(entry);
        if (!rule || seen.has(rule)) continue;
        seen.add(rule);
        out.push({ rule });
        if (out.length >= MAX_JUDGED_CHIPS) break;
    }
    return out;
}

export interface AnswerChips {
    citations: CitationChip[];
    citationsHidden: number;
    rules: { rule: string }[];
    hasRecorded: boolean;
    hasJudged: boolean;
    isEmpty: boolean;
}

/**
 * Everything, in render order: recorded first, judged after. `showSources` is
 * FAIL-CLOSED — anything but a literal `true` hides the citations, because a
 * chip carries a document title, a page and a heading. `showProcess` picks
 * which half of the row a screen shows.
 */
export function answerChipsFor(
    message: Pick<ChatMessage, 'sources' | 'ruleAttribution'>,
    { showSources = false, showProcess = true }: { showSources?: boolean; showProcess?: boolean } = {},
): AnswerChips {
    const all = showSources === true ? citationChipsOf(message) : [];
    const citations = all.slice(0, MAX_RECORDED_CHIPS);
    const rules = showProcess === false ? [] : ruleChipsOf(message);
    const hasRecorded = citations.length > 0;
    const hasJudged = rules.length > 0;
    return {
        citations,
        citationsHidden: Math.max(0, all.length - citations.length),
        rules,
        hasRecorded,
        hasJudged,
        isEmpty: !hasRecorded && !hasJudged,
    };
}
