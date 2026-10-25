/**
 * The chip row under one answer: WHICH chips, and of what KIND of claim.
 *
 * ── A CHIP IS A CLAIM, AND THEY ARE NOT ALL EQUALLY STRONG ──────────
 *
 * A chip says: this answer comes from here. Three of the four kinds here
 * are RECORDED. The server wrote an event while the answer was being made,
 * and there is something behind it that you can read back:
 *
 *   knowledge base   `kb_sources` → `msg.kbSources`, the passage is in it
 *   table row        same event, `kind: 'datatable_row'`: a row that was
 *                    read from the table at the moment of the question
 *   skill            `session_skill_completed` → the snapshot on the message
 *
 * The fourth is not. "Rule followed: …" comes from an attribution pass
 * (`server/core/agentRuntime/ruleAttribution.js`): a second model, afterwards,
 * laid the role next to the answer and concluded something about it. That is an
 * OPINION about the same question, and it may not appear on screen as minutes.
 *
 * So every chip here gets a `grade`, and `AnswerChips.jsx` keeps the two apart
 * in form, in order and in wording:
 *
 *   'recorded'  the turn wrote this down
 *   'judged'    someone claimed this afterwards
 *
 * Throwing them into one uniform pill would give the weakest evidence in the row
 * the weight of the strongest. That is exactly the wrong direction: whoever sees
 * a chip believes the row, not the chip.
 *
 * ── WHAT DOES NOT GO IN ────────────────────────────────────────────────────
 *
 *   • A skill that was merely AVAILABLE. Available means "was on offer", and that
 *     is not provenance. Only what ran to completion (`completedSkillIds`)
 *     contributed to this answer.
 *   • A skill we do not know by name. A chip with an id in it is not a claim
 *     anyone can read, so unknown narrows.
 *   • Anything at all when the attribution pass sent nothing. No chip is not a
 *     claim. A chip saying "no rule followed" would be one, and it would come
 *     precisely from the source that just proved it could not say anything.
 *
 * Pure: no React, no t(), no DOM. So that "which chip may appear here" can be
 * tested with plain objects.
 */

import { groupByDocument, type CitedSource } from './citationGroups';

/** De beurt heeft dit opgeschreven; er zit iets achter om na te lezen. */
export const GRADE_RECORDED = 'recorded';
/** Iemand heeft dit achteraf beweerd. Nooit dezelfde pil als hierboven. */
export const GRADE_JUDGED = 'judged';
/** De twee soorten bewering. De volgorde is de rendervolgorde. */
const CHIP_GRADES = Object.freeze([GRADE_RECORDED, GRADE_JUDGED]);

/** Hoeveel geoordeelde chips er hoogstens onder één antwoord passen. */
export const MAX_JUDGED_CHIPS = 6;
/**
 * How many RECORDED chips at most may stand under one answer.
 *
 * The same measure as above, and for the same reason. That half was unbounded
 * while the judged half was capped at six, and that turns out badly:
 * `kbSources` STACKS across all tool rounds of one turn (sseEvents merges instead
 * of replacing), and one `datatable_query` yields up to MAX_ROW_LIMIT = 50
 * citations. One table query thus turned the row meant as evidence into a wall of
 * fifty always-expanded pills, with the judged chip you actually wanted to see
 * pushed away underneath.
 *
 * The rest does not vanish: a count pill "+N more" comes after it, just as
 * `HowIGotThisAnswer` puts the full list behind a collapsed `<details>` with a
 * count pill. Leaving things out without saying so would turn a limit into a
 * falsehood.
 */
export const MAX_RECORDED_CHIPS = 6;

/** The parts of a message these chips read; every one of them may be absent. */
interface ChipMessage {
    kbSources?: unknown;
    sessionSkillsSnapshot?: { completedSkillIds?: unknown } | null;
    ruleAttribution?: { rules?: unknown } | null;
}

/** One cited document, as a chip shows it. */
export interface CitationChip extends CitedSource {
    chunkId?: string | number;
    documentId?: string | number;
    document_id?: string | number;
    passageCount?: number;
}

/** One session skill, as far as the chips read it. */
export interface ChipSkill {
    id?: string;
    name?: string;
    icon?: string;
    [key: string]: unknown;
}

export interface SkillChip { id?: string; name: string; icon: string | null }

export interface RuleChip { rule: string }

interface AnswerChipsOptions {
    sessionSkills?: ChipSkill[] | null;
    showSources?: boolean;
    showProcess?: boolean;
}

/** A non-empty trimmed string, or null. */
function text(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
}

/**
 * The citations of this turn: knowledge-base passages and live table rows.
 *
 * They travel through the same event and carry the same shape
 * (`server/core/kb/citation.js`), so they stay together here too. `CitationChips`
 * turns the kind into a glyph. Anything without a title AND without content
 * drops out: that is not a citation but an empty spot with a border.
 */
export function citationChipsOf(msg: ChipMessage | null | undefined): CitationChip[] {
    const sources = Array.isArray(msg?.kbSources) ? msg.kbSources : [];
    const cited = sources.filter((s: CitationChip) => s && (text(s.title) || text(s.content)));
    // One chip per DOCUMENT, not per passage (BFSF-352): several passages of
    // one meeting note used to render as a row of identical chips. The chip
    // stands for the document, opens its best passage, and says how many
    // passages it folds (`passageCount`, only when more than one).
    return groupByDocument<CitationChip>(cited).map(({ best, passages }) => (
        passages.length > 1 ? { ...best, passageCount: passages.length } : best
    ));
}

/**
 * Is there anything to OPEN behind this chip? (C13)
 *
 * A citation chip opens `CitationOverlay`, and that overlay shows exactly one
 * thing: `source.content`, the passage itself. If that is missing, the chip opens
 * a panel that says "No content preview available", a click that promises you can
 * read it and then shows nothing.
 *
 * And missing really happens. Not every emitter sends the passage
 * (`routes/ai/webpageChat.js` sends only `preview`), and a server may have left it
 * out because THIS reader may not read the source. From this side those two cases
 * cannot be told apart, and that is precisely why this is the safe direction:
 * unknown readability narrows to NOT clickable. The chip itself stays (the answer
 * used that source, and we do not hide that). It is just not a button.
 *
 * `preview` deliberately does NOT count. It is the alias of one release
 * (`core/kb/citation.js`) and the overlay does not read it. Approving it here
 * would produce exactly the empty overlay that this function prevents.
 */
export function citationIsOpenable(source: CitationChip | null | undefined): boolean {
    return text(source?.content) !== null;
}

/**
 * The skills that have FINISHED during this turn, with their name.
 *
 * The catalogue (`sessionSkills`) supplies the name. A completed id that is not
 * in it drops out. Duplicates are removed, in catalogue order, so that two turns
 * with the same skills show the same row.
 */
export function skillChipsOf(msg: ChipMessage | null | undefined, sessionSkills: ChipSkill[] | null | undefined): SkillChip[] {
    const catalogue = Array.isArray(sessionSkills) ? sessionSkills : [];
    if (catalogue.length === 0) return [];
    const snap = msg?.sessionSkillsSnapshot;
    const completed = Array.isArray(snap?.completedSkillIds) ? snap.completedSkillIds : [];
    if (completed.length === 0) return [];
    const done = new Set(completed);
    const out = [];
    for (const skill of catalogue) {
        if (!skill || !done.has(skill.id)) continue;
        const name = text(skill.name);
        if (!name) continue;
        out.push({ id: skill.id, name, icon: text(skill.icon) });
    }
    return out;
}

/**
 * The rules that the attribution pass named as followed.
 *
 * The server sends only `followed` (see `ruleAttribution.js`), but this side does
 * not read that on good faith: anything that is not usable rule text drops out,
 * and without an event the list is empty. No event, no chip, and no statement
 * about its absence.
 */
export function ruleChipsOf(msg: ChipMessage | null | undefined): RuleChip[] {
    const rules = msg?.ruleAttribution?.rules;
    if (!Array.isArray(rules)) return [];
    const seen = new Set();
    const out = [];
    for (const entry of rules) {
        const rule = text(typeof entry === 'string' ? entry : entry?.rule);
        if (!rule || seen.has(rule)) continue;
        seen.add(rule);
        out.push({ rule });
        if (out.length >= MAX_JUDGED_CHIPS) break;
    }
    return out;
}

/**
 * Everything together, in render order: first what is recorded, then what is
 * claimed. Never mixed. The order is one of the carriers of the difference.
 *
 * `showSources` is FAIL-CLOSED: omitting it here means `false`, not `true`.
 * A future caller who forgets the prop should show nothing instead of
 * everything. This is the same invariant that `HowIGotThisAnswer` records in its
 * heading. The product default ("within the product that transparency is
 * exactly the point") belongs on `MessageItem`, which passes the prop explicitly.
 *
 * `showProcess` is a different kind of switch, and therefore NOT a gate. It does
 * not say who may see something, but WHICH HALF of the row this screen shows.
 * Since C6 the normal chat shows the source chips, because that is what the answer
 * is about. It leaves the account of how the turn ran (which skills completed,
 * which rule a second model recognised afterwards) to the test chat in the
 * builder, which asks for it explicitly. Hence the default `true`: this function
 * reports what IS, and the narrowing happens at the call site. `MessageItem`
 * passes it on as `showAnswerChips`.
 *
 * `showSources: false` removes the CITATIONS and leaves the rest. That is the
 * same switch that `HowIGotThisAnswer` already gets, and it applies here too: a
 * citation chip carries a document title, a page number and, via `chipTitle`,
 * the heading of the passage. That is someone's handbook on a stranger's screen.
 * The skill and rule chips do not carry that and stay. Unknown narrows: anything
 * that is not literally `true` is no permission.
 *
 * @param {Array}  [opts.sessionSkills] the skill catalogue of this session
 * @param {boolean} [opts.showSources] may knowledge-base data be shown on this screen?
 * @param {boolean} [opts.showProcess] does this screen also show how the turn ran?
 */
export function answerChipsFor(msg: ChipMessage | null | undefined, { sessionSkills, showSources = false, showProcess = true }: AnswerChipsOptions = {}) {
    const allCitations = showSources === true ? citationChipsOf(msg) : [];
    const citations = allCitations.slice(0, MAX_RECORDED_CHIPS);
    const citationsHidden = Math.max(0, allCitations.length - citations.length);
    const skills = showProcess === false ? [] : skillChipsOf(msg, sessionSkills);
    const rules = showProcess === false ? [] : ruleChipsOf(msg);
    const hasRecorded = citations.length > 0 || skills.length > 0;
    const hasJudged = rules.length > 0;
    return {
        citations, citationsHidden, skills, rules,
        hasRecorded, hasJudged, isEmpty: !hasRecorded && !hasJudged,
    };
}
