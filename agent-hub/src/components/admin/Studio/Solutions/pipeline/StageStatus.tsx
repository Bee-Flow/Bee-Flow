import { AlertTriangle } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { PROGRESS_STEPS, phaseOf, type Phase } from './pipelineModel';
import { Addresses, LastDeployment } from './StageStatusParts';
import { STAGE_DOT, STAGE_INK, STAGE_RULE, STAGE_TINT, useStageLabel } from './StageSwitcher';
import type { PipelineStage, StageKey } from './stagesApi';

export {
    StatusPill, ackText, blockTexts, errorText, findingText, footerLabels, kindLabel, outcomeText, statusLabel,
} from './stageText';

/**
 * The first thing on a UAT or Production stage: a status header (what runs here
 * now, as a dot and a sentence), then what happened last, whether something
 * waits for approval, and where the stage can be reached from outside.
 *
 * All of it but the addresses comes from the pipeline read SolutionDetail
 * already holds (no second fetch per stage). The addresses are the settings
 * read's `inbound` list; when that read fails the section says so rather than
 * printing "no addresses", because a stage with a webhook and a failed read
 * must not look like a stage without one.
 */

export interface StageStatusProps {
    solutionId: string;
    stage: StageKey;
    row: PipelineStage | undefined;
    /** Bumped by the parent when a deployment finished, so the addresses are read again. */
    refreshKey?: number;
}

const HEAD = 'text-[11px] font-medium uppercase tracking-wide mb-2 text-[var(--text-tertiary)]';

export default function StageStatus({ solutionId, stage, row, refreshKey = 0 }: StageStatusProps) {
    const { t } = useTranslation();
    const label = useStageLabel();
    if (!row) {
        return (
            <p className="px-3 py-2.5 rounded-[var(--radius-md)] text-sm bg-[var(--bg-secondary)] text-[var(--text-tertiary)]" data-testid="stage-status-missing">
                {t('solution_stages.stage_missing', 'This stage is not set up for this Solution.')}
            </p>
        );
    }
    const seq = row.currentRelease?.seq ?? null;
    const pending = row.pending;
    return (
        <div className="space-y-6" data-testid="stage-status" data-stage={stage}>
            <section className={`rounded-[var(--radius-lg)] border border-t-2 border-[var(--border-subtle)] p-4 lg:p-5 bg-[var(--bg-card)] ${STAGE_RULE[stage]} ${STAGE_TINT[stage]}`}>
                <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-3 min-w-0">
                        <span className={`inline-block w-3.5 h-3.5 rounded-full shrink-0 ${STAGE_DOT[stage]}`} aria-hidden="true" />
                        <div className="min-w-0">
                            <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-tertiary)]">
                                {t('solution_stages.status_running', 'Running now')}
                            </p>
                            <p className={`text-lg font-semibold ${STAGE_INK[stage]}`} data-testid="stage-status-release">
                                {seq === null
                                    ? t('solution_stages.nothing_deployed', 'Nothing deployed to {stage} yet', { stage: label(stage) })
                                    : t('solution_stages.release_n', 'Release {seq}', { seq })}
                            </p>
                        </div>
                    </div>
                    {!row.enabled && (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-[var(--bg-tertiary)] text-[var(--text-secondary)]" data-testid="stage-status-paused">
                            {t('solution_stages.stage_paused', 'Paused')}
                        </span>
                    )}
                </div>
                {row.bindingsPending && (
                    <p className="mt-3 flex items-start gap-2 text-[13px] text-[var(--text-primary)]" data-testid="stage-status-bindings-pending">
                        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-[var(--warning)]" aria-hidden="true" />
                        {t('solution_stages.settings_pending', 'Settings changed since the last deploy. They apply when this stage is deployed again.')}
                    </p>
                )}
            </section>

            {pending && (
                <section className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] border-l-2 border-l-[var(--warning)] p-4 bg-[var(--bg-card)]" data-testid="stage-status-pending">
                    <p className="text-sm font-medium text-[var(--text-primary)]">
                        {t('solution_stages.pending_title', 'Waiting for approval')}
                    </p>
                    <p className="text-[13px] text-[var(--text-secondary)] mt-1">
                        {pending.releaseSeq != null
                            ? t('solution_stages.pending_body_release', 'Release {seq} goes live in {stage} once it is approved. Nothing has changed yet.', { seq: pending.releaseSeq, stage: label(stage) })
                            : t('solution_stages.pending_body', 'A change to {stage} goes live once it is approved. Nothing has changed yet.', { stage: label(stage) })}
                    </p>
                </section>
            )}

            <LastDeployment last={row.lastDeployment} stage={stage} />

            <section>
                <h3 className={HEAD}>{t('solution_stages.addresses', 'Addresses')}</h3>
                <Addresses solutionId={solutionId} stage={stage} refreshKey={refreshKey} />
            </section>
        </div>
    );
}

/** Preparing → Switching → Finishing, with the one we are in marked. */
export function DeploymentProgress({ status }: { status: string }) {
    const { t } = useTranslation();
    const phase = phaseOf(status);
    const at = PROGRESS_STEPS.indexOf(phase);
    const words: Record<Phase, string> = {
        awaiting: t('solution_stages.status_awaiting_approval', 'Waiting for approval'),
        preparing: t('solution_stages.phase_preparing', 'Preparing'),
        switching: t('solution_stages.phase_switching', 'Switching'),
        finishing: t('solution_stages.phase_finishing', 'Finishing'),
        done: t('solution_stages.status_succeeded', 'Succeeded'),
        stopped: t('solution_stages.status_failed', 'Failed'),
    };
    return (
        <ol className="flex items-center gap-2 text-xs flex-wrap" data-testid="deploy-progress" data-phase={phase}>
            {PROGRESS_STEPS.map((step, i) => {
                const done = phase === 'done' || (at >= 0 && i < at);
                const current = i === at;
                return (
                    <li
                        key={step}
                        aria-current={current ? 'step' : undefined}
                        data-state={done ? 'done' : current ? 'current' : 'todo'}
                        className={`px-2.5 py-1 rounded-full border whitespace-nowrap ${current
                            ? 'border-[var(--accent-primary)] text-[var(--text-primary)] font-semibold'
                            : done ? 'border-[var(--border-default)] text-[var(--text-secondary)]'
                                : 'border-[var(--border-default)] text-[var(--text-tertiary)]'}`}
                    >
                        {words[step]}
                    </li>
                );
            })}
        </ol>
    );
}
