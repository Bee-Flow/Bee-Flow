import { useMemo } from 'react';
import { Copy as CopyIcon } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import OutputView from '../OutputView';
import ErrorCard, { type ErrorFix, type StepErrorInfo } from '../output/ErrorCard';
import ExpectedFields from '../output/ExpectedFields';
import { appendKey } from '@shared/expr/path.mjs';
import { routeNoteOf, routeOutputsOf, type RouteContext } from '../output/routeNote';
import RunNote from '../output/RunNote';
import { smartRowsOf } from '../output/SmartOutput';
import UsedBy, { type NextSuggestion } from '../output/UsedBy';
import { looksLikeFileRows, type UsedByEntry } from '../output/usedBy';
import WithheldTools, { withheldRunTools } from '../output/WithheldTools';
import BindingWarnings from '../runs/BindingWarnings';
import { bindingWarningsOf } from '../runs/bindingMisses';

export interface StepOutputTabProps {
    /** Current step id (the base of every copied path). */
    stepId?: string | null;
    stepLabel?: string | null;
    /** Output from the most recent run (any JSON), or null. */
    liveOutput: unknown;
    /** Top-level error message from the run, if any. */
    error?: string | null;
    /** The server's plain-language reading of that error. */
    errorInfo?: StepErrorInfo | null;
    /** Short "what to do next" hint for the error, if any. */
    remediation?: string | null;
    onCopyPath?: ((path: string) => void) | null;
    /**
     * Drop the standing hint footer. The quick dialog stacks this under the
     * settings in a few hundred pixels; a permanent line of advice there costs
     * more than it teaches.
     */
    compact?: boolean;
    /** What the step promises to return: shown while nothing real is known. */
    describedSample?: unknown;
    /** Later steps reading this output; undefined = do not show "Used by". */
    usedBy?: UsedByEntry[];
    /** Columns the table suggests by default (a flatten's ids). */
    promote?: readonly string[];
    onAddAfter?: ((suggestion: NextSuggestion) => void) | null;
    onRetry?: (() => void) | null;
    onFix?: ((fix: ErrorFix, info: StepErrorInfo | null) => boolean | void) | null;
    /** Where this step's column choice is remembered. */
    columnsKey?: string | null;
    /** The run-step row's `toolsWithheld`: tools this AI step was not given. */
    toolsWithheld?: unknown;
    /** The run-step row's `bindingWarnings`: the mappings that found nothing while it ran. */
    bindingWarnings?: unknown;
    /** Step id → label, so a warning names the step it read from, not its id. */
    stepLabelById?: Map<string, string> | null;
    /** Step id → type, so a path into a Condition's outputs names the output. */
    stepTypeById?: Map<string, string> | null;
    /**
     * The step works through a list as a Condition: its unit and outputs, so
     * the output opens with "Kept 3 of 4 messages" or the per-output split.
     */
    route?: RouteContext | null;
}

/** "Kept 3 of 4 messages" above a Condition's output; nothing for any other step. */
function RouteNoteLine({ value, route }: { value: unknown; route?: RouteContext | null }) {
    if (!route || !routeNoteOf(value, route)) return null;
    return (
        <div className="shrink-0 px-1 text-xs">
            <RunNote value={value} route={route} />
        </div>
    );
}

/**
 * The "Continues on" column's body (artboards 4a/4b): why the step stopped
 * and how to fix it, what it returned (a list as a table with useful
 * columns), what it WILL return while nothing has run, and which later steps
 * use it, or what to do with it when none does.
 */
export default function StepOutputTab({
    stepId = null, stepLabel = null, liveOutput, error = null, errorInfo = null, remediation = null,
    onCopyPath = null, compact = false, describedSample = null, usedBy, onAddAfter = null,
    onRetry = null, onFix = null, columnsKey = null, toolsWithheld = null, bindingWarnings = null,
    stepLabelById = null, stepTypeById = null, route, promote,
}: StepOutputTabProps) {
    const { t } = useTranslation();
    const basePath = stepId ? `steps.${stepId}.output` : '';
    const hasOutput = liveOutput !== null && liveOutput !== undefined;
    const failed = !!(error || errorInfo);
    const rows = useMemo(() => smartRowsOf(liveOutput), [liveOutput]);
    const usedFields = useMemo(() => (usedBy || []).flatMap(e => e.leaves), [usedBy]);
    const showExpected = !hasOutput && describedSample != null;
    const withheld = useMemo(() => withheldRunTools(toolsWithheld), [toolsWithheld]);
    const misses = useMemo(() => bindingWarningsOf(bindingWarnings), [bindingWarnings]);
    // A list switch's record is the runner's filing (mode, branch, counts):
    // the panel shows its outputs instead, at their own path, and the route
    // note above says the counts (P2).
    const outputs = useMemo(() => routeOutputsOf(liveOutput, route), [liveOutput, route]);
    const shown = outputs ?? liveOutput;
    const shownPath = outputs && basePath ? appendKey(basePath, 'matchesByCase') : basePath;

    // `flex-1` so this sizes as a flex ITEM of its (flex) parent: in the
    // compact dialog that parent only carries a max-height, so `h-full` alone
    // resolves to `auto` and nothing ever clamps the output (BFSF-386).
    return (
        <div className="flex-1 flex flex-col h-full min-h-0">
            <div className="flex-1 min-h-0 flex flex-col gap-3 px-2 py-2 overflow-y-auto custom-scrollbar">
                {failed && (
                    <ErrorCard info={errorInfo} error={error} remediation={remediation} onRetry={onRetry} onFix={onFix} />
                )}
                {/* Above the output: an input that came up empty explains an
                    output that looks wrong, and often the error above it. */}
                <BindingWarnings warnings={misses} labelById={stepLabelById} typeById={stepTypeById} />
                <RouteNoteLine value={liveOutput} route={route} />
                {hasOutput && (
                    <div className="flex-1 min-h-[160px] flex flex-col">
                        <OutputView
                            fill
                            fieldsView
                            allowExpand
                            smartTable
                            value={shown}
                            basePath={shownPath}
                            onCopyPath={onCopyPath}
                            columnsKey={columnsKey}
                            usedFields={usedFields}
                            promote={promote}
                            stepLabel={stepLabel}
                            emptyMessage={t('automations.output.none_recorded', 'No output recorded yet. Run or dry-run this step to capture one.')}
                        />
                    </div>
                )}
                {showExpected && <ExpectedFields sample={describedSample} />}
                {!hasOutput && !showExpected && !failed && (
                    <div className="text-[11px] text-[var(--text-tertiary)] italic px-1">
                        {t('automations.output.none_recorded', 'No output recorded yet. Run or dry-run this step to capture one.')}
                    </div>
                )}
                <WithheldTools tools={withheld} />
                {usedBy && !compact && (
                    <div className="shrink-0">
                        <UsedBy entries={usedBy} isList={!!rows} fileRows={!!rows && looksLikeFileRows(rows)} onAddAfter={onAddAfter} />
                    </div>
                )}
            </div>
            {/* A standing hint: one line at most, and none in a narrow column
                (NdvSideColumn's @container/ndvside), where it cost a table row. */}
            {!compact && hasOutput && (
                <footer
                    className="shrink-0 px-3 py-1.5 border-t border-[var(--border-default)] text-[10px] text-[var(--text-tertiary)] flex items-center gap-1.5 min-w-0 @max-[560px]/ndvside:hidden"
                    title={t('automations.output.footer_hint', 'Fields is the glance. Switch to Table for a record set, or to JSON to search the whole structure and copy a field’s path.')}
                >
                    <CopyIcon size={10} className="shrink-0" />
                    <span className="truncate">{t('automations.output.footer_hint', 'Fields is the glance. Switch to Table for a record set, or to JSON to search the whole structure and copy a field’s path.')}</span>
                </footer>
            )}
        </div>
    );
}
