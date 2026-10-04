import type { ReactNode } from 'react';

export type CanvasPillTone = 'neutral' | 'success' | 'warning' | 'ai' | 'trigger';

/**
 * NodeChip's geometry (StepNodeBase.jsx) with class-based tones. NodeChip
 * paints its tones through an inline style; this one is for surfaces under
 * the no-`style={{}}` ratchet, such as evidence pills and tags on a page.
 * The tints are the canvas's 16%.
 */
const TONE: Readonly<Record<CanvasPillTone, string>> = Object.freeze({
    neutral: 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
    success: 'bg-[color-mix(in_srgb,var(--success)_16%,transparent)] text-[var(--success-ink)]',
    warning: 'bg-[color-mix(in_srgb,var(--warning)_16%,transparent)] text-[var(--warning)]',
    ai: 'bg-[color-mix(in_srgb,var(--type-ai)_16%,transparent)] text-[var(--type-ai)]',
    trigger: 'bg-[color-mix(in_srgb,var(--type-trigger)_16%,transparent)] text-[var(--type-trigger)]',
});

export const CANVAS_PILL = 'inline-flex items-center gap-1 text-[10px] font-semibold leading-4 px-1.5 rounded-md whitespace-nowrap tabular-nums';

export interface CanvasPillProps {
    tone?: CanvasPillTone;
    title?: string;
    children: ReactNode;
}

export default function CanvasPill({ tone = 'neutral', title, children }: CanvasPillProps) {
    return (
        <span className={`${CANVAS_PILL} ${TONE[tone] ?? TONE.neutral}`} title={title} data-tone={tone}>
            {children}
        </span>
    );
}
