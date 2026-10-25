import { AlertTriangle, ArrowUpRight, Loader2, Users } from 'lucide-react';
import { useMemo } from 'react';
import { isForeignRow, kindLabelFor, usageHref } from '../../../components/shared/UsedByTab';
import useTranslation from '../../../hooks/useTranslation';
import { formatSpeakerLabel } from '../lib/format';
import { buildInsightsModel } from '../lib/insightsMetrics';
import { buildFollowUpStats } from '../lib/insightsMetrics.helpers';
import { buildSpeakerColorMap, speakerColor, type ColorSpeaker } from '../lib/playerData';
import {
    KNOWLEDGE_LINES,
    SPEAKER_CHECK,
    buildKnowledgeLines,
    buildSpeakerCheck,
} from '../lib/transcriptOutputs';
import { BarRow, EmptyState, MetricRow, TabHeading, duration } from './insights/primitives';
import type { TranslateParams } from '../../../hooks/useTranslation';
import type { UsageRow } from '../../../hooks/useUsage';
import type { MeetingNote } from './meetingDetailTypes';
import type { InsightsModel } from './insights/insights.types';

/**
 * "EXTRACTED FROM THIS TRANSCRIPT": the side panel next to the transcript lines
 * (Meeting Notes artboard 1b, plan M4 step 2).
 *
 * Step 1 made every line a button: action, decision, knowledge rule, table row. This
 * panel stands beside it and says what that button has meanwhile delivered. Otherwise
 * the only evidence that something happened is a chip in the third column, three
 * hundred lines further down.
 *
 * ── ONE COUNT, THREE SCREENS ───────────────────────────────────────
 * The figures come from `buildFollowUpStats`, the same function that feeds the
 * Insights tab and the heading. The speakers come from `buildInsightsModel().people`,
 * the data that PeopleTab draws. Nothing is counted here, and nothing is derived that
 * already exists elsewhere. A panel that says "3 decisions" while the Insights tab
 * counts 4 is worse than a panel that is not there.
 *
 * ── THE PER-PERSON GATE LIVES IN THE MODEL ─────────────────────────
 * `buildInsightsModel(meeting, { perPersonEnabled })` does not build `people` at all
 * when the organisation has the per-person statistic switched off. This panel reads
 * that model instead of the segments. There is thus no back door: the speaker lines
 * cannot be drawn because they do not exist, and the question about an unrecognised
 * speaker with the gate closed names no name, only two counts (see
 * lib/transcriptOutputs.js).
 *
 * ── THE QUESTION IS ONLY ASKED IF IT CAN BE ANSWERED ───────────────
 * The prompt "was X present?" appears only with `onEditSpeakers` attached. That is the
 * same rule as the popover of step 1: a row that writes to the note is not drawn
 * without a handler. A colleague who reads a shared note cannot correct the speakers,
 * and asking a question that only the owner can answer is not information but noise.
 *
 * ── WHY NO <PeopleTab> HERE ────────────────────────────────────────
 * PeopleTab draws a row of about 350px (name, bar, percentage, duration, longest
 * monologue, disclosure). In a column of 300px that would make the page scroll
 * horizontally. So: the same DATA, and the shared building blocks from
 * ./insights/primitives, in one line per speaker. Whoever wants the whole story opens
 * the Insights tab, where PeopleTab itself stands.
 */
/**
 * One array for the default value. A fresh `[]` per render is a new identity, and then
 * the useMemo beneath it runs on every render anyway.
 */
const NOTHING_UNCHECKED = Object.freeze([]);

interface ExtractedPanelProps {
    meeting?: MeetingNote | null;
    onNavigate?: ((href: string) => void) | null;
    onEditSpeakers?: (() => void) | null;
    usage?: (UsageRow | null)[] | null;
    usageUnchecked?: readonly string[];
    usageError?: Error | string | null;
    perPersonEnabled?: boolean;
    currentUserId?: string | null;
    className?: string;
}

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
}: ExtractedPanelProps) {
    const { t } = useTranslation();

    const stats = useMemo(() => buildFollowUpStats(meeting), [meeting]);
    const model = useMemo(
        () => buildInsightsModel(meeting, { perPersonEnabled }),
        [meeting, perPersonEnabled],
    );
    const knowledge = useMemo(
        () => buildKnowledgeLines(usage as Parameters<typeof buildKnowledgeLines>[0], { unchecked: usageUnchecked as string[], error: usageError }),
        [usage, usageUnchecked, usageError],
    );
    const speakers = useMemo(
        () => buildSpeakerCheck(meeting as Parameters<typeof buildSpeakerCheck>[0], model, { perPersonEnabled }),
        [meeting, model, perPersonEnabled],
    );
    const colorMap = useMemo(() => buildSpeakerColorMap(meeting?.speakers as ColorSpeaker[] | undefined), [meeting?.speakers]);

    return (
        <aside
            className={`flex flex-col gap-4 rounded-xl border px-3 py-3 h-fit ${className} [background:var(--bg-secondary)] [border-color:var(--border-default)]`}
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
 * Which knowledge bases contain rules from this transcript.
 *
 * Four outcomes, and three of them are sentences that may not be mixed up: still
 * loading, not able to look, looked and found nothing, and the list itself. "Could
 * not look" shown as "there is nothing" is precisely the fail-open that the rest of
 * this screen avoids everywhere.
 */
interface KnowledgeLinesProps {
    knowledge: ReturnType<typeof buildKnowledgeLines>;
    currentUserId: string | null;
    onNavigate?: ((href: string) => void) | null;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}

function KnowledgeLines({ knowledge, currentUserId, onNavigate, t }: KnowledgeLinesProps) {
    return (
        <div className="flex flex-col gap-1" data-testid="extracted-knowledge">
            <TabHeading hint={t('meetings.extracted_knowledge_hint', 'Lines from this transcript that were filed into a knowledge base')}>
                {t('meetings.extracted_knowledge', 'Filed as knowledge')}
            </TabHeading>

            {knowledge.state === KNOWLEDGE_LINES.LOADING && (
                <p className="flex items-center gap-1.5 text-xs text-[var(--text-tertiary)]">
                    <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                    {t('meetings.outputs_checking', 'Checking what happens to this meeting…')}
                </p>
            )}

            {knowledge.state === KNOWLEDGE_LINES.UNKNOWN && (
                <p className="flex items-start gap-1.5 text-xs text-[var(--warning)]" role="status" data-testid="extracted-knowledge-unknown">
                    <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" aria-hidden="true" />
                    {t('meetings.extracted_knowledge_unknown', 'Could not check which knowledge bases hold lines from this transcript.')}
                </p>
            )}

            {knowledge.state === KNOWLEDGE_LINES.READY && (
                <>
                    {/* Looked, but not everywhere: "at least this" belongs before the list, not beneath it. */}
                    {knowledge.partial && (
                        <p className="flex items-start gap-1.5 text-xs text-[var(--warning)]" role="status">
                            <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" aria-hidden="true" />
                            {t('meetings.extracted_knowledge_partial', 'This list may be incomplete.')}
                        </p>
                    )}
                    {knowledge.rows.length === 0 ? (
                        <p className="text-xs text-[var(--text-tertiary)]" data-testid="extracted-knowledge-none">
                            {t('meetings.extracted_knowledge_none', 'No line from this transcript has been filed yet.')}
                        </p>
                    ) : (
                        (knowledge.rows as UsageRow[]).map((row) => (
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
 * "2 knowledge rules → Sales".
 *
 * The navigation line is that of UsedByTab, deliberately reused. Someone else's
 * knowledge base is PLAIN TEXT that says whose it is, because a link to a page that
 * this account may not open is worse than no link.
 */
interface KnowledgeRowProps {
    row: UsageRow;
    currentUserId: string | null;
    onNavigate?: ((href: string) => void) | null;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}

function KnowledgeRow({ row, currentUserId, onNavigate, t }: KnowledgeRowProps) {
    const foreign = isForeignRow(row, currentUserId);
    const href = usageHref(row);
    const navigable = !foreign && typeof onNavigate === 'function' && !!href;
    const kindLabel = kindLabelFor(t, 'kb', 1);
    const name = row.title
        || (foreign
            ? t('usage.someone_elses_kind', 'Someone else’s {kind}', { kind: kindLabel })
            : t('usage.untitled_kind', 'Untitled {kind}', { kind: kindLabel }));
    // The ternary goes around the KEY, never around a part of a word. "1 line" and
    // "2 lines" are two sentences, not a sentence with a plural s stuck on.
    const lines = row.lineCount === 1
        ? t('meetings.extracted_lines', '{count} knowledge line', { count: row.lineCount })
        : t('meetings.extracted_lines_plural', '{count} knowledge lines', { count: row.lineCount });

    return (
        <div className="flex items-baseline gap-1.5 text-xs min-w-0" data-testid="extracted-knowledge-row">
            <span className="tabular-nums font-medium shrink-0 text-[var(--text-primary)]">{lines}</span>
            <span className="shrink-0 text-[var(--text-muted)]" aria-hidden="true">→</span>
            {navigable ? (
                <button
                    type="button"
                    onClick={() => onNavigate(href)}
                    className="min-w-0 truncate inline-flex items-center gap-1 hover:underline text-[var(--text-secondary)]"
                >
                    <span className="truncate">{name}</span>
                    <ArrowUpRight className="w-2.5 h-2.5 shrink-0" aria-hidden="true" />
                </button>
            ) : (
                <span className="min-w-0 truncate text-[var(--text-secondary)]">{name}</span>
            )}
        </div>
    );
}

/**
 * Who was recognised, and the question if there are fewer than were present.
 *
 * The three states of `buildSpeakerCheck` map here one-to-one onto the layout,
 * including the most boring one: COMPLETE draws nothing. The question appears only if
 * there is someone who can answer it.
 */
interface SpeakersProps {
    model: InsightsModel | null;
    check: ReturnType<typeof buildSpeakerCheck>;
    colorFor: (id: string) => string;
    perPersonEnabled: boolean;
    onEditSpeakers?: (() => void) | null;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}

function Speakers({ model, check, colorFor, perPersonEnabled, onEditSpeakers, t }: SpeakersProps) {
    const rows = model?.people?.rows || [];
    // There is nothing to compare if there was no attendee list, and then there is nothing
    // to report either. Only if there IS a list (or it is unreadable) does the unknown
    // answer belong on the screen.
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
                <p className="text-xs text-[var(--text-muted)]" data-testid="extracted-speakers-off">
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
                <p className="flex items-start gap-1.5 text-xs text-[var(--text-muted)]" role="status" data-testid="extracted-speakers-unknown">
                    <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" aria-hidden="true" />
                    {t('meetings.speaker_gap_unknown', 'The speaker list for this meeting could not be read, so it was not compared with the attendees.')}
                </p>
            )}

            {showGap && (
                <div
                    className="flex flex-col gap-1.5 rounded-lg border px-2 py-1.5 mt-0.5 [background:color-mix(in_srgb,var(--accent-primary)_6%,transparent)] [border-color:var(--border-default)]"
                    data-testid="extracted-speaker-gap"
                >
                    <p className="text-xs text-[var(--text-secondary)]">
                        {speakerGapText(check, t)}
                    </p>
                    <button
                        type="button"
                        onClick={() => onEditSpeakers()}
                        className="self-start inline-flex items-center gap-1 text-xs font-semibold rounded-md px-2 py-1 hover:bg-[var(--bg-tertiary)] transition-colors text-[var(--accent-primary)]"
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
 * The question itself. Three keys, and which one is chosen depends on WHAT there is to
 * say, never on a little word that is stuck into the sentence:
 *
 *   one name      "was X present?": the sentence of the artboard, and the only form in
 *                 which a question about one person is also true.
 *   several names a STATEMENT, not a question. `buildSilentAttendees` yields everyone
 *                 who could not be linked to any speaker label. In "Guest-1 /
 *                 Guest-2" that is all three, while only one speaker is missing.
 *                 "3 speakers not recognised" would then be untrue. The button
 *                 beneath carries the action.
 *   no name       two counts. That is the sentence with the gate closed, and also the
 *                 sentence when no name is left to mention.
 */
export function speakerGapText(check: { state: string; speakerCount: number; attendeeCount: number | null; names: string[] | null }, t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) {
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
