import { AlertTriangle, ArrowUpRight, Loader2, Users } from 'lucide-react';
import React, { useMemo } from 'react';
import { isForeignRow, kindLabelFor, usageHref } from '../../../components/shared/UsedByTab';
import useTranslation from '../../../hooks/useTranslation';
import { formatSpeakerLabel } from '../lib/format';
import { buildFollowUpStats, buildInsightsModel } from '../lib/insightsMetrics';
import { buildSpeakerColorMap, speakerColor } from '../lib/playerData';
import {
    KNOWLEDGE_LINES,
    SPEAKER_CHECK,
    buildKnowledgeLines,
    buildSpeakerCheck,
} from '../lib/transcriptOutputs';
import { BarRow, EmptyState, MetricRow, TabHeading, duration } from './insights/primitives';

/**
 * "UIT DIT TRANSCRIPT GEHAALD" — het zijpaneel naast de transcriptregels
 * (Meeting Notes artboard 1b, plan M4 stap 2).
 *
 * Stap 1 maakte van elke regel een knop: actie, besluit, kennisregel,
 * tabelrij. Dit paneel staat ernaast en zegt wat die knop inmiddels heeft
 * opgeleverd — anders is het enige bewijs dat er iets gebeurd is een chip in
 * de derde kolom, driehonderd regels verderop.
 *
 * ── ÉÉN TELLING, DRIE SCHERMEN ──────────────────────────────────────
 * De aantallen komen van `buildFollowUpStats`, dezelfde functie die de
 * Inzichten-tab en de kop voedt. De sprekers komen uit
 * `buildInsightsModel().people` — de data die PeopleTab tekent. Er wordt hier
 * niets geteld en niets afgeleid wat elders al bestaat: een paneel dat "3
 * besluiten" zegt terwijl de Inzichten-tab er 4 telt is erger dan een paneel
 * dat er niet is.
 *
 * ── DE PER-PERSOONS-GATE ZIT IN HET MODEL ───────────────────────────
 * `buildInsightsModel(meeting, { perPersonEnabled })` bouwt `people` helemaal
 * niet als de organisatie per-persoonsstatistiek uit heeft staan, en dit
 * paneel leest dat model in plaats van de segmenten. Er is dus geen
 * achterdeur: de sprekersregels kunnen niet getekend worden omdat ze niet
 * bestaan, en de vraag over een niet-herkende spreker noemt met de gate dicht
 * geen naam maar twee aantallen (zie lib/transcriptOutputs.js).
 *
 * ── DE VRAAG WORDT ALLEEN GESTELD ALS ZE TE BEANTWOORDEN IS ─────────
 * De prompt "was X aanwezig?" verschijnt alleen met `onEditSpeakers` erbij —
 * dezelfde regel als de popover van stap 1: een rij die op de notitie
 * schrijft, wordt zonder handler niet getekend. Een collega die een gedeelde
 * notitie leest kan de sprekers niet corrigeren, en een vraag stellen die
 * alleen de eigenaar kan beantwoorden is geen informatie maar ruis.
 *
 * ── WAAROM HIER GEEN <PeopleTab> STAAT ──────────────────────────────
 * PeopleTab tekent een rij van ~350px (naam, balk, percentage, duur, langste
 * monoloog, disclosure). In een kolom van 300px zou die de pagina horizontaal
 * laten scrollen. Dus: dezelfde DATA, en de gedeelde bouwstenen uit
 * ./insights/primitives, in één regel per spreker. Wie het hele verhaal wil,
 * opent de Inzichten-tab — daar staat PeopleTab zelf.
 */
/**
 * Eén array voor de standaardwaarde. Een verse `[]` per render is een nieuwe
 * identiteit, en dan draait de useMemo eronder alsnog bij elke render.
 */
const NOTHING_UNCHECKED = Object.freeze([]);

export default function ExtractedPanel({
    meeting,
    usage = null,
    usageUnchecked = NOTHING_UNCHECKED,
    usageError = null,
    perPersonEnabled = true,
    currentUserId = null,
    onNavigate = null,
    onEditSpeakers = null,
    className = '',
}) {
    const { t } = useTranslation();

    const stats = useMemo(() => buildFollowUpStats(meeting), [meeting]);
    const model = useMemo(
        () => buildInsightsModel(meeting, { perPersonEnabled }),
        [meeting, perPersonEnabled],
    );
    const knowledge = useMemo(
        () => buildKnowledgeLines(usage, { unchecked: usageUnchecked, error: usageError }),
        [usage, usageUnchecked, usageError],
    );
    const speakers = useMemo(
        () => buildSpeakerCheck(meeting, model, { perPersonEnabled }),
        [meeting, model, perPersonEnabled],
    );
    const colorMap = useMemo(() => buildSpeakerColorMap(meeting?.speakers), [meeting?.speakers]);

    return (
        <aside
            className={`flex flex-col gap-4 rounded-xl border px-3 py-3 h-fit ${className}`}
            style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}
            aria-label={t('meetings.extracted_title', 'Pulled from this transcript')}
            data-testid="extracted-panel"
        >
            <TabHeading>{t('meetings.extracted_title', 'Pulled from this transcript')}</TabHeading>

            <div className="flex flex-col gap-1" data-testid="extracted-counts">
                <MetricRow
                    label={t('meetings.extracted_actions', 'Action items')}
                    value={`${stats.open} / ${stats.total}`}
                    title={t('meetings.extracted_actions_hint', 'Still open, out of everything this meeting produced')}
                />
                <MetricRow
                    label={t('meetings.extracted_decisions', 'Decisions')}
                    value={stats.decisions}
                />
                <MetricRow
                    label={t('meetings.extracted_questions', 'Open questions')}
                    value={stats.openQuestions.length}
                />
            </div>

            <KnowledgeLines
                knowledge={knowledge}
                currentUserId={currentUserId}
                onNavigate={onNavigate}
                t={t}
            />

            <Speakers
                model={model}
                check={speakers}
                colorFor={(id) => speakerColor(colorMap, id)}
                perPersonEnabled={perPersonEnabled}
                onEditSpeakers={onEditSpeakers}
                t={t}
            />
        </aside>
    );
}

/**
 * Welke kennisbanken regels uit dit transcript bevatten.
 *
 * Vier uitkomsten, en drie ervan zijn zinnen die niet door elkaar mogen: nog
 * aan het laden, niet kunnen kijken, wél gekeken en niets gevonden, en de
 * lijst zelf. "Kon niet kijken" als "er staat niets" tonen is precies de
 * fail-open die de rest van dit scherm overal vermijdt.
 */
function KnowledgeLines({ knowledge, currentUserId, onNavigate, t }) {
    return (
        <div className="flex flex-col gap-1" data-testid="extracted-knowledge">
            <TabHeading hint={t('meetings.extracted_knowledge_hint', 'Lines from this transcript that were filed into a knowledge base')}>
                {t('meetings.extracted_knowledge', 'Filed as knowledge')}
            </TabHeading>

            {knowledge.state === KNOWLEDGE_LINES.LOADING && (
                <p className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                    {t('meetings.outputs_checking', 'Checking what happens to this meeting…')}
                </p>
            )}

            {knowledge.state === KNOWLEDGE_LINES.UNKNOWN && (
                <p className="flex items-start gap-1.5 text-xs" role="status" style={{ color: 'var(--warning)' }} data-testid="extracted-knowledge-unknown">
                    <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" aria-hidden="true" />
                    {t('meetings.extracted_knowledge_unknown', 'Could not check which knowledge bases hold lines from this transcript.')}
                </p>
            )}

            {knowledge.state === KNOWLEDGE_LINES.READY && (
                <>
                    {/* Gekeken, maar niet overal: "minstens dit" hoort vóór de
                        lijst te staan, niet eronder. */}
                    {knowledge.partial && (
                        <p className="flex items-start gap-1.5 text-xs" role="status" style={{ color: 'var(--warning)' }}>
                            <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" aria-hidden="true" />
                            {t('meetings.extracted_knowledge_partial', 'This list may be incomplete.')}
                        </p>
                    )}
                    {knowledge.rows.length === 0 ? (
                        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }} data-testid="extracted-knowledge-none">
                            {t('meetings.extracted_knowledge_none', 'No line from this transcript has been filed yet.')}
                        </p>
                    ) : (
                        knowledge.rows.map((row) => (
                            <KnowledgeRow
                                key={row.id}
                                row={row}
                                currentUserId={currentUserId}
                                onNavigate={onNavigate}
                                t={t}
                            />
                        ))
                    )}
                </>
            )}
        </div>
    );
}

/**
 * "2 kennisregels → Sales".
 *
 * De navigatieregel is die van UsedByTab, bewust hergebruikt: een kennisbank
 * van iemand anders is PLATTE TEKST die zegt van wie hij is, want een link
 * naar een pagina die dit account niet mag openen is erger dan geen link.
 */
function KnowledgeRow({ row, currentUserId, onNavigate, t }) {
    const foreign = isForeignRow(row, currentUserId);
    const href = usageHref(row);
    const navigable = !foreign && typeof onNavigate === 'function' && !!href;
    const kindLabel = kindLabelFor(t, 'kb', 1);
    const name = row.title
        || (foreign
            ? t('usage.someone_elses_kind', 'Someone else’s {kind}', { kind: kindLabel })
            : t('usage.untitled_kind', 'Untitled {kind}', { kind: kindLabel }));
    // De ternary staat om de SLEUTEL heen, nooit om een woorddeel: "1 line"
    // en "2 lines" zijn twee zinnen, geen zin met een aangeplakte s.
    const lines = row.lineCount === 1
        ? t('meetings.extracted_lines', '{count} knowledge line', { count: row.lineCount })
        : t('meetings.extracted_lines_plural', '{count} knowledge lines', { count: row.lineCount });

    return (
        <div className="flex items-baseline gap-1.5 text-xs min-w-0" data-testid="extracted-knowledge-row">
            <span className="tabular-nums font-medium shrink-0" style={{ color: 'var(--text-primary)' }}>{lines}</span>
            <span className="shrink-0" style={{ color: 'var(--text-muted)' }} aria-hidden="true">→</span>
            {navigable ? (
                <button
                    type="button"
                    onClick={() => onNavigate(href)}
                    className="min-w-0 truncate inline-flex items-center gap-1 hover:underline"
                    style={{ color: 'var(--text-secondary)' }}
                >
                    <span className="truncate">{name}</span>
                    <ArrowUpRight className="w-2.5 h-2.5 shrink-0" aria-hidden="true" />
                </button>
            ) : (
                <span className="min-w-0 truncate" style={{ color: 'var(--text-secondary)' }}>{name}</span>
            )}
        </div>
    );
}

/**
 * Wie er herkend is, en de vraag als dat er minder zijn dan er aanwezig waren.
 *
 * De drie toestanden van `buildSpeakerCheck` staan hier één op één in de
 * opmaak, inclusief de saaiste: COMPLETE tekent niets. De vraag verschijnt
 * alleen als er iemand is die hem kan beantwoorden.
 */
function Speakers({ model, check, colorFor, perPersonEnabled, onEditSpeakers, t }) {
    const rows = model?.people?.rows || [];
    // Er is niets te vergelijken als er geen aanwezigenlijst was; dan is er
    // ook niets te melden. Alleen als er WÉL een lijst is (of hij onleesbaar
    // is) hoort het onbekende antwoord op het scherm.
    const showUnknown = check.state === SPEAKER_CHECK.UNKNOWN && check.attendeeCount !== 0;
    const showGap = check.state === SPEAKER_CHECK.GAP && !!onEditSpeakers;
    // Nooit een kale kop: een sectie die niets zegt, zegt dat.
    const silent = perPersonEnabled && rows.length === 0 && !showUnknown && !showGap;

    return (
        <div className="flex flex-col gap-1" data-testid="extracted-speakers">
            <TabHeading>{t('meetings.extracted_speakers', 'Speakers')}</TabHeading>

            {!perPersonEnabled ? (
                // Dezelfde zin die de Inzichten-tab gebruikt — één sleutel,
                // niet twee met dezelfde tekst.
                <p className="text-xs" style={{ color: 'var(--text-muted)' }} data-testid="extracted-speakers-off">
                    {t('meeting_notes.insights_per_person_off', 'Per-person statistics are disabled by your organization.')}
                </p>
            ) : rows.length > 0 ? (
                rows.map((s) => (
                    <BarRow
                        key={s.speakerId}
                        label={formatSpeakerLabel(s.speakerId)}
                        fraction={s.share}
                        value={duration(s.speakingSeconds)}
                        color={colorFor(s.speakerId)}
                    />
                ))
            ) : null}

            {silent && (
                <EmptyState>
                    {t('meetings.extracted_speakers_none', 'No speaker was recognised in this recording.')}
                </EmptyState>
            )}

            {showUnknown && (
                <p className="flex items-start gap-1.5 text-xs" role="status" style={{ color: 'var(--text-muted)' }} data-testid="extracted-speakers-unknown">
                    <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" aria-hidden="true" />
                    {t('meetings.speaker_gap_unknown', 'The speaker list for this meeting could not be read, so it was not compared with the attendees.')}
                </p>
            )}

            {showGap && (
                <div
                    className="flex flex-col gap-1.5 rounded-lg border px-2 py-1.5 mt-0.5"
                    style={{ background: 'color-mix(in srgb, var(--accent-primary) 6%, transparent)', borderColor: 'var(--border-default)' }}
                    data-testid="extracted-speaker-gap"
                >
                    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {speakerGapText(check, t)}
                    </p>
                    <button
                        type="button"
                        onClick={() => onEditSpeakers()}
                        className="self-start inline-flex items-center gap-1 text-xs font-semibold rounded-md px-2 py-1 hover:bg-[var(--bg-tertiary)] transition-colors"
                        style={{ color: 'var(--accent-primary)' }}
                    >
                        <Users className="w-3 h-3" aria-hidden="true" />
                        {t('meetings.speaker_gap_fix', 'Check the speakers')}
                    </button>
                </div>
            )}
        </div>
    );
}

/**
 * De vraag zelf. Drie sleutels, en welke er gekozen wordt hangt af van WAT er
 * te zeggen valt — nooit van een woordje dat in de zin geplakt wordt:
 *
 *   één naam      "was X aanwezig?" — de zin van het artboard, en de enige
 *                 waarin een vraag over één persoon ook waar is.
 *   meer namen    een MEDEDELING, geen vraag. `buildSilentAttendees` levert
 *                 iedereen die aan geen enkel sprekerlabel te koppelen was, en
 *                 dat zijn er bij "Guest-1 / Guest-2" alle drie terwijl er maar
 *                 één spreker ontbreekt. "3 sprekers niet herkend" zou dan
 *                 onwaar zijn; de knop eronder draagt de actie.
 *   geen naam     twee aantallen. Dat is de zin met de gate dicht, en ook de
 *                 zin als er geen naam over is om te noemen.
 */
export function speakerGapText(check, t) {
    const names = Array.isArray(check?.names) ? check.names : [];
    if (names.length === 1) {
        return t('meetings.speaker_gap_ask', 'One speaker was not recognised — was {names} in this meeting?', { names: names[0] });
    }
    if (names.length > 1) {
        return t('meetings.speaker_gap_ask_plural', 'Not everyone was recognised — {names} were not matched to a speaker.', {
            names: names.join(', '),
        });
    }
    return t('meetings.speaker_gap_count', 'Fewer speakers were recognised ({speakers}) than there were attendees ({attendees}).', {
        speakers: check?.speakerCount ?? 0,
        attendees: check?.attendeeCount ?? 0,
    });
}
