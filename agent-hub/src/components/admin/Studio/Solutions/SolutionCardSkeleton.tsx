import React from 'react';

/** One placeholder card while the overview loads; same footprint as SolutionCard. */
export default function SolutionCardSkeleton() {
    return (
        <div
            className="flex flex-col gap-3 p-4 lg:p-5 rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-card)] animate-pulse motion-reduce:animate-none"
            data-testid="solution-card-skeleton"
            aria-hidden="true"
        >
            <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-[var(--radius-sm)] bg-[var(--bg-tertiary)]" />
                <div className="flex-1 space-y-2">
                    <div className="h-3.5 w-2/3 rounded bg-[var(--bg-tertiary)]" />
                    <div className="h-2.5 w-1/3 rounded bg-[var(--bg-tertiary)]" />
                </div>
            </div>
            <div className="h-3 w-full rounded bg-[var(--bg-tertiary)]" />
            <div className="h-3 w-4/5 rounded bg-[var(--bg-tertiary)]" />
            <div className="flex gap-2">
                <div className="h-5 w-12 rounded-full bg-[var(--bg-tertiary)]" />
                <div className="h-5 w-12 rounded-full bg-[var(--bg-tertiary)]" />
            </div>
        </div>
    );
}
