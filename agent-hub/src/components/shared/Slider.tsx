import React from 'react';
import { RANGE_INPUT } from './adminUi';

/**
 * Slider — the themed range input (adminUi RANGE_INPUT: off-track bar, ink
 * thumb) with a label, value pill and optional suffix/formatter. Replaces the
 * ad-hoc `<input type="range">` + value `<span>` blocks that used to live
 * inline in admin panels, and the browser's own accent-coloured slider.
 */

export interface SliderProps {
    value: number;
    onChange: (next: number) => void;
    min: number;
    max: number;
    step?: number;
    label?: React.ReactNode;
    hint?: React.ReactNode;
    suffix?: string;
    /** Optional custom formatter for the value pill. Defaults to `${value}${suffix}`. */
    valueFormatter?: (value: number) => string;
    disabled?: boolean;
    id?: string;
    className?: string;
    /** Extra content rendered between the value pill and the slider — e.g. radius chips. */
    trailing?: React.ReactNode;
    /** Accessible name when there is no visible `label`. */
    ariaLabel?: string;
    /** Set false to drop the value pill (the caller shows the value itself). */
    showValue?: boolean;
}

function formatValue(value: number, step: number, suffix: string, valueFormatter?: (value: number) => string): string {
    if (valueFormatter) return valueFormatter(value);
    return `${typeof value === 'number' && step < 1 ? value.toFixed(2) : value}${suffix}`;
}

function SliderHeader({ id, label, hint }: Pick<SliderProps, 'id' | 'label' | 'hint'>) {
    if (label == null && hint == null) return null;
    return (
        <div className="flex items-baseline justify-between gap-3 mb-2">
            {label != null && (
                <label htmlFor={id} className="text-sm font-medium text-[var(--text-primary)]">
                    {label}
                </label>
            )}
            {hint != null && (
                <span className="text-[11px] text-[var(--text-tertiary)]">{hint}</span>
            )}
        </div>
    );
}

export default function Slider({
    value,
    onChange,
    min,
    max,
    step = 1,
    label,
    hint,
    suffix = '',
    valueFormatter,
    disabled = false,
    id,
    className = '',
    trailing,
    ariaLabel,
    showValue = true,
}: SliderProps) {
    const display = formatValue(value, step, suffix, valueFormatter);

    return (
        <div className={className}>
            <SliderHeader id={id} label={label} hint={hint} />
            <div className="flex items-center gap-3">
                <input
                    id={id}
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={value}
                    onChange={(e) => onChange(Number(e.target.value))}
                    disabled={disabled}
                    aria-label={ariaLabel}
                    aria-valuetext={valueFormatter || suffix ? display : undefined}
                    className={`flex-1 ${RANGE_INPUT}`}
                />
                {showValue && (
                    <span
                        className="text-xs font-mono tabular-nums px-2 py-1 rounded-md min-w-[3.5rem] text-center bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                    >
                        {display}
                    </span>
                )}
                {trailing}
            </div>
        </div>
    );
}
