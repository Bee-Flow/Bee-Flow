import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';

/** One source a scan reads, as useSuggestionScan tracks it. */
export interface ScanStep {
    tool: string;
    integration: string;
    status: 'scanning' | 'done' | 'blocked' | string;
}

/** "Show details" / "Hide details": the per-source log sits behind it. */
export function DetailsToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
    const { t } = useTranslation();
    return (
        <button
            type="button"
            aria-expanded={open}
            onClick={onToggle}
            className="inline-flex items-center gap-1 text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition"
        >
            {open ? <ChevronDown size={11} aria-hidden="true" /> : <ChevronRight size={11} aria-hidden="true" />}
            {open ? t('routines.repeating.hideDetails', 'Hide details') : t('routines.repeating.showDetails', 'Show details')}
        </button>
    );
}

/** What the scan is doing right now, in one sentence. */
export function progressText(
    phase: string | null,
    steps: ScanStep[],
    labelFor: (id: string) => string,
    t: ReturnType<typeof useTranslation>['t'],
): string {
    if (phase === 'synthesising') return t('routines.repeating.reviewing', 'Looking for patterns in what Bee read…');
    const current = [...steps].reverse().find(s => s.status === 'scanning');
    if (current) return t('routines.repeating.reading', 'Reading {app}…', { app: labelFor(current.integration) });
    return t('routines.repeating.starting', 'Starting the scan…');
}

/**
 * The compact progress line while a scan runs (handoff 5 language), in place
 * of the old full log: what Bee is reading, how many sources it has read, the
 * log behind "Show details", and Stop.
 */
export default function ScanProgress({ phase, steps, labelFor, detailsOpen, onToggleDetails, onStop }: {
    phase: string | null;
    steps: ScanStep[];
    labelFor: (id: string) => string;
    detailsOpen: boolean;
    onToggleDetails: () => void;
    onStop: () => void;
}) {
    const { t } = useTranslation();
    const read = steps.filter(s => s.status === 'done').length;
    return (
        <div className="flex items-center gap-2 flex-wrap text-[12px] text-[var(--text-secondary)]" data-testid="scan-progress">
            <Loader2 size={13} className="animate-spin text-[var(--text-tertiary)] flex-shrink-0" aria-hidden="true" />
            <span role="status" aria-live="polite">{progressText(phase, steps, labelFor, t)}</span>
            {read > 0 && (
                <span className="text-[var(--text-tertiary)]">
                    {'· '}
                    {read === 1
                        ? t('routines.repeating.readOne', '1 source read')
                        : t('routines.repeating.readCount', '{count} sources read', { count: read })}
                </span>
            )}
            <span className="ml-auto flex items-center gap-3">
                {steps.length > 0 && <DetailsToggle open={detailsOpen} onToggle={onToggleDetails} />}
                <button
                    type="button"
                    onClick={onStop}
                    className="text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline transition"
                >
                    {t('routines.repeating.stop', 'Stop')}
                </button>
            </span>
        </div>
    );
}
