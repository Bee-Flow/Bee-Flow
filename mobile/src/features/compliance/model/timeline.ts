/**
 * A framework's Timeline tab, ported from the web's
 * pages/framework/TimelineTab.jsx (milestonesOf, frameworkRecord, toPhases)
 * and pages/framework/phaseRules.ts (isArt50Phase, disclosureFails,
 * shortTitlesOf); pinned by timeline.test.ts. The stepper order (TimelinePhases.jsx
 * below 640px: phases by date, "today" after the last one not later than
 * today) is stepperOf.
 */

import type { TranslateFn } from '@/core/i18n';

import { daysUntil, parseDay, resolveNow, SOON_DAYS } from './calendarMath';
import { detailOfMilestone, labelOfMilestone, type MilestoneWords } from './calendarText';

export interface MilestoneLike extends MilestoneWords {
    date?: string | null;
    framework_id?: string | null;
    article?: string | number | null;
    key?: string | null;
}

export type PhaseState = 'done' | 'missed' | 'upcoming' | 'future';

export interface Phase {
    date: string;
    title: string;
    subtitle: string;
    state: PhaseState;
    daysLeft?: number;
}

const ART50_RE = /(^|_)art50($|_)/i;

/** The AI Act's Art. 50 transparency step? (id or label_key slug, or an explicit article) */
export function isArt50Phase(phase: MilestoneLike | null | undefined): boolean {
    if (!phase) return false;
    if (String(phase.article ?? '').startsWith('50')) return true;
    return ART50_RE.test(String(phase.id ?? '')) || ART50_RE.test(String(phase.label_key ?? phase.key ?? ''));
}

interface CheckLike {
    status?: string | null;
    regulation?: string | null;
    article?: string | number | null;
}

/** Does any AI Act Art. 50 check fail in the latest check rows? */
export function disclosureFails(checks: readonly (CheckLike | null)[] | null | undefined): boolean {
    if (!Array.isArray(checks)) return false;
    return checks.some((c) => !!c && c.status === 'fail' && String(c.regulation ?? '').toUpperCase() === 'AIA' && String(c.article ?? '').startsWith('50'));
}

interface CatalogueRecord {
    phases?: readonly ({ date?: string | null; label_key?: string | null; label?: string | null } | null)[] | null;
}

/** Date → the catalogue's short phase label, for dates that carry exactly one phase. */
export function shortTitlesOf(record: CatalogueRecord | null | undefined, t: TranslateFn): Map<string, string> {
    const out = new Map<string, string>();
    const seen = new Map<string, number>();
    for (const p of Array.isArray(record?.phases) ? record.phases : []) {
        if (!p || !p.date) continue;
        seen.set(p.date, (seen.get(p.date) ?? 0) + 1);
        const label = p.label_key ? t(p.label_key, p.label ?? '') : (p.label ?? '');
        if (label) out.set(p.date, label);
    }
    for (const [date, n] of seen) if (n > 1) out.delete(date);
    return out;
}

/** The calendar rows of one framework by date (undated last); null when the calendar is unread. */
export function milestonesOf<T extends MilestoneLike>(calendar: readonly T[] | null | undefined, frameworkId: string): T[] | null {
    if (!Array.isArray(calendar)) return null;
    return calendar
        .filter((m) => m && m.framework_id === frameworkId)
        .sort((a, b) => (parseDay(a.date) ?? Infinity) - (parseDay(b.date) ?? Infinity));
}

/** One framework's catalogue record from the frameworks list, or null. */
export function frameworkRecord<T extends { id: string }>(frameworks: readonly T[] | null | undefined, frameworkId: string): T | null {
    return (Array.isArray(frameworks) ? frameworks : []).find((f) => f && f.id === frameworkId) ?? null;
}

export interface PhaseOptions {
    art50Missed?: boolean;
    shortTitles?: Map<string, string> | null;
}

/** Track phases: past → done (or missed), within SOON_DAYS → upcoming, later → future. Undated rows drop. */
export function toPhases(milestones: readonly MilestoneLike[] | null | undefined, t: TranslateFn, now: number = Date.now(), opts: PhaseOptions = {}): Phase[] {
    const rows = (milestones ?? []).filter((m) => parseDay(m.date) !== null);
    const perDate = new Map<string, number>();
    for (const m of rows) perDate.set(m.date as string, (perDate.get(m.date as string) ?? 0) + 1);
    return rows.map((m) => {
        const date = m.date as string;
        const days = daysUntil(date, now) ?? 0;
        const past = days < 0;
        const soon = !past && days <= SOON_DAYS;
        const short = perDate.get(date) === 1 ? opts.shortTitles?.get(date) : undefined;
        const phase: Phase = {
            date,
            title: short || labelOfMilestone(m, t),
            subtitle: detailOfMilestone(m, t),
            state: past ? (opts.art50Missed && isArt50Phase(m) ? 'missed' : 'done') : soon ? 'upcoming' : 'future',
        };
        if (soon) phase.daysLeft = days;
        return phase;
    });
}

/** The vertical stepper: phases by date, and the index "today" goes before. */
export function stepperOf(phases: readonly Phase[], now?: number): { items: Phase[]; todayIndex: number } {
    const items = [...phases].sort((a, b) => (parseDay(a.date) ?? 0) - (parseDay(b.date) ?? 0));
    const today = parseDay(resolveNow(now)) ?? 0;
    return { items, todayIndex: items.filter((p) => (parseDay(p.date) ?? 0) <= today).length };
}

/** The track: the calendar's rows for the framework, else the catalogue record's own phases. */
export function phasesOf(milestones: readonly MilestoneLike[] | null, record: CatalogueRecord | null, frameworkId: string, ctx: { t: TranslateFn; now: number; art50Missed: boolean }): Phase[] {
    const fromCalendar = toPhases(milestones, ctx.t, ctx.now, { art50Missed: ctx.art50Missed, shortTitles: shortTitlesOf(record, ctx.t) });
    if (fromCalendar.length > 0) return fromCalendar;
    const catalogue = (record?.phases ?? []).filter((p): p is NonNullable<typeof p> => !!p);
    return toPhases(catalogue.map((p, i) => ({ id: `${frameworkId}_${i}`, ...p })), ctx.t, ctx.now, { art50Missed: ctx.art50Missed });
}
