/**
 * The one confirmation before a new task exists (./CoworkConfirmCard.tsx): what the composer worked out of the
 * sentence (./useCoworkComposer.ts with `confirm`), as When, Uses and Sends to. Pure: the clock comes in.
 *
 * When the sentence does not say when ("summarise my meetings", "every week, …" without a day), the card asks "Which
 * day?" before Start: once today, every day, weekdays, or every one weekday, at a time. Choosing one rewrites the
 * draft's schedule with the same fields the composer itself sends.
 */
import { cadenceLine, nextOccurrence, repeatLabel, toTimeInput } from './coworkSchedule';
import type { CoworkPayload, CoworkTriggerPayload } from '@/api/cowork.types';
import type { CoworkDraft } from './useCoworkComposer';
import type { TranslateFn } from '@/hooks/useTranslation';

export const WEEK_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
type WeekDay = typeof WEEK_DAYS[number];
export type DayChoice = 'once' | 'day' | 'weekdays' | WeekDay;

const WORK_DAYS: string[] = ['mon', 'tue', 'wed', 'thu', 'fri'];
const DEFAULT_TIME = '09:00';

export const isClockPayload = (p: CoworkPayload | CoworkTriggerPayload): p is CoworkPayload => !('triggerKind' in p && p.triggerKind === 'app_event');

/** The sentence said nothing about when: no repeat, no day and no time, or "every week" without the day. */
export function needsDay({ payload, spec }: CoworkDraft): boolean {
    if (!isClockPayload(payload)) return false;
    const days = Array.isArray(payload.daysOfWeek) && payload.daysOfWeek.length > 0;
    if (payload.repeatInterval === 'weekly' && !days) return true;
    if (!spec) return true;
    return !spec.repeatInterval && !spec.timeOfDay && !(spec.daysOfWeek?.length);
}

/** The time the draft runs at, as HH:MM: its own, that of its first run, or 09:00. */
export function timeOf(payload: CoworkPayload): string {
    if (payload.timeOfDay) return payload.timeOfDay;
    if (payload.startNow) return DEFAULT_TIME;
    const first = new Date(payload.nextRunAt);
    return Number.isNaN(first.getTime()) ? DEFAULT_TIME : toTimeInput(first);
}

/** The schedule fields of a choice, without the rest of the draft. */
function scheduleOf(choice: DayChoice): Pick<CoworkPayload, 'repeatInterval' | 'daysOfWeek'> {
    if (choice === 'once') return { repeatInterval: null };
    if (choice === 'day') return { repeatInterval: 'daily' };
    if (choice === 'weekdays') return { repeatInterval: 'weekdays' };
    return { repeatInterval: 'weekly', daysOfWeek: [choice] };
}

/** The draft with its schedule and time replaced; the first run is the next such moment. */
function rescheduled(payload: CoworkPayload, schedule: Pick<CoworkPayload, 'repeatInterval' | 'daysOfWeek'>, time: string, now: Date): CoworkPayload {
    const rest: CoworkPayload = { ...payload };
    delete rest.startNow;
    delete rest.daysOfWeek;
    delete rest.timeOfDay;
    const days = schedule.daysOfWeek ?? (schedule.repeatInterval === 'weekdays' ? WORK_DAYS : null);
    const first = nextOccurrence(time, days, { now }) ?? new Date(payload.nextRunAt);
    return {
        ...rest,
        repeatInterval: schedule.repeatInterval ?? null,
        nextRunAt: first.toISOString(),
        ...(schedule.daysOfWeek ? { daysOfWeek: schedule.daysOfWeek } : {}),
        ...(schedule.repeatInterval ? { timeOfDay: time } : {}),
    };
}

/** The draft set to the day chosen under "Which day?", at `time`. */
export function withDay(payload: CoworkPayload, choice: DayChoice, time: string, now: Date = new Date()): CoworkPayload {
    return rescheduled(payload, scheduleOf(choice), time, now);
}

/** The draft at another time of day, on the days it already had. */
export function withTime(payload: CoworkPayload, time: string, now: Date = new Date()): CoworkPayload {
    if (payload.repeatInterval === 'hourly') return payload;
    return rescheduled(payload, { repeatInterval: payload.repeatInterval, ...(payload.daysOfWeek?.length ? { daysOfWeek: payload.daysOfWeek } : {}) }, time, now);
}

/** It runs at a time of day the card can show and change (not hourly, not on a mail). */
export const hasTimeOfDay = (payload: CoworkPayload | CoworkTriggerPayload): boolean => isClockPayload(payload) && payload.repeatInterval !== 'hourly';

/** "Every Monday", "Every weekday", "Every day", "Once, today", "Right away": the day part of When, without the time. */
export function dayWords(payload: CoworkPayload | CoworkTriggerPayload, t: TranslateFn, now: Date = new Date()): string {
    if (!isClockPayload(payload)) return t('cowork_home.confirm.on_mail', 'When a new e-mail arrives');
    if (payload.repeatInterval === 'hourly') return repeatLabel('hourly', t);
    if (payload.repeatInterval || payload.daysOfWeek?.length) return cadenceLine({ ...payload, timeOfDay: null }, t);
    if (payload.startNow) return t('cowork_home.confirm.right_away', 'Right away');
    const first = new Date(payload.nextRunAt);
    if (first.toDateString() === now.toDateString()) return t('cowork_home.confirm.once_today', 'Once, today');
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    if (first.toDateString() === tomorrow.toDateString()) return t('cowork_home.confirm.once_tomorrow', 'Once, tomorrow');
    return t('cowork_home.confirm.once_on', 'Once, {date}', { date: first.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) });
}

/** The e-mail addresses written in the sentence, in order and once each. */
function addressesIn(text: string): string[] {
    const out: string[] = [];
    for (const raw of text.split(/[\s,;:()<>]+/)) {
        const word = raw.replace(/[.!?]+$/, '');
        const at = word.indexOf('@');
        if (at > 0 && word.indexOf('.', at) > at + 1 && !out.includes(word)) out.push(word);
    }
    return out;
}

/** Who a new task sends to, as far as the sentence says: the addresses in it, or only its owner. */
export function sendsToWords({ payload }: CoworkDraft, t: TranslateFn): string {
    if (!isClockPayload(payload)) return t('cowork_home.confirm.sends_sender', 'The sender of each mail, as a draft');
    const to = addressesIn(payload.prompt);
    return to.length > 0 ? to.join(', ') : t('cowork_home.confirm.sends_you', 'Only you');
}

/** The part of an app's name a person writes in a sentence: "Fireflies.ai" → "fireflies", "Google Calendar" → "google calendar". */
function spokenName(label: string): string {
    const lower = label.toLowerCase().trim();
    const dot = lower.indexOf('.');
    return dot > 0 ? lower.slice(0, dot) : lower;
}

/**
 * The apps the sentence itself names, by their name or id, with plain string matching (no regular expression on what
 * the user typed). The confirmation names only these: the workspace's other apps are not what the task "uses"; the
 * steps Cowork sets up afterwards say exactly which apps they read, change or send with, before anything runs.
 */
export function appsNamedIn<A extends { id: string; label: string }>(text: string, apps: readonly A[]): A[] {
    const said = ` ${text.toLowerCase()} `;
    return apps.filter((a) => {
        const name = spokenName(a.label);
        return (name.length >= 3 && said.includes(name)) || (a.id.length >= 3 && said.includes(a.id.toLowerCase()));
    });
}
