import React, { useRef } from 'react';

/**
 * ChoiceCards — a radio group rendered as description cards.
 *
 * `SegmentedControl` is the right shape when the options are one or two words.
 * When each option needs a sentence explaining its consequence ("Replace
 * sensitive values with placeholders before the AI sees them" vs "Reject the
 * message before it leaves the organisation") a pill row cannot carry it, and
 * every place that needed one grew its own `<button>` grid instead.
 *
 * ── Why a shared component rather than a fourth copy ──────────────────────
 * There were already two prior arts — `admin/subscriptions/ui/Choice.jsx` and
 * `appearance-studio/shared/PresetCard.tsx` — and NEITHER has radio semantics.
 * They render plain buttons whose only selected-state signal is colour, so a
 * screen-reader user is told "button, Tokenize & round-trip" with no way to
 * know it is the current choice, or even that the options are mutually
 * exclusive. That is the defect this component exists to stop copying.
 *
 * Semantics follow the ARIA APG radiogroup pattern, mirroring
 * `SegmentedControl.tsx`:
 *   - one tab stop for the whole group (roving tabindex), not one per card;
 *   - arrows / Home / End move between ENABLED options, wrapping;
 *   - selection follows focus, as APG specifies for a radio group;
 *   - `aria-checked` carries the state that colour alone used to carry.
 *
 * Note the `activeIdx` fallback: when nothing is selected — which really
 * happens, e.g. a stored value whose licence has since lapsed — the first
 * enabled card takes the tab stop, so the group cannot become unreachable by
 * keyboard at exactly the moment the user needs to fix it.
 */

export interface ChoiceCardOption<TValue extends string> {
    value: TValue;
    label: React.ReactNode;
    description?: React.ReactNode;
    /** Lucide component (or any icon component). Rendered decoratively. */
    Icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
    /** Small pill after the label — "Recommended", "Enterprise", … */
    badge?: React.ReactNode;
    disabled?: boolean;
    /** Shown under the card when it is disabled; explains what would unlock it. */
    lockedNotice?: React.ReactNode;
}

/**
 * `tint` (the default) fills the chosen card with the theme's selected-row
 * tint (`--item-active-bg`) and outlines it in ink. `radio` draws a ring dot
 * and an ink outline on a clear card instead. Neither uses a status colour:
 * green means "OK" or "stays inside" elsewhere and must not double as
 * "selected".
 */
type ChoiceCardsAppearance = 'tint' | 'radio';

export interface ChoiceCardsProps<TValue extends string> {
    value: TValue | null | undefined;
    onChange: (next: TValue) => void;
    options: readonly ChoiceCardOption<TValue>[];
    /** Accessible name for the group. Required in practice — the cards alone never say what is being chosen. */
    ariaLabel?: string;
    disabled?: boolean;
    columns?: 1 | 2 | 3;
    className?: string;
    appearance?: ChoiceCardsAppearance;
}

// A literal map, not `grid-cols-${n}`. Tailwind's scanner only sees class
// names that appear literally in the source, so the interpolated form in
// `Choice.jsx` silently produces no grid at all at build time.
const GRID: Record<number, string> = {
    1: 'grid-cols-1',
    2: 'grid-cols-1 sm:grid-cols-2',
    3: 'grid-cols-1 sm:grid-cols-3',
};

// `flex-1`, not `h-full`: the card fills its cell, and a locked notice under
// it gets its own space instead of being painted over.
const FOCUS = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';
const RADIO_BASE = `w-full flex-1 text-left rounded-[10px] flex flex-col gap-1.5 bg-transparent transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${FOCUS}`;
// The chosen card's 2px outline would push its text 1px inwards; the padding
// gives that pixel back so both cards' text lines up.
const RADIO_CARD = {
    on: `${RADIO_BASE} border-2 border-[var(--text-primary)] px-[13px] py-[11px]`,
    off: `${RADIO_BASE} border border-[var(--border-default)] px-3.5 py-3 enabled:hover:border-[var(--text-tertiary)]`,
};
const RADIO_DOT = {
    on: 'w-3.5 h-3.5 rounded-full box-border shrink-0 border-4 border-[var(--text-primary)]',
    off: 'w-3.5 h-3.5 rounded-full box-border shrink-0 border-[1.5px] border-[var(--border-default)]',
};

function RadioFace<TValue extends string>({ opt, selected }: { opt: ChoiceCardOption<TValue>; selected: boolean }) {
    return (
        <>
            <span className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-primary)]">
                <span aria-hidden="true" className={selected ? RADIO_DOT.on : RADIO_DOT.off} />
                {opt.Icon && <opt.Icon className="w-4 h-4 shrink-0" aria-hidden="true" />}
                <span>{opt.label}</span>
                {opt.badge && (
                    <span className="text-[10px] font-semibold px-1.5 py-px rounded-full border border-[var(--border-default)] text-[var(--text-secondary)]">
                        {opt.badge}
                    </span>
                )}
            </span>
            {opt.description && (
                <span className="block text-xs leading-[17px] font-normal text-[var(--text-secondary)]">{opt.description}</span>
            )}
        </>
    );
}

// The default look: the selected-row tint of the theme with an ink outline
// (the same 1.5px on both, so the text never shifts when the choice moves).
const TINT_BASE = `w-full h-full text-left px-3 py-2.5 rounded-lg transition-colors disabled:opacity-60 disabled:cursor-not-allowed border-[1.5px] ${FOCUS}`;
const TINT_CARD = {
    on: `${TINT_BASE} bg-[var(--item-active-bg)] border-[var(--text-primary)]`,
    off: `${TINT_BASE} bg-[var(--bg-primary)] border-[var(--border-default)] enabled:hover:bg-[var(--item-hover-bg)]`,
};

function TintFace<TValue extends string>({ opt }: { opt: ChoiceCardOption<TValue> }) {
    return (
        <>
            <span className="text-[13px] font-medium flex items-center gap-1.5 text-[var(--text-primary)]">
                {opt.Icon && <opt.Icon className="w-4 h-4 shrink-0" aria-hidden="true" />}
                <span>{opt.label}</span>
                {opt.badge && (
                    <span className="text-[10px] font-semibold px-1.5 py-px rounded-full border border-[var(--border-default)] text-[var(--text-secondary)]">{opt.badge}</span>
                )}
            </span>
            {opt.description && (
                <span className="text-xs mt-0.5 leading-relaxed block text-[var(--text-secondary)]">{opt.description}</span>
            )}
        </>
    );
}

export default function ChoiceCards<TValue extends string>({
    value,
    onChange,
    options,
    ariaLabel,
    disabled = false,
    columns = 2,
    className = '',
    appearance = 'tint',
}: ChoiceCardsProps<TValue>) {
    const radio = appearance === 'radio';
    const refs = useRef<Record<string, HTMLButtonElement | null>>({});
    const enabled = options.filter(o => !o.disabled && !disabled);

    const selectedIdx = options.findIndex(o => o.value === value);
    const firstEnabledIdx = options.findIndex(o => !o.disabled && !disabled);
    // The tab stop sits on the selection only while it can take focus: a
    // stored value whose option is now disabled (a lapsed licence) would
    // otherwise leave the group with no way in from the keyboard.
    const selectedUsable = selectedIdx >= 0 && !disabled && !options[selectedIdx].disabled;
    const activeIdx = selectedUsable ? selectedIdx : Math.max(0, firstEnabledIdx);

    const onKeyDown = (e: React.KeyboardEvent, idx: number) => {
        if (enabled.length === 0) return;
        const pos = enabled.findIndex(o => o.value === options[idx].value);
        const from = pos >= 0 ? pos : 0;
        let next = from;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (from + 1) % enabled.length;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (from - 1 + enabled.length) % enabled.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = enabled.length - 1;
        else return;
        e.preventDefault();
        const target = enabled[next];
        onChange(target.value);
        refs.current[target.value]?.focus();
    };

    return (
        <div
            role="radiogroup"
            aria-label={ariaLabel}
            className={`grid ${radio ? 'gap-2.5' : 'gap-2'} ${GRID[columns]} ${className}`}
        >
            {options.map((opt, idx) => {
                const selected = opt.value === value;
                const off = disabled || !!opt.disabled;
                const cardClass = radio
                    ? (selected ? RADIO_CARD.on : RADIO_CARD.off)
                    : (selected ? TINT_CARD.on : TINT_CARD.off);
                return (
                    <div key={opt.value} className={radio ? 'flex flex-col' : undefined}>
                        <button
                            type="button"
                            role="radio"
                            ref={(el) => { refs.current[opt.value] = el; }}
                            aria-checked={selected}
                            tabIndex={idx === activeIdx ? 0 : -1}
                            disabled={off}
                            onClick={() => onChange(opt.value)}
                            onKeyDown={(e) => onKeyDown(e, idx)}
                            className={cardClass}
                        >
                            {radio ? <RadioFace opt={opt} selected={selected} /> : <TintFace opt={opt} />}
                        </button>
                        {off && opt.lockedNotice && (
                            <p className="text-[11px] mt-1 leading-relaxed text-[var(--text-tertiary)]">
                                {opt.lockedNotice}
                            </p>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
