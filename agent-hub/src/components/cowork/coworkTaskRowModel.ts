/**
 * The words of one row of "Your tasks" (./CoworkTaskRows.tsx) besides its title and status: when it runs and its goal
 * (left), and what comes next (right): "Next: Tomorrow, 09:00", "Now", "On hold", "Waits for a new mail", "Ran once".
 * Pure: the clock and the locale come in.
 */
import { isMailTriggerItem } from './mailTrigger';
import type { TaskStatus } from './coworkTaskStatus';
import type { CoworkItem } from '@/api/cowork.types';
import type { TranslateFn } from '@/hooks/useTranslation';

type RowItem = Pick<CoworkItem, 'isActive' | 'nextRunAt' | 'repeatInterval' | 'daysOfWeek' | 'trigger'> & { triggerKind?: string | null };

const sameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString();

/** "Today, 09:00", "Tomorrow, 09:00", "Tue 1 Dec, 09:00", on the reader's clock and in their language. */
export function momentWords(at: Date, t: TranslateFn, locale: string, now: Date = new Date()): string {
    const time = at.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    if (sameDay(at, now)) return t('cowork_home.next.today', 'Today, {time}', { time });
    if (sameDay(at, tomorrow)) return t('cowork_home.next.tomorrow', 'Tomorrow, {time}', { time });
    const date = at.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });
    return t('cowork_home.next.on', '{date}, {time}', { date, time });
}

/** What starts it when it is not the clock, as "waits for …"; null for the clock. */
function waitsFor(item: RowItem, t: TranslateFn): string | null {
    if (isMailTriggerItem({ triggerKind: item.triggerKind ?? null, trigger: item.trigger })) return t('cowork_home.next.mail', 'Waits for a new mail');
    switch (item.triggerKind) {
        case 'after_cowork': return t('cowork_home.next.after', 'Waits for the other task');
        case 'webhook': return t('cowork_home.next.webhook', 'Waits for a call');
        case 'row': return t('cowork_home.next.row', 'Waits for a new row');
        case 'file': return t('cowork_home.next.file', 'Waits for a new file');
        default: return null;
    }
}

/** Its next start, when it is switched on and that start is still to come. */
function dueAt(item: RowItem, now: Date): Date | null {
    const at = item.nextRunAt ? new Date(item.nextRunAt) : null;
    if (!at || Number.isNaN(at.getTime()) || item.isActive === false) return null;
    return at.getTime() >= now.getTime() ? at : null;
}

const repeats = (item: RowItem): boolean => !!item.repeatInterval || (Array.isArray(item.daysOfWeek) && item.daysOfWeek.length > 0);

/** The right-hand line of a row; empty when there is nothing to say (paused). */
export function nextLine(item: RowItem, status: TaskStatus, t: TranslateFn, locale: string, now: Date = new Date()): string {
    if (status === 'running' || status === 'testing') return t('cowork_home.next.now', 'Now');
    if (status === 'paused') return '';
    if (status === 'failed') return t('cowork_home.next.on_hold', 'On hold');
    const event = waitsFor(item, t);
    if (event) return event;
    const due = dueAt(item, now);
    const finished = status === 'done' || status === 'nothing';
    if (!due) return finished && !repeats(item) ? t('cowork_home.next.ran_once', 'Ran once') : '';
    return t('cowork_home.next.next', 'Next: {when}', { when: momentWords(due, t, locale, now) });
}
