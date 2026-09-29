import { Eye, Sparkles, X } from 'lucide-react';
import React from 'react';
import { evidenceParts, missingApps } from './suggestionEvidence';
import { useTranslation } from '../../../../hooks/useTranslation';

const identity = (x) => x;

/**
 * One suggested automation as a compact row (Studio → Automations, handoff 5
 * language): a plain title, one sentence of what it would do, a quiet
 * evidence line ("Observed · seen 6× in the last 3 months · from Gmail"), and
 * the two ways on: "Build it" (Bee builds it now) and "Adjust first" (the
 * builder opens with the idea filled in, for you to change before sending).
 * Dismiss removes it.
 *
 *   - Build it      → onBuildDirectly(suggestion)
 *   - Adjust first  → onAskForChanges(suggestion)
 *   - Dismiss       → onDismiss(suggestion)
 *
 * The row folds by its own width: the actions sit beside the text when there
 * is room, below it when there is not. A dismissed or built row greys out and
 * its actions are disabled.
 */
export default function SuggestionCard({
    suggestion,
    onBuildDirectly,
    onAskForChanges,
    onDismiss,
    built = false,
    dismissed = false,
    muted = false,
    labelFor = identity,
}) {
    const { t } = useTranslation();
    const { title, description } = suggestion || {};
    const done = dismissed || built;

    return (
        <div className={`@container/sugg bg-[var(--bg-card)] transition ${muted || done ? 'opacity-60' : ''}`} data-testid="suggestion-row">
            <div className="flex flex-col gap-2.5 px-3.5 py-3 @[36rem]/sugg:flex-row @[36rem]/sugg:items-center @[36rem]/sugg:gap-4">
                <div className="flex items-start gap-3 flex-1 min-w-0">
                    <span className="w-7 h-7 rounded-lg grid place-items-center flex-shrink-0 bg-[color-mix(in_srgb,var(--type-ai)_12%,transparent)] text-[var(--type-ai)]">
                        <Sparkles size={14} aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[13px] font-semibold leading-snug text-[var(--text-primary)]">{title}</span>
                            {done && (
                                <span className="text-[10px] font-semibold px-1.5 py-px rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                                    {built ? t('routines.repeating.built', 'Built') : t('routines.repeating.dismissed', 'Dismissed')}
                                </span>
                            )}
                        </div>
                        {description && (
                            <p className="m-0 mt-0.5 text-[12px] leading-snug text-[var(--text-secondary)] line-clamp-2">{description}</p>
                        )}
                        <EvidenceLine suggestion={suggestion} labelFor={labelFor} />
                    </div>
                </div>
                <div className="flex items-center gap-1.5 pl-10 @[36rem]/sugg:pl-0 flex-shrink-0">
                    <button
                        type="button"
                        onClick={() => onBuildDirectly?.(suggestion)}
                        disabled={done}
                        className="px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {t('routines.repeating.build', 'Build it')}
                    </button>
                    <button
                        type="button"
                        onClick={() => onAskForChanges?.(suggestion)}
                        disabled={done}
                        className="px-3 py-1.5 rounded-lg text-[12px] font-medium border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {t('routines.repeating.adjust', 'Adjust first')}
                    </button>
                    {onDismiss && !done && (
                        <button
                            type="button"
                            onClick={() => onDismiss(suggestion)}
                            aria-label={t('routines.repeating.dismiss', 'Dismiss suggestion')}
                            title={t('routines.repeating.dismiss', 'Dismiss suggestion')}
                            className="p-1 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition"
                        >
                            <X size={13} aria-hidden="true" />
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

/** Observed or idea, then the evidence parts, then what is not connected yet. */
function EvidenceLine({ suggestion, labelFor }) {
    const { t } = useTranslation();
    const groundedIn = suggestion?.groundedIn;
    const parts = evidenceParts(suggestion, t, labelFor);
    const needs = missingApps(suggestion, labelFor);
    const items = [];
    if (groundedIn) {
        const observed = groundedIn === 'activity';
        items.push(
            <span key="grounding" className={`inline-flex items-center gap-1 ${observed ? 'text-[var(--success)]' : ''}`} data-grounding={observed ? 'observed' : 'idea'}>
                <Eye size={10} aria-hidden="true" />
                {observed ? t('routines.repeating.observed', 'Observed') : t('routines.repeating.idea', 'Idea')}
            </span>,
        );
    }
    parts.forEach((p, i) => items.push(<span key={`p${i}`}>{p}</span>));
    if (needs.length) {
        items.push(
            <span key="needs" className="text-[var(--warning)]">
                {t('routines.repeating.needs', 'needs {apps} connected', { apps: needs.join(', ') })}
            </span>,
        );
    }
    if (!items.length) return null;
    return (
        <div className="mt-1 flex flex-wrap items-center gap-x-1 text-[11px] leading-snug text-[var(--text-tertiary)]">
            {items.map((item, i) => (
                <React.Fragment key={item.key}>
                    {i > 0 && <span aria-hidden="true">·</span>}
                    {item}
                </React.Fragment>
            ))}
        </div>
    );
}
