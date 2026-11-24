/**
 * "When", the second row of a task's Settings (./CoworkTaskSettings.tsx), opened: every start the server supports,
 * with what each needs. On a schedule (how often, the date, the time, the days), a new e-mail (the mail app, from
 * whom, the subject; a task a mail starts only drafts its reply, to the sender), after another task, a new row in a
 * table, a new file in a folder, or a webhook (its address is made on save, and shown once with Copy).
 *
 * A new time is saved at once. Another kind of start for a task with fixed steps is "Save and test". Pausing is not
 * here: it is in the task's header.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import MailTriggerPanel from '../MailTriggerPanel';
import { cadenceLine } from '../coworkSchedule';
import { fullTimestamp } from '../coworkFormat';
import { whenLine } from '../coworkOverviewModel';
import { DAY_TOKENS, REPEATS, nextRunOf, type Repeat, type StartChoiceKind, type TaskDraft } from './coworkTaskSettingsModel';
import { SaveBar } from './taskRows';
import { BTN_LINK, BTN_PRIMARY, BTN_QUIET, FIELD, LABEL, META, ROW_ACTIONS } from './taskUi';
import { useSettingRow, type SettingRowForm } from './useTaskSettingsSave';
import { useOwnCoworks, useReadableTables, type HookAddress, type StartState } from '@/api/coworkStart';
import type { CoworkItem } from '@/api/cowork.types';
import type { TranslateFn } from '@/hooks/useTranslation';

type Set = (patch: Partial<TaskDraft>) => void;

const KINDS: Array<[StartChoiceKind, string, string]> = [
    ['schedule', 'cowork_task.when.schedule', 'On a schedule'],
    ['email', 'cowork_task.when.email', 'When a new e-mail arrives'],
    ['after', 'cowork_task.when.after', 'After another task finishes'],
    ['row', 'cowork_task.when.row', 'When a table gets a new row'],
    ['file', 'cowork_task.when.file', 'When a new file lands in a folder'],
    ['webhook', 'cowork_task.when.webhook', 'When another system calls it (webhook)'],
];

const REPEAT_WORDS: Record<Repeat, [string, string]> = {
    '': ['cowork_task.repeat.once', 'Once'],
    hourly: ['cowork_task.repeat.hourly', 'Every hour'],
    daily: ['cowork_task.repeat.daily', 'Every day'],
    weekdays: ['cowork_task.repeat.weekdays', 'Weekdays'],
    weekly: ['cowork_task.repeat.weekly', 'On chosen days'],
    biweekly: ['cowork_task.repeat.biweekly', 'Every two weeks'],
    monthly: ['cowork_task.repeat.monthly', 'Every month'],
    quarterly: ['cowork_task.repeat.quarterly', 'Every quarter'],
    yearly: ['cowork_task.repeat.yearly', 'Every year'],
};

const DAY_WORDS: Record<string, [string, string]> = {
    mon: ['cowork_task.day.mon', 'Mon'], tue: ['cowork_task.day.tue', 'Tue'], wed: ['cowork_task.day.wed', 'Wed'], thu: ['cowork_task.day.thu', 'Thu'],
    fri: ['cowork_task.day.fri', 'Fri'], sat: ['cowork_task.day.sat', 'Sat'], sun: ['cowork_task.day.sun', 'Sun'],
};

const kindWords = (kind: StartChoiceKind, t: TranslateFn): string => {
    const found = KINDS.find((k) => k[0] === kind) ?? KINDS[0];
    return t(found[1], found[2]);
};

/** When the task starts, in plain words, as the When row shows it while closed. */
export function whenWords(item: CoworkItem, start: StartState | null | undefined, t: TranslateFn): string {
    switch (start?.kind) {
        case 'after_cowork': return t('cowork_task.head.after', "After '{title}' finishes", { title: start.after?.title || t('cowork_task.head.untitled', 'Untitled task') });
        case 'row': return kindWords('row', t);
        case 'webhook': return kindWords('webhook', t);
        case 'file': return start.inFolder ? t('cowork_task.when.file_in', 'When a new file lands in {folder}', { folder: start.inFolder }) : kindWords('file', t);
        default: return whenLine(item, t);
    }
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
    return (
        <div className="flex-[1_1_160px] min-w-0 flex flex-col gap-1">
            <label htmlFor={id} className={LABEL}>{label}</label>
            {children}
            {hint && <span className={META}>{hint}</span>}
        </div>
    );
}

const DAY_ON = 'border-[var(--accent-primary)] bg-[var(--bg-tertiary)] text-[var(--text-primary)]';
const DAY_OFF = 'border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-secondary)]';

function Schedule({ draft, set, id, t }: { draft: TaskDraft; set: Set; id: string; t: TranslateFn }) {
    const dated = draft.repeat === '' || ['biweekly', 'monthly', 'quarterly', 'yearly'].includes(draft.repeat);
    const toggle = (day: string) => set({ days: draft.days.includes(day) ? draft.days.filter((d) => d !== day) : [...draft.days, day] });
    return (
        <>
            <div className="flex flex-wrap gap-3">
                <Field id={`${id}-repeat`} label={t('cowork_task.when.how_often', 'How often')}>
                    <select id={`${id}-repeat`} className={FIELD} value={draft.repeat} onChange={(e) => set({ repeat: e.target.value as Repeat })}>
                        {REPEATS.map((r) => <option key={r || 'once'} value={r}>{t(REPEAT_WORDS[r][0], REPEAT_WORDS[r][1])}</option>)}
                    </select>
                </Field>
                {dated && (
                    <Field id={`${id}-date`} label={draft.repeat === '' ? t('cowork_task.when.on', 'On') : t('cowork_task.when.from', 'Starting on')}>
                        <input id={`${id}-date`} type="date" className={FIELD} value={draft.date} onChange={(e) => set({ date: e.target.value })} />
                    </Field>
                )}
                {draft.repeat !== 'hourly' && (
                    <Field id={`${id}-time`} label={t('cowork_task.when.at', 'At')}>
                        <input id={`${id}-time`} type="time" className={FIELD} value={draft.time} onChange={(e) => set({ time: e.target.value || '09:00' })} />
                    </Field>
                )}
            </div>
            {draft.repeat === 'weekly' && (
                <div className="flex flex-col gap-1.5">
                    <span className={LABEL} id={`${id}-days`}>{t('cowork_task.when.days', 'On these days')}</span>
                    <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby={`${id}-days`}>
                        {DAY_TOKENS.map((day) => (
                            <button key={day} type="button" aria-pressed={draft.days.includes(day)} onClick={() => toggle(day)}
                                className={`min-w-11 min-h-11 px-2 rounded-[var(--radius-md)] border text-[14px] font-medium transition-colors duration-[120ms] ${draft.days.includes(day) ? DAY_ON : DAY_OFF}`}>
                                {t(DAY_WORDS[day][0], DAY_WORDS[day][1])}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </>
    );
}

interface TargetProps { draft: TaskDraft; set: Set; id: string; itemId: string; onOpenTask: (id: string) => void; t: TranslateFn }

/** The task it starts after, with a way to open that task. */
function AfterTask({ draft, set, id, itemId, onOpenTask, t }: TargetProps) {
    const others = (useOwnCoworks(true).data ?? []).filter((o) => o.id !== itemId);
    const chosen = others.find((o) => o.id === draft.afterId);
    return (
        <Field id={`${id}-after`} label={t('cowork_task.when.after_which', 'After this task finishes')} hint={t('cowork_task.when.after_hint', 'It starts once the other task ends as Done.')}>
            <select id={`${id}-after`} className={FIELD} value={draft.afterId} onChange={(e) => set({ afterId: e.target.value })}>
                <option value="">{t('cowork_task.when.choose', 'Choose…')}</option>
                {others.map((o) => <option key={o.id} value={o.id}>{o.title || t('cowork_task.head.untitled', 'Untitled task')}</option>)}
            </select>
            {chosen && (
                <div><button type="button" className={BTN_LINK} onClick={() => onOpenTask(chosen.id)}>{t('cowork_task.when.open_after', "Open '{title}'", { title: chosen.title || t('cowork_task.head.untitled', 'Untitled task') })}</button></div>
            )}
        </Field>
    );
}

/** The other kinds: which task, which table, which folder. */
function Target(props: TargetProps) {
    const { draft, set, id, t } = props;
    const tables = useReadableTables(draft.kind === 'row').data ?? [];
    if (draft.kind === 'after') return <AfterTask {...props} />;
    if (draft.kind === 'row') {
        return (
            <Field id={`${id}-table`} label={t('cowork_task.when.table', 'Table')}>
                <select id={`${id}-table`} className={FIELD} value={draft.tableId} onChange={(e) => set({ tableId: e.target.value })}>
                    <option value="">{t('cowork_task.when.choose', 'Choose…')}</option>
                    {tables.map((tb) => <option key={tb.id} value={tb.id}>{tb.name || tb.id}</option>)}
                </select>
            </Field>
        );
    }
    return (
        <Field id={`${id}-folder`} label={t('cowork_task.when.folder', 'Folder')} hint={t('cowork_task.when.folder_hint', 'A folder in Nextcloud, such as /Invoices')}>
            <input id={`${id}-folder`} type="text" className={FIELD} placeholder="/Invoices" value={draft.folder} onChange={(e) => set({ folder: e.target.value })} />
        </Field>
    );
}

/** A webhook's address, once it was made: copy it now, the token is shown only once. */
function HookAddressCard({ address, onDone, t }: { address: HookAddress; onDone: () => void; t: TranslateFn }) {
    const [copied, setCopied] = useState('');
    const copy = () => {
        const fail = () => setCopied(t('cowork_task.when.copy_failed', 'Select the address to copy it'));
        try { navigator.clipboard.writeText(`${address.url}\nAuthorization: Bearer ${address.token}`).then(() => setCopied(t('cowork_task.when.copied', 'Copied')), fail); } catch { fail(); }
    };
    return (
        <div className="flex flex-col gap-2.5" data-testid="cowork-task-hook">
            <strong className="font-semibold" role="status">{t('cowork_task.edit.saved', 'Saved')}</strong>
            <span className={LABEL}>{t('cowork_task.when.address', 'Its address')}</span>
            <code className="block break-all rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-3 py-2 text-[13px]">POST {address.url}<br />Authorization: Bearer {address.token}</code>
            <p className={META}>{t('cowork_task.when.address_hint', 'Copy it now: the token is shown only once. Whoever has it can start the task, but cannot read anything.')}</p>
            <div className={ROW_ACTIONS}>
                <button type="button" className={BTN_PRIMARY} onClick={copy}>{t('cowork_task.when.copy', 'Copy address')}</button>
                <button type="button" className={BTN_QUIET} onClick={onDone}>{t('cowork_task.when.done', 'Done')}</button>
                {copied && <span className={META} role="status">{copied}</span>}
            </div>
        </div>
    );
}

const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/** "In short: every Monday 09:00." */
function shortWhen(draft: TaskDraft, t: TranslateFn): string {
    if (draft.kind !== 'schedule') return kindWords(draft.kind, t);
    if (draft.repeat === '') {
        const at = nextRunOf(draft);
        return t('cowork_task.when.once_at', 'Once, {when}', { when: at ? fullTimestamp(at, t) : '' });
    }
    return cadenceLine({ repeatInterval: draft.repeat, daysOfWeek: draft.repeat === 'weekly' ? draft.days : null, nextRunAt: nextRunOf(draft)?.toISOString() ?? null, timeOfDay: draft.repeat === 'hourly' ? null : draft.time }, t);
}

function Kind({ draft, set, id, itemId, onOpenTask, t }: TargetProps) {
    const onEvent = draft.kind === 'after' || draft.kind === 'row' || draft.kind === 'file';
    return (
        <>
            <Field id={`${id}-kind`} label={t('cowork_task.when.starts', 'It starts')}>
                <select id={`${id}-kind`} className={FIELD} value={draft.kind} onChange={(e) => set({ kind: e.target.value as StartChoiceKind })}>
                    {KINDS.map(([kind, key, en]) => <option key={kind} value={kind}>{t(key, en)}</option>)}
                </select>
            </Field>
            {draft.kind === 'schedule' && <Schedule draft={draft} set={set} id={id} t={t} />}
            {draft.kind === 'email' && (
                <>
                    <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-card)]"><MailTriggerPanel value={draft.mail} onChange={(mail) => set({ mail })} /></div>
                    <p className={`${META} rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-3 py-2`}>{t('cowork_task.when.mail_note', 'A task that starts from a mail only drafts its reply, and the draft goes only to the person who sent that mail. It runs as one of your agents.')}</p>
                </>
            )}
            {onEvent && <Target draft={draft} set={set} id={id} itemId={itemId} onOpenTask={onOpenTask} t={t} />}
            {draft.kind === 'webhook' && <p className={META}>{t('cowork_task.when.webhook_hint', 'Any system that calls its address starts the task. The address is made when you save, and shown once.')}</p>}
        </>
    );
}

export default function TaskSetWhen({ form, onOpenTask, t }: { form: SettingRowForm; onOpenTask: (id: string) => void; t: TranslateFn }) {
    const { draft, set, submit, address, bar } = useSettingRow('when', form);
    const id = `cowork-task-when-${form.itemId}`;
    if (address) return <HookAddressCard address={address} onDone={form.onDone} t={t} />;
    return (
        <form className="flex flex-col gap-3" onSubmit={(e) => { void submit(e); }}>
            <Kind draft={draft} set={set} id={id} itemId={form.itemId} onOpenTask={onOpenTask} t={t} />
            <p className={META} role="status">{t('cowork_task.when.short', 'In short: {when}.', { when: lowerFirst(shortWhen(draft, t)) })}</p>
            <SaveBar state={bar} onCancel={form.onDone} t={t} />
        </form>
    );
}
