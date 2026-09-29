/**
 * The start dialog's six cards (artboard 5e-2) mapped onto the trigger kinds
 * the runner knows, plus the "schedule in words" model behind it. Pure: the
 * dialog and its tests share it.
 *
 *   manual    → kind 'manual'
 *   schedule  → kind 'schedule'                     (schedule.cron/tz/skipHolidays)
 *   file      → kind 'app_event' nextcloud.file.new
 *   form      → kind 'form'
 *   email     → kind 'app_event' <mail provider>.<mail event>
 *   app       → kind 'app_event', any other provider/event
 */
import { defaultTriggerLabel, isGeneratedTriggerLabel } from '../flow/triggerLabels';

export type StartCard = 'manual' | 'schedule' | 'file' | 'form' | 'email' | 'app';
export const START_CARDS: StartCard[] = ['manual', 'schedule', 'file', 'form', 'email', 'app'];

export interface TriggerStep {
    id?: string;
    type?: string;
    kind?: string;
    label?: string;
    schedule?: { cron?: string; tz?: string; skipHolidays?: boolean } | null;
    appEvent?: { provider?: string; event?: string; filter?: unknown } | null;
    form?: unknown;
    [key: string]: unknown;
}

const isMailEvent = (event: string | undefined) => /mail/i.test(event || '');

/** Which card a stored trigger belongs to; null for kinds no card offers (webhook, agent, app action). */
export function cardFromTrigger(trigger: TriggerStep | null | undefined): StartCard | null {
    const kind = trigger?.kind || 'manual';
    if (kind === 'manual' || kind === 'schedule' || kind === 'form') return kind;
    if (kind === 'app_event') {
        const { provider, event } = trigger?.appEvent || {};
        if (provider === 'nextcloud' && event === 'file.new') return 'file';
        if (isMailEvent(event)) return 'email';
        return 'app';
    }
    return null;
}

export interface MailProvider { id: string; events: string[] }

export interface ChoiceInput {
    card: StartCard;
    cron: string;
    tz: string;
    skipHolidays: boolean;
    /** The app-event providers this user can use, for the e-mail card. */
    providers?: MailProvider[];
    /** A fresh form declaration for the form card (injected: it lives in a React module). */
    defaultForm?: () => unknown;
}

type AppEvent = NonNullable<TriggerStep['appEvent']>;

function mailEvent(prev: TriggerStep, providers: MailProvider[] = []): AppEvent | null | undefined {
    if (cardFromTrigger(prev) === 'email') return prev.appEvent;
    const p = providers.find((x) => x.events.some(isMailEvent));
    return p
        ? { provider: p.id, event: p.events.find(isMailEvent), filter: null }
        : { provider: 'gmail', event: 'mail.new', filter: null };
}

function fileEvent(prev: TriggerStep): AppEvent {
    const same = prev.appEvent?.provider === 'nextcloud' && prev.appEvent?.event === 'file.new';
    return { provider: 'nextcloud', event: 'file.new', filter: same ? prev.appEvent?.filter ?? null : null };
}

/** The card-specific part of the trigger; everything else is nulled by the caller. */
function cardFields(prev: TriggerStep, input: ChoiceInput): Partial<TriggerStep> {
    switch (input.card) {
        case 'schedule':
            return { schedule: { ...(prev.schedule || {}), cron: input.cron, tz: input.tz, skipHolidays: input.skipHolidays } };
        case 'form':
            return { form: prev.kind === 'form' && prev.form ? prev.form : (input.defaultForm?.() ?? null) };
        case 'file':
            return { appEvent: fileEvent(prev) };
        case 'email':
            return { appEvent: mailEvent(prev, input.providers) };
        case 'app':
            // The app and its event are picked on the start card itself; keep
            // an app event that is already there.
            return { appEvent: cardFromTrigger(prev) === 'app' ? prev.appEvent : { provider: '', event: '', filter: null } };
        default:
            return {};
    }
}

/** The trigger step after choosing a card; keeps what still applies, nulls the rest. */
export function triggerFromChoice(base: TriggerStep | null | undefined, input: ChoiceInput): TriggerStep {
    const prev: TriggerStep = base && typeof base === 'object' ? base : { id: 'trigger', type: 'trigger' };
    const kind = input.card === 'manual' || input.card === 'schedule' || input.card === 'form' ? input.card : 'app_event';
    const next: TriggerStep = { ...prev, type: 'trigger', kind, schedule: null, appEvent: null, form: null, ...cardFields(prev, input) };
    if (isGeneratedTriggerLabel(prev.label)) next.label = defaultTriggerLabel(kind);
    return next;
}

// ── Schedule in words ──────────────────────────────────────────────────────

export type Frequency = 'weekday' | 'day' | 'week' | 'month' | 'custom';
export interface ScheduleWords { freq: Frequency; days: number[]; hour: number; minute: number; dayOfMonth: number; cron: string }

const WEEKDAYS = [1, 2, 3, 4, 5];
const sameDays = (a: number[], b: number[]) => a.length === b.length && a.every((d) => b.includes(d));

/** Read a cron into the words model; anything else stays 'custom' and round-trips unchanged. */
export function wordsFromCron(cron: string | undefined): ScheduleWords {
    const fallback: ScheduleWords = { freq: 'weekday', days: WEEKDAYS, hour: 7, minute: 0, dayOfMonth: 1, cron: '0 7 * * 1,2,3,4,5' };
    const parts = (cron || '').trim().split(/\s+/);
    if (!cron || !cron.trim()) return fallback;
    if (parts.length !== 5) return { ...fallback, freq: 'custom', cron: cron.trim() };
    const [m, h, dom, mon, dow] = parts;
    const custom = { ...fallback, freq: 'custom' as const, cron: cron.trim() };
    if (!/^\d+$/.test(m) || !/^\d+$/.test(h) || mon !== '*') return custom;
    const base = { hour: Number(h), minute: Number(m), cron: cron.trim() };
    if (dom === '*' && dow === '*') return { ...fallback, ...base, freq: 'day', days: [0, 1, 2, 3, 4, 5, 6] };
    if (dom === '*' && /^[0-7](,[0-7])*$/.test(dow)) {
        const days = [...new Set(dow.split(',').map((d) => Number(d) % 7))];
        return { ...fallback, ...base, freq: sameDays(days, WEEKDAYS) ? 'weekday' : 'week', days };
    }
    if (dom === '*' && dow === '1-5') return { ...fallback, ...base, freq: 'weekday', days: WEEKDAYS };
    if (/^\d+$/.test(dom) && dow === '*') return { ...fallback, ...base, freq: 'month', dayOfMonth: Number(dom) };
    return custom;
}

/** The cron for a words model. 'custom' keeps its own expression. */
export function cronFromWords(w: Omit<ScheduleWords, 'cron'> & { cron?: string }): string {
    const m = Math.min(Math.max(Math.trunc(w.minute) || 0, 0), 59);
    const h = Math.min(Math.max(Math.trunc(w.hour) || 0, 0), 23);
    switch (w.freq) {
        case 'day': return `${m} ${h} * * *`;
        case 'weekday': return `${m} ${h} * * 1,2,3,4,5`;
        case 'week': {
            const days = [...new Set(w.days)].sort((a, b) => a - b);
            return `${m} ${h} * * ${(days.length ? days : [1]).join(',')}`;
        }
        case 'month': return `${m} ${h} ${Math.min(Math.max(Math.trunc(w.dayOfMonth) || 1, 1), 31)} * *`;
        default: return (w.cron || '').trim() || `${m} ${h} * * *`;
    }
}

/** Toggling a day button: the frequency follows the set of days. */
export function toggleDay(w: ScheduleWords, day: number): ScheduleWords {
    const has = w.days.includes(day);
    const days = has ? w.days.filter((d) => d !== day) : [...w.days, day];
    if (!days.length) return w;
    const freq: Frequency = days.length === 7 ? 'day' : sameDays(days, WEEKDAYS) ? 'weekday' : 'week';
    const next = { ...w, days, freq };
    return { ...next, cron: cronFromWords(next) };
}

/** Changing the frequency select. */
export function withFrequency(w: ScheduleWords, freq: Frequency): ScheduleWords {
    const days = freq === 'weekday' ? WEEKDAYS : freq === 'day' ? [0, 1, 2, 3, 4, 5, 6] : freq === 'week' ? (w.days.length && w.days.length < 7 ? w.days : [1]) : w.days;
    const next = { ...w, freq, days };
    return { ...next, cron: cronFromWords(next) };
}
