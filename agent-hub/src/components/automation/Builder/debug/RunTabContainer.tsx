import { memo, useCallback, useMemo } from 'react';
import { Clock } from 'lucide-react';
import StepOutputTab from './StepOutputTab';
import { useTranslation } from '../../../../hooks/useTranslation';
import { deepEqual as deepEqualJs } from '../../../../utils/deepEqual';
import { statusLabel, tokenForStep } from '../../../shared/statusTokens';
import { summariseData as summariseDataJs } from '../flow/dataSummary';
import { stepPayload } from '../flow/stepPayload';
import { buildRunStepLabelMap } from '../flow/displayHelpers';
import type { FlowDefinition, FlowStep } from '../flow/types';
import type { ErrorFix, StepErrorInfo } from '../output/ErrorCard';
import type { NextSuggestion } from '../output/UsedBy';
import { usedByDownstream } from '../output/usedBy';

const deepEqual = deepEqualJs as (a: unknown, b: unknown) => boolean;
const summariseData = summariseDataJs as (value: unknown) => { label: string } | null;

/** The run record this panel reads: one step's row in the latest run. */
interface RunStepRecord {
    status?: string | null;
    output?: unknown;
    error?: string | null;
    errorInfo?: StepErrorInfo | null;
    errorRemediation?: string | null;
    durationMs?: number | null;
    attempts?: number | null;
    finishedAt?: string | null;
    startedAt?: string | null;
    skippedReason?: string | null;
    toolsWithheld?: unknown;
    bindingWarnings?: unknown;
    [key: string]: unknown;
}

interface RunTabContainerProps {
    step: FlowStep | null | undefined;
    runStep: RunStepRecord | null | undefined;
    /**
     * The caller already shows the status and the row count in its own header
     * (the quick dialog does), so the strip here would be the same sentence
     * twice. Drops it, and the standing hint footer with it.
     */
    compact?: boolean;
    /** The graph on screen: who uses this output ("Used by"). */
    definition?: FlowDefinition | null;
    /** The describers' guess at this step's output: "This step will return". */
    describedSample?: unknown;
    /** Remembers the column choice per automation + step. */
    automationId?: string | null;
    /** (stepId, suggestion) => void: add a step after this one. */
    onAddAfterStep?: ((stepId: string, suggestion: NextSuggestion) => void) | null;
    /** (stepId) => void: retry this step and continue downstream. */
    onRetryFromStep?: ((stepId: string) => void) | null;
    /** A fix that changes one of this step's settings. */
    onFixError?: ((fix: ErrorFix, info: StepErrorInfo | null) => boolean | void) | null;
}

// Its own function so the `tab` builder below stays readable (and under the
// complexity bar): the row's mappings that found nothing, or null.
const bindingWarningsOfRow = (run: RunStepRecord | null): unknown => run?.bindingWarnings ?? null;

/**
 * The step drawer's "Continues on" column. Shows the latest run's OUTPUT
 * directly, under a one-line status strip, plus what the step will return
 * before it ever ran, why it stopped when it failed, and who uses it next.
 */
function RunTabContainer({
    step, runStep, compact = false, definition = null, describedSample = null, automationId = null,
    onAddAfterStep = null, onRetryFromStep = null, onFixError = null,
}: RunTabContainerProps) {
    const { t } = useTranslation();
    const copyPath = useCallback((path: string) => {
        if (!path) return;
        try {
            void navigator.clipboard?.writeText(path);
        } catch {
            // Clipboard API can be blocked in non-secure contexts: a silent
            // fail is preferable to a noisy error here.
        }
    }, []);

    const stepId = step?.id ?? null;
    const usedBy = useMemo(() => (definition ? usedByDownstream(definition, stepId) : undefined), [definition, stepId]);
    const labelById = useMemo(() => buildRunStepLabelMap(definition) as Map<string, string>, [definition]);
    const onAddAfter = useMemo(
        () => (onAddAfterStep && stepId ? (s: NextSuggestion) => onAddAfterStep(stepId, s) : null),
        [onAddAfterStep, stepId],
    );
    const onRetry = useMemo(
        () => (onRetryFromStep && stepId ? () => onRetryFromStep(stepId) : null),
        [onRetryFromStep, stepId],
    );

    // No live run record yet. A PINNED output is exactly what downstream
    // steps will receive, so it shows instead of the empty state. A payload
    // the author TYPED is badged "Edited", never "Pinned" (BFSF-408).
    const isPinned = step?.pinnedOutput !== undefined && step?.pinnedOutput !== null;
    const effectiveRun: RunStepRecord | null = runStep || (isPinned
        ? { status: step?.pinnedSource === 'edited' ? 'edited' : 'pinned', output: step?.pinnedOutput }
        : null);

    const tab = (run: RunStepRecord | null) => (
        <StepOutputTab
            stepId={stepId}
            stepLabel={step?.label ?? null}
            liveOutput={run?.output ?? null}
            error={run?.error ?? null}
            errorInfo={run?.errorInfo ?? null}
            remediation={run?.errorRemediation ?? null}
            onCopyPath={copyPath}
            compact={compact}
            describedSample={describedSample}
            usedBy={usedBy}
            onAddAfter={onAddAfter}
            onRetry={onRetry}
            onFix={onFixError}
            columnsKey={stepId ? `${automationId || 'draft'}.${stepId}` : null}
            toolsWithheld={run?.toolsWithheld ?? null}
            bindingWarnings={bindingWarningsOfRow(run)}
            stepLabelById={labelById}
        />
    );

    if (!effectiveRun) {
        // Something to promise ("This step will return …") or somebody to
        // point at: the column carries it. Otherwise the plain empty state.
        if (describedSample != null || usedBy) return <div className="flex flex-col h-full min-h-0">{tab(null)}</div>;
        return (
            <div className="flex-1 flex flex-col h-full min-h-0 items-center justify-center px-6 py-12 text-[11px] text-[var(--text-tertiary)] text-center gap-2">
                <Clock size={18} className="opacity-60" />
                {/* Deliberately does NOT name ▶ Execute alone: on a trigger, and
                    on any node whose upstream cannot be replayed yet, running
                    is the option you do not have (BFSF-408). */}
                <div>{t('automations.output.no_data_yet', 'No data yet. Run this step to capture its output, or write it yourself with Edit.')}</div>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full min-h-0">
            {!compact && <StatusStrip runStep={effectiveRun} stepType={step?.type} />}
            {/* MUST stay a flex COLUMN: as a plain block the subtree's
                percentage heights fell back to `auto` and the table had no
                scrollbars inside the quick dialog (BFSF-386). */}
            <div className="flex-1 min-h-0 flex flex-col">{tab(effectiveRun)}</div>
        </div>
    );
}

function formatWhen(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * How the last run of this step went, in one line, off the shared status
 * table (components/shared/statusTokens.ts). A failed step says what went
 * on: nothing (artboard 4a).
 */
function StatusStrip({ runStep, stepType }: { runStep: RunStepRecord; stepType?: string | null }) {
    const { t } = useTranslation();
    // A failed step: the column header already says "Nothing, the step
    // stopped" and the error card says why, so the strip only says when.
    if (runStep.status === 'error' || runStep.status === 'failed') {
        const when = formatWhen(runStep.finishedAt || runStep.startedAt);
        if (!when) return null;
        return (
            <div className="px-3 py-1.5 border-b border-[var(--border-default)] flex items-center gap-2 text-[11px] text-[var(--text-tertiary)]" data-testid="output-status-strip">
                {t('automations.output.stopped_at', 'Stopped {when}', { when })}
            </div>
        );
    }
    const token = tokenForStep(runStep);
    const Icon = token.icon;
    const duration = runStep.durationMs != null ? formatDuration(runStep.durationMs) : null;
    // How much came out, in the same words the connection chip uses.
    const summary = summariseData(stepPayload(stepType, runStep.output));
    // In a narrow column (NdvSideColumn's @container/ndvside) the column head
    // already says how much and how long, and the header pill that it worked:
    // the strip would be the third copy, in the height the table needs.
    return (
        <div className="px-3 py-1.5 border-b border-[var(--border-default)] flex items-center gap-2 text-[11px] @max-[560px]/ndvside:hidden" data-testid="output-status-strip">
            <Icon size={12} className={`${token.solid} ${token.spin ? 'animate-spin' : ''}`} />
            <span className={token.solid}>{statusLabel(t, token)}</span>
            {summary && <span className="text-[var(--text-primary)] font-medium">· {summary.label}</span>}
            {duration && <span className="text-[var(--text-tertiary)]">· {duration}</span>}
            {runStep.attempts != null && runStep.attempts > 1 && (
                <span className="text-[var(--text-tertiary)]">· {t('automations.output.attempts', '{count} attempts', { count: runStep.attempts })}</span>
            )}
        </div>
    );
}

function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60_000);
    const secs = Math.floor((ms % 60_000) / 1000);
    return `${mins}m ${secs}s`;
}

/**
 * True when two run-step records would render identically here: the same
 * bar as useAutomationBuilderStream's own dedup (BFSF-396). Duration is
 * bucketed to the second because a 'running' row has no output to compare
 * and its duration isn't displayed while running; a render every ~750ms poll
 * starved the spinner of paint frames.
 */
function runStepsRenderEqual(a: RunStepRecord | null | undefined, b: RunStepRecord | null | undefined): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.status !== b.status || a.error !== b.error || a.attempts !== b.attempts) return false;
    if (durationBucket(a.durationMs) !== durationBucket(b.durationMs)) return false;
    if (a.errorInfo !== b.errorInfo && !deepEqual(a.errorInfo, b.errorInfo)) return false;
    if (a.toolsWithheld !== b.toolsWithheld && !deepEqual(a.toolsWithheld, b.toolsWithheld)) return false;
    if (a.bindingWarnings !== b.bindingWarnings && !deepEqual(a.bindingWarnings, b.bindingWarnings)) return false;
    if (a.status === 'running') return true;
    return deepEqual(a.output, b.output);
}

function durationBucket(ms: number | null | undefined): number | null {
    return ms == null ? null : Math.floor(ms / 1000);
}

function propsAreEqual(prev: RunTabContainerProps, next: RunTabContainerProps): boolean {
    return prev.compact === next.compact
        && prev.step === next.step
        && prev.definition === next.definition
        && prev.describedSample === next.describedSample
        && prev.automationId === next.automationId
        && prev.onAddAfterStep === next.onAddAfterStep
        && prev.onRetryFromStep === next.onRetryFromStep
        && prev.onFixError === next.onFixError
        && runStepsRenderEqual(prev.runStep, next.runStep);
}

export default memo(RunTabContainer, propsAreEqual);
