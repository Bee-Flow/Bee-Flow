import React from 'react';

/**
 * SegmentedControl — pill-style choice group. Replaces the local
 * `SegmentedControl` previously nested inside the admin theme panel and the
 * 6+ ad-hoc `<button>` rows scattered across Glass settings.
 *
 * Each option's value can be a string OR number — the consumer's value type
 * is preserved through the generic.
 *
 * An option may carry a `badge`: the count the Studio tab strips show after
 * the label ("Used by 3", "Rows 412", "Review 2"). It renders as a dimmer
 * inline span in the label's own type size — never as a chip (that is
 * shared/Tabs' underline-bar idiom) — and it renders NOTHING when absent, so
 * a badge-less strip keeps its exact textContent
 * (BuilderHeader.views.test.jsx pins the four view labels that way).
 */

export type SegmentedBadgeTone = 'neutral' | 'error' | 'warning';

export interface SegmentedBadge {
    /** The count (or a short node) shown after the label. `null`/`undefined` renders nothing. */
    count: React.ReactNode;
    /** `neutral` (default) sits at --text-tertiary; `error`/`warning` take the status colour. */
    tone?: SegmentedBadgeTone;
}

export interface SegmentedOption<TValue> {
    value: TValue;
    label: React.ReactNode;
    icon?: React.ReactNode;
    disabled?: boolean;
    /**
     * A bare count (`3`) or `{ count, tone }`. Omitted, `null`, or a
     * `{ count: null }` still loading → no badge at all, not a "0".
     */
    badge?: React.ReactNode | SegmentedBadge;
}

export interface SegmentedControlProps<TValue> {
    value: TValue;
    onChange: (next: TValue) => void;
    options: readonly SegmentedOption<TValue>[];
    disabled?: boolean;
    size?: 'sm' | 'md';
    /** Fills the row width with equal-flex segments instead of natural width. */
    fullWidth?: boolean;
    ariaLabel?: string;
    className?: string;
}

const BADGE_TONE_COLOR: Record<SegmentedBadgeTone, string> = {
    neutral: 'var(--text-tertiary)',
    error: 'var(--error)',
    warning: 'var(--warning)',
};

function isBadgeObject(badge: unknown): badge is SegmentedBadge {
    return (
        typeof badge === 'object'
        && badge !== null
        && !Array.isArray(badge)
        && !React.isValidElement(badge)
        && 'count' in badge
    );
}

/**
 * Normalises the two accepted badge shapes into `{ count, tone }`, or `null`
 * when there is nothing to show. Exported so a strip that folds into a menu
 * at narrow widths can carry the same count into its menu items.
 */
export function resolveSegmentedBadge(
    badge: React.ReactNode | SegmentedBadge | undefined,
): { count: React.ReactNode; tone: SegmentedBadgeTone } | null {
    if (badge === undefined || badge === null || typeof badge === 'boolean') return null;
    if (isBadgeObject(badge)) {
        if (badge.count === undefined || badge.count === null || typeof badge.count === 'boolean') return null;
        return { count: badge.count, tone: badge.tone ?? 'neutral' };
    }
    return { count: badge, tone: 'neutral' };
}

export default function SegmentedControl<TValue extends string | number>({
    value,
    onChange,
    options,
    disabled = false,
    size = 'md',
    fullWidth = false,
    ariaLabel,
    className = '',
}: SegmentedControlProps<TValue>) {
    const pad = size === 'sm' ? 'px-3 py-1.5 text-[12px]' : 'px-4 py-2 text-sm';
    return (
        <div
            role="radiogroup"
            aria-label={ariaLabel}
            className={
                'inline-flex items-center gap-1 p-1 rounded-xl border ' +
                (fullWidth ? 'flex w-full ' : '') +
                className
            }
            style={{
                borderColor: 'var(--border-subtle)',
                background: 'var(--bg-tertiary)',
            }}
        >
            {options.map((opt) => {
                const active = value === opt.value;
                const optDisabled = disabled || !!opt.disabled;
                const badge = resolveSegmentedBadge(opt.badge);
                return (
                    <button
                        key={String(opt.value)}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        disabled={optDisabled}
                        onClick={() => onChange(opt.value)}
                        className={
                            'rounded-lg font-medium transition-all whitespace-nowrap inline-flex items-center justify-center gap-1.5 ' +
                            pad +
                            (fullWidth ? ' flex-1' : '') +
                            (optDisabled ? ' opacity-50 cursor-not-allowed' : ' cursor-pointer')
                        }
                        style={{
                            background: active ? 'var(--bg-card)' : 'transparent',
                            // Inactive segments are still choices the user is
                            // being offered — tertiary made them read as
                            // disabled next to the one active pill.
                            color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                            boxShadow: active
                                ? '0 1px 2px rgba(0,0,0,0.06), 0 0 0 1px var(--border-default) inset'
                                : 'none',
                        }}
                    >
                        {opt.icon}
                        <span>{opt.label}</span>
                        {badge && (
                            // Artboard 1b: `Gebruikt door <span style="color:var(--text-tertiary)">n</span>`
                            // — same size and weight as the label, only dimmer.
                            <span
                                data-tone={badge.tone}
                                className="tabular-nums"
                                style={{ color: BADGE_TONE_COLOR[badge.tone] }}
                            >
                                {badge.count}
                            </span>
                        )}
                    </button>
                );
            })}
        </div>
    );
}
