/**
 * The small pieces every part of an opened task (./CoworkTaskView.tsx) is built from, so the task reads as one page
 * with the home: the buttons, fields, tags and section heading of ../coworkUi.ts under the names the task's files use,
 * cards with their 16px padding, the "Fixed … · Undo" note, rows that open in place, and the receipt mark. Bee Flow
 * tokens only; the look and its rules are ../coworkUi.ts, the motion ../coworkMotion.ts.
 */
import { useId } from 'react';
import type { ReactNode } from 'react';
import { Check, ChevronDown, ChevronUp, ShieldCheck } from 'lucide-react';
import { Expand, TINT, useReveal } from '../coworkMotion';
import { ALERT, BUTTON_DANGER, BUTTON_PRIMARY, BUTTON_SECONDARY, CARD as SURFACE, CARD_INSET, FIELD_WIDE, FOCUS_INSET, LINK_BUTTON, LINK_INLINE } from '../coworkUi';
import { errorMessage } from '@/utils/caughtError';
import type { TranslateFn } from '@/hooks/useTranslation';

export { LABEL, META, TAG_ACCENT, TAG_OK, TAG_PLAIN, TAG_WARN } from '../coworkUi';

export const BTN_PRIMARY = BUTTON_PRIMARY;
export const BTN_QUIET = BUTTON_SECONDARY;
export const BTN_LINK = LINK_BUTTON;
/** The action that cannot be taken back. */
export const BTN_DANGER = BUTTON_DANGER;

const CARD_BODY = 'p-4 flex flex-col gap-3 min-w-0 text-[var(--text-primary)]';
export const CARD = `${SURFACE} ${CARD_BODY}`;
export const CARD_SOFT = `${CARD_INSET} ${CARD_BODY}`;
/** A card's heading; its colour is the card's unless the caller gives one. */
export const CARD_HEAD = 'flex flex-wrap items-center gap-2 text-[16px] leading-6 font-semibold';
export const ROW_ACTIONS = 'flex flex-wrap items-center gap-2';
export const FIELD = FIELD_WIDE;

/** "Fixed … · Undo": a change Cowork made that can be taken back. */
export function UndoNote({ children, undoing, onUndo, t, testId }: { children: ReactNode; undoing: boolean; onUndo: () => void; t: TranslateFn; testId?: string }) {
    return (
        <div data-testid={testId} className={`${SURFACE} flex flex-wrap items-center gap-2 py-1 pl-3 pr-1 text-[14px] leading-5 text-[var(--text-primary)]`}>
            <Check aria-hidden="true" size={16} className="flex-shrink-0 text-[var(--success-ink)]" />
            <span className="flex-1 min-w-[12rem] py-1.5">{children}</span>
            <button type="button" className={LINK_INLINE} disabled={undoing} onClick={onUndo}>
                {undoing ? t('cowork_task.undoing', 'Undoing…') : t('cowork_task.undo', 'Undo')}
            </button>
        </div>
    );
}

/** "Receipt 41 · signed". */
export function ReceiptMark({ seq, signed, t }: { seq: number; signed: boolean; t: TranslateFn }) {
    return (
        <span className="inline-flex items-center gap-1.5 text-[13px] leading-5 tabular-nums text-[var(--text-tertiary)]" data-testid="cowork-task-receipt">
            <ShieldCheck aria-hidden="true" size={16} />
            {signed
                ? t('cowork_task.receipt.signed', 'Receipt {seq} · signed', { seq })
                : t('cowork_task.receipt.unsigned', 'Receipt {seq} · not signed', { seq })}
        </span>
    );
}

/** The chevron of a row that opens in place: once open it points the other way, by being the other icon. */
export function Chevron({ open }: { open: boolean }) {
    const Icon = open ? ChevronUp : ChevronDown;
    return <Icon aria-hidden="true" size={16} className="flex-shrink-0 text-[var(--text-tertiary)]" />;
}

const ROW_HEAD = `w-full min-h-11! px-4 flex items-center gap-3 text-left hover:bg-[var(--item-hover-bg)] ${TINT} ${FOCUS_INSET}`;

interface FoldRowProps {
    id: string;
    label: string;
    value?: string;
    open: boolean;
    onToggle: (id: string | null) => void;
    danger?: boolean;
    children: ReactNode;
}

/** One row that opens in place: its name and where it stands; opened, what it holds. Only the opened row renders its body. */
export function FoldRow({ id, label, value, open, onToggle, danger = false, children }: FoldRowProps) {
    const bodyId = useId();
    const ref = useReveal<HTMLDivElement>(open);
    return (
        <div ref={ref} className="scroll-my-4" data-testid={`cowork-task-row-${id}`}>
            <button
                type="button"
                aria-expanded={open}
                aria-controls={bodyId}
                onClick={() => onToggle(open ? null : id)}
                className={`${ROW_HEAD} border-t border-[var(--border-subtle)]`}
            >
                <span className={`flex-1 min-w-0 text-[14px] leading-5 font-medium ${danger ? 'text-[var(--error-ink)]' : 'text-[var(--text-primary)]'}`}>{label}</span>
                {value && <span className="min-w-0 max-w-[55%] truncate text-right text-[13px] leading-5 text-[var(--text-tertiary)]">{value}</span>}
                <Chevron open={open} />
            </button>
            <Expand open={open} id={bodyId} className="px-4 pt-1 pb-4 flex flex-col gap-3">{children}</Expand>
        </div>
    );
}

/** The sentence of a request that did not go through. */
export function Failure({ error, t }: { error: unknown; t: TranslateFn }) {
    if (!error) return null;
    return <p role="alert" className={ALERT}>{errorMessage(error) || t('cowork_task.failed', 'That did not work. Try again.')}</p>;
}
