import { FileText } from 'lucide-react';
import React from 'react';
import { answerChipsFor, citationIsOpenable, GRADE_JUDGED, GRADE_RECORDED } from './answerChips';
import useTranslation from '../../../hooks/useTranslation';
import CitationChips, { chipLabel, chipTitle, ChipText } from '../../../pages/documents/notebook/CitationChips';
import { passagesNote } from '../../../pages/documents/notebook/citationText';
import { kindColorVar, kindIcon } from '../../shared/kindColors';
import { nOf } from '../../admin/Studio/KnowledgeStudio/plural';

/**
 * De chiprij direct onder een antwoord: waar dit antwoord vandaan komt.
 *
 * Welke chips er staan bepaalt `answerChips.js`; dit bestand gaat over de ene
 * vraag die overblijft — hoe je laat ZIEN dat ze niet even sterk zijn.
 *
 * ── HET VERSCHIL MAG NIET WEGGEPOETST WORDEN ───────────────────────────────
 *
 * Een kennisbankchip, een tabelrijchip en een skillchip zijn NOTULEN: de
 * server schreef ze op tijdens het antwoord, en er zit iets achter dat je kunt
 * openen en nalezen. De chip "Regel gevolgd: …" niet — die komt uit een
 * attributie-pass die ná afloop de rol naast het antwoord legde. Dat is een
 * mening, en een mening die eruitziet als notulen is erger dan geen mening,
 * want de hele rij wordt dan gelezen op het gezag van de sterkste chip erin.
 *
 * ── VIER DRAGERS, WANT KLEUR ALLEEN IS GEEN DRAGER ─────────────────────────
 *
 * Het verschil moet een schermafdruk in grijstinten overleven, en een
 * schermlezer ook. Dus:
 *
 *   1. VORM       geoordeeld = een gestippelde rand op een doorzichtige
 *                 ondergrond; opgetekend = een dichte pil met de kleur van
 *                 zijn soort. Zichtbaar zonder kleur.
 *   2. WOORD      de geoordeelde rij draagt een kopje ("Judged") en heeft als
 *                 toegankelijke naam de hele uitleg — een schermlezer krijgt
 *                 dus niet één woord maar de reden.
 *   3. PLAATS     geoordeeld staat ALTIJD onderaan, achter een streep, nooit
 *                 tussen de opgetekende chips door. Niets interleavet.
 *   4. GEEN GLYPH Elke opgetekende chip draagt de glyph van het DING dat
 *                 erachter zit — een boek, een tabel, een skill. Achter een
 *                 geoordeelde chip zit niets, dus draagt hij er geen. (Niet
 *                 ✨: dat teken is in dit product al vergeven aan Skills en
 *                 aan "AI, doe jij het maar", en een chip die per ongeluk als
 *                 skill leest is een verkeerde bewering, geen versiering.)
 *
 * KLIKBAARHEID IS EXPRES GEEN DRAGER. Een opgetekende chip heeft niet altijd
 * iets om te openen (een skill heeft in een chat geen pagina), dus "niet
 * klikbaar" zou niets betekenen. Andersom geldt het wel, als gevolg en niet
 * als signaal: een geoordeelde chip is nooit klikbaar, want er is niets om
 * achter te kijken. Vandaar geen handler op deze chips en geen `button`.
 *
 * ── EEN CHIP DIE NIETS TE OPENEN HEEFT, IS GEEN KNOP (C13) ─────────────────
 *
 * Een citaatchip opent `CitationOverlay`, en die toont precies één ding: de
 * passage (`content`). Komt die niet mee — een emitter die alleen `preview`
 * stuurt, of een server die de passage voor déze lezer weglaat — dan zou de
 * klik een leeg paneel openen. Van deze kant is "niet meegestuurd" niet te
 * onderscheiden van "mag je niet lezen", dus versmalt onbekende leesbaarheid
 * naar niet-klikbaar: zo'n citaat rendert als `span`, niet als `button`
 * (`citationIsOpenable` in answerChips.js).
 *
 * Hij VERDWIJNT niet. Het antwoord heeft die bron gebruikt en dat verzwijgen
 * is erger dan hem tonen; hij staat alleen achteraan, gedempt, met de reden
 * in zijn tooltip. Plaats is hier dezelfde drager als bij de geoordeelde rij.
 *
 * De pil zelf komt uit `CitationChips` — dezelfde `chipLabel`/`chipTitle`, dus
 * één citatieschema en één manier om "Handboek · p. 12" te schrijven. Alleen
 * de soortglyph blijft weg: die glyph zegt "hier zit een boek/tabel/notulen
 * achter", en dat is precies de bewering die deze chip niet kan waarmaken.
 *
 * ── DE POORT OP KENNISBANKGEGEVENS REIST MEE ───────────────────────────────
 *
 * `showSources` is dezelfde schakelaar die `HowIGotThisAnswer` krijgt, en hij
 * geldt hier onverkort: een citaatchip draagt een documenttitel, een
 * paginanummer en via `chipTitle` ook de kop van de passage. Zonder die poort
 * bestond er één regel boven de gepoorte weg een tweede, ONGEPOORTE weg naar
 * exact dezelfde gegevens — precies wat de invariant "the gate is fail-closed
 * at every step" uitsluit. Weglaten van de prop betekent hier `false`: een
 * aanroeper die hem vergeet toont niets in plaats van alles. De productdefault
 * (`true`, want binnen het product is die transparantie juist het punt) hoort
 * op `MessageItem`, dat hem expliciet doorgeeft.
 *
 * ── VALT DE PASS OM, DAN STAAT HIER NIETS ──────────────────────────────────
 *
 * Geen event ⇒ geen rij ⇒ geen kopje. Er komt nooit een chip die zegt dat er
 * geen regel gevolgd is: dat zou een bewering zijn uit de bron die zojuist
 * bewees niets te kunnen beweren.
 */

/** Eén dichte pil — de vorm die `CitationChips` voor een citaat gebruikt. */
const RECORDED_CLASS = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-medium';
/** Dezelfde maat, gestippeld en doorzichtig. Zichtbaar anders zonder kleur. */
const JUDGED_CLASS = `${RECORDED_CLASS} border-dashed`;

/**
 * De citaten waar niets achter openging. Zelfde pil, geen knop.
 *
 * Geen `onClick`, geen `button`, geen tabstop — een chip die niet opent mag
 * ook niet beloven dat hij dat doet. De reden staat in de tooltip én in de
 * toegankelijke naam van de rij, zodat een schermlezer niet alleen "bron"
 * hoort maar ook waarom er niets te openen valt.
 */
function ClosedCitationChips({ sources, tt }) {
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
            {sources.map((s, i) => {
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
function SkillChips({ skills, tt }) {
    const SkillGlyph = kindIcon('skill');
    return (
        <div
            className="flex flex-wrap gap-1.5"
            role="list"
            aria-label={tt('agent_studio.answer_chips_skills', 'Skills that ran')}
        >
            {skills.map(skill => (
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

/** De geoordeelde helft: een eigen rij, achter een streep, niet klikbaar. */
function RuleChips({ rules, tt }) {
    const hint = tt(
        'agent_studio.answer_chips_judged_hint',
        'An extra check read your rules and this answer afterwards. This is its opinion, not something the run recorded.',
    );
    return (
        <div
            className="flex flex-wrap items-center gap-1.5 pt-1.5"
            style={{ borderTop: '1px dashed var(--border-subtle)' }}
            role="list"
            /* De toegankelijke naam is de UITLEG, niet het kopje: een
               schermlezer die "Judged" hoort weet nog niets. */
            aria-label={hint}
        >
            <span
                className="text-[10px] uppercase tracking-wide select-none"
                style={{ color: 'var(--text-tertiary)' }}
                title={hint}
                data-testid="judged-label"
            >
                {tt('agent_studio.answer_chips_judged', 'Judged')}
            </span>
            {rules.map(({ rule }) => {
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

const AnswerChips = ({
    msg, sessionSkills = [], onCitationClick = null,
    showSources = false, showProcess = true, t,
}) => {
    const { t: tFallback } = useTranslation();
    const tt = t || tFallback;
    const { citations, citationsHidden, skills, rules, isEmpty } =
        answerChipsFor(msg, { sessionSkills, showSources, showProcess });
    if (isEmpty) return null;

    // Wat opengaat eerst, wat dat niet doet erachter. De volgorde binnen elke
    // helft blijft die van de retrieval — de relevantste bron vooraan.
    const open = citations.filter(citationIsOpenable);
    const closed = citations.filter(s => !citationIsOpenable(s));

    return (
        <div className="mt-2 space-y-1.5" data-testid="answer-chips">
            {citations.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                    {open.length > 0 && (
                        <CitationChips sources={open} onCitationClick={onCitationClick} t={tt} />
                    )}
                    {closed.length > 0 && <ClosedCitationChips sources={closed} tt={tt} />}
                    {/* Wat er niet past, wordt geteld en niet verzwegen. Zie
                        MAX_RECORDED_CHIPS in answerChips.js. */}
                    {citationsHidden > 0 && (
                        <span
                            data-testid="answer-chips-more"
                            className="text-[10px] px-2 py-0.5 rounded-full border border-dashed"
                            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-tertiary)' }}
                        >
                            {nOf(tt, 'agent_studio.answer_chips_more', citationsHidden,
                                '+{count} more source', '+{count} more sources')}
                        </span>
                    )}
                </div>
            )}
            {skills.length > 0 && <SkillChips skills={skills} tt={tt} />}
            {/* Altijd als laatste. De plaats is een van de dragers van het
                verschil tussen opgetekend en geoordeeld. */}
            {rules.length > 0 && <RuleChips rules={rules} tt={tt} />}
        </div>
    );
};

export default AnswerChips;
