import React from 'react';
import { SquareFunction, TriangleAlert, X } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';

/**
 * A field's value from an earlier step, as one chip: its name in words, and
 * for a list how many values it holds ("Product of all orderregels · 12").
 *
 *   ok       the chip, with the value's example beside it in grey
 *   stale    amber: the source is gone (a step was removed, a field renamed):
 *            "No longer available: E-mail van klant · Pick again"
 *   formula  grey "Formula" chip with a one-line summary, for a stored
 *            binding that does not read as one value (usePickLabel.ts
 *            formulaSummary words it)
 *
 * Presentational: what a click does is the caller's.
 */

export type ValueChipState = 'ok' | 'stale' | 'formula';

export interface ValueChipProps {
    label: string;
    state?: ValueChipState;
    /** Values in the list, shown as "· 12"; null or undefined for one value. */
    count?: number | null;
    /** A short example of the value from the sample or the last run. */
    preview?: string | null;
    /** The formula in words (state 'formula'). */
    summary?: string;
    /** A click on the chip: how the value is used (PickOptions), or the formula editor. */
    onOpen?: () => void;
    onRemove?: () => void;
    /** state 'stale': pick the value again. */
    onRepick?: () => void;
    disabled?: boolean;
}

const CHIP = 'inline-flex items-center gap-1 max-w-full min-w-0 rounded-md border px-1.5 py-0.5 text-[12px] leading-[1.4]';

function RemoveButton({ name, onRemove }: { name: string; onRemove: () => void }) {
    const { t } = useTranslation();
    return (
        <button
            type="button"
            onClick={onRemove}
            aria-label={t('mapping.slot.remove', 'Remove {label}', { label: name })}
            className="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100"
        >
            <X size={11} aria-hidden="true" />
        </button>
    );
}

type Part = Omit<ValueChipProps, 'state' | 'disabled'> & { remove: React.ReactNode };

function StaleChip({ label, onRepick, remove }: Part) {
    const { t } = useTranslation();
    return (
        <span
            data-testid="value-chip"
            data-state="stale"
            className={`${CHIP} border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] text-[var(--warning-ink)]`}
        >
            <TriangleAlert size={12} className="shrink-0" aria-hidden="true" />
            <span className="truncate">{t('mapping.slot.stale', 'No longer available: {label}', { label })}</span>
            {onRepick && (
                <>
                    <span aria-hidden="true">·</span>
                    <button type="button" onClick={onRepick} className="shrink-0 font-semibold underline underline-offset-2">
                        {t('mapping.slot.repick', 'Pick again')}
                    </button>
                </>
            )}
            {remove}
        </span>
    );
}

function FormulaChip({ summary, onOpen, remove }: Part) {
    const { t } = useTranslation();
    const name = t('mapping.slot.formula', 'Formula');
    const title = summary ? t('mapping.slot.formula_title', 'Formula: {summary}', { summary }) : undefined;
    return (
        <span data-testid="value-chip" data-state="formula" className="inline-flex items-center gap-1.5 max-w-full min-w-0">
            <span className={`${CHIP} shrink-0 border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]`}>
                <SquareFunction size={12} className="shrink-0" aria-hidden="true" />
                {onOpen
                    ? <button type="button" onClick={onOpen} className="font-medium" title={title}>{name}</button>
                    : <span className="font-medium">{name}</span>}
                {remove}
            </span>
            {summary && <span className="truncate text-[12px] text-[var(--text-tertiary)]" title={summary}>{summary}</span>}
        </span>
    );
}

function PickChip({ label, count, preview, onOpen, remove }: Part) {
    const { t } = useTranslation();
    const body = (
        <>
            <span className="truncate font-medium">{label}</span>
            {typeof count === 'number' && Number.isFinite(count) && (
                <span className="shrink-0 opacity-70" aria-label={t('mapping.slot.list_count', '{count} values', { count })}>
                    · {count}
                </span>
            )}
        </>
    );
    return (
        <span data-testid="value-chip" data-state="ok" className="inline-flex items-center gap-1.5 max-w-full min-w-0">
            <span className={`${CHIP} border-[color-mix(in_srgb,var(--accent-primary)_35%,transparent)] bg-[color-mix(in_srgb,var(--accent-primary)_10%,transparent)] text-[var(--text-primary)]`}>
                {onOpen ? (
                    <button
                        type="button"
                        onClick={onOpen}
                        aria-label={t('mapping.slot.open_options', 'Change how {label} is used', { label })}
                        className="inline-flex items-center gap-1 min-w-0"
                    >
                        {body}
                    </button>
                ) : <span className="inline-flex items-center gap-1 min-w-0">{body}</span>}
                {remove}
            </span>
            {preview && <span className="truncate text-[12px] text-[var(--text-tertiary)]" title={preview}>{preview}</span>}
        </span>
    );
}

const CHIPS = { ok: PickChip, stale: StaleChip, formula: FormulaChip } as const;

export default function ValueChip({ state = 'ok', disabled = false, onOpen, onRemove, onRepick, ...rest }: ValueChipProps) {
    const { t } = useTranslation();
    const name = state === 'formula' ? t('mapping.slot.formula', 'Formula') : rest.label;
    const remove = onRemove && !disabled ? <RemoveButton name={name} onRemove={onRemove} /> : null;
    const Chip = CHIPS[state] || PickChip;
    // Disabled: shown, not clickable.
    return (
        <Chip
            {...rest}
            onOpen={disabled ? undefined : onOpen}
            onRepick={disabled ? undefined : onRepick}
            remove={remove}
        />
    );
}
