import React from 'react';
import { SUGGESTION_GRID } from './suggestionGrid';

/**
 * SuggestionSkeleton: placeholder rows shown while a scan is running and there
 * are no results to show yet. Mirrors the SuggestionCard row (tile, title,
 * sentence, evidence line) so the list does not jump when real rows arrive.
 * Pure CSS pulse, theme vars only.
 */
export default function SuggestionSkeleton({ count = 3 }) {
    return (
        <div className={`rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] divide-y divide-[var(--border-default)] overflow-hidden ${SUGGESTION_GRID}`} aria-hidden="true">
            {Array.from({ length: Math.max(1, count) }).map((_, i) => (
                <div key={i} className="flex items-start gap-3 px-3.5 py-3 bg-[var(--bg-card)] animate-pulse">
                    <div className="w-7 h-7 rounded-lg bg-[var(--bg-tertiary)] flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                        <div className="h-3.5 w-2/5 rounded bg-[var(--bg-tertiary)] mb-2" />
                        <div className="h-3 w-4/5 rounded bg-[var(--bg-tertiary)] mb-1.5" />
                        <div className="h-2.5 w-1/3 rounded bg-[var(--bg-tertiary)]" />
                    </div>
                    <div className="h-7 w-20 rounded-lg bg-[var(--bg-tertiary)] flex-shrink-0" />
                </div>
            ))}
        </div>
    );
}
