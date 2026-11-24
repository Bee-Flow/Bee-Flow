/**
 * The edit view of a task (./CoworkTaskEdit.tsx) as data: the draft it starts from, what a save sends, and whether the
 * steps must be rebuilt ("Save and test") or a save is enough. Pure: no fetching, no React.
 *
 * Every start the server supports: the clock (once, every hour, every day, weekdays, chosen days, every two weeks,
 * month, quarter or year), a new e-mail, after another task, a new row in a table, a file in a folder, a webhook.
 */
import { defaultMailTrigger, isMailTriggerItem, normaliseMailTrigger } from '../mailTrigger';
import { nextOccurrence, toDateInput, toTimeInput } from '../coworkSchedule';
import type { StartChoice, StartKind, StartState } from '@/api/coworkStart';
import type { CoworkItem, MailTrigger } from '@/api/cowork.types';
import type { CoworkItemChange } from '@/api/coworkTask';
import type { TaskMode } from './coworkTaskModel';

export type StartChoiceKind = 'schedule' | 'email' | 'after' | 'row' | 'file' | 'webhook';

/** The repeat of a task on the clock, in the server's words; '' is once. */
export type Repeat = '' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';
export const REPEATS: readonly Repeat[] = ['', 'hourly', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];
export const DAY_TOKENS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];

export interface EditDraft {
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
}

const KIND_OF_START: Record<StartKind, StartChoiceKind> = { schedule: 'schedule', app_event: 'email', after_cowork: 'after', webhook: 'webhook', row: 'row', file: 'file' };

/** How the task starts now: the start the server says, else its trigger. */
export function startKindOf(item: Pick<CoworkItem, 'triggerKind' | 'trigger'>, start: StartState | null | undefined): StartChoiceKind {
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
function targetsOf(start: StartState | null | undefined): Pick<EditDraft, 'afterId' | 'tableId' | 'folder'> {
    return { afterId: start?.after?.id ?? '', tableId: start?.datatableId ?? '', folder: start?.inFolder ?? '' };
}

/** The draft of a task as it is. */
export function draftOf(item: CoworkItem, start: StartState | null | undefined, mode: TaskMode, now: Date = new Date()): EditDraft {
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
    };
}

/**
 * The steps must be made again, and tried once, before it runs: it is (or becomes) a task with fixed steps, and what
 * it should do, how it works or what starts it changed. A new name or time alone keeps the steps.
 */
export function mustRebuild(draft: EditDraft, initial: EditDraft): boolean {
    if (draft.mode !== 'steps') return false;
    return draft.prompt.trim() !== initial.prompt.trim() || initial.mode !== 'steps' || draft.kind !== initial.kind;
}

/** The days a clock start runs on: chosen days for "on chosen days", Monday to Friday for weekdays, else none. */
function daysOf(draft: EditDraft): string[] | null {
    if (draft.repeat === 'weekly') return draft.days.length > 0 ? DAY_TOKENS.filter((d) => draft.days.includes(d)) : null;
    if (draft.repeat === 'weekdays') return WEEKDAYS;
    return null;
}

/** The next moment a clock start runs: the chosen date for a start on a date, the next matching time for the rest. */
export function nextRunOf(draft: EditDraft, now: Date = new Date()): Date | null {
    const [hh, mm] = draft.time.split(':').map(Number);
    if (draft.repeat === 'hourly') return new Date(now.getTime() + 60 * 60_000);
    if (draft.repeat === 'daily' || draft.repeat === 'weekdays' || draft.repeat === 'weekly') return nextOccurrence(draft.time, daysOf(draft), { now });
    const [y, m, d] = draft.date.split('-').map(Number);
    const at = new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0, 0);
    return Number.isNaN(at.getTime()) ? null : at;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** What the save sends to PUT /api/cowork/:id. */
export function changeOf(draft: EditDraft, now: Date = new Date()): CoworkItemChange {
    const base: CoworkItemChange = { title: draft.title.trim(), prompt: draft.prompt.trim(), agentId: draft.mode === 'agent' && draft.agentId ? draft.agentId : null };
    if (draft.kind === 'email') {
        const mail = normaliseMailTrigger(draft.mail);
        return { ...base, triggerKind: 'app_event', trigger: { provider: mail.provider, event: mail.event, filter: Object.fromEntries(Object.entries(mail.filter ?? {})) } };
    }
    if (draft.kind !== 'schedule') return base;
    const next = nextRunOf(draft, now);
    return {
        ...base,
        triggerKind: 'schedule',
        repeatInterval: draft.repeat || null,
        daysOfWeek: draft.repeat === 'weekly' ? daysOf(draft) : null,
        timeOfDay: draft.repeat !== 'hourly' && TIME.test(draft.time) ? draft.time : null,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        ...(next ? { nextRunAt: next.toISOString() } : {}),
    };
}

/**
 * The start to save through PUT /api/cowork/:id/start, or null when that is not needed: a start on an event that is
 * new or points elsewhere, or back to the clock from such a start. The clock and a mail are saved with the task.
 */
export function startChoiceOf(draft: EditDraft, initial: EditDraft): StartChoice | null {
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

/** The draft can be saved: a name, a sentence, and what its start needs. */
export function canSave(draft: EditDraft): boolean {
    if (!draft.title.trim() || !draft.prompt.trim()) return false;
    if (draft.mode === 'agent' && !draft.agentId) return false;
    if (draft.kind === 'after') return !!draft.afterId;
    if (draft.kind === 'row') return !!draft.tableId;
    if (draft.kind === 'file') return draft.folder.startsWith('/');
    if (draft.kind === 'schedule' && draft.repeat === 'weekly') return draft.days.length > 0;
    return true;
}
