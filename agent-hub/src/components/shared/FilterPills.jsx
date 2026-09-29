import React from 'react';
import { TONES } from './statusTone';

/**
 * FilterPills — the counted 11px filter capsules of a toolbar ("All 15 ·
 * Failing 1 · Needs attention 4 · Passing 9 · N/A 1", Compliance artboards
 * 1b/1c/1d; "All · Mine · Shared · dataweging 4" in the Meeting Notes rail,
 * whose `FilterChip` this hoists — LibraryFilters re-exports it from here).
 *
 * The artboard draws the active pill as an INK FILL (`background:
 * var(--text-primary)`). Rejected, per the 2026-09-03 rule recorded in
 * StatusActionPill/StudioSectionHeader: an interactive element must not read
 * as a black block. The active state is a TINT instead:
 *
 *   neutral  inactive = hairline border + secondary text (the chip as it was)
 *            active   = the accepted FilterChip recipe — accent at 14 %,
 *                       accent border, accent text
 *   toned    (success · warning · error — "Failing 1", "Overdue 1",
 *            "Approved 9") inactive = border in the tone's RAW colour, text in
 *            its INK (exactly the artboard's inactive look);
 *            active = the same border and ink over a 14 % tint of the raw —
 *            the StatusActionPill cell recipe, so status keeps carrying the
 *            meaning while the area colour stays teal
 *   muted    ("N/A 1", "Rejected 1") tertiary text, hairline; active fills
 *            with bg-tertiary
 *
 * The count follows the label in tabular figures. A count that is undefined
 * or null renders NOTHING — a pill for a filter nobody has counted yet must
 * not say 0 (an explicit 0 from a count that was made does render).
 */

export const PILL_TONES = Object.freeze(['neutral', 'success', 'warning', 'error', 'muted']);

/** The four colours of a pill in a given tone/state. Exported for tests and for hosts that draw their own. */
export function pillStyle(tone = 'neutral', active = false) {
    if (tone === 'success' || tone === 'warning' || tone === 'error') {
        const { raw, ink } = TONES[tone];
        return {
            background: active ? `color-mix(in srgb, ${raw} 14%, transparent)` : 'transparent',
            borderColor: raw,
            color: ink,
            countColor: ink,
        };
    }
    if (tone === 'muted') {
        return {
            background: active ? 'var(--bg-tertiary)' : 'transparent',
            borderColor: 'var(--border-default)',
            color: 'var(--text-tertiary)',
            countColor: 'var(--text-tertiary)',
        };
    }
    // neutral — the FilterChip recipe, unchanged for its existing callers.
    return {
        background: active ? 'color-mix(in srgb, var(--accent-primary) 14%, transparent)' : 'transparent',
        borderColor: active ? 'var(--accent-primary)' : 'var(--border-default)',
        color: active ? 'var(--accent-primary)' : 'var(--text-secondary)',
        countColor: active ? 'var(--accent-primary)' : 'var(--text-tertiary)',
    };
}

export function FilterPill({
    label,
    count = undefined,
    active = false,
    onClick = undefined,
    tone = 'neutral',
    disabled = false,
    title = undefined,
    testId = undefined,
}) {
    const t = PILL_TONES.includes(tone) ? tone : 'neutral';
    const s = pillStyle(t, active);
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            title={title}
            aria-pressed={active}
            data-testid={testId}
            data-tone={t}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
            style={{ background: s.background, borderColor: s.borderColor, color: s.color }}
        >
            <span className="truncate max-w-[9rem]">{label}</span>
            {count !== undefined && count !== null && (
                <span className="tabular-nums" style={{ color: s.countColor }}>{count}</span>
            )}
        </button>
    );
}

/**
 * A row of pills that behaves as one single-choice filter: `value` is the
 * active option, `onChange(value)` fires on a pill. `role="group"` with the
 * caller's label; each pill carries `aria-pressed`.
 */
export default function FilterPills({
    value,
    onChange,
    options = [],
    ariaLabel = undefined,
    className = '',
    testId = undefined,
}) {
    return (
        <div role="group" aria-label={ariaLabel} data-testid={testId} className={`flex flex-wrap items-center gap-1 ${className}`.trim()}>
            {options.map((o) => (
                <FilterPill
                    key={String(o.value)}
                    label={o.label}
                    count={o.count}
                    tone={o.tone}
                    active={o.value === value}
                    disabled={o.disabled}
                    title={o.title}
                    onClick={() => onChange?.(o.value)}
                    testId={testId ? `${testId}-${o.value}` : undefined}
                />
            ))}
        </div>
    );
}
