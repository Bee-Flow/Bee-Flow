/**
 * The plan of one Cowork item, as a card: its steps in order with what kind of work each is, what the plan may do,
 * and where it stands (never approved, approved, changed since, or not allowed to run and why).
 *
 * A plan does the fixed parts of recurring work without AI. The card says so in numbers ("4 fixed, 2 AI") and per
 * step, and marks the AI steps that read text someone outside wrote: those get no apps.
 *
 * Presentation only. What it shows comes in as props (./CoworkPlanPanel.tsx reads and acts), so the card can be
 * rendered with any plan.
 */
import { ListChecks, Lock, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import CoworkPlanKindTile, { KIND_FALLBACK } from './CoworkPlanKindTile';
import { appsByEffect, canApprove, makeUpParts, planStatusOf } from './coworkPlanModel';
import type { PlanStatus } from './coworkPlanModel';
import { fullTimestamp } from './coworkFormat';
import type { TranslateFn } from '../../hooks/useTranslation';
import type { PlanDraft, PlanEffect, PlanPermissions, PlanState, PlanStep, PlanStepChange, PlanStepKind } from '../../api/coworkPlan.types';

interface CoworkPlanCardProps {
    state: PlanState;
    t: TranslateFn;
    /** 'approve' or 'remove' while that request is on its way. */
    busy?: 'approve' | 'remove' | null;
    /** The sentence of a refused request. */
    error?: string | null;
    /** The try-out of this plan (./CoworkPlanTry.tsx), shown between the plan and what its owner can do with it. */
    tryOut?: ReactNode;
    /** The choice of how independent the approved plan may be (./CoworkIndependence.tsx). */
    independence?: ReactNode;
    /** What the planner said about the plan it just made: what it does each run, and what it could not do. */
    note?: string | null;
    onApprove: (fingerprint: string) => void;
    onRemove: () => void;
}

const COUNT_FALLBACK: Record<PlanStepKind, string> = { fixed: '{count} fixed', ai: '{count} AI', ask: '{count} for you to decide', deliver: '{count} result for you' };
const EFFECT_FALLBACK: Record<PlanEffect, string> = { reads: 'May read', writes: 'May change', sends: 'May send' };
const SENDS_FALLBACK: Record<PlanPermissions['sends'], string> = { none: 'Nothing leaves this plan', owner: 'Only to you', others: 'To other people' };

const LABEL = 'text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]';
const PILL = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] border-[var(--border-default)] text-[var(--text-secondary)]';
const SECONDARY = 'inline-flex items-center px-2.5 py-1.5 rounded-lg border text-[12px] font-medium disabled:opacity-50 border-[var(--border-default)] text-[var(--text-secondary)]';
const PRIMARY = 'inline-flex items-center px-2.5 py-1.5 rounded-lg text-[12px] font-medium disabled:opacity-50 bg-[var(--button-primary-bg)] text-[var(--button-primary-fg)]';

/** One small block per step: ink for a step done the same way every run, the AI blue for a step a model does. */
const SEGMENT: Record<PlanStepKind, string> = {
    fixed: 'bg-[var(--text-primary)]',
    deliver: 'bg-[var(--text-primary)]',
    ask: 'bg-[var(--warning)]',
    ai: 'bg-[var(--type-ai)]',
};

/** How much of every run needs no model: a block per step, and the count in words. */
function MakeUpBar({ draft, t }: { draft: PlanDraft; t: TranslateFn }) {
    const line = makeUpParts(draft.view.makeUp).map((p) => t(`cowork_plan.count.${p.kind}`, COUNT_FALLBACK[p.kind], { count: p.count })).join(', ');
    return (
        <div className="flex flex-col gap-1.5" data-testid="cowork-plan-makeup">
            <div className="flex gap-0.5 h-1.5" role="img" aria-label={line}>
                {draft.view.steps.map((step) => <span key={step.id} className={`w-4 rounded-sm ${SEGMENT[step.kind]}`} />)}
            </div>
            <span className="text-[12px] text-[var(--text-secondary)]">{line}</span>
        </div>
    );
}

const CHANGE_PILL = 'inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-medium border-[color-mix(in_srgb,var(--warning)_40%,transparent)] text-[var(--warning-ink)]';

/** "New" or "Changed" beside a step that differs from the approved plan. */
function ChangeMark({ change, t }: { change: PlanStepChange['change'] | undefined; t: TranslateFn }) {
    if (change === 'added') return <span className={CHANGE_PILL} data-testid="cowork-plan-step-change">{t('cowork_plan.step_change.added', 'New')}</span>;
    if (change === 'changed') return <span className={CHANGE_PILL} data-testid="cowork-plan-step-change">{t('cowork_plan.step_change.changed', 'Changed')}</span>;
    return null;
}

function StepRow({ step, change, t }: { step: PlanStep; change?: PlanStepChange['change']; t: TranslateFn }) {
    return (
        <li className={`flex items-start gap-2.5 py-1.5 ${step.depth > 0 ? 'pl-6' : ''}`} data-testid={`cowork-plan-step-${step.id}`}>
            <CoworkPlanKindTile kind={step.kind} />
            <span className="flex-1 min-w-0 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[13px] font-medium break-words text-[var(--text-primary)]">{step.title}</span>
                <span className={PILL}>{t(`cowork_plan.kind.${step.kind}`, KIND_FALLBACK[step.kind])}</span>
                <ChangeMark change={change} t={t} />
                {step.readsOutsideText && (
                    <span className={PILL} title={t('cowork_plan.outside_text_hint', 'This step reads text someone outside wrote, so the AI gets no apps here.')}>
                        <Lock aria-hidden="true" className="w-3 h-3" />
                        {t('cowork_plan.outside_text', 'Reads outside text')}
                    </span>
                )}
            </span>
        </li>
    );
}

/** What the plan may do: the apps it reads and changes, and who it can reach. Also what a template's plan may do (./CoworkTemplates.tsx). */
export function MayDo({ permissions, t }: { permissions: PlanPermissions; t: TranslateFn }) {
    const apps = appsByEffect(permissions);
    const nothing = t('cowork_plan.may.nothing', 'Nothing');
    const column = (effect: PlanEffect, lines: string[]) => (
        <div className="flex flex-col gap-0.5 min-w-[120px] flex-1" data-testid={`cowork-plan-may-${effect}`}>
            <span className={LABEL}>{t(`cowork_plan.may.${effect}`, EFFECT_FALLBACK[effect])}</span>
            {(lines.length > 0 ? lines : [nothing]).map((line) => (
                <span key={line} className="text-[12.5px] text-[var(--text-secondary)]">{line}</span>
            ))}
        </div>
    );
    const reach = [...apps.sends, t(`cowork_plan.may.sends_${permissions.sends}`, SENDS_FALLBACK[permissions.sends])];
    return (
        <div className="flex flex-wrap gap-4">
            {column('reads', apps.reads)}
            {column('writes', apps.writes)}
            {column('sends', reach)}
        </div>
    );
}

function statusLine(status: PlanStatus, state: PlanState, t: TranslateFn): string {
    const version = state.approved?.version ?? 0;
    switch (status) {
        case 'approved': return t('cowork_plan.status.approved', 'Approved, version {version}. Runs follow this plan.', { version });
        case 'changed': return t('cowork_plan.status.changed', 'The plan changed since you approved it. Runs still follow version {version}.', { version });
        case 'blocked': return t('cowork_plan.status.blocked', 'This plan cannot run as it is.');
        case 'gone': return t('cowork_plan.status.gone', 'The automation behind this plan is gone.');
        default: return t('cowork_plan.status.first', 'Not approved yet. It runs as a plan once you approve it.');
    }
}

/** What stops the plan, or what approving it adds: the sentences the server gave. */
function Notes({ heading, lines, tone }: { heading: string; lines: string[]; tone: 'error' | 'warning' }) {
    if (lines.length === 0) return null;
    const border = tone === 'error' ? 'border-[color-mix(in_srgb,var(--error)_40%,transparent)]' : 'border-[color-mix(in_srgb,var(--warning)_40%,transparent)]';
    return (
        <div className={`rounded-lg border px-3 py-2 flex flex-col gap-1 ${border}`}>
            <span className={LABEL}>{heading}</span>
            <ul className="list-disc pl-4 flex flex-col gap-0.5">
                {lines.map((line) => <li key={line} className="text-[12.5px] text-[var(--text-secondary)]">{line}</li>)}
            </ul>
        </div>
    );
}

/** The plan itself: its steps (marked where they differ from the approved plan), what it may do, and what stops it. */
function PlanBody({ draft, changed, stepChanges, t }: { draft: PlanDraft; changed: boolean; stepChanges: PlanStepChange[]; t: TranslateFn }) {
    const changeOf = new Map(changed ? stepChanges.map((c) => [c.id, c.change]) : []);
    const removed = changed ? stepChanges.filter((c) => c.change === 'removed').map((c) => c.title) : [];
    return (
        <>
            <ol className="flex flex-col">
                {draft.view.steps.map((step) => <StepRow key={step.id} step={step} change={changeOf.get(step.id)} t={t} />)}
            </ol>
            {removed.length > 0 && (
                <p className="text-[12px] text-[var(--text-secondary)]" data-testid="cowork-plan-steps-removed">
                    {t('cowork_plan.step_change.removed', 'Taken out since you approved it: {steps}', { steps: removed.join(', ') })}
                </p>
            )}
            <div className="flex flex-col gap-2 pt-2 border-t border-[var(--border-subtle)]">
                <span className="text-[12.5px] font-semibold text-[var(--text-primary)]">{t('cowork_plan.may.heading', 'What it may do')}</span>
                <MayDo permissions={draft.permissions} t={t} />
            </div>
            <Notes
                tone="error"
                heading={changed ? t('cowork_plan.findings.heading_changed', 'Why this change cannot be approved') : t('cowork_plan.findings.heading', 'Why it cannot run')}
                lines={draft.findings.map((f) => f.message)}
            />
        </>
    );
}

/** Approve the plan on screen (when it can be approved), or take the plan off. */
function PlanActions({ state, t, busy, onApprove, onRemove }: Pick<CoworkPlanCardProps, 'state' | 't' | 'onApprove' | 'onRemove'> & { busy: 'approve' | 'remove' | null }) {
    const fingerprint = canApprove(state) ? state.draft?.fingerprint : undefined;
    return (
        <div className="flex flex-wrap items-center gap-2">
            {fingerprint && (
                <button type="button" data-testid="cowork-plan-approve" className={PRIMARY} disabled={busy !== null} onClick={() => onApprove(fingerprint)}>
                    {busy === 'approve' ? t('cowork_plan.approving', 'Approving…') : t('cowork_plan.approve', 'Approve this plan')}
                </button>
            )}
            <button type="button" data-testid="cowork-plan-remove" className={SECONDARY} disabled={busy !== null} onClick={onRemove}>
                {t('cowork_plan.remove', 'Take the plan off')}
            </button>
        </div>
    );
}

/** Where the plan stands, with the moment it was approved when it is the approved one. */
function StatusLine({ status, state, t }: { status: PlanStatus; state: PlanState; t: TranslateFn }) {
    const approvedAt = status === 'approved' && state.approved?.approvedAt ? ` ${fullTimestamp(state.approved.approvedAt)}` : '';
    return (
        <p className="text-[12.5px] text-[var(--text-secondary)]" data-testid="cowork-plan-status">
            {statusLine(status, state, t)}{approvedAt}
        </p>
    );
}

/** What the planner said about the plan it just made. Its words are shown as text, never rendered. */
function PlannerNote({ note, t }: { note: string; t: TranslateFn }) {
    return (
        <p className="flex items-start gap-1.5 text-[12.5px] whitespace-pre-wrap break-words text-[var(--text-secondary)]" data-testid="cowork-plan-note">
            <Sparkles aria-hidden="true" className="mt-0.5 w-3.5 h-3.5 flex-shrink-0 text-[var(--type-ai)]" />
            <span><span className="font-medium text-[var(--text-primary)]">{t('cowork_plan.make.note_label', 'Cowork')}: </span>{note}</span>
        </p>
    );
}

export default function CoworkPlanCard({ state, t, busy = null, error = null, tryOut = null, independence = null, note = null, onApprove, onRemove }: CoworkPlanCardProps) {
    const status = planStatusOf(state);
    if (status === 'none') return null;
    const draft = state.draft;
    return (
        <section
            aria-label={t('cowork_plan.heading', 'The plan')}
            data-testid="cowork-plan"
            data-status={status}
            className="rounded-[10px] border px-[18px] py-4 flex flex-col gap-3 [background:var(--bg-card)] [border-color:var(--border-subtle)] [box-shadow:var(--shadow-sm)]"
        >
            <div className="flex flex-wrap items-start gap-3">
                <div className="flex items-center gap-1.5">
                    <ListChecks aria-hidden="true" className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
                    <h3 className={LABEL}>{t('cowork_plan.heading', 'The plan')}</h3>
                </div>
                {draft && <div className="ml-auto"><MakeUpBar draft={draft} t={t} /></div>}
            </div>
            <StatusLine status={status} state={state} t={t} />
            {note && <PlannerNote note={note} t={t} />}
            {draft && <PlanBody draft={draft} changed={status === 'changed'} stepChanges={state.stepChanges ?? []} t={t} />}
            {status === 'changed' && <Notes tone="warning" heading={t('cowork_plan.widens.heading', 'New compared with what you approved')} lines={state.widens} />}
            {tryOut}
            {independence}
            {error && <p role="alert" className="text-[12.5px] text-[var(--error-ink)]">{error}</p>}
            <PlanActions state={state} t={t} busy={busy} onApprove={onApprove} onRemove={onRemove} />
        </section>
    );
}
