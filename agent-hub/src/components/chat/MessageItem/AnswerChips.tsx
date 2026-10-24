import { FileText } from 'lucide-react';
import React from 'react';
import { answerChipsFor, citationIsOpenable, GRADE_JUDGED, GRADE_RECORDED, type CitationChip, type RuleChip, type SkillChip } from './answerChips';
import type { ChatMessage } from './messageTypes';
import type { SkillSummary } from '../../../hooks/useChatEngine/types';
import useTranslation, { type TranslateFn } from '../../../hooks/useTranslation';
import CitationChips, { chipLabel, chipTitle, ChipText } from '../../../pages/documents/notebook/CitationChips';
import { passagesNote } from '../../../pages/documents/notebook/citationText';
import { kindColorVar, kindIcon } from '../../shared/kindColors';
import { nOf } from '../../admin/Studio/KnowledgeStudio/plural';

/**
 * The chip row directly under an answer: where this answer comes from.
 *
 * Which chips appear is decided by `answerChips.js`. This file concerns the one question that remains: how
 * you show that they are not equally strong.
 *
 * ── THE DIFFERENCE MUST NOT BE SMOOTHED OVER ───────────────────────────────
 *
 * A knowledge-base chip, a table-row chip and a skill chip are MINUTES: the server wrote them down while the
 * answer was being formed, and there is something behind them that you can open and check. The chip "Regel
 * gevolgd: …" is not: it comes from an attribution pass that placed the role next to the answer afterwards.
 * That is an opinion, and an opinion that looks like minutes is worse than no opinion, because the whole row
 * is then read on the authority of the strongest chip in it.
 *
 * ── FOUR CARRIERS, BECAUSE COLOUR ALONE IS NOT A CARRIER ──────────────────
 *
 * The difference must survive a screenshot in greyscale, and a screen reader too. So:
 *
 *   1. SHAPE      judged = a dotted border on a transparent background; recorded = a solid pill in the
 *                 colour of its kind. Visible without colour.
 *   2. WORD       the judged row carries a heading ("Judged") and has the whole explanation as its
 *                 accessible name, so a screen reader gets not one word but the reason.
 *   3. PLACE      judged always stands at the END, behind a dash, never between the recorded chips.
 *                 Nothing interleaves.
 *   4. NO GLYPH   every recorded chip carries the glyph of the THING behind it: a book, a table, a skill.
 *                 Behind a judged chip there is nothing, so it carries none. (Not ✨: that sign is already
 *                 reserved in this product for Skills and for "AI, you do it", and a chip that is read as a
 *                 skill by mistake is a wrong claim, not decoration.)
 *
 * CLICKABILITY IS DELIBERATELY NOT A CARRIER. A recorded chip does not always have anything to open (a skill
 * has no page in a chat), so "not clickable" would mean nothing. The reverse does apply, as a consequence and
 * not as a signal: a judged chip is never clickable, because there is nothing to look behind. Hence no handler
 * on these chips and no `button`.
 *
 * ── A CHIP WITH NOTHING TO OPEN IS NOT A BUTTON (C13) ──────────────────
 *
 * A citation chip opens `CitationOverlay`, and that shows exactly one thing: the passage (`content`). If that
 * does not come along (an emitter that sends only `preview`, or a server that omits the passage for THIS
 * reader), the click would open an empty panel. From this side, "not sent along" is not distinguishable from
 * "you may not read it", so unknown readability narrows to non-clickable: such a citation renders as `span`,
 * not as `button` (`citationIsOpenable` in answerChips.js).
 *
 * It does NOT disappear. The answer used that source, and concealing it is worse than showing it. It only
 * stands at the end, muted, with the reason in its tooltip. Placement here is the same carrier as with the
 * judged row.
 *
 * The pill itself comes from `CitationChips`: the same `chipLabel`/`chipTitle`, so one citation scheme and one
 * way of writing "Handboek · p. 12". Only the kind-glyph disappears: that glyph says "a book, table or minutes
 * sits behind here", and that is precisely the claim this chip cannot make good.
 *
 * ── THE GATE ON KNOWLEDGE-BASE DATA TRAVELS ALONG ───────────────────────
 *
 * `showSources` is the same switch that `HowIGotThisAnswer` gets, and it applies here unabridged: a citation
 * chip carries a document title, a page number and, via `chipTitle`, also the heading of the passage. Without
 * that gate there was one line above the gated path, a second, UNGATED path to exactly the same data, which is
 * precisely what the invariant "the gate is fail-closed at every step" rules out. Omitting the prop means
 * `false` here: a caller that forgets it shows nothing instead of everything. The product default (`true`,
 * because within the product that transparency is the point) belongs on `MessageItem`, which passes it
 * explicitly.
 *
 * ── IF THE PASS FALLS OVER, NOTHING IS SHOWN HERE ──────────────────────
 *
 * No event means no row, and no heading. A chip that says no rule was followed never appears: that would be a
 * claim from the source that just proved it could claim nothing.
 */

/** Eén dichte pil — de vorm die `CitationChips` voor een citaat gebruikt. */
const RECORDED_CLASS = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-medium';
/** Dezelfde maat, gestippeld en doorzichtig. Zichtbaar anders zonder kleur. */
const JUDGED_CLASS = `${RECORDED_CLASS} border-dashed`;

/**
 * The citations that nothing opened behind. Same pill, no button.
 *
 * No `onClick`, no `button`, no tab stop: a chip that does not open may not promise that it does either.
 * The reason stands in the tooltip AND in the accessible name of the row, so that a screen reader hears not
 * only "source" but also why there is nothing to open.
 */
function ClosedCitationChips({ sources, tt }: { sources: CitationChip[]; tt: TranslateFn }) {
    const hint = tt(
        'chat.source_closed_hint',
        'The passage behind this source did not come with the answer, so it cannot be opened here',
    );
    return (
        <div
            /* `mt-1.5` staat ook op de rij van CitationChips hiernaast; zonder
               dat zakken de twee helften ten opzichte van elkaar. */
            className="flex flex-wrap gap-1.5 mt-1.5"
            role="list"
            aria-label={tt('chat.sources_closed', 'Sources that cannot be opened')}
        >
            {sources.map((s: CitationChip, i: number) => {
                const label = chipLabel(s, i, tt);
                const passages = passagesNote(s, tt);
                return (
                    <span
                        key={s?.chunkId ?? s?.documentId ?? s?.document_id ?? `${label}-${i}`}
                        role="listitem"
                        data-testid="citation-chip-closed"
                        data-grade={GRADE_RECORDED}
                        className={RECORDED_CLASS}
                        style={{
                            borderColor: 'var(--border-subtle)',
                            color: 'var(--text-tertiary)',
                            background: 'transparent',
                        }}
                        title={`${chipTitle(s, label)}${passages ? ` (${passages})` : ''} — ${hint}`}
                    >
                        <FileText className="w-2.5 h-2.5 shrink-0" strokeWidth={2} aria-hidden="true" />
                        <ChipText source={s} index={i} tt={tt} />
                    </span>
                );
            })}
        </div>
    );
}

/** De skills die tijdens deze beurt afliepen. Opgetekend, dus dicht. */
function SkillChips({ skills, tt }: { skills: SkillChip[]; tt: TranslateFn }) {
    const SkillGlyph = kindIcon('skill');
    return (
        <div
            className="flex flex-wrap gap-1.5"
            role="list"
            aria-label={tt('agent_studio.answer_chips_skills', 'Skills that ran')}
        >
            {skills.map((skill: SkillChip) => (
                <span
                    key={skill.id}
                    role="listitem"
                    data-testid="skill-chip"
                    data-grade={GRADE_RECORDED}
                    className={RECORDED_CLASS}
                    style={{
                        borderColor: 'var(--border-subtle)',
                        color: 'var(--text-secondary)',
                        background: 'var(--bg-tertiary)',
                    }}
                    title={skill.name}
                >
                    {skill.icon
                        ? <span className="text-[10px] leading-none shrink-0" aria-hidden="true">{skill.icon}</span>
                        : <SkillGlyph className="w-2.5 h-2.5 shrink-0" strokeWidth={2} style={{ color: kindColorVar('skill') }} />}
                    <span className="truncate max-w-[170px]">{skill.name}</span>
                </span>
            ))}
        </div>
    );
}

/** The judged half: its own row, behind a dash, not clickable. */
function RuleChips({ rules, tt }: { rules: RuleChip[]; tt: TranslateFn }) {
    const hint = tt(
        'agent_studio.answer_chips_judged_hint',
        'An extra check read your rules and this answer afterwards. This is its opinion, not something the run recorded.',
    );
    return (
        <div
            className="flex flex-wrap items-center gap-1.5 pt-1.5 [border-top:1px_dashed_var(--border-subtle)]"
            role="list"
            /* The accessible name is the EXPLANATION, not the heading: a screen reader that hears "Judged"
               does not yet know anything. */
            aria-label={hint}
        >
            <span
                className="text-[10px] uppercase tracking-wide select-none text-[var(--text-tertiary)]"
                title={hint}
                data-testid="judged-label"
            >
                {tt('agent_studio.answer_chips_judged', 'Judged')}
            </span>
            {rules.map(({ rule }: RuleChip) => {
                const label = tt('agent_studio.chip_rule_followed', 'Rule followed: {rule}', { rule });
                return (
                    <span
                        key={rule}
                        role="listitem"
                        data-testid="rule-chip"
                        data-grade={GRADE_JUDGED}
                        className={JUDGED_CLASS}
                        style={{
                            borderColor: 'var(--border-subtle)',
                            color: 'var(--text-tertiary)',
                            background: 'transparent',
                        }}
                        title={`${label} — ${hint}`}
                    >
                        <span className="truncate max-w-[220px]">{label}</span>
                    </span>
                );
            })}
        </div>
    );
}

interface AnswerChipsProps {
    msg: ChatMessage;
    sessionSkills?: SkillSummary[];
    onCitationClick?: ((source: CitationChip) => void) | null;
    showSources?: boolean;
    showProcess?: boolean;
    t?: TranslateFn;
}

const AnswerChips = ({
    msg, sessionSkills = [], onCitationClick = null,
    showSources = false, showProcess = true, t,
}: AnswerChipsProps) => {
    const { t: tFallback } = useTranslation();
    const tt = t || tFallback;
    const { citations, citationsHidden, skills, rules, isEmpty } =
        answerChipsFor(msg, { sessionSkills, showSources, showProcess });
    if (isEmpty) return null;

    // Wat opengaat eerst, wat dat niet doet erachter. De volgorde binnen elke
    // helft blijft die van de retrieval — de relevantste bron vooraan.
    const open = citations.filter(citationIsOpenable);
    const closed = citations.filter((s: CitationChip) => !citationIsOpenable(s));

    return (
        <div className="mt-2 space-y-1.5" data-testid="answer-chips">
            {citations.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                    {open.length > 0 && (
                        <CitationChips sources={open} onCitationClick={onCitationClick} t={tt} />
                    )}
                    {closed.length > 0 && <ClosedCitationChips sources={closed} tt={tt} />}
                    {/* What does not fit is counted, not concealed. See MAX_RECORDED_CHIPS in answerChips.js. */}
                    {citationsHidden > 0 && (
                        <span
                            data-testid="answer-chips-more"
                            className="text-[10px] px-2 py-0.5 rounded-full border border-dashed border-[var(--border-subtle)] text-[var(--text-tertiary)]"
                        >
                            {nOf(tt, 'agent_studio.answer_chips_more', citationsHidden,
                                '+{count} more source', '+{count} more sources')}
                        </span>
                    )}
                </div>
            )}
            {skills.length > 0 && <SkillChips skills={skills} tt={tt} />}
            {/* Always last. The place is one of the carriers of the difference between recorded and judged. */}
            {rules.length > 0 && <RuleChips rules={rules} tt={tt} />}
        </div>
    );
};

export default AnswerChips;
