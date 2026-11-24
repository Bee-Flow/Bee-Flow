/**
 * The Settings of a task (./CoworkTaskSettings.tsx) as data: the draft a row starts from, what a save of each row
 * sends, and whether the steps must be rebuilt ("Save and test") or a save is enough. Pure: no fetching, no React.
 *
 * Three rows are edited as a draft and saved: What (its name and its sentence), When (every start the server supports:
 * the clock, once or every hour, day, weekdays, chosen days, two weeks, month, quarter or year; a new e-mail; after
 * another task; a new row in a table; a file in a folder; a webhook) and Uses (its apps, and how it works). Each row
 * sends only its own fields, so a new name never moves the clock. Sends to saves each choice at once
 * (./TaskSetSendsTo.tsx).
 */
import { defaultMailTrigger, isMailTriggerItem, normaliseMailTrigger } from '../mailTrigger';
import { nextOccurrence, toDateInput, toTimeInput } from '../coworkSchedule';
import type { StartChoice, StartKind, StartState } from '@/api/coworkStart';
import type { CoworkItem, MailTrigger } from '@/api/cowork.types';
import type { CoworkItemChange } from '@/api/coworkTask';
import type { TaskMode } from './coworkTaskModel';

/** The four rows of Settings; the first three are saved as a draft. */
export type SettingRowId = 'what' | 'when' | 'uses' | 'sends';
export type DraftRowId = Exclude<SettingRowId, 'sends'>;

export type StartChoiceKind = 'schedule' | 'email' | 'after' | 'row' | 'file' | 'webhook';

/** The repeat of a task on the clock, in the server's words; '' is once. */
export type Repeat = '' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';
export const REPEATS: readonly Repeat[] = ['', 'hourly', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];
export const DAY_TOKENS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];

export interface TaskDraft {
    title: string;
    prompt: string;
    kind: StartChoiceKind;
    repeat: Repeat;
    days: string[];
    date: string;
    time: string;
    mail: MailTrigger;
    afterId: string;
    tableId: string;
    folder: string;
    mode: TaskMode;
    agentId: string;
    /** The apps it may use; null while it has no list of its own (it then uses the workspace's). */
    apps: string[] | null;
}

const KIND_OF_START: Record<StartKind, StartChoiceKind> = { schedule: 'schedule', app_event: 'email', after_cowork: 'after', webhook: 'webhook', row: 'row', file: 'file' };

/** How the task starts now: the start the server says, else its trigger. */
function startKindOf(item: Pick<CoworkItem, 'triggerKind' | 'trigger'>, start: StartState | null | undefined): StartChoiceKind {
    if (start) return KIND_OF_START[start.kind] ?? 'schedule';
    return isMailTriggerItem({ triggerKind: item.triggerKind ?? null, trigger: item.trigger }) ? 'email' : 'schedule';
}

const isRepeat = (value: unknown): value is Repeat => typeof value === 'string' && (REPEATS as readonly string[]).includes(value);

/** When it runs next, or now for a task without a valid next run. */
function nextOf(item: Pick<CoworkItem, 'nextRunAt'>, now: Date): Date {
    const next = item.nextRunAt ? new Date(item.nextRunAt) : now;
    return Number.isNaN(next.getTime()) ? now : next;
}

/** Its days as tokens; a plain "every week" runs on the weekday of its next run. */
function daysOfItem(item: Pick<CoworkItem, 'daysOfWeek'>, repeat: Repeat, at: Date): string[] {
    const own = Array.isArray(item.daysOfWeek) ? item.daysOfWeek.map((d) => String(d).toLowerCase().slice(0, 3)) : [];
    return own.length === 0 && repeat === 'weekly' ? [['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][at.getDay()]] : own;
}

/** What a start on an event points at: the task it follows, the table, the folder. */
function targetsOf(start: StartState | null | undefined): Pick<TaskDraft, 'afterId' | 'tableId' | 'folder'> {
    return { afterId: start?.after?.id ?? '', tableId: start?.datatableId ?? '', folder: start?.inFolder ?? '' };
}

/** The draft of a task as it is. */
export function draftOf(item: CoworkItem, start: StartState | null | undefined, mode: TaskMode, now: Date = new Date()): TaskDraft {
    const at = nextOf(item, now);
    const stored = item.repeatInterval ?? '';
    const repeat: Repeat = isRepeat(stored) ? stored : 'daily';
    return {
        title: item.title ?? '',
        prompt: item.prompt ?? '',
        kind: startKindOf(item, start),
        repeat,
        days: daysOfItem(item, repeat, at),
        date: toDateInput(at),
        time: item.timeOfDay ?? toTimeInput(at),
        mail: item.triggerKind === 'app_event' && item.trigger ? item.trigger : defaultMailTrigger(),
        ...targetsOf(start),
        mode,
        agentId: item.agentId ?? '',
        apps: Array.isArray(item.enabledApps) ? item.enabledApps : null,
    };
}

/** The fields each row edits. */
const ROW_FIELDS: Readonly<Record<DraftRowId, ReadonlyArray<keyof TaskDraft>>> = {
    what: ['title', 'prompt'],
    when: ['kind', 'repeat', 'days', 'date', 'time', 'mail', 'afterId', 'tableId', 'folder'],
    uses: ['apps', 'mode', 'agentId'],
};

const same = (a: unknown, b: unknown): boolean => JSON.stringify(typeof a === 'string' ? a.trim() : a) === JSON.stringify(typeof b === 'string' ? b.trim() : b);

/** The row's draft differs from the task as it is: there is something to save. */
export function rowChanged(row: DraftRowId, draft: TaskDraft, initial: TaskDraft): boolean {
    return ROW_FIELDS[row].some((field) => !same(draft[field], initial[field]));
}

/** Its own list of apps changed (the order does not count); a task without a list of its own did not change. */
function appsChanged(draft: TaskDraft, initial: TaskDraft): boolean {
    if (draft.apps === null) return false;
    return initial.apps === null || !same([...draft.apps].sort(), [...initial.apps].sort());
}

/**
 * The steps must be made again, and tested once, before it runs: it is (or becomes) a task with fixed steps, and what
 * it should do, what it may use, how it works or what starts it changed. A new name or time alone keeps the steps.
 */
export function mustRebuild(draft: TaskDraft, initial: TaskDraft): boolean {
    if (draft.mode !== 'steps') return false;
    return draft.prompt.trim() !== initial.prompt.trim() || initial.mode !== 'steps' || draft.kind !== initial.kind || appsChanged(draft, initial);
}

/**
 * What a save does to the task's steps, said before it is made: they are made again and tested (`rebuild`), taken off
 * because the AI or an agent does the task from now on (`drops_steps`), left as they are (`keeps_steps`), or the task
 * has no fixed steps to speak of (`plain`).
 */
export type SaveEffect = 'rebuild' | 'drops_steps' | 'keeps_steps' | 'plain';

export function saveEffect(draft: TaskDraft, initial: TaskDraft): SaveEffect {
    if (mustRebuild(draft, initial)) return 'rebuild';
    if (initial.mode !== 'steps') return 'plain';
    return draft.mode === 'steps' ? 'keeps_steps' : 'drops_steps';
}

/** The days a clock start runs on: chosen days for "on chosen days", Monday to Friday for weekdays, else none. */
function daysOf(draft: TaskDraft): string[] | null {
    if (draft.repeat === 'weekly') return draft.days.length > 0 ? DAY_TOKENS.filter((d) => draft.days.includes(d)) : null;
    if (draft.repeat === 'weekdays') return WEEKDAYS;
    return null;
}

/** The next moment a clock start runs: the chosen date for a start on a date, the next matching time for the rest. */
export function nextRunOf(draft: TaskDraft, now: Date = new Date()): Date | null {
    const [hh, mm] = draft.time.split(':').map(Number);
    if (draft.repeat === 'hourly') return new Date(now.getTime() + 60 * 60_000);
    if (draft.repeat === 'daily' || draft.repeat === 'weekdays' || draft.repeat === 'weekly') return nextOccurrence(draft.time, daysOf(draft), { now });
    const [y, m, d] = draft.date.split('-').map(Number);
    const at = new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0, 0);
    return Number.isNaN(at.getTime()) ? null : at;
}

/** "HH:MM" on a 24-hour clock, checked with plain string operations (no regular expression on what the user typed). */
function isTimeOfDay(value: string): boolean {
    if (value.length !== 5 || value[2] !== ':') return false;
    const digits = value.slice(0, 2) + value.slice(3);
    if (![...digits].every((c) => c >= '0' && c <= '9')) return false;
    return Number(value.slice(0, 2)) <= 23 && Number(value.slice(3)) <= 59;
}

/** What saving When sends to PUT /api/cowork/:id: the clock, or the mail that starts it; null for a start on another event. */
function whenChange(draft: TaskDraft, now: Date): CoworkItemChange | null {
    if (draft.kind === 'email') {
        const mail = normaliseMailTrigger(draft.mail);
        return { triggerKind: 'app_event', trigger: { provider: mail.provider, event: mail.event, filter: Object.fromEntries(Object.entries(mail.filter ?? {})) } };
    }
    if (draft.kind !== 'schedule') return null;
    const next = nextRunOf(draft, now);
    return {
        triggerKind: 'schedule',
        repeatInterval: draft.repeat || null,
        daysOfWeek: draft.repeat === 'weekly' ? daysOf(draft) : null,
        timeOfDay: draft.repeat !== 'hourly' && isTimeOfDay(draft.time) ? draft.time : null,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        ...(next ? { nextRunAt: next.toISOString() } : {}),
    };
}

/** What saving a row sends to PUT /api/cowork/:id: that row's own fields, or null when it has none to send there. */
export function changeOf(row: DraftRowId, draft: TaskDraft, now: Date = new Date()): CoworkItemChange | null {
    if (row === 'what') return { title: draft.title.trim(), prompt: draft.prompt.trim() };
    if (row === 'when') return whenChange(draft, now);
    return { agentId: draft.mode === 'agent' && draft.agentId ? draft.agentId : null, ...(draft.apps === null ? {} : { enabledApps: draft.apps }) };
}

/**
 * The start to save through PUT /api/cowork/:id/start, or null when that is not needed: a start on an event that is
 * new or points elsewhere, or back to the clock from such a start. The clock and a mail are saved with the task.
 */
export function startChoiceOf(draft: TaskDraft, initial: TaskDraft): StartChoice | null {
    const moved = (field: 'afterId' | 'tableId' | 'folder') => draft.kind !== initial.kind || draft[field] !== initial[field];
    switch (draft.kind) {
        case 'after': return draft.afterId && moved('afterId') ? { kind: 'after_cowork', scheduleId: draft.afterId } : null;
        case 'row': return draft.tableId && moved('tableId') ? { kind: 'row', datatableId: draft.tableId } : null;
        case 'file': return draft.folder.startsWith('/') && moved('folder') ? { kind: 'file', inFolder: draft.folder } : null;
        case 'webhook': return draft.kind === initial.kind ? null : { kind: 'webhook' };
        case 'schedule': return ['after', 'row', 'file', 'webhook'].includes(initial.kind) ? { kind: 'schedule' } : null;
        default: return null;
    }
}

/** What its start needs before it can be saved. */
function whenComplete(draft: TaskDraft): boolean {
    if (draft.kind === 'after') return !!draft.afterId;
    if (draft.kind === 'row') return !!draft.tableId;
    if (draft.kind === 'file') return draft.folder.startsWith('/');
    return draft.kind !== 'schedule' || draft.repeat !== 'weekly' || draft.days.length > 0;
}

/** The row can be saved: a name and a sentence, what its start needs, or the agent that does it. */
export function canSave(row: DraftRowId, draft: TaskDraft): boolean {
    if (row === 'what') return !!draft.title.trim() && !!draft.prompt.trim();
    if (row === 'when') return whenComplete(draft);
    return draft.mode !== 'agent' || !!draft.agentId;
}
