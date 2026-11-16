/**
 * The class recipes of the one Button primitive (`Button.tsx`), as data, so a
 * kit that styles a plain `<button>` or an `<a>` (SAVE_BUTTON, PRIMARY_BTN)
 * can reuse the SAME colours instead of keeping its own copy.
 *
 * Colours come only from theme tokens:
 *  - primary is the accent with the accent's own readable foreground
 *    (`--accent-primary-fg`), never `text-white`: several themes have a light
 *    accent (grey, yellow, pearl) where white text disappears;
 *  - success, warning and danger read the tone pairs of `statusTone.ts` TONES
 *    (raw colour for the border and tint, ink for the text);
 *  - focus is `--focus-ring`, which every theme declares.
 *
 * Hover sits behind `enabled:` so a disabled button does not change colour on
 * hover; disabled is the same colours at half opacity for every variant.
 *
 * Literal strings only: Tailwind keeps what it finds in the source, never a
 * class assembled at runtime.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'success' | 'danger' | 'warning';
export type ButtonSize = 'sm' | 'md' | 'lg';

/** The fill of the primary action, without size or shape: ink in the neutral-accent themes, the accent elsewhere (index.css --button-primary-*). */
export const PRIMARY_TONE = 'bg-[var(--button-primary-bg)] enabled:hover:bg-[var(--button-primary-hover)] text-[var(--button-primary-fg)] border-transparent';

/** The keyboard focus ring of every button-like control. */
export const FOCUS_RING = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';

/** Disabled looks the same in every variant: the same colours, dimmed. */
const DISABLED = 'disabled:opacity-50 disabled:cursor-not-allowed';

export const BUTTON_VARIANTS: Readonly<Record<ButtonVariant, string>> = Object.freeze({
    primary: PRIMARY_TONE,
    secondary: 'bg-[var(--bg-tertiary)] enabled:hover:bg-[var(--bg-card-hover)] text-[var(--text-primary)] border-[var(--border-default)]',
    ghost: 'bg-transparent enabled:hover:bg-[var(--item-hover-bg)] text-[var(--text-secondary)] enabled:hover:text-[var(--text-primary)] border-transparent',
    success: 'bg-[color-mix(in_srgb,var(--success)_12%,transparent)] enabled:hover:bg-[color-mix(in_srgb,var(--success)_22%,transparent)] text-[var(--success-ink)] border-[color-mix(in_srgb,var(--success)_40%,transparent)]',
    danger: 'bg-[color-mix(in_srgb,var(--error)_10%,transparent)] enabled:hover:bg-[color-mix(in_srgb,var(--error)_20%,transparent)] text-[var(--error-ink)] border-[color-mix(in_srgb,var(--error)_40%,transparent)]',
    warning: 'bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] enabled:hover:bg-[color-mix(in_srgb,var(--warning)_22%,transparent)] text-[var(--warning-ink)] border-[color-mix(in_srgb,var(--warning)_40%,transparent)]',
});

const BUTTON_SIZES: Readonly<Record<ButtonSize, string>> = Object.freeze({
    sm: 'px-2.5 py-1 text-xs gap-1 rounded-md',
    md: 'px-3.5 py-2 text-[13px] gap-1.5 rounded-lg',
    lg: 'px-4 py-2.5 text-sm gap-2 rounded-lg',
});

const BASE = `inline-flex items-center justify-center font-semibold border transition-colors duration-150 whitespace-nowrap ${DISABLED} ${FOCUS_RING}`;

/** The full class string of a Button of this variant and size. */
export function buttonClass(variant: ButtonVariant = 'primary', size: ButtonSize = 'md'): string {
    return `${BASE} ${BUTTON_SIZES[size]} ${BUTTON_VARIANTS[variant]}`;
}
