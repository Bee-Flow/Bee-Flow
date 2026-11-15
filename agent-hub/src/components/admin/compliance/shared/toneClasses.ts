// The status tones of the Compliance rails as Tailwind classes, so a row's dot
// and its badge text need no inline style (statusTone.ts TONES holds the same
// pairs as CSS values). Literal strings only: Tailwind keeps what it finds in
// the source, never a class assembled at runtime. An unknown or missing tone
// reads as neutral.

const DOT: Readonly<Record<string, string>> = Object.freeze({
    success: 'bg-[var(--success)]',
    warning: 'bg-[var(--warning)]',
    error: 'bg-[var(--error)]',
    neutral: 'bg-[var(--bg-tertiary)]',
});

const INK: Readonly<Record<string, string>> = Object.freeze({
    success: 'text-[var(--success-ink)]',
    warning: 'text-[var(--warning-ink)]',
    error: 'text-[var(--error-ink)]',
    neutral: 'text-[var(--text-tertiary)]',
});

/** The background class of a tone's dot (the raw status colour). */
export function toneDotClass(tone: string | null | undefined): string {
    return (tone && Object.hasOwn(DOT, tone) ? DOT[tone] : undefined) ?? DOT.neutral;
}

/** The text class of a tone (its ink: readable on the card). */
export function toneInkClass(tone: string | null | undefined): string {
    return (tone && Object.hasOwn(INK, tone) ? INK[tone] : undefined) ?? INK.neutral;
}
