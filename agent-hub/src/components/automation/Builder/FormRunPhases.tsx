import { AlertTriangle, CheckCircle2, Clock, Loader2, OctagonX } from 'lucide-react';
import React from 'react';
import FormSaveScenario from './FormSaveScenario';
import { FormEndingView } from '../../forms/PublicFormRenderer';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { RUN_PHASE_LABELS, type RunPhaseName } from './runs/runPhase';
import type { FormDef } from '../../forms/PublicFormRenderer.types';
import type { FormRunKind } from './formRunContract';

/**
 * The overlay's phases that ask nothing of the person: the chip, the working
 * screen, "still running", and the end of the journey. FormRunOverlay picks
 * one; the page and the approval have their own files.
 */

/** A phase's short name, from the run vocabulary (runPhase.ts), never a raw status. */
export function phaseLabel(t: TranslateFn, phase: RunPhaseName): string {
    const { labelKey, label } = RUN_PHASE_LABELS[phase];
    return t(labelKey, label);
}

const PRIMARY_BUTTON = 'px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--accent)] text-white hover:opacity-90';
const SECONDARY_BUTTON = 'px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]';

/** DRY RUN or LIVE TEST: what the answers do. A production run wears no chip. */
export function ModeChip({ runKind }: { runKind: FormRunKind | null }) {
    const { t } = useTranslation();
    if (runKind !== 'dry' && runKind !== 'live') return null;
    const dry = runKind === 'dry';
    return (
        <span
            data-testid="form-run-chip"
            className={`shrink-0 rounded-full px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${dry ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300' : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'}`}
        >
            {dry ? t('automation_testing.overlay.chip_dry', 'Dry run') : t('automation_testing.overlay.chip_live', 'Live test')}
        </span>
    );
}

export function WorkingPhase() {
    const { t } = useTranslation();
    return (
        <div className="py-12 text-center">
            <Loader2 size={20} className="mx-auto animate-spin text-[var(--text-tertiary)]" />
            <p className="mt-3 text-sm text-[var(--text-secondary)]">{t('automations.form_run_overlay.running_the_automation', 'Running the automation…')}</p>
            <p className="mt-1 text-[11px] text-[var(--text-tertiary)]">
                {t('automations.form_run_overlay.each_step_lights_up_on_the', 'Each step lights up on the canvas behind this.')}
            </p>
        </div>
    );
}

/** Still going after the follow budget, or no longer readable here: say where to look, never spin forever. */
export function SlowPhase({ reason, onRetry, onClose }: { reason: 'budget' | 'unreadable' | null; onRetry: () => void; onClose: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="py-10 text-center">
            <Clock size={20} className="mx-auto text-[var(--text-tertiary)]" />
            <p className="mt-3 text-sm text-[var(--text-primary)]">{t('automation_testing.overlay.slow_title', 'Still running')}</p>
            <p className="mt-1 text-[11px] text-[var(--text-tertiary)]">
                {reason === 'unreadable'
                    ? t('automation_testing.overlay.slow_unreadable', 'This window can no longer read the run. Follow it on the canvas or in Runs.')
                    : t('automation_testing.overlay.slow_budget', 'This is taking a while. Follow it on the canvas or in Runs.')}
            </p>
            <div className="mt-4 flex justify-center gap-2">
                <button type="button" onClick={onRetry} className={SECONDARY_BUTTON}>{t('automation_testing.overlay.check_again', 'Check again')}</button>
                <button type="button" onClick={onClose} className={PRIMARY_BUTTON}>{t('automation_testing.overlay.close', 'Close')}</button>
            </div>
        </div>
    );
}

interface EndPhaseProps {
    phase: 'done' | 'failed' | 'stopped';
    ending: FormDef | null;
    automationId: string | null | undefined;
    /** The journey's head, when this overlay answered at least one page of it: its answers can be kept. */
    scenarioRunId: string | null;
    onClose: () => void;
}

function EndHeadline({ phase }: { phase: 'failed' | 'stopped' }) {
    const { t } = useTranslation();
    const failed = phase === 'failed';
    const Icon = failed ? AlertTriangle : OctagonX;
    return (
        <>
            <Icon size={20} className={`mx-auto ${failed ? 'text-amber-500' : 'text-[var(--text-tertiary)]'}`} />
            <p className="mt-3 text-sm font-medium text-[var(--text-primary)]">{phaseLabel(t, failed ? 'failed' : 'cancelled')}</p>
            <p className="mt-1 text-[11px] text-[var(--text-tertiary)]">
                {failed
                    ? t('automation_testing.overlay.failed_text', 'The run stopped on an error. The canvas shows which step and why.')
                    : t('automation_testing.overlay.stopped_text', 'The run was stopped before it finished.')}
            </p>
        </>
    );
}

/** The journey ended: its closing page as the visitor sees it, what each step did, and keeping the answers. */
export function EndPhase({ phase, ending, automationId, scenarioRunId, onClose }: EndPhaseProps) {
    const { t } = useTranslation();
    const done = phase === 'done';
    return (
        <div className={ending && done ? 'py-2 text-center' : 'py-12 text-center'}>
            {done && ending && <FormEndingView form={ending} />}
            {done && !ending && (
                <>
                    <CheckCircle2 size={20} className="mx-auto text-emerald-500" />
                    <p className="mt-3 text-sm text-[var(--text-primary)]">{t('automations.form_run_overlay.the_automation_finished', 'The automation finished.')}</p>
                </>
            )}
            {!done && <EndHeadline phase={phase} />}
            <button type="button" onClick={onClose} className={`mt-4 ${done ? PRIMARY_BUTTON : SECONDARY_BUTTON}`}>
                {done
                    ? t('automations.form_run_overlay.see_what_each_step_did', 'See what each step did')
                    : t('automations.form_run_overlay.close_and_look_at_the_run', 'Close and look at the run')}
            </button>
            {scenarioRunId && <FormSaveScenario automationId={automationId} runId={scenarioRunId} partial={!done} />}
        </div>
    );
}
