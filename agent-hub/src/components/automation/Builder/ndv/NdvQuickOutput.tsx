import { ChevronDown, ChevronRight, Pin, PinOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import RunTabContainer from '../debug/RunTabContainer';
import type { DataSummary, FlowStep } from '../flow/types';
import type { ErrorFix, StepErrorInfo } from '../output/ErrorCard';

type RunStepProp = Parameters<typeof RunTabContainer>[0]['runStep'];

/**
 * The quick dialog's own words for how the last run went: shorter and
 * quieter than the shared table's. Colours follow shared/statusTokens.ts
 * (`running` is --type-ai there, so here too).
 */
const QUICK_STATUS: Record<string, { key: string; en: string; color: string }> = {
    success: { key: 'routines.ndv.quick_success', en: 'Success', color: 'text-[var(--text-tertiary)]' },
    error: { key: 'routines.ndv.quick_failed', en: 'Failed', color: 'text-[var(--error)]' },
    failed: { key: 'routines.ndv.quick_failed', en: 'Failed', color: 'text-[var(--error)]' },
    running: { key: 'routines.ndv.quick_running', en: 'Running…', color: 'text-[var(--type-ai)]' },
    awaiting_approval: { key: 'routines.ndv.pill_waiting', en: 'Waiting for approval', color: 'text-[var(--warning)]' },
    pinned: { key: 'routines.ndv.pinned', en: 'Pinned', color: 'text-[var(--pinned)]' },
    // Never "Pinned": a value the author typed is not a capture.
    edited: { key: 'routines.ndv.edited', en: 'Edited', color: 'text-[var(--pinned)]' },
};

/**
 * Quick view: what came back, beside or under the settings that produced it.
 * Renders for triggers too, because the quick density is where people land
 * and Edit here is the one way to supply trigger data. Test step is not
 * repeated here: the header's primary button sits right above it.
 */
export default function NdvQuickOutput({
    step, runStep, outSummary, open, onToggle, editButton, editor, editorOpen,
    isTrigger, pinned, edited, canPin, pinTitle, onTogglePin,
    onRetryFromStep = null, onFixError = null,
}: {
    step: FlowStep;
    runStep: { status?: unknown } | null;
    outSummary: DataSummary | null;
    open: boolean;
    onToggle: () => void;
    editButton: ReactNode;
    editor: ReactNode;
    editorOpen: boolean;
    isTrigger: boolean;
    pinned: boolean;
    edited: boolean;
    canPin: boolean;
    pinTitle: string;
    onTogglePin: () => void;
    /** The error card's "Try again": retry this step and continue downstream. */
    onRetryFromStep?: ((stepId: string) => void) | null;
    /** The error card's setting fixes: show the ringed setting above. */
    onFixError?: ((fix: ErrorFix, info: StepErrorInfo | null) => boolean | void) | null;
}) {
    const { t } = useTranslation();
    const s = QUICK_STATUS[String(runStep?.status || '')]
        || (pinned && !runStep ? (edited ? QUICK_STATUS.edited : QUICK_STATUS.pinned) : null);
    return (
        // Open, it shares the drawer with the settings: under them (2 : 3) in a
        // narrow drawer, beside them in a wide one (NodeDetailView's row).
        <div
            data-testid="ndv-quick-output"
            className={`flex flex-col min-h-0 min-w-0 border-t border-[var(--border-default)] bg-[var(--bg-secondary)] ${open
                ? 'flex-[2_1_0%] @min-[1100px]/ndv:flex-[3_1_0%] @min-[1100px]/ndv:min-w-[420px] @min-[1100px]/ndv:border-t-0 @min-[1100px]/ndv:border-l'
                : 'flex-shrink-0'}`}
        >
            <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 text-[10px] uppercase tracking-[0.08em] font-semibold text-[var(--text-secondary)]">
                <button type="button" onClick={onToggle} aria-expanded={open} className="inline-flex items-center gap-1.5 hover:text-[var(--text-primary)] min-w-0">
                    {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    {t('routines.ndv.output', 'Output')}
                    {s && <span className={`normal-case font-normal tracking-normal ${s.color}`}>· {t(s.key, s.en)}</span>}
                    {outSummary && (
                        <span className="normal-case font-normal tracking-normal text-[var(--text-tertiary)] truncate">· {outSummary.label}</span>
                    )}
                </button>
                <span className="ml-auto shrink-0 whitespace-nowrap inline-flex items-center gap-1">
                    {editButton}
                    {!isTrigger && (
                        <button
                            type="button"
                            onClick={onTogglePin}
                            disabled={!canPin && !pinned}
                            title={pinTitle}
                            className={`inline-flex items-center gap-1 normal-case tracking-normal px-2 py-0.5 rounded border text-[11px] transition disabled:opacity-30 ${
                                pinned && !edited
                                    ? 'border-[var(--pinned)] text-[var(--pinned)] bg-[color-mix(in_srgb,var(--pinned)_15%,transparent)]'
                                    : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'}`}
                        >
                            {pinned ? <PinOff size={11} /> : <Pin size={11} />}
                            {pinned ? (edited ? t('routines.ndv.clear', 'Clear') : t('routines.ndv.pinned', 'Pinned')) : t('routines.ndv.pin', 'Pin')}
                        </button>
                    )}
                </span>
            </div>
            {open && (
                // Its share of the drawer, never more: a large result cannot push the settings away.
                <div className="flex-1 min-h-0 overflow-hidden flex flex-col border-t border-[var(--border-default)]">
                    {editorOpen ? editor : <RunTabContainer step={step} runStep={runStep as RunStepProp} compact onRetryFromStep={onRetryFromStep} onFixError={onFixError} />}
                </div>
            )}
        </div>
    );
}
