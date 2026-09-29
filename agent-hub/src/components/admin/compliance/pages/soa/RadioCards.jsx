import React from 'react';
import { Circle, CircleDot } from 'lucide-react';

/**
 * RadioCards — a 2×2 (or n-column) grid of bordered option cards that behaves
 * as one radio group (artboard 1d, the SoA drawer's "Besluit").
 *
 * The selected card wears a 2px outline in `--text-primary` — an OUTLINE, not
 * an ink fill, which is why it is allowed next to the no-ink-pills rule. A
 * disabled card keeps its place in the grid (the decision vocabulary never
 * shrinks) and explains itself through `hint`, which the caller renders under
 * the grid; the card itself is `aria-disabled` and skips the click.
 *
 * props:
 *   value, onChange(value)
 *   options   [{ value, label, disabled?, title? }]
 *   columns   default 2
 *   ariaLabel, className, testId (per-card testid `<testId>-<value>`)
 */
export default function RadioCards({ value, onChange, options = [], columns = 2, ariaLabel, className = '', testId = 'radio-cards' }) {
    return (
        <div
            role="radiogroup"
            aria-label={ariaLabel}
            data-testid={testId}
            className={`grid gap-2 ${className}`}
            style={{ gridTemplateColumns: `repeat(${Math.max(1, columns)}, minmax(0, 1fr))` }}
        >
            {options.map(opt => {
                const selected = opt.value === value;
                const Glyph = selected ? CircleDot : Circle;
                return (
                    <button
                        key={String(opt.value)}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-disabled={opt.disabled || undefined}
                        disabled={opt.disabled}
                        title={opt.title}
                        data-testid={`${testId}-${opt.value}`}
                        data-selected={selected ? 'true' : 'false'}
                        onClick={() => { if (!opt.disabled && !selected) onChange?.(opt.value); }}
                        className={
                            'flex items-center gap-2 px-2.5 py-2 rounded-[10px] text-left text-xs font-medium ' +
                            'bg-[var(--bg-card)] transition-colors ' +
                            (selected
                                ? 'border-2 border-[var(--text-primary)] text-[var(--text-primary)]'
                                : 'border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)]') +
                            (opt.disabled ? ' opacity-50 cursor-not-allowed' : ' cursor-pointer')
                        }
                    >
                        <Glyph size={13} aria-hidden="true" className="shrink-0" />
                        <span className="truncate">{opt.label}</span>
                    </button>
                );
            })}
        </div>
    );
}
