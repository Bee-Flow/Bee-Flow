import { Check, Loader2 } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import Modal from '../../../../shared/Modal';
import { PlanView, ROW } from './DeployPlanView';
import {
    ackKey, acksOf, errorKind, outcomeOf, submitBlocks, type ErrorKind, type SubmitBlock,
} from './pipelineModel';
import { DeploymentProgress, ackText, blockTexts, errorText, footerLabels, outcomeText } from './StageStatus';
import { useStageLabel } from './StageSwitcher';
import {
    deploy, getDeployment, isTerminal, missingFromError, newRequestKey, planDeployment, planFromError,
    type DeploymentKind, type DeploymentSummary, type Plan, type PlanAck, type StageKey,
} from './stagesApi';

/**
 * One dialog for deploy, promote, rollback and redeploy — it is always the same
 * question: "here is what this release does to this stage; go?".
 *
 * Built from the plan (POST …/plan, which writes nothing). The footer button
 * names the outcome ("Promote R7 to Production", "Request approval for R7") and
 * stays off until every reason in submitBlocks() is gone. Production also asks
 * for the Solution's name. The request key is made ONCE when the dialog opens
 * and reused for every retry from it, so a lost response replays the same
 * deployment instead of starting another.
 *
 * A 409 `plan_stale` is not an error to apologise for: the stage moved while
 * the dialog was open, so the plan the server sends back replaces the one on
 * screen, the ticks are cleared (they were given for another plan) and a
 * notice says what happened.
 */

export interface DeployRequest {
    stage: StageKey;
    kind: DeploymentKind;
    releaseId: string | null;
    releaseSeq: number | null;
}

export interface DeployDialogProps {
    open: boolean;
    solutionId: string;
    solutionName: string;
    request: DeployRequest;
    onClose: () => void;
    onOpenSettings?: (stage: StageKey) => void;
    /** Progress is polled this often. */
    pollMs?: number;
}


// ── The flow: plan, acknowledgements, submit, progress ───────────────────────

function useDeployFlow({ open, solutionId, request, pollMs }: { open: boolean; solutionId: string; request: DeployRequest; pollMs: number }) {
    const { stage, kind, releaseId } = request;
    const requestKey = useRef<string>(newRequestKey());
    const [plan, setPlan] = useState<Plan | null>(null);
    const [loading, setLoading] = useState(true);
    const [problem, setProblem] = useState<ErrorKind | null>(null);
    const [replanned, setReplanned] = useState(false);
    const [acked, setAcked] = useState<Set<string>>(new Set());
    const [missing, setMissing] = useState<Set<string>>(new Set());
    const [submitting, setSubmitting] = useState(false);
    const [deployment, setDeployment] = useState<DeploymentSummary | null>(null);

    const loadPlan = useCallback(async () => {
        setLoading(true);
        const res = await planDeployment(solutionId, stage, releaseId, kind);
        setLoading(false);
        setPlan(res.ok ? res.data : null);
        setProblem(res.ok ? null : errorKind(res));
    }, [solutionId, stage, releaseId, kind]);

    useEffect(() => {
        if (!open) return;
        requestKey.current = newRequestKey();
        setDeployment(null); setAcked(new Set()); setMissing(new Set()); setReplanned(false);
        loadPlan();
    }, [open, loadPlan]);

    // Progress: ask the deployment again until it has an end.
    useEffect(() => {
        if (!deployment || isTerminal(deployment.status)) return undefined;
        let stopped = false;
        let inFlight = false;
        const tick = async () => {
            if (inFlight) return;
            inFlight = true;
            const res = await getDeployment(solutionId, deployment.id);
            inFlight = false;
            if (!stopped && res.ok && res.data?.deployment) setDeployment(res.data.deployment);
        };
        const id = setInterval(tick, pollMs);
        return () => { stopped = true; clearInterval(id); };
    }, [deployment, solutionId, pollMs]);

    const toggle = (a: PlanAck) => setAcked(prev => {
        const next = new Set(prev);
        if (!next.delete(ackKey(a))) next.add(ackKey(a));
        return next;
    });

    const replan = async (res: Parameters<typeof planFromError>[0]) => {
        setAcked(new Set()); setReplanned(true);
        const fresh = planFromError(res);
        if (fresh) setPlan(fresh); else await loadPlan();
    };

    const submit = async () => {
        if (!plan) return;
        setSubmitting(true);
        setProblem(null);
        const res = await deploy(solutionId, stage, {
            releaseId: plan.release?.id ?? releaseId, kind, planHash: plan.planHash,
            requestKey: requestKey.current, acknowledgements: acksOf(plan),
        });
        setSubmitting(false);
        if (res.ok) { setDeployment(res.data.deployment); return; }
        const k = errorKind(res);
        if (k === 'plan_stale') { await replan(res); return; }
        if (k === 'acknowledgement_missing') setMissing(new Set(missingFromError(res).map(ackKey)));
        setProblem(k);
    };

    return { plan, loading, problem, replanned, acked, missing, submitting, deployment, toggle, submit };
}

function AckRow({ text, checked, flagged, onToggle }: { text: string; checked: boolean; flagged: boolean; onToggle: () => void }) {
    return (
        <label className={`flex items-start gap-2 ${ROW} ${flagged ? 'ring-1 ring-[var(--error)]' : ''}`}>
            <input type="checkbox" className="mt-0.5 w-4 h-4 accent-[var(--accent-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]" checked={checked} onChange={onToggle} />
            <span>{text}</span>
        </label>
    );
}

interface FooterProps {
    deployed: boolean; blocks: SubmitBlock[]; loading: boolean; submitting: boolean; label: string;
    onSubmit: () => void; onClose: () => void;
}

function DeployFooter({ deployed, blocks, loading, submitting, label, onSubmit, onClose }: FooterProps) {
    const { t } = useTranslation();
    if (deployed) {
        return (
            <button type="button" onClick={onClose} data-testid="deploy-close" className="h-10 px-4 rounded-lg text-sm font-medium bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] focus-visible:ring-offset-2">
                {t('solution_stages.close', 'Close')}
            </button>
        );
    }
    return (
        <div className="flex flex-wrap items-center gap-3 w-full justify-end">
            {blocks.length > 0 && !loading && <span className="text-xs text-[var(--text-tertiary)] mr-auto basis-full sm:basis-auto" data-testid="deploy-block-hint">{blockTexts(t)[blocks[0]]}</span>}
            <button type="button" onClick={onClose} className="h-10 px-3 rounded-lg text-sm border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-card-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]">
                {t('solution_stages.cancel', 'Not now')}
            </button>
            <button
                type="button" onClick={onSubmit} disabled={blocks.length > 0 || submitting} data-testid="deploy-submit"
                className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg text-sm font-medium disabled:opacity-50 bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] focus-visible:ring-offset-2"
            >
                {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
                {label}
            </button>
        </div>
    );
}

type StepState = 'done' | 'current' | 'todo';

/** Review changes / Checks / Confirm: where the dialog is, as text plus a marker. */
function Stepper({ steps }: { steps: { id: string; label: string; state: StepState }[] }) {
    const { t } = useTranslation();
    return (
        <ol className="flex items-center gap-2 text-xs" data-testid="deploy-stepper" aria-label={t('studio_misc.deploy.steps', 'Steps')}>
            {steps.map((st, i) => (
                <li
                    key={st.id} data-step={st.id} data-state={st.state}
                    aria-current={st.state === 'current' ? 'step' : undefined}
                    className={`flex items-center gap-1.5 ${st.state === 'todo' ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]'} ${st.state === 'current' ? 'font-semibold' : ''}`}
                >
                    {i > 0 && <span className="w-4 sm:w-8 h-px bg-[var(--border-default)]" aria-hidden="true" />}
                    <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[11px] tabular-nums ${st.state === 'done' ? 'bg-[var(--success)] text-[var(--bg-primary)]' : st.state === 'current' ? 'bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]' : 'bg-[var(--bg-tertiary)]'}`} aria-hidden="true">
                        {st.state === 'done' ? <Check className="w-3 h-3" /> : i + 1}
                    </span>
                    {st.label}
                </li>
            ))}
        </ol>
    );
}

function DeployStatus({ flow, stage, seq }: { flow: ReturnType<typeof useDeployFlow>; stage: StageKey; seq: number | string }) {
    const { t } = useTranslation();
    const stageName = useStageLabel();
    const { plan, deployment } = flow;
    return (
        <>
            {flow.loading && !plan && <div className="flex justify-center py-8" aria-busy="true"><Loader2 className="w-5 h-5 animate-spin text-[var(--text-tertiary)]" aria-label={t('solution_stages.loading', 'Loading…')} /></div>}
            {flow.problem && <p className={`${ROW} border-l-2 border-l-[var(--error)]`} role="alert" data-testid="deploy-problem" data-kind={flow.problem}>{errorText(t, flow.problem)}</p>}
            {flow.replanned && !deployment && (
                <p className={`${ROW} border-l-2 border-l-[var(--warning)]`} role="status" data-testid="deploy-replanned">
                    {t('solution_stages.replanned', 'The stage changed while this was open. This is the new plan; your ticks were cleared.')}
                </p>
            )}
            {deployment && (
                <div className="space-y-3" data-testid="deploy-tracking" data-status={deployment.status}>
                    <DeploymentProgress status={deployment.status} />
                    <p className={ROW} data-testid="deploy-outcome">{outcomeText(t, deployment, stageName(stage), seq)}</p>
                </div>
            )}
        </>
    );
}

function partName(plan: Plan | null, ref: string | null | undefined, fallback: string): string {
    if (!ref) return fallback;
    return plan?.parts.find(p => p.ref === ref)?.name || plan?.data.find(x => x.ref === ref)?.name || ref;
}

function buildSteps(t: ReturnType<typeof useTranslation>['t'], plan: Plan | null, blocked: boolean, deployed: boolean): { id: string; label: string; state: StepState }[] {
    const checksOpen = !!plan && (plan.blocking.length > 0 || blocked);
    let checks: StepState = 'done';
    if (!plan) checks = 'todo'; else if (checksOpen) checks = 'current';
    return [
        { id: 'review', label: t('solution_stages.step_review', 'Review changes'), state: plan ? 'done' : 'current' },
        { id: 'checks', label: t('solution_stages.step_checks', 'Checks'), state: checks },
        { id: 'confirm', label: t('solution_stages.step_confirm', 'Confirm'), state: deployed ? 'done' : plan && !checksOpen ? 'current' : 'todo' },
    ];
}

export default function DeployDialog({ open, solutionId, solutionName, request, onClose, onOpenSettings, pollMs = 2000 }: DeployDialogProps) {
    const { t } = useTranslation();
    const stageName = useStageLabel();
    const { stage, kind } = request;
    const flow = useDeployFlow({ open, solutionId, request, pollMs });
    const { plan, deployment, acked, missing } = flow;
    const [typed, setTyped] = useState('');
    const blocks = submitBlocks({ plan, acked, typedName: typed, solutionName, stage });
    const seq = request.releaseSeq ?? plan?.release?.seq ?? '';

    const nameOf = (ref?: string | null): string => partName(plan, ref, stageName(stage));
    const ackBox = (a: PlanAck) => (
        <AckRow key={ackKey(a)} text={ackText(t, a, nameOf(a.ref))} checked={acked.has(ackKey(a))} flagged={missing.has(ackKey(a))} onToggle={() => flow.toggle(a)} />
    );

    const steps = buildSteps(t, plan, blocks.length > 0, !!deployment);

    const footer = (
        <DeployFooter
            deployed={!!deployment} blocks={blocks} loading={flow.loading} submitting={flow.submitting}
            label={footerLabels(t, seq)[outcomeOf(plan, stage, kind)]} onSubmit={flow.submit} onClose={onClose}
        />
    );

    return (
        <Modal
            open={open} onClose={onClose} size="lg" footer={footer} data-testid="deploy-dialog"
            title={t('solution_stages.dialog_title', '{stage}: release {seq}', { stage: stageName(stage), seq })}
            description={plan?.from?.seq != null ? t('solution_stages.dialog_from', 'Now running: release {seq}.', { seq: plan.from.seq }) : undefined}
        >
            <div className="space-y-4" data-testid="deploy-body">
                <Stepper steps={steps} />
                <DeployStatus flow={flow} stage={stage} seq={seq} />
                {!deployment && plan && (
                    <PlanView plan={plan} stage={stage} solutionName={solutionName} typed={typed} onTyped={setTyped} ackBox={ackBox} onOpenSettings={onOpenSettings} />
                )}
            </div>
        </Modal>
    );
}
