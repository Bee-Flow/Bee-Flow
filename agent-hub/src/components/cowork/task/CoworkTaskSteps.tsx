/**
 * "Steps", in an opened task (./CoworkTaskView.tsx): what it does, in the order it runs.
 *
 *   - Fixed steps are the plan's, in RUN ORDER (server core/cowork/plan/planOrder.mts), the steps that only reshape
 *     data folded behind "Show N helper steps", a step changed since the last approval marked Changed. For the AI or
 *     an agent, what its last run did. Each step has its kind word (Reads, Changes, Sends, AI writes or decides) and
 *     its app, never a tool name.
 *   - How it was tested, in plain words; what it may read, change and send.
 *   - For fixed steps: Try it now (reads real data, changes and sends nothing) and Replay on last month (no app at all,
 *     ./CoworkTaskReplay.tsx).
 */
import { useState } from 'react';
import { Check, FileSearch, Hand, PenLine, Send } from 'lucide-react';
import { triedLines } from '../coworkWiringModel';
import { canTry } from '../coworkPlanModel';
import { planMayDo, planSteps, runMayDo, runSteps, stepWord, type MayDo, type TaskMode, type TaskStep } from './coworkTaskModel';
import CoworkTaskReplay from './CoworkTaskReplay';
import { BTN_LINK, BTN_QUIET, Failure, META, ROW_ACTIONS, SECTION_H, TAG_WARN } from './taskUi';
import { useCoworkPlanReplay } from '@/api/coworkReplay';
import type { CoworkRun } from '@/api/cowork.types';
import type { PlanState, PlanTryState } from '@/api/coworkPlan.types';
import type { TranslateFn } from '@/hooks/useTranslation';

const TILE: Record<TaskStep['sort'], string> = {
    read: 'bg-[var(--surface-2)] text-[var(--text-secondary)]',
    change: 'bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning-ink)]',
    send: 'bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success-ink)]',
    ai: 'bg-[color-mix(in_srgb,var(--type-ai)_14%,transparent)] text-[var(--type-ai)]',
    ask: 'bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning-ink)]',
};
const ICON = { read: FileSearch, change: PenLine, send: Send, ask: Hand } as const;
/** The tile of a step a model does: a mark, the same in every language (hidden from screen readers; the word below says it). */
const AI_MARK = 'AI';

function StepTile({ step }: { step: TaskStep }) {
    const base = 'w-8 h-8 rounded-[10px] grid place-items-center flex-shrink-0 text-[11px] font-extrabold';
    if (step.helper) return <span aria-hidden="true" className={`${base} border border-dashed border-[var(--border-default)] text-[var(--text-tertiary)]`}>·</span>;
    if (step.sort === 'ai') return <span aria-hidden="true" className={`${base} ${TILE.ai}`}>{AI_MARK}</span>;
    const Icon = ICON[step.sort];
    return <span aria-hidden="true" className={`${base} ${TILE[step.sort]}`}><Icon className="w-4 h-4" /></span>;
}

function StepItem({ step, t }: { step: TaskStep; t: TranslateFn }) {
    return (
        <li className="grid grid-cols-[32px_minmax(0,1fr)] gap-3 pb-3.5" data-testid="cowork-task-step" data-helper={step.helper ? 'yes' : 'no'}>
            <StepTile step={step} />
            <div className="min-w-0">
                <div className={`pt-[5px] flex flex-wrap items-center gap-2 ${step.helper ? 'font-medium text-[var(--text-secondary)]' : 'font-semibold text-[var(--text-primary)]'}`}>
                    <span className="break-words">{step.title}</span>
                    {step.changed && <span className={TAG_WARN}>{t('cowork_task.steps.changed', 'Changed')}</span>}
                </div>
                <div className="text-[14px] text-[var(--text-tertiary)]">{stepWord(step, t)}{step.app ? ` · ${step.app}` : ''}</div>
            </div>
        </li>
    );
}

function MayList({ may, t }: { may: MayDo; t: TranslateFn }) {
    const nothing = t('cowork_task.may.nothing', 'Nothing');
    const row = (label: string, list: string[]) => (
        <>
            <dt className="text-[var(--text-tertiary)]">{label}</dt>
            <dd className="m-0 min-w-0 break-words">{list.length > 0 ? list.join(', ') : nothing}</dd>
        </>
    );
    return (
        <dl aria-label={t('cowork_task.may.label', 'What this task may do')} className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3.5 gap-y-1.5 m-0 text-[14px] px-4 py-3.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-card)] text-[var(--text-primary)]" data-testid="cowork-task-may">
            {row(t('cowork_task.may.read', 'May read'), may.read)}
            {row(t('cowork_task.may.change', 'May change'), may.change)}
            {row(t('cowork_task.may.send', 'May send'), may.send)}
        </dl>
    );
}

/** "Show 3 helper steps", "Hide helper steps"; nothing without helper steps. */
function HelperToggle({ count, open, onToggle, t }: { count: number; open: boolean; onToggle: () => void; t: TranslateFn }) {
    if (count === 0) return null;
    const show = count === 1 ? t('cowork_task.steps.show_helper', 'Show 1 helper step') : t('cowork_task.steps.show_helpers', 'Show {count} helper steps', { count });
    return (
        <button type="button" className={BTN_LINK} aria-expanded={open} onClick={onToggle}>
            {open ? t('cowork_task.steps.hide_helpers', 'Hide helper steps') : show}
        </button>
    );
}

function leadOf(mode: TaskMode, agentName: string | null, t: TranslateFn): string {
    if (mode === 'steps') return t('cowork_task.steps.lead_steps', 'Fixed steps, the same on every run, top to bottom.');
    if (mode === 'agent') return t('cowork_task.steps.lead_agent', "Your agent '{agent}' does this. This is what it did last time.", { agent: agentName ?? t('cowork_task.steps.an_agent', 'an agent') });
    return t('cowork_task.steps.lead_ai', 'The AI works out the steps on every run. This is what it did last time.');
}

/** How it was tested: the try-out just made, else the last one the plan knows of. */
function testedLine(plan: PlanState | undefined, tryState: PlanTryState | null, t: TranslateFn): { line: string; ok: boolean } | null {
    if (tryState?.done) {
        const failed = !!tryState.error || tryState.steps.some((s) => s.status === 'failed' || s.status === 'error');
        return failed
            ? { line: t('cowork_task.steps.try_failed', 'The try stopped: {reason} Nothing was changed or sent.', { reason: tryState.error ?? t('cowork_task.steps.a_step_failed', 'a step failed.') }), ok: false }
            : { line: t('cowork_task.steps.try_passed', 'Tried just now on your real data. Nothing was changed or sent.'), ok: true };
    }
    const tried = triedLines(plan?.tried, t);
    return tried ? { line: tried.line, ok: tried.tone === 'ok' } : null;
}

export interface TryOut {
    state: PlanTryState | null;
    starting: boolean;
    error: unknown;
    onStart: () => void;
}

interface CoworkTaskStepsProps {
    coworkId: string;
    mode: TaskMode;
    plan: PlanState | undefined;
    latestRun: CoworkRun | null;
    agentName: string | null;
    tryOut: TryOut;
    /** Something is on the go: no new try-out now. */
    live: boolean;
    /** Someone else's task: the steps are shown, nothing is tried. */
    readOnly: boolean;
    t: TranslateFn;
}

function TryAndReplay({ coworkId, plan, tryOut, live, titleOf, t }: Pick<CoworkTaskStepsProps, 'coworkId' | 'tryOut' | 'live' | 't'> & { plan: PlanState; titleOf: (id: string) => string | null }) {
    const { start, state, error } = useCoworkPlanReplay(coworkId);
    const replaying = start.isPending || (state !== null && !state.done && !error);
    return (
        <div className="flex flex-col gap-2">
            <div className={ROW_ACTIONS}>
                <button type="button" className={BTN_QUIET} disabled={live || tryOut.starting || !canTry(plan)} onClick={tryOut.onStart}>{t('cowork_task.steps.try', 'Try it now')}</button>
                <button type="button" className={BTN_QUIET} disabled={replaying} onClick={() => start.mutate()}>{t('cowork_task.steps.replay', 'Replay on last month')}</button>
            </div>
            <p className={META}>{t('cowork_task.steps.safe', 'Both are safe: a try reads real data but changes and sends nothing. A replay touches no app at all.')}</p>
            <Failure error={tryOut.error || error} t={t} />
            {state && <CoworkTaskReplay state={state} titleOf={titleOf} onClose={() => start.reset()} t={t} />}
        </div>
    );
}

export default function CoworkTaskSteps({ coworkId, mode, plan, latestRun, agentName, tryOut, live, readOnly, t }: CoworkTaskStepsProps) {
    const [helpers, setHelpers] = useState(false);
    const steps = mode === 'steps' && plan ? planSteps(plan, t) : runSteps(latestRun, t);
    const helperCount = steps.filter((s) => s.helper).length;
    const shown = helpers ? steps : steps.filter((s) => !s.helper);
    const may = mode === 'steps' && plan ? planMayDo(plan, t) : runMayDo(steps);
    const tested = mode === 'steps' ? testedLine(plan, tryOut.state, t) : null;
    const titleOf = (id: string) => steps.find((s) => s.id === id)?.title ?? null;
    return (
        <section aria-labelledby="cowork-task-steps-h" className="flex flex-col gap-3.5" data-testid="cowork-task-steps">
            <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-3">
                    <h3 id="cowork-task-steps-h" className={SECTION_H}>{t('cowork_task.steps.heading', 'Steps')}</h3>
                    <HelperToggle count={helperCount} open={helpers} onToggle={() => setHelpers((v) => !v)} t={t} />
                </div>
                <p className={META}>{leadOf(mode, agentName, t)}</p>
            </div>
            {shown.length > 0
                ? <ol className="list-none m-0 p-0">{shown.map((step) => <StepItem key={step.id} step={step} t={t} />)}</ol>
                : <p className={META}>{t('cowork_task.steps.none_yet', 'It has not run yet. After its first run you see here what it did.')}</p>}
            {tested && (
                <p className={`flex items-start gap-2 text-[14px] ${tested.ok ? 'text-[var(--success-ink)]' : 'text-[var(--warning-ink)]'}`} data-testid="cowork-task-tested">
                    <Check aria-hidden="true" className="w-4 h-4 mt-[3px] flex-shrink-0" /><span>{tested.line}</span>
                </p>
            )}
            <MayList may={may} t={t} />
            {mode === 'steps' && plan && !readOnly && <TryAndReplay coworkId={coworkId} plan={plan} tryOut={tryOut} live={live} titleOf={titleOf} t={t} />}
        </section>
    );
}
