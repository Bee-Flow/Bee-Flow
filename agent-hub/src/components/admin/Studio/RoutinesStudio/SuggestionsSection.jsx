import React, { useMemo, useState } from 'react';
import SuggestionCard from './SuggestionCard';
import { SUGGESTION_GRID } from './suggestionGrid';
import { useTranslation } from '../../../../hooks/useTranslation';

/**
 * SuggestionsSection: the suggestions as one list of compact rows, split into
 * "From your activity" (observed, suggestion.groundedIn === 'activity') and
 * "Ideas" (everything else). When BOTH are present a segmented filter with
 * counts sits above the list (the Runs list's idiom); otherwise the list
 * shows without it.
 *
 * Grounding is feature-detected: before the backend tags suggestions, every
 * row lands in "Ideas" and the filter never appears.
 *
 * Dismissed/built state is passed down per row so they grey out in place.
 */
export default function SuggestionsSection({
    suggestions = [],
    onBuildDirectly,
    onAskForChanges,
    onDismiss,
    dismissed,       // Set of ids
    builtIds,        // Set of ids
    labelFor,
}) {
    const { t } = useTranslation();
    const { activity, ideas } = useMemo(() => {
        const a = [];
        const b = [];
        for (const s of suggestions) (s && s.groundedIn === 'activity' ? a : b).push(s);
        return { activity: a, ideas: b };
    }, [suggestions]);

    const hasBoth = activity.length > 0 && ideas.length > 0;
    const [filter, setFilter] = useState('all'); // 'all' | 'activity' | 'ideas'

    const visible = useMemo(() => {
        if (!hasBoth || filter === 'all') return suggestions;
        return filter === 'activity' ? activity : ideas;
    }, [hasBoth, filter, suggestions, activity, ideas]);

    if (!suggestions.length) return null;

    const segments = [
        { value: 'all', label: t('routines.repeating.filterAll', 'All'), count: suggestions.length },
        { value: 'activity', label: t('routines.repeating.filterActivity', 'From your activity'), count: activity.length },
        { value: 'ideas', label: t('routines.repeating.filterIdeas', 'Ideas'), count: ideas.length },
    ];

    return (
        <div className="flex flex-col gap-2.5">
            {hasBoth && (
                <div role="group" aria-label={t('routines.repeating.filterLabel', 'Show suggestions')} className="self-start flex bg-[var(--bg-tertiary)] rounded-lg p-0.5 gap-0.5 text-[12px] font-medium">
                    {segments.map((s) => {
                        const on = filter === s.value;
                        return (
                            <button
                                key={s.value}
                                type="button"
                                aria-pressed={on}
                                onClick={() => setFilter(s.value)}
                                className={`px-2.5 py-1 rounded-md whitespace-nowrap transition ${on ? 'bg-[var(--bg-card)] shadow-sm text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
                            >
                                {s.label}
                                <span className="ml-1 text-[var(--text-tertiary)]">{s.count}</span>
                            </button>
                        );
                    })}
                </div>
            )}

            {/* One column of rows, or two on a wide tab (suggestionGrid.ts). */}
            <div className={`rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] divide-y divide-[var(--border-default)] overflow-hidden ${SUGGESTION_GRID}`} data-testid="suggestion-list">
                {visible.map((s) => (
                    <SuggestionCard
                        key={s.id}
                        suggestion={s}
                        onBuildDirectly={onBuildDirectly}
                        onAskForChanges={onAskForChanges}
                        onDismiss={onDismiss}
                        dismissed={dismissed?.has?.(s.id)}
                        built={builtIds?.has?.(s.id)}
                        muted={dismissed?.has?.(s.id) || builtIds?.has?.(s.id)}
                        labelFor={labelFor}
                    />
                ))}
            </div>
        </div>
    );
}
