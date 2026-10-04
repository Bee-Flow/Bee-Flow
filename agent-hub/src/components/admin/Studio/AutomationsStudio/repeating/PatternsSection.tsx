import { Info, X, XCircle } from 'lucide-react';
import type { ReasonCode, RepeatingSuggestion, ScanResult } from '../../../../../api/queries/automation/repeating';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { EYEBROW } from '../../../../automation/Builder/flow/canvasClasses';
import PatternCard from './PatternCard';
import PatternSkeleton, { PATTERN_GRID } from './PatternSkeleton';
import RepeatingEmpty, { emptyKindFor } from './RepeatingEmpty';
import type { PendingHide } from './usePatternFeedback';

export interface PatternActions {
    onBuild: (s: RepeatingSuggestion, opts: { autoSend: boolean }) => void;
    onSnooze: (s: RepeatingSuggestion) => void;
    onNotRepetitive: (s: RepeatingSuggestion, reason: ReasonCode) => void;
    onDismiss: (s: RepeatingSuggestion) => void;
}

/** "Hidden for 30 days · Undo", while the choice can still be taken back. */
export function UndoNotice({ pending, onUndo, onClose }: { pending: PendingHide; onUndo: () => void; onClose: () => void }) {
    const { t } = useTranslation();
    let what = t('automations.repeating.undoDismissed', 'Marked as not repetitive.');
    if (pending.action === 'snoozed') what = t('automations.repeating.undoSnoozed', 'Hidden for 30 days.');
    else if (!pending.reasonCode) what = t('automations.repeating.undoDismissedIdea', 'Suggestion dismissed.');
    return (
        <div role="status" className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] shadow-sm text-[12px] text-[var(--text-secondary)]" data-testid="repeating-undo">
            <span className="min-w-0 flex-1 truncate">
                <span className="font-medium text-[var(--text-primary)]">{pending.suggestion.title}</span>
                {' · '}{what}
            </span>
            <button type="button" onClick={onUndo} className="font-semibold text-[var(--accent-primary)] hover:underline">
                {t('automations.repeating.undo', 'Undo')}
            </button>
            <button type="button" onClick={onClose} aria-label={t('automations.repeating.undoClose', 'Close')} className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                <X size={12} aria-hidden="true" />
            </button>
        </div>
    );
}

function ErrorNotice({ error, onRetry }: { error: string; onRetry: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-start gap-3 px-4 py-3.5 rounded-[var(--radius-md)] border border-dashed border-[var(--border-default)] bg-[var(--bg-card)]" data-testid="repeating-error">
            <XCircle size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--error)]" />
            <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-[var(--text-primary)]">{t('automations.repeating.errorTitle', 'Bee could not finish the scan')}</div>
                <p className="m-0 mt-0.5 text-[12px] leading-snug text-[var(--text-tertiary)]">{error}</p>
                <button type="button" onClick={onRetry} className="mt-2 px-3 py-1.5 rounded-lg text-[12px] font-medium border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition">
                    {t('automations.repeating.tryAgain', 'Try again')}
                </button>
            </div>
        </div>
    );
}

/** The ideas fallback, clearly apart from what was observed. */
function IdeasList({ ideas, busy, labelFor, actions }: { ideas: ScanResult; busy: boolean; labelFor: (id: string) => string; actions: PatternActions }) {
    const { t } = useTranslation();
    return (
        <section className="flex flex-col gap-2.5" aria-label={t('automations.repeating.ideasTitle', 'Ideas · not seen in your activity')} data-testid="repeating-ideas">
            <div className={`${EYEBROW} text-[var(--type-ai)]`}>{t('automations.repeating.ideasTitle', 'Ideas · not seen in your activity')}</div>
            {ideas.suggestions.length === 0
                ? <p className="m-0 text-[12px] text-[var(--text-tertiary)]">{t('automations.repeating.ideasNone', 'Bee had no ideas this time.')}</p>
                : (
                    <div className={PATTERN_GRID}>
                        {ideas.suggestions.map(s => (
                            <PatternCard key={s.id} suggestion={s} variant="idea" busy={busy} labelFor={labelFor} onBuild={actions.onBuild} onDismiss={actions.onDismiss} />
                        ))}
                    </div>
                )}
        </section>
    );
}

export interface PatternsSectionProps {
    suggestions: RepeatingSuggestion[];
    /** A scan is running: the cards dim and their actions wait for it. */
    busy: boolean;
    /** The running scan is a patterns scan (it gets the skeleton; the ideas scan does not). */
    scanningPatterns: boolean;
    scanned: boolean;
    reason: string | null;
    /** The sources the last scan read, by name. */
    looked: string;
    error: string | null;
    onRetry: () => void;
    stale: boolean;
    ideas: ScanResult | null;
    onSuggestIdeas: () => void;
    pending: PendingHide | null;
    onUndo: () => void;
    onCloseUndo: () => void;
    labelFor: (id: string) => string;
    actions: PatternActions;
}

/**
 * The patterns the scan found, as a grid of canvas cards. An error sits ABOVE
 * the previous result instead of replacing it; a re-scan dims the cards until
 * its result lands; a "sources changed" line says when the cards no longer
 * match what is switched on. With nothing found, the empty state says why,
 * and only then is the ideas fallback offered.
 */
export default function PatternsSection(props: PatternsSectionProps) {
    const { t } = useTranslation();
    const { suggestions, busy, scanningPatterns, scanned, error, ideas, labelFor, actions } = props;
    const showEmpty = scanned && !scanningPatterns && !error && suggestions.length === 0;
    const kind = emptyKindFor(props.reason);
    const offerIdeas = !ideas && kind !== 'no_sources' ? props.onSuggestIdeas : undefined;
    return (
        <div className="flex flex-col gap-3">
            {props.pending && <UndoNotice pending={props.pending} onUndo={props.onUndo} onClose={props.onCloseUndo} />}
            {error && <ErrorNotice error={error} onRetry={props.onRetry} />}
            {props.stale && suggestions.length > 0 && (
                <p role="status" className="m-0 flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
                    <Info size={13} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" />
                    {t('automations.repeating.stale', 'Your sources or focus changed since this scan. Scan again to update it.')}
                </p>
            )}
            {scanningPatterns && suggestions.length === 0 && <PatternSkeleton count={2} />}
            {showEmpty && <RepeatingEmpty kind={kind} looked={props.looked} onSuggestIdeas={offerIdeas} ideasBusy={busy} />}
            {suggestions.length > 0 && (
                <div className={PATTERN_GRID} data-testid="suggestion-list">
                    {suggestions.map(s => (
                        <PatternCard key={s.id} suggestion={s} busy={busy} labelFor={labelFor}
                            onBuild={actions.onBuild} onSnooze={actions.onSnooze} onNotRepetitive={actions.onNotRepetitive} />
                    ))}
                </div>
            )}
            {ideas && <IdeasList ideas={ideas} busy={busy} labelFor={labelFor} actions={actions} />}
        </div>
    );
}
