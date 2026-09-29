import type { ReactNode } from 'react';

/**
 * A numbered column head for the step drawer (round 4): "1 Comes in",
 * "2 What this step does", "3 Continues on", each with a one-sentence summary
 * underneath so the three read as one sentence left to right without
 * scrolling. The middle column is the one being edited and gets the filled
 * number.
 */
export default function NdvColumnHeader({
    n, title, summary = null, active = false, testId, children = null,
}: {
    n: number;
    title: ReactNode;
    summary?: ReactNode;
    active?: boolean;
    testId?: string;
    children?: ReactNode;
}) {
    return (
        <div
            data-testid={testId}
            className="flex items-center gap-2.5 px-4 py-2.5 border-b border-[var(--border-default)] flex-shrink-0 text-[12px] min-w-0"
        >
            <span
                aria-hidden="true"
                className={`shrink-0 w-[22px] h-[22px] rounded-full grid place-items-center font-bold text-[12px] ${
                    active
                        ? 'bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]'
                        : 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]'}`}
            >
                {n}
            </span>
            <div className="min-w-0 flex-1">
                <div className="font-semibold text-[13px] text-[var(--text-primary)] leading-tight truncate">{title}</div>
                {summary && (
                    <div className="text-[var(--text-secondary)] truncate leading-snug" data-testid={testId ? `${testId}-summary` : undefined}>
                        {summary}
                    </div>
                )}
            </div>
            {children && <div className="shrink-0 flex items-center gap-1.5 min-w-0">{children}</div>}
        </div>
    );
}
