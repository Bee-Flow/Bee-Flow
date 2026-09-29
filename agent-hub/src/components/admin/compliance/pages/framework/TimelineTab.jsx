import React, { useMemo } from 'react';
import { CalendarClock } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import TimelinePhases from '../../shared/TimelinePhases';
import RegulatoryCalendar from '../../shared/RegulatoryCalendar';
import { parseDay, daysUntil, SOON_DAYS } from '../../shared/calendarMath';
import { frameworkIdOf } from './checkSort';

/**
 * TimelineTab — the framework's own dates (artboard 1b › Tijdlijn): the
 * phases on one track, then the regulatory calendar filtered to this
 * framework.
 *
 * Milestones come from `GET /calendar` (data.calendar) — the one list the
 * overview's calendar reads too, so the two cannot disagree. When the
 * calendar has nothing for the framework, the catalogue entry's `phases`
 * (data.frameworks) fill the track. `undefined` = still loading, `null` =
 * the read failed: each is its own line, never an empty track.
 */

/** Rows of `GET /calendar` for one framework, in date order (undated rows last). */
export function milestonesOf(calendar, frameworkId) {
    const rows = Array.isArray(calendar) ? calendar : (Array.isArray(calendar?.milestones) ? calendar.milestones : null);
    if (!rows) return null;
    return rows
        .filter((m) => m && m.framework_id === frameworkId)
        .sort((a, b) => (parseDay(a.date) ?? Infinity) - (parseDay(b.date) ?? Infinity));
}

/** The catalogue record of one framework from data.frameworks ({active,candidates} or a flat list). */
export function frameworkRecord(frameworks, frameworkId) {
    const lists = Array.isArray(frameworks)
        ? [frameworks]
        : [frameworks?.active, frameworks?.candidates, frameworks?.items].filter(Array.isArray);
    for (const list of lists) {
        const hit = list.find((f) => f && f.id === frameworkId);
        if (hit) return hit;
    }
    return null;
}

/**
 * TimelinePhases input from milestones. The component draws the word it is
 * given, so the date → state decision is made here: past → done, within
 * SOON_DAYS → upcoming (with the countdown), later → future. Undated
 * (uncertain) rows have no place on a track.
 */
export function toPhases(milestones, t, now = Date.now()) {
    const out = [];
    for (const m of milestones || []) {
        const ms = parseDay(m.date);
        if (ms === null) continue;
        const days = daysUntil(m.date, now);
        const past = days < 0;
        const soon = !past && days <= SOON_DAYS;
        out.push({
            date: m.date,
            title: m.label ?? (m.label_key ? t(m.label_key, m.id) : m.id),
            subtitle: m.detail ?? (m.detail_key ? t(m.detail_key, '') : ''),
            state: past ? 'done' : (soon ? 'upcoming' : 'future'),
            daysLeft: soon ? days : undefined,
        });
    }
    return out;
}

export default function TimelineTab({ regulation, calendar, frameworks, now = undefined, testId = 'timeline-tab' }) {
    const { t } = useTranslation();
    const frameworkId = frameworkIdOf(regulation);
    const nowMs = now ?? Date.now();

    const milestones = useMemo(() => milestonesOf(calendar, frameworkId), [calendar, frameworkId]);
    const record = useMemo(() => frameworkRecord(frameworks, frameworkId), [frameworks, frameworkId]);

    const phases = useMemo(() => {
        const fromCalendar = toPhases(milestones, t, nowMs);
        if (fromCalendar.length > 0) return fromCalendar;
        const catalogue = Array.isArray(record?.milestones) ? record.milestones : (Array.isArray(record?.phases) ? record.phases : []);
        return toPhases(catalogue.map((p, i) => ({ id: p.id ?? `${frameworkId}_${i}`, ...p })), t, nowMs);
    }, [milestones, record, t, nowMs, frameworkId]);

    // No calendar rows yet: `null` / `{failed:true}` is a failed read, anything
    // else is still loading — unless the catalogue record can fill the track.
    const unread = milestones === null;
    const failed = unread && !record && (calendar === null || calendar?.failed === true);
    const loading = unread && !record && !failed;

    return (
        <div className="flex flex-col gap-4" data-testid={testId}>
            <section className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-4 flex flex-col gap-3" style={{ boxShadow: 'var(--shadow-sm)' }}>
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
                <section className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-4" style={{ boxShadow: 'var(--shadow-sm)' }}>
                    <RegulatoryCalendar milestones={milestones} now={nowMs} variant="full" testId={`${testId}-calendar`} />
                </section>
            )}
        </div>
    );
}
