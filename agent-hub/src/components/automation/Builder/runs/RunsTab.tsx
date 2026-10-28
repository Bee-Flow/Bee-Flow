import React, { useCallback, useState } from 'react';
import type { ComponentType } from 'react';
import type { RunListFilters } from '@/api/queries/automation/runs';
import { useInvalidateRuns, useRunList } from '@/api/queries/automation/runs';
import useRunStreamJs from '@/components/admin/Studio/Executions/useRunStream';
import ExecutionViewJs from '@/components/admin/Studio/Executions/ExecutionView';
import RunFilters from './RunFilters';
import RunList from './RunList';
import RunDetail from './RunDetail';
import RunCompare from './RunCompare';
import RunsLeftColumn from './RunsLeftColumn';
import { useRunsViews } from './useRunsViews';
import { useTranslation } from '@/hooks/useTranslation';

const useRunStream = useRunStreamJs;
// ExecutionView is plain JS whose defaults (`= null`) are all tsc can infer from.
const ExecutionView = ExecutionViewJs;

type RunStateReport = (patch: { runId: string | null; stepId: string | null }, opts: { replace: boolean }) => void;

export interface RunsTabProps {
    automationId: string;
    /** false while mounted but hidden: no fetching, no streaming. */
    active?: boolean;
    initialRunId?: string | null;
    initialStepId?: string | null;
    onRunStateChange?: RunStateReport;
    /** Back to the Editor; with a step id, open that step's drawer too. */
    onOpenEditor?: (stepId?: string | null) => void;
}

/**
 * The builder's Runs tab (handoff 5, artboard 5c): the list on the left, one
 * run on the right. Nothing is fetched until the tab is first shown, and it
 * stays mounted after that, so switching to the Editor and back keeps the
 * filters, the scroll and the open run.
 *
 * Widths follow the tab's own container: one pane below 960px, a 480px list
 * on a laptop so the run keeps its room, the designed 560px from 1400px. The
 * list never grows past that; every extra pixel goes to the run.
 */
export default function RunsTab(props: RunsTabProps) {
    const { active = true } = props;
    const [seen, setSeen] = useState(active);
    if (active && !seen) setSeen(true);
    if (!seen) return null;
    return <RunsTabBody {...props} active={active} />;
}

const DEFAULT_FILTERS: RunListFilters = { status: 'all', period: 168, q: '', showTests: true };

/** The open run and step, kept in step with the URL's ?run=&step=. */
function useOpenRun(initialRunId: string | null, initialStepId: string | null, report?: RunStateReport) {
    const [openRunId, setOpenRunId] = useState<string | null>(initialRunId);
    const [stepId, setStepId] = useState<string | null>(initialStepId);
    // Adopt deep-link CHANGES (Back/Forward moving ?run=/?step=).
    const [lastInitial, setLastInitial] = useState(initialRunId);
    if (initialRunId !== lastInitial) {
        setLastInitial(initialRunId);
        setOpenRunId(initialRunId);
        setStepId(initialRunId ? initialStepId : null);
    }
    const openRun = useCallback((runId: string) => {
        setOpenRunId(runId);
        setStepId(null);
        // PUSH, so Back closes the run again.
        report?.({ runId, stepId: null }, { replace: false });
    }, [report]);
    const closeRun = useCallback(() => {
        setOpenRunId(null);
        setStepId(null);
        report?.({ runId: null, stepId: null }, { replace: true });
    }, [report]);
    return { openRunId, stepId, setStepId, openRun, closeRun };
}

interface CanvasViewProps {
    runId: string;
    active: boolean;
    stepId: string | null;
    onSelectStep: (stepId: string | null) => void;
    onBack: () => void;
    onOpenEditor?: (stepId?: string | null) => void;
    onOpenRun: (runId: string) => void;
}

/** One run drawn on the canvas, with the way back to the Runs tab. */
function CanvasView({ runId, active, stepId, onSelectStep, onBack, onOpenEditor, onOpenRun }: CanvasViewProps) {
    return (
        <div className="h-full min-h-0 flex flex-col">
            <ExecutionView
                runId={runId}
                scope="automation"
                active={active}
                initialStepId={stepId}
                onSelectStep={onSelectStep}
                onBack={onBack}
                onOpenEditor={() => onOpenEditor?.(null)}
                onOpenAnotherRun={onOpenRun}
            />
        </div>
    );
}

function RunsTabBody({
    automationId, active = true, initialRunId = null, initialStepId = null, onRunStateChange, onOpenEditor,
}: RunsTabProps) {
    const { t } = useTranslation();
    const [filters, setFilters] = useState<RunListFilters>(DEFAULT_FILTERS);
    const { openRunId, stepId, setStepId, openRun, closeRun } = useOpenRun(initialRunId, initialStepId, onRunStateChange);
    const {
        canvasRunId, setCanvasRunId, section, setSection, compare, openFromList, compareGolden, compareRuns, closeCompare,
    } = useRunsViews(openRun);

    const list = useRunList(automationId, filters, active);
    const runs = list.data || [];
    // Nothing chosen yet: show the newest run without claiming it in the URL.
    const shownRunId = openRunId || runs[0]?.id || null;

    const invalidate = useInvalidateRuns();
    // Heartbeats say nothing new; every other event may change a row.
    useRunStream({ enabled: active, automationId, onEvent: (type) => { if (type !== 'step.heartbeat') invalidate(); } });

    const selectStep = useCallback((sid: string | null) => {
        setStepId(sid);
        onRunStateChange?.({ runId: shownRunId, stepId: sid }, { replace: true });
    }, [onRunStateChange, shownRunId, setStepId]);
    const showDetail = !!openRunId || !!compare;

    if (canvasRunId) {
        return (
            <CanvasView
                runId={canvasRunId}
                active={active}
                stepId={stepId}
                onSelectStep={selectStep}
                onBack={() => setCanvasRunId(null)}
                onOpenEditor={onOpenEditor}
                onOpenRun={openFromList}
            />
        );
    }

    return (
        <div className="h-full min-h-0 @container/runs">
            <div className="h-full min-h-0 grid grid-cols-1 @[960px]/runs:grid-cols-[480px_minmax(0,1fr)] @[1400px]/runs:grid-cols-[560px_minmax(0,1fr)] bg-[var(--bg-primary)]">
                <RunsLeftColumn
                    automationId={automationId}
                    active={active}
                    section={section}
                    onSection={setSection}
                    hiddenOnNarrow={showDetail}
                    onCompareGolden={compareGolden}
                    onOpenRun={openFromList}
                >
                    <RunFilters automationId={automationId} active={active} filters={filters} onChange={setFilters} onOpenRun={openFromList} />
                    <RunList
                        automationId={automationId}
                        runs={runs}
                        loading={list.isLoading}
                        failed={list.isError}
                        selectedRunId={shownRunId}
                        onOpenRun={openFromList}
                        onOpenEditor={onOpenEditor}
                    />
                </RunsLeftColumn>
                <section aria-label={t('runs.tab.detail_label', 'Run')} className={`min-h-0 flex-col ${showDetail ? 'flex' : 'hidden @[960px]/runs:flex'}`}>
                    {compare && <RunCompare runId={compare.a} otherRunId={compare.b} ignoredPaths={compare.ignored} onClose={closeCompare} onOpenRun={openFromList} />}
                    {!compare && shownRunId && (
                        <RunDetail
                            automationId={automationId}
                            runId={shownRunId}
                            seed={runs.find(r => r.id === shownRunId) || null}
                            active={active}
                            selectedStepId={stepId}
                            onSelectStep={selectStep}
                            onOpenRun={openFromList}
                            onOpenEditor={onOpenEditor}
                            onViewCanvas={() => setCanvasRunId(shownRunId)}
                            onClose={closeRun}
                            onCompare={(other) => compareRuns(shownRunId, other)}
                        />
                    )}
                </section>
            </div>
        </div>
    );
}
