/**
 * The small pieces every part of an opened task (./CoworkTaskView.tsx) is built from, so the sheet reads as one page:
 * pill buttons with 44px targets, cards, the green "Fixed … · Undo" note, a section heading, the folded rows of
 * "More", the progress list of something on the go, and the status pill. Bee Flow tokens only.
 */
import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, ChevronDown, ShieldCheck } from 'lucide-react';
import { FOCUS_RING, PRIMARY_TONE } from '../../shared/buttonClasses';
import { statusLabel } from '../../shared/statusTokens';
import type { StatusToken } from '../../shared/statusTokens';
import { errorMessage } from '@/utils/caughtError';
import type { TranslateFn } from '@/hooks/useTranslation';

const PILL = `inline-flex items-center justify-center gap-2 min-h-[44px] px-[18px] rounded-full text-[14px] font-semibold whitespace-nowrap transition-colors disabled:opacity-45 disabled:cursor-default ${FOCUS_RING}`;

/** The one action a part of the sheet asks for. */
export const BTN_PRIMARY = `${PILL} border ${PRIMARY_TONE}`;
/** Every other way, beside it. */
export const BTN_QUIET = `${PILL} border bg-[var(--bg-card)] text-[var(--text-primary)] border-[var(--border-default)] [box-shadow:var(--shadow-sm)] enabled:hover:bg-[var(--bg-card-hover)]`;
/** A quiet text action: Undo, Show more. */
export const BTN_LINK = `inline-flex items-center gap-1.5 min-h-[44px] px-2 -mx-2 rounded-md text-[14px] font-semibold text-[var(--accent-primary)] enabled:hover:underline disabled:opacity-45 ${FOCUS_RING}`;
/** The action that cannot be taken back. */
export const BTN_DANGER = `${PILL} border border-transparent bg-[var(--error)] text-[var(--bg-card)]`;

export const CARD = 'rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-card)] [box-shadow:var(--shadow-sm)] p-[18px] flex flex-col gap-3 min-w-0 text-[var(--text-primary)]';
export const CARD_SOFT = 'rounded-[var(--radius-lg)] bg-[var(--surface-2)] p-[18px] flex flex-col gap-3 min-w-0 text-[var(--text-primary)]';
/** A card's heading; its colour is the card's unless the caller gives one. */
export const CARD_HEAD = 'flex flex-wrap items-center gap-2 text-[16px] font-bold';
export const SECTION_H = 'text-[13px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]';
export const META = 'text-[14px] text-[var(--text-secondary)]';
export const ROW_ACTIONS = 'flex flex-wrap items-center gap-2';
export const FIELD = 'w-full min-h-[44px] rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 text-[14px] text-[var(--text-primary)]';
export const LABEL = 'text-[14px] font-medium text-[var(--text-primary)]';
export const ALERT = 'text-[14px] text-[var(--error-ink)]';

const TAG = 'inline-flex items-center rounded-full px-[9px] py-0.5 text-[12px] font-semibold whitespace-nowrap';
export const TAG_PLAIN = `${TAG} bg-[var(--surface-2)] text-[var(--text-secondary)]`;
export const TAG_OK = `${TAG} bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success-ink)]`;
export const TAG_WARN = `${TAG} bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning-ink)]`;
export const TAG_ACCENT = `${TAG} bg-[color-mix(in_srgb,var(--accent-primary)_14%,transparent)] text-[var(--accent-primary)]`;

/** The status word in its colour. */
export function StatusPill({ token, t }: { token: StatusToken; t: TranslateFn }) {
    return (
        <span data-testid="cowork-task-status" data-status-key={token.labelKey} className={`inline-flex items-center gap-1.5 self-start rounded-full px-2.5 py-[3px] text-[13px] font-semibold ${token.badge}`}>
            <span aria-hidden="true" className="w-[7px] h-[7px] rounded-full bg-current motion-safe:data-[spin=true]:animate-pulse" data-spin={token.spin} />
            {statusLabel(t, token)}
        </span>
    );
}

/** "Fixed … · Undo": a change Cowork made that can be taken back. */
export function UndoNote({ children, undoing, onUndo, t, testId }: { children: ReactNode; undoing: boolean; onUndo: () => void; t: TranslateFn; testId?: string }) {
    return (
        <div data-testid={testId} className="flex flex-wrap items-center gap-2.5 rounded-[var(--radius-md)] py-1.5 pl-3 pr-1.5 text-[14px] text-[var(--text-primary)] bg-[color-mix(in_srgb,var(--success)_12%,transparent)]">
            <Check aria-hidden="true" className="w-4 h-4 flex-shrink-0 text-[var(--success-ink)]" />
            <span className="flex-1 min-w-[12rem] py-1.5">{children}</span>
            <button type="button" className={BTN_LINK} disabled={undoing} onClick={onUndo}>
                {undoing ? t('cowork_task.undoing', 'Undoing…') : t('cowork_task.undo', 'Undo')}
            </button>
        </div>
    );
}

/** "Receipt 41 · signed". */
export function ReceiptMark({ seq, signed, t }: { seq: number; signed: boolean; t: TranslateFn }) {
    return (
        <span className="inline-flex items-center gap-1.5 text-[13px] tabular-nums text-[var(--text-tertiary)]" data-testid="cowork-task-receipt">
            <ShieldCheck aria-hidden="true" className="w-3.5 h-3.5" />
            {signed
                ? t('cowork_task.receipt.signed', 'Receipt {seq} · signed', { seq })
                : t('cowork_task.receipt.unsigned', 'Receipt {seq} · not signed', { seq })}
        </span>
    );
}

export type ProgressState = 'did' | 'now' | 'next';

/** What is on the go, one line per part: done ones ticked, the current one turning. */
export function ProgressList({ rows }: { rows: Array<{ key: string; label: string; state: ProgressState }> }) {
    const tone: Record<ProgressState, string> = { did: 'text-[var(--success-ink)]', now: 'text-[var(--text-primary)] font-semibold', next: 'text-[var(--text-tertiary)]' };
    return (
        <ol role="status" aria-live="polite" className="flex flex-col gap-2.5" data-testid="cowork-task-progress">
            {rows.map((row) => (
                <li key={row.key} className={`flex items-center gap-2.5 text-[14px] ${tone[row.state]}`}>
                    <span aria-hidden="true" className={`w-[18px] h-[18px] rounded-full border-2 border-current grid place-items-center flex-shrink-0 ${row.state === 'now' ? 'border-[var(--accent-primary)] border-t-transparent motion-safe:animate-spin' : ''}`}>
                        {row.state === 'did' && <Check className="w-[11px] h-[11px]" />}
                    </span>
                    <span>{row.label}</span>
                </li>
            ))}
        </ol>
    );
}

/** "More": everything a task holds besides what it does, folded until asked for. */
export function Fold({ label, children }: { label: string; children: ReactNode }) {
    const [open, setOpen] = useState(false);
    const bodyId = useId();
    return (
        <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-card)] [box-shadow:var(--shadow-sm)] overflow-hidden" data-testid="cowork-task-more">
            <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((v) => !v)} className={`w-full min-h-[54px] px-[18px] flex items-center justify-between gap-3 text-left text-[15px] font-semibold text-[var(--text-primary)] ${FOCUS_RING}`}>
                <span>{label}</span>
                <ChevronDown aria-hidden="true" className={`w-4 h-4 flex-shrink-0 motion-safe:transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
            {open && <div id={bodyId} className="flex flex-col">{children}</div>}
        </div>
    );
}

interface FoldRowProps {
    id: string;
    label: string;
    value?: string;
    open: boolean;
    onToggle: (id: string | null) => void;
    danger?: boolean;
    children: ReactNode;
}

/** One row of "More": its name and where it stands; opened, what it holds. Only the opened row renders its body. */
export function FoldRow({ id, label, value, open, onToggle, danger = false, children }: FoldRowProps) {
    const bodyId = useId();
    return (
        <div data-testid={`cowork-task-row-${id}`}>
            <button
                type="button"
                aria-expanded={open}
                aria-controls={bodyId}
                onClick={() => onToggle(open ? null : id)}
                className={`w-full min-h-[48px] px-[18px] flex items-center gap-3 text-left border-t border-[var(--border-subtle)] hover:bg-[var(--surface-2)] ${FOCUS_RING}`}
            >
                <span className={`flex-1 min-w-0 text-[15px] font-medium ${danger ? 'text-[var(--error-ink)]' : 'text-[var(--text-primary)]'}`}>{label}</span>
                {value && <span className="min-w-0 max-w-[55%] truncate text-right text-[14px] text-[var(--text-tertiary)]">{value}</span>}
                <ChevronDown aria-hidden="true" className={`w-4 h-4 flex-shrink-0 text-[var(--text-tertiary)] motion-safe:transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
            {open && <div id={bodyId} className="px-[18px] pt-1 pb-[18px] flex flex-col gap-3">{children}</div>}
        </div>
    );
}

/** The sentence of a request that did not go through. */
export function Failure({ error, t }: { error: unknown; t: TranslateFn }) {
    if (!error) return null;
    return <p role="alert" className={ALERT}>{errorMessage(error) || t('cowork_task.failed', 'That did not work. Try again.')}</p>;
}
