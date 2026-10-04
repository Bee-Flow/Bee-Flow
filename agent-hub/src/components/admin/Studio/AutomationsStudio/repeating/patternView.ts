import type { TranslateFn } from '../../../../../hooks/useTranslation';
import { INTEGRATION_META } from '../../../../../utils/integrationIcons';
import type { Pattern, ReasonCode, RepeatingSuggestion, ScanSourceGroup, FeedbackBody } from '../../../../../api/queries/automation/repeating';

/**
 * Pure formatters for the "Find repeating work" page: how a pattern the
 * server measured is put into words and pills. No React, no I/O; every
 * sentence goes through the `t` the caller passes in.
 *
 * Every number shown comes from `suggestion.pattern`, which the server's miner
 * computed. Nothing here estimates anything: a missing number shows nothing.
 */

export type PillTone = 'neutral' | 'success' | 'warning' | 'ai' | 'trigger';
export interface EvidencePill { id: string; text: string; tone: PillTone; title?: string }

/* ── Names ──────────────────────────────────────────────────────────── */

/** A source group's name. An unknown group keeps its id. */
export function groupLabel(id: string, t: TranslateFn): string {
    switch (id) {
        case 'mail': return t('automations.repeating.sourceMail', 'Mail');
        case 'calendar': return t('automations.repeating.sourceCalendar', 'Calendar & meetings');
        case 'files': return t('automations.repeating.sourceFiles', 'Files');
        case 'beeflow': return t('automations.repeating.sourceBeeflow', 'Bee Flow activity');
        default: return id;
    }
}

/** "google_drive" / "google-drive" → "Google Drive", from the app registry or the id itself. */
export function prettyAppId(id: string): string {
    const meta = (INTEGRATION_META as Record<string, { label?: string } | undefined>)[id.replace(/-/g, '_')];
    if (meta?.label) return meta.label;
    return id.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim() || id;
}

/** id → name for both source groups and apps: the server's labels first. */
export function makeLabelFor(groups: ScanSourceGroup[], t: TranslateFn): (id: string) => string {
    const known = new Map<string, string>();
    for (const g of groups) {
        known.set(g.id, groupLabel(g.id, t));
        for (const a of g.apps) known.set(a.id, a.label || prettyAppId(a.id));
    }
    return (id: string) => {
        if (!id) return '';
        return known.get(id) || (['mail', 'calendar', 'files', 'beeflow'].includes(id) ? groupLabel(id, t) : prettyAppId(id));
    };
}

/* ── Cadence ────────────────────────────────────────────────────────── */

/** Monday first: the order the strip draws, as Date#getDay indexes. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

export function weekdayShort(day: number, t: TranslateFn): string {
    switch (day) {
        case 0: return t('automations.schedule.day_sun', 'Sun');
        case 1: return t('automations.schedule.day_mon', 'Mon');
        case 2: return t('automations.schedule.day_tue', 'Tue');
        case 3: return t('automations.schedule.day_wed', 'Wed');
        case 4: return t('automations.schedule.day_thu', 'Thu');
        case 5: return t('automations.schedule.day_fri', 'Fri');
        default: return t('automations.schedule.day_sat', 'Sat');
    }
}

export function cadenceWord(kind: string, t: TranslateFn): string {
    switch (kind) {
        case 'daily': return t('automations.cadence_daily', 'Daily');
        case 'weekdays': return t('automations.repeating.cadenceWeekdays', 'Weekdays');
        case 'weekly': return t('automations.cadence_weekly', 'Weekly');
        case 'biweekly': return t('automations.cadence_biweekly', 'Every 2 weeks');
        case 'monthly': return t('automations.cadence_monthly', 'Monthly');
        default: return t('automations.repeating.cadenceIrregular', 'Irregular');
    }
}

const hh = (h: number) => String(Math.max(0, Math.min(24, Math.round(h)))).padStart(2, '0');

/** [9, 10] → "09–10". */
export function hourBandText(band: [number, number] | undefined | null): string {
    return band ? `${hh(band[0])}–${hh(band[1])}` : '';
}

/** "Mon 09–10", "Mon", "09–10" or "". */
export function whenText(p: Pattern, t: TranslateFn): string {
    const day = typeof p.cadence.weekday === 'number' ? weekdayShort(p.cadence.weekday, t) : '';
    return [day, hourBandText(p.cadence.hourBand)].filter(Boolean).join(' ');
}

/** The card's kicker: "Pattern · Weekly · Mon 09–10". */
export function patternEyebrow(p: Pattern, t: TranslateFn): string {
    return [t('automations.repeating.patternEyebrow', 'Pattern'), cadenceWord(p.cadence.kind, t), whenText(p, t)]
        .filter(Boolean).join(' · ');
}

export interface CadenceBar { day: number; count: number; level: number }

/** Seven bars, Monday first, each with a height level 0–6 relative to the busiest day. */
export function cadenceBars(histogram: number[]): CadenceBar[] {
    const max = Math.max(0, ...histogram.map(n => (Number.isFinite(n) ? n : 0)));
    return WEEK_ORDER.map((day) => {
        const count = Number.isFinite(histogram[day]) ? histogram[day] : 0;
        const level = max > 0 && count > 0 ? Math.max(1, Math.round((count / max) * 6)) : 0;
        return { day, count, level };
    });
}

/* ── Evidence ───────────────────────────────────────────────────────── */

/** "≈1–2 h/month" or "≈20–40 min/month"; empty for a missing or zero range. */
export function minutesText(range: [number, number] | null | undefined, t: TranslateFn): string {
    if (!range) return '';
    const [lo, hi] = [Math.max(0, range[0]), Math.max(0, range[1])];
    if (hi <= 0) return '';
    if (hi < 60) return t('automations.repeating.pillMinutes', '≈{lo}–{hi} min/month', { lo: Math.round(lo), hi: Math.round(hi) });
    const h = (m: number) => (m >= 600 ? Math.round(m / 60) : Math.round(m / 6) / 10);
    return t('automations.repeating.pillHours', '≈{lo}–{hi} h/month', { lo: h(lo), hi: h(hi) });
}

/** "1 event" / "412 events". */
export function eventsText(n: number, t: TranslateFn): string {
    return n === 1
        ? t('automations.repeating.flowEventsOne', '1 event')
        : t('automations.repeating.flowEvents', '{count} events', { count: n });
}

/** "Gmail → Google Sheets". */
export function appChain(apps: string[], labelFor: (id: string) => string): string {
    return apps.map(labelFor).filter(Boolean).join(' → ');
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []);

/** The apps it needs that are not connected yet, by name. */
export function missingApps(s: RepeatingSuggestion, labelFor: (id: string) => string): string[] {
    return list(s.unavailableIntegrations).map(labelFor);
}

/** An older scan's one sentence of evidence (a string, or `{ summary }`). */
export function legacyEvidence(evidence: unknown): string {
    if (typeof evidence === 'string') return evidence.trim();
    if (evidence && typeof evidence === 'object') {
        const summary = (evidence as { summary?: unknown }).summary;
        if (typeof summary === 'string') return summary.trim();
    }
    return '';
}

/**
 * The evidence pills under a pattern's title, in reading order: how often,
 * how steadily, how much time (always a range, always labelled), which apps,
 * then what still has to be connected.
 */
export function evidencePills(s: RepeatingSuggestion, t: TranslateFn, labelFor: (id: string) => string): EvidencePill[] {
    const p = s.pattern;
    const pills: EvidencePill[] = [];
    if (p) {
        if (p.occurrences > 0) {
            pills.push({ id: 'times', tone: 'neutral', text: t('automations.repeating.pillTimes', '{count}× in {days} days', { count: p.occurrences, days: p.windowDays }) });
        }
        const { weeksPresent = 0, weeksWindow = 0 } = p.cadence;
        if (weeksWindow > 0 && weeksPresent > 0) {
            pills.push({ id: 'weeks', tone: 'neutral', text: t('automations.repeating.pillWeeks', '{present} of {window} weeks', { present: weeksPresent, window: weeksWindow }) });
        }
        const minutes = minutesText(p.minutesPerMonth, t);
        if (minutes) {
            const basis = p.basis === 'measured'
                ? t('automations.repeating.pillMeasured', 'measured')
                : t('automations.repeating.pillEstimated', 'estimated');
            pills.push({
                id: 'minutes', tone: 'success', text: `${minutes} (${basis})`,
                title: t('automations.repeating.pillMinutesHint', 'Time this takes you per month. A range, never an exact figure.'),
            });
        }
    }
    const missing = new Set(list(s.unavailableIntegrations));
    const apps = (p?.apps.length ? p.apps : list(s.requiredIntegrations)).filter(id => !missing.has(id));
    if (apps.length) pills.push({ id: 'apps', tone: 'neutral', text: appChain(apps, labelFor) });
    if (p?.confidence === 'early') {
        pills.push({
            id: 'early', tone: 'warning', text: t('automations.repeating.pillEarly', 'Early signal'),
            title: t('automations.repeating.pillEarlyHint', 'Based on little history. It gets surer as Bee sees more weeks.'),
        });
    }
    const needs = missingApps(s, labelFor);
    if (needs.length) pills.push({ id: 'needs', tone: 'warning', text: t('automations.repeating.needs', 'needs {apps} connected', { apps: needs.join(', ') }) });
    return pills;
}

/* ── Why it ranks here ──────────────────────────────────────────────── */

const REASON_TEXT: Readonly<Record<string, { key: string; en: string }>> = Object.freeze({
    frequent: { key: 'automations.repeating.reasonFrequent', en: 'It happens often' },
    regular: { key: 'automations.repeating.reasonRegular', en: 'It follows a steady rhythm' },
    multiStep: { key: 'automations.repeating.reasonMultiStep', en: 'It takes several steps each time' },
    measuredEffort: { key: 'automations.repeating.reasonMeasuredEffort', en: 'The time is measured from your own sessions' },
    structuredInput: { key: 'automations.repeating.reasonStructuredInput', en: 'It starts from a predictable input' },
    recent: { key: 'automations.repeating.reasonRecent', en: 'It still happened in recent weeks' },
    early: { key: 'automations.repeating.reasonEarly', en: 'Early signal: based on little history' },
});

/** The server's reason codes as sentences; an unknown code is left out, never shown raw. */
export function reasonTexts(codes: string[], t: TranslateFn): string[] {
    return codes.map(c => REASON_TEXT[c]).filter(Boolean).map(r => t(r.key, r.en));
}

/** The "Not repetitive" menu, in order. */
export const NOT_REPETITIVE: ReadonlyArray<{ code: ReasonCode; key: string; en: string }> = Object.freeze([
    { code: 'wrong_grouping', key: 'automations.repeating.wrongGrouping', en: 'These are not the same task' },
    { code: 'do_myself', key: 'automations.repeating.wrongDoMyself', en: 'I prefer to do this myself' },
    { code: 'already_automated', key: 'automations.repeating.wrongAlreadyAutomated', en: 'This is already automated' },
    { code: 'privacy', key: 'automations.repeating.wrongPrivacy', en: 'Bee should not look at this' },
]);

/* ── Template line ──────────────────────────────────────────────────── */

export interface TemplatePart { text: string; placeholder: boolean }

/** "Invoice <n> from <org>" → text and placeholder parts, placeholders already in words. */
export function templateParts(template: string | null | undefined, t: TranslateFn): TemplatePart[] {
    if (!template) return [];
    return template.split(/(<[a-z]+(?::[A-Za-z0-9]+)?>)/).filter(Boolean).map((part) => {
        const m = /^<([a-z]+)(?::([A-Za-z0-9]+))?>$/.exec(part);
        return m ? { text: placeholderWord(m[1], m[2], t), placeholder: true } : { text: part, placeholder: false };
    });
}

function placeholderWord(kind: string, tag: string | undefined, t: TranslateFn): string {
    switch (kind) {
        case 'n': return t('automations.repeating.phNumber', 'number');
        case 'date': return t('automations.repeating.phDate', 'date');
        case 'id': return t('automations.repeating.phId', 'reference');
        case 'email': return t('automations.repeating.phEmail', 'email address');
        case 'url': return t('automations.repeating.phUrl', 'link');
        case 'name': return t('automations.repeating.phName', 'name');
        case 'org': return t('automations.repeating.phOrg', 'organisation');
        case 'domain': return t('automations.repeating.phDomain', 'domain {tag}', { tag: tag || '' }).trim();
        default: return kind;
    }
}

/* ── Identity and feedback ──────────────────────────────────────────── */

/** What a hide is keyed by: the pattern's signature, else the suggestion id (ideas, older scans). */
export function suggestionKey(s: RepeatingSuggestion): string {
    return s.pattern?.signature || `id:${s.id}`;
}

/** The suggestion as feedback carries it: an explicit allow-list, never the whole object. */
export function feedbackSuggestion(s: RepeatingSuggestion): FeedbackBody['suggestion'] {
    return {
        id: s.id,
        title: s.title,
        requiredIntegrations: list(s.requiredIntegrations),
        groundedIn: s.groundedIn ?? null,
        complexity: s.complexity ?? null,
    };
}

/** The retry seconds in a rate-limit message like "Retry in ~20s". */
export function parseRetrySeconds(message: unknown): number | null {
    const m = /(\d+)\s*s\b/.exec(String(message || ''));
    return m ? Number(m[1]) : null;
}
