/**
 * The steps of one run that followed a plan, inside the opened run of the item's history: the plan as it was approved
 * then, each step with how it went, its time, and (folded away) what it got or what it changed or sent.
 *
 * A run that followed no plan shows nothing here. A failure to read the steps costs this block and nothing else: the
 * run's result still renders.
 */
import { ListChecks } from 'lucide-react';
import CoworkPlanSteps from './CoworkPlanSteps';
import { useCoworkRunTrace } from '../../api/queries/coworkPlan';
import type { TranslateFn } from '../../hooks/useTranslation';
import type { CoworkRun } from '../../api/cowork.types';
import type { PlanRunTrace } from '../../api/coworkPlan.types';

const LABEL = 'text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]';

/** The steps as read; presentation only. */
export function RunTraceView({ trace, t }: { trace: PlanRunTrace; t: TranslateFn }) {
    return (
        <div data-testid="cowork-run-trace" className="flex flex-col gap-1 pb-2">
            <span className={`${LABEL} inline-flex items-center gap-1.5`}>
                <ListChecks aria-hidden="true" className="w-3.5 h-3.5" />
                {t('cowork_plan.trace.heading', 'The steps')}
                <span className="font-normal normal-case tracking-normal">{t('cowork_plan.trace.version', 'Followed the plan, version {version}', { version: trace.planVersion })}</span>
            </span>
            {!trace.recorded && (
                <p className="text-[12px] text-[var(--text-tertiary)]" data-testid="cowork-run-trace-not-recorded">
                    {t('cowork_plan.trace.not_recorded', 'The steps of this run were not recorded, or are no longer kept.')}
                </p>
            )}
            {trace.recorded && <CoworkPlanSteps steps={trace.steps} t={t} folded />}
        </div>
    );
}

function LoadedTrace({ coworkId, runId, t }: { coworkId: string; runId: string; t: TranslateFn }) {
    const { data, error } = useCoworkRunTrace(coworkId, runId);
    if (error) return <p className="pb-2 text-[12px] text-[var(--text-tertiary)]">{t('cowork_plan.trace.failed', 'The steps of this run could not be loaded.')}</p>;
    return data ? <RunTraceView trace={data} t={t} /> : null;
}

export default function CoworkRunTrace({ coworkId, run, t }: { coworkId: string; run: CoworkRun; t: TranslateFn }) {
    if (!run.planId) return null;
    return <LoadedTrace coworkId={coworkId} runId={run.id} t={t} />;
}
