import { BookOpen, CalendarClock, ExternalLink } from 'lucide-react';
import { useMemo } from 'react';
import { frameworkIdOf, type CheckRecord } from './checkSort';
import { disclosureFails, isArt50Phase, shortTitlesOf } from './phaseRules';
import { useTranslation, type TranslateParams } from '../../../../../hooks/useTranslation';
import { parseDay, daysUntil, SOON_DAYS } from '../../shared/calendarMath';
import RegulatoryCalendar, { type CalendarItem } from '../../shared/RegulatoryCalendar';
import TimelinePhases from '../../shared/TimelinePhases';

/** A milestone, from the calendar or from a catalogue entry (the labels come as keys or as text). */
export interface PhaseSource {
    id: string;
    date: string;
    label?: string;
    label_key?: string;
    detail?: string;
    detail_key?: string;
    framework_id?: string;
    kind?: string;
}

/** One row of `GET /calendar`. */
export type CalendarMilestone = PhaseSource & { framework_id: string; kind: string; label: string };

/** `data.calendar`: the milestones, or a failed read. */
export interface CalendarData {
    milestones?: CalendarItem[] | null;
    failed?: boolean;
}

/** A catalogue entry of `data.frameworks`. */
export interface CatalogueFramework {
    id: string;
    milestones?: Array<Partial<Omit<PhaseSource, 'date'>> & { date: string }> | null;
    phases?: Array<Partial<Omit<PhaseSource, 'date'>> & { date: string }> | null;
    sources?: Array<{ url: string; label?: string }> | null;
    legal_review?: { verified_on?: string; age_days?: number; stale?: boolean; stale_after_days?: number; sources?: number } | null;
}

/** `data.frameworks`: the active and candidate lists, or a flat list. */
export interface FrameworksData {
    active?: CatalogueFramework[] | null;
    candidates?: CatalogueFramework[] | null;
    items?: CatalogueFramework[] | null;
}

/** One phase on the track. */
export interface TimelinePhase {
    date: string;
    title: string;
    subtitle: string;
    state: 'done' | 'missed' | 'upcoming' | 'future';
    daysLeft?: number | null;
}

/**
 * TimelineTab — the framework's own dates (artboard 1b › Tijdlijn): the
 * phases on one track, then the regulatory calendar filtered to this
 * framework. For the AI Act this is THE phasing (the More frameworks page no
 * longer repeats it), including the Art. 50 "missed" rule.
 *
 * Milestones come from `GET /calendar` (data.calendar) — the one list the
 * overview's calendar reads too, so the two cannot disagree. When the
 * calendar has nothing for the framework, the catalogue entry's `phases`
 * (data.frameworks) fill the track. `undefined` = still loading, `null` =
 * the read failed: each is its own line, never an empty track.
 */

/** Rows of `GET /calendar` for one framework, in date order (undated rows last). */
export function milestonesOf(calendar: CalendarData | CalendarItem[] | null | undefined, frameworkId: string | null): CalendarMilestone[] | null {
    const rows = Array.isArray(calendar) ? calendar : (Array.isArray(calendar?.milestones) ? calendar.milestones : null);
    if (!rows) return null;
    // The rows kept are the ones of this framework, so they carry its id; the rest of a CalendarMilestone is what the calendar sends.
    return (rows
        .filter((m) => m && m.framework_id === frameworkId)
        .sort((a, b) => (parseDay(a.date) ?? Infinity) - (parseDay(b.date) ?? Infinity))) as CalendarMilestone[];
}

/** The catalogue record of one framework from data.frameworks ({active,candidates} or a flat list). */
export function frameworkRecord(frameworks: FrameworksData | CatalogueFramework[] | null | undefined, frameworkId: string | null): CatalogueFramework | null {
    const lists = Array.isArray(frameworks)
        ? [frameworks]
        : [frameworks?.active, frameworks?.candidates, frameworks?.items].filter(Array.isArray);
    for (const list of lists) {
        const hit = list.find((f) => f && f.id === frameworkId);
        if (hit) return hit;
    }
    return null;
}

/** A milestone's own label, translated. */
const labelOf = (m: PhaseSource, t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) => m.label ?? (m.label_key ? t(m.label_key, m.id) : m.id);

/**
 * TimelinePhases input from milestones. The component draws the word it is
 * given, so the date → state decision is made here: past → done, within
 * SOON_DAYS → upcoming (with the countdown), later → future. Undated
 * (uncertain) rows have no place on a track. One exception the design pins:
 * with `art50Missed` (the AI Act disclosure check fails today) the past
 * Art. 50 phase is `missed`, not done.
 *
 * `shortTitles` (phaseRules.shortTitlesOf) gives the track the catalogue's
 * short label for a date that carries one milestone; the milestone's own
 * label stays in the calendar list under the track.
 */
export function toPhases(milestones: PhaseSource[] | null, t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string, now: number = Date.now(), { art50Missed = false, shortTitles = null }: { art50Missed?: boolean; shortTitles?: Map<string, string> | null } = {}): TimelinePhase[] {
    const rows = (milestones || []).filter(m => parseDay(m.date) !== null);
    const perDate = new Map<string, number>();
    for (const m of rows) perDate.set(m.date, (perDate.get(m.date) ?? 0) + 1);
    return rows.map((m): TimelinePhase => {
        const days = daysUntil(m.date, now);
        const past = days !== null && days < 0;
        const soon = !past && (days as number) <= SOON_DAYS;
        const pastState = art50Missed && isArt50Phase(m) ? 'missed' : 'done';
        const short = perDate.get(m.date) === 1 ? shortTitles?.get(m.date) : undefined;
        return {
            date: m.date,
            title: short || labelOf(m, t),
            subtitle: m.detail ?? (m.detail_key ? t(m.detail_key, '') : ''),
            state: past ? pastState : (soon ? 'upcoming' : 'future'),
            daysLeft: soon ? days : undefined,
        };
    });
}

interface TimelineTabProps {
    regulation: string;
    checks?: CheckRecord[] | null;
    testId?: string;
    calendar?: CalendarData | CalendarMilestone[] | null;
    frameworks?: FrameworksData | CatalogueFramework[] | null;
    now?: number;
}

export default function TimelineTab({ regulation, calendar, frameworks, checks = null, now = undefined, testId = 'timeline-tab' }: TimelineTabProps) {
    const { t } = useTranslation();
    const frameworkId = frameworkIdOf(regulation);
    const nowMs = now ?? Date.now();

    const milestones = useMemo(() => milestonesOf(calendar, frameworkId), [calendar, frameworkId]);
    const record = useMemo(() => frameworkRecord(frameworks, frameworkId), [frameworks, frameworkId]);

    // Only the AI Act has an Art. 50 phase; the rule is moot elsewhere.
    const art50Missed = regulation === 'AIA' && disclosureFails(checks);
    const phases = useMemo(() => {
        const fromCalendar = toPhases(milestones, t, nowMs, { art50Missed, shortTitles: shortTitlesOf(record, t) });
        if (fromCalendar.length > 0) return fromCalendar;
        const catalogue = Array.isArray(record?.milestones) ? record.milestones : (Array.isArray(record?.phases) ? record.phases : []);
        return toPhases(catalogue.map((p, i) => ({ id: p.id ?? `${frameworkId}_${i}`, ...p })), t, nowMs, { art50Missed });
    }, [milestones, record, t, nowMs, frameworkId, art50Missed]);

    // No calendar rows yet: `null` / `{failed:true}` is a failed read, anything
    // else is still loading — unless the catalogue record can fill the track.
    const unread = milestones === null;
    const failed = unread && !record && (calendar === null || (!Array.isArray(calendar) && calendar?.failed === true));
    const loading = unread && !record && !failed;

    return (
        <div className="flex flex-col gap-4" data-testid={testId}>
            <section className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-4 flex flex-col gap-3 shadow-[var(--shadow-sm)]">
                <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[.08em] font-semibold text-[var(--text-tertiary)]">
                    <CalendarClock size={12} aria-hidden="true" />
                    <span>{t('compliance.tbl_timeline_phases', 'Phases')}</span>
                </div>
                {loading && <p className="m-0 text-[12px] text-[var(--text-tertiary)]" data-testid={`${testId}-loading`}>{t('common.loading', 'Loading…')}</p>}
                {failed && <p className="m-0 text-[12px] text-[var(--text-tertiary)]" data-testid={`${testId}-failed`}>{t('compliance.tbl_calendar_unavailable', 'The regulatory calendar could not be read.')}</p>}
                {!loading && !failed && phases.length === 0 && (
                    <p className="m-0 text-[12px] text-[var(--text-tertiary)]" data-testid={`${testId}-empty`}>{t('compliance.tbl_timeline_none', 'This framework has no staged dates — it applies in full.')}</p>
                )}
                {phases.length > 0 && <TimelinePhases phases={phases} now={nowMs} testId={`${testId}-phases`} />}
            </section>
            {Array.isArray(milestones) && (
                <section className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-4 shadow-[var(--shadow-sm)]">
                    <RegulatoryCalendar milestones={milestones} now={nowMs} variant="full" testId={`${testId}-calendar`} />
                </section>
            )}
            <SourcesBlock record={record} testId={`${testId}-sources`} />
        </div>
    );
}

/**
 * Where this framework's dates come from, and when they were last checked
 * (catalogue `sources` + `legal_review`). Nothing renders for a record
 * without sources, e.g. from an older server.
 */
interface SourcesBlockProps {
    record?: CatalogueFramework | null;
    testId?: string;
}

export function SourcesBlock({ record, testId = 'timeline-sources' }: SourcesBlockProps) {
    const { t } = useTranslation();
    const sources = Array.isArray(record?.sources) ? record.sources.filter((s): boolean => s && typeof s.url === 'string' && s.url.startsWith('https://')) : [];
    if (!sources.length) return null;
    const review = record?.legal_review || null;
    return (
        <section className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-4 flex flex-col gap-2 shadow-[var(--shadow-sm)]" data-testid={testId}>
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[.08em] font-semibold text-[var(--text-tertiary)]">
                <BookOpen size={12} aria-hidden="true" />
                <span>{t('compliance.tbl_timeline_sources', 'Sources')}</span>
            </div>
            <ul className="m-0 p-0 list-none flex flex-col gap-1">
                {sources.map(src => (
                    <li key={src.url} className="text-[12px]">
                        <a href={src.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[var(--text-primary)] underline underline-offset-2 hover:text-[var(--accent-primary)]">
                            {src.label}
                            <ExternalLink size={11} aria-hidden="true" />
                        </a>
                    </li>
                ))}
            </ul>
            {review?.verified_on && (
                <p className={`m-0 text-[11px] ${review.stale ? 'text-[var(--warning-ink)]' : 'text-[var(--text-tertiary)]'}`} data-testid={`${testId}-checked`} data-stale={review.stale ? 'true' : 'false'}>
                    {review.stale
                        ? t('compliance.tbl_timeline_review_due', 'Checked {date}. Due for review: more than {days} days ago, so treat these dates as unconfirmed until Bee Flow is updated.', { date: review.verified_on, days: review.stale_after_days })
                        : t('compliance.tbl_timeline_checked', 'Checked against these sources on {date}. Not legal advice.', { date: review.verified_on })}
                </p>
            )}
        </section>
    );
}
