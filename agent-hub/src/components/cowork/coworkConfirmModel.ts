/**
 * The one confirmation before a new task exists (./CoworkConfirmCard.tsx): what the composer worked out of the
 * sentence (./useCoworkComposer.ts with `confirm`), as What, When, Uses and Sends to. Pure: the clock comes in.
 *
 * When the sentence does not say when ("summarise my meetings", "every week, …" without a day), the card asks "Which
 * day?" before Start: once today, every day, weekdays, or every one weekday, at a time. Choosing one rewrites the
 * draft's schedule with the same fields the composer itself sends.
 *
 * Every row can be changed before Start. What the owner changed by hand is kept apart from the draft (`ConfirmChoices`),
 * so reading the sentence again after an edit replaces only the rows they did not touch (`confirmView`). What Start
 * sends is the draft with those choices in it (`startPayload`): the name, the schedule, the apps as the task's own
 * list, and who it sends to with "show me each message first" as its set-up (server usecases/coworkSetup.mts).
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

const BREAKS = ' \t\n\r,;:()<>"';
const ENDINGS = '.!?';

/** The words of a text, cut at blanks and brackets, without the full stop a sentence ends on. Plain string walking. */
function wordsOf(text: string): string[] {
    const out: string[] = [];
    let word = '';
    for (const ch of text + ' ') {
        if (!BREAKS.includes(ch)) { word += ch; continue; }
        while (word && ENDINGS.includes(word.charAt(word.length - 1))) word = word.slice(0, -1);
        if (word) out.push(word);
        word = '';
    }
    return out;
}

/** An e-mail address, by plain string checks (never a pattern on what a person typed): one @, a dotted host, no blanks. */
export function isAddress(value: string): boolean {
    const text = value.trim();
    if (!text || text.length > 320 || wordsOf(text)[0] !== text) return false;
    const at = text.indexOf('@');
    if (at <= 0 || at !== text.lastIndexOf('@')) return false;
    const host = text.slice(at + 1);
    const dot = host.lastIndexOf('.');
    return dot > 0 && dot < host.length - 1 && !host.includes('..');
}

/** Who a task sends to: its owner ("Me"), and the addresses of other people. */
export interface Recipients { me: boolean; others: string[] }

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Who a new task sends to, as far as its sentence says: its owner, and every address written in it, in order and once
 * each. "Me" is always there: "send it to me and sam@example.com" is both, and only the owner takes themselves off.
 */
export function recipientsIn(text: string): Recipients {
    const others: string[] = [];
    for (const word of wordsOf(text)) if (isAddress(word) && !others.some((o) => sameAddress(o, word))) others.push(word);
    return { me: true, others };
}

/** With one more address; the same list when it is there already or is no address. */
export function withRecipient(to: Recipients, address: string): Recipients {
    const next = address.trim();
    if (!isAddress(next) || to.others.some((o) => sameAddress(o, next))) return to;
    return { ...to, others: [...to.others, next] };
}

/** Without one address. */
export const withoutRecipient = (to: Recipients, address: string): Recipients => ({ ...to, others: to.others.filter((o) => !sameAddress(o, address)) });

/** What a task's set-up says it sends to: "me", then the addresses. */
const sendsToList = (to: Recipients): string[] => [...(to.me ? ['me'] : []), ...to.others];

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

/** The schedule of a draft: the fields "Which day?" and the time rewrite. */
export type SchedulePart = Pick<CoworkPayload, 'repeatInterval' | 'nextRunAt' | 'daysOfWeek' | 'timeOfDay' | 'startNow'>;

/** What the owner changed by hand on the card; a row they did not touch follows the sentence. */
export interface ConfirmChoices {
    title?: string;
    schedule?: SchedulePart;
    /** The apps the task may use, by id. */
    apps?: string[];
    recipients?: Recipients;
    showFirst?: boolean;
}

export const schedulePartOf = ({ repeatInterval, nextRunAt, daysOfWeek, timeOfDay, startNow }: CoworkPayload): SchedulePart => ({
    repeatInterval, nextRunAt, ...(daysOfWeek ? { daysOfWeek } : {}), ...(timeOfDay ? { timeOfDay } : {}), ...(startNow ? { startNow } : {}),
});

/** The draft with a schedule chosen by hand in it. */
function withSchedule(payload: CoworkPayload, schedule: SchedulePart): CoworkPayload {
    const rest: CoworkPayload = { ...payload };
    delete rest.startNow;
    delete rest.daysOfWeek;
    delete rest.timeOfDay;
    return { ...rest, ...schedule };
}

/** The four rows as the card shows them now. */
export interface ConfirmView {
    title: string;
    /** What Start creates, with the schedule the owner chose by hand. */
    payload: CoworkPayload | CoworkTriggerPayload;
    /** The ids of the apps the task may use; null while nobody chose and the sentence names none (Cowork picks them). */
    apps: string[] | null;
    recipients: Recipients;
    /** Someone other than the owner gets it: "Show me each message first" is offered. */
    sendsToOthers: boolean;
    showFirst: boolean;
}

/**
 * The card's rows: the owner's own choice where they made one, else what the sentence says. `sentence` is what they
 * typed (the draft's instruction may word it differently), `catalogue` the workspace's apps.
 */
export function confirmView(draft: CoworkDraft, choices: ConfirmChoices, sentence: string, catalogue: ReadonlyArray<{ id: string; label: string }>): ConfirmView {
    const { payload } = draft;
    const said = [sentence, payload.prompt ?? ''].join(' ');
    const named = appsNamedIn(said, catalogue).map((a) => a.id);
    const own = Array.isArray(payload.enabledApps) ? payload.enabledApps : null;
    const recipients = choices.recipients ?? recipientsIn(said);
    const sendsToOthers = isClockPayload(payload) && recipients.others.length > 0;
    return {
        title: choices.title ?? payload.title,
        payload: choices.schedule && isClockPayload(payload) ? withSchedule(payload, choices.schedule) : payload,
        apps: choices.apps ?? own ?? (named.length > 0 ? named : null),
        recipients,
        sendsToOthers,
        showFirst: sendsToOthers && (choices.showFirst ?? true),
    };
}

/**
 * What Start sends: the draft with the card's rows in it. `steps`: Cowork sets up fixed steps for it and tests them
 * (false where the organisation has none: the AI then works it out every run, and the card said so).
 */
export function startPayload(view: ConfirmView, steps: boolean): CoworkPayload | CoworkTriggerPayload {
    const title = view.title.trim() || view.payload.title;
    if (!isClockPayload(view.payload)) return { ...view.payload, title };
    return {
        ...view.payload,
        title,
        ...(view.apps ? { enabledApps: view.apps } : {}),
        setup: { steps, sendsTo: sendsToList(view.recipients), ...(view.sendsToOthers ? { askFirst: view.showFirst } : {}) },
    };
}
