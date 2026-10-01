import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';

/**
 * "Where should this go?": asked when a value is clicked in the source panel
 * while no field of the step has focus. Lists the step's EMPTY fields, the
 * required ones first (useSlotRegistry emptySlots gives them in that order;
 * the order is enforced here too, so any caller gets it). Choosing one puts
 * the value there.
 *
 * Presentational: the caller positions it and closes it.
 */

export interface SlotTarget {
    id: string;
    label: string;
    required?: boolean;
}

export interface TargetPopoverProps {
    targets: SlotTarget[];
    /** The clicked value's name. */
    valueLabel?: string;
    onChoose: (id: string) => void;
    onClose: () => void;
    /** Take focus when shown (default): it answers a click. */
    autoFocus?: boolean;
}

/** Required fields first; form order otherwise. */
export function orderTargets(targets: SlotTarget[]): SlotTarget[] {
    return [...targets].sort((a, b) => Number(!!b.required) - Number(!!a.required));
}

export default function TargetPopover({ targets, valueLabel, onChoose, onClose, autoFocus = true }: TargetPopoverProps) {
    const { t } = useTranslation();
    const firstRef = useRef<HTMLButtonElement | null>(null);
    const title = t('mapping.slot.target.title', 'Where should this go?');
    const ordered = orderTargets(targets);

    // The popover is the answer to a click, so it takes focus (and Escape).
    useEffect(() => { if (autoFocus) firstRef.current?.focus(); }, [autoFocus]);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    return (
        <div
            role="dialog"
            aria-label={title}
            data-testid="target-popover"
            className="flex w-64 max-w-[calc(100vw-32px)] flex-col gap-1 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] p-2 text-[12px] shadow-[var(--shadow-popover)]"
        >
            <div className="flex items-start gap-2 px-1">
                <div className="min-w-0 flex-1">
                    <div className="font-semibold text-[var(--text-primary)]">{title}</div>
                    {valueLabel && (
                        <div className="truncate text-[var(--text-tertiary)]">
                            {t('mapping.slot.target.value', 'Put {label} in:', { label: valueLabel })}
                        </div>
                    )}
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label={t('mapping.slot.target.close', 'Close')}
                    className="shrink-0 rounded p-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                >
                    <X size={12} aria-hidden="true" />
                </button>
            </div>
            {ordered.length ? (
                <ul className="flex flex-col gap-0.5">
                    {ordered.map((target, i) => (
                        <li key={target.id}>
                            <button
                                ref={i === 0 ? firstRef : undefined}
                                type="button"
                                onClick={() => onChoose(target.id)}
                                className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                            >
                                <span className="truncate">{target.label}</span>
                                {target.required && (
                                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                                        {t('mapping.slot.target.required', 'Required')}
                                    </span>
                                )}
                            </button>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="px-1 py-1 text-[var(--text-tertiary)]">
                    {t('mapping.slot.target.none', 'Every field of this step is filled. Click a field first, then pick a value.')}
                </p>
            )}
        </div>
    );
}
