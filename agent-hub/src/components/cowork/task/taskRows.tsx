/**
 * What the sections of an opened task (./CoworkTaskView.tsx) are laid out with, next to the shared recipes of
 * ./taskUi.tsx: a section with its heading, the bordered list its rows sit in, one row of Settings (its name, its
 * current value in plain words, and what it holds once opened in place), the bar a row's form saves with, and the
 * "Technical details" disclosure that is the only place a raw error is shown.
 *
 * A row opens in place through <Expand>, and a value that changes fades in (SWAP): ../coworkMotion.ts.
 */
import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { ENTER, Expand, SWAP, TINT, useReveal } from '../coworkMotion';
import { CARD as SURFACE, FOCUS_INSET } from '../coworkUi';
import { BTN_LINK, BTN_PRIMARY, BTN_QUIET, Chevron, Failure, META, ROW_ACTIONS, SECTION_H, TAG_OK } from './taskUi';
import type { SaveState } from './useTaskSettingsSave';
import type { TranslateFn } from '@/hooks/useTranslation';

/** The bordered list a section's rows sit in; the first row carries no line of its own above it. */
export const ROWS = `${SURFACE} overflow-hidden [&>div:first-child]:border-t-0 [&>div:first-child>button]:border-t-0`;
/** The name of a part inside an opened row ("Target to track", "What it remembers"). */
export const PART_H = 'text-[14px] leading-5 font-semibold text-[var(--text-primary)]';
/** A part inside an opened row, set off from the one above it. */
export const PART = 'flex flex-col gap-2.5 pt-4 border-t border-[var(--border-subtle)]';
/** A choice that is on, and one that is off (an app, a day, a way of working): a solid border and fill, no tint. */
export const CHOICE_ON = 'border-[var(--accent-primary)] bg-[var(--bg-tertiary)] text-[var(--text-primary)]';
export const CHOICE_OFF = 'border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-secondary)]';

export function Section({ id, heading, testId, children }: { id: string; heading: string; testId: string; children: ReactNode }) {
    return (
        <section aria-labelledby={id} className="flex flex-col gap-3" data-testid={testId}>
            <h2 id={id} className={`${SECTION_H} scroll-mt-4`}>{heading}</h2>
            {children}
        </section>
    );
}

interface SettingRowProps<Id extends string> {
    id: Id;
    label: string;
    /** Where it stands now, in plain words; always shown. */
    value: string;
    /** A second, quieter line under the value. */
    note?: string | null;
    open: boolean;
    /** It was saved a moment ago: the closed row says so. */
    saved?: boolean;
    onToggle: (id: Id | null) => void;
    t: TranslateFn;
    children: ReactNode;
}

/** One row of Settings: opened, it is edited in place, right under its value. Only the opened row renders its body. */
export function SettingRow<Id extends string>({ id, label, value, note, open, saved = false, onToggle, t, children }: SettingRowProps<Id>) {
    const bodyId = useId();
    const ref = useReveal<HTMLDivElement>(open);
    return (
        <div ref={ref} className="scroll-my-4 border-t border-[var(--border-subtle)]" data-testid={`cowork-task-setting-${id}`}>
            <button
                type="button"
                aria-expanded={open}
                aria-controls={bodyId}
                onClick={() => onToggle(open ? null : id)}
                className={`w-full min-h-11 px-4 py-3 grid grid-cols-[80px_minmax(0,1fr)_auto] sm:grid-cols-[96px_minmax(0,1fr)_auto] items-start gap-x-3 text-left hover:bg-[var(--item-hover-bg)] ${TINT} ${FOCUS_INSET}`}
            >
                <span className="text-[13px] font-medium leading-5 text-[var(--text-tertiary)]">{label}</span>
                <span className="min-w-0 flex flex-col gap-0.5">
                    <span key={value} className={`${SWAP} text-[14px] leading-5 break-words line-clamp-2 text-[var(--text-primary)]`} data-testid={`cowork-task-setting-${id}-value`}>{value}</span>
                    {note && <span key={note} className={`${SWAP} text-[13px] leading-5 break-words text-[var(--text-secondary)]`}>{note}</span>}
                </span>
                <span className="inline-flex items-center gap-1 text-[13px] font-medium leading-5 text-[var(--text-secondary)]">
                    {saved && !open && <span role="status" className={`${TAG_OK} ${ENTER} mr-1`} data-testid={`cowork-task-setting-${id}-saved`}>{t('cowork_task.edit.saved', 'Saved')}</span>}
                    {open ? t('cowork_task.close', 'Close') : t('cowork_task.set.change', 'Change')}
                    <Chevron open={open} />
                </span>
            </button>
            <Expand open={open} id={bodyId} className="px-4 pt-2 pb-4 flex flex-col gap-4 text-[14px] leading-5 text-[var(--text-primary)]">{children}</Expand>
        </div>
    );
}

/** What a save does, said before it is made. */
function saveNote({ effect, locked }: SaveState, t: TranslateFn): string {
    if (locked) return t('cowork_task.set.locked', 'It is running or being tested right now. You can save once that is over.');
    switch (effect) {
        case 'rebuild': return t('cowork_task.set.rebuild_note', 'Save and test: Cowork rebuilds the steps and tests them once. Nothing is sent. You approve the changed steps before it runs again.');
        case 'drops_steps': return t('cowork_task.set.drops_note', 'Saving takes its fixed steps off: from then on the task is worked out again on every run. You can choose fixed steps again here; they are then made and tested anew.');
        case 'keeps_steps': return t('cowork_task.set.keeps_note', 'Saving takes effect at once. The steps stay as they are.');
        default: return t('cowork_task.set.at_once_note', 'Saving takes effect at once.');
    }
}

/** The bar a row's form saves with: what the save does, then "Save" or "Save and test", and Cancel. */
export function SaveBar({ state, onCancel, t }: { state: SaveState; onCancel: () => void; t: TranslateFn }) {
    const note = saveNote(state, t);
    return (
        <div className="flex flex-col gap-2.5">
            <p key={note} className={`${META} ${SWAP}`} data-testid="cowork-task-save-note">{note}</p>
            <Failure error={state.error} t={t} />
            <div className={ROW_ACTIONS}>
                <button type="submit" className={BTN_PRIMARY} disabled={state.saving || state.locked || !state.ready}>
                    {state.effect === 'rebuild' ? t('cowork_task.edit.save_test', 'Save and test') : t('cowork_task.edit.save', 'Save')}
                </button>
                <button type="button" className={BTN_QUIET} onClick={onCancel}>{t('cowork_task.edit.cancel', 'Cancel')}</button>
            </div>
        </div>
    );
}

/** The raw words of the system, for whoever has to look into it: folded, never part of the sentence a person reads. */
export function TechnicalDetails({ text, t }: { text: string | null | undefined; t: TranslateFn }) {
    const [open, setOpen] = useState(false);
    const bodyId = useId();
    if (!text) return null;
    return (
        <div className="flex flex-col" data-testid="cowork-task-technical">
            <div>
                <button type="button" className={BTN_LINK} aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((v) => !v)}>
                    {t('cowork_task.technical', 'Technical details')}
                </button>
            </div>
            <Expand open={open} id={bodyId} className="pt-1.5">
                <pre className="m-0 whitespace-pre-wrap break-words rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-3 py-2 text-[12px] leading-5 text-[var(--text-secondary)]">{text}</pre>
            </Expand>
        </div>
    );
}
