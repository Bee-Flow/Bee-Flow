/**
 * "Steps", in an opened task (./CoworkTaskView.tsx): what it does, in the order it runs.
 *
 *   - Fixed steps are the plan's, in RUN ORDER (server core/cowork/plan/planOrder.mts), the steps that only reshape
 *     data folded behind "Show N in-between steps", a step changed since the last approval marked Changed. For the AI
 *     or an agent, what its last run did. Each step has its kind word (Reads, Changes, Sends to …, AI writes or
 *     decides) and its app, never a tool name. A step that sends names who receives it.
 *   - How it was tested, in plain words (what stopped a test only under "Technical details"); what it may read,
 *     change and send.
 *   - For fixed steps: "Test, sends nothing" (reads real data, changes and sends nothing) and "Compare with last
 *     month" (no app at all, ./CoworkTaskReplay.tsx).
 */
import { useState } from 'react';
import { Check, FileSearch, Hand, PenLine, Send, TriangleAlert } from 'lucide-react';
import { triedLines } from '../coworkWiringModel';
import { canTry } from '../coworkPlanModel';
import { planMayDo, planSteps, runMayDo, runSteps, stepWord, type MayDo, type TaskMode, type TaskStep } from './coworkTaskModel';
import CoworkTaskReplay from './CoworkTaskReplay';
import { Section, TechnicalDetails } from './taskRows';
import { BTN_LINK, BTN_QUIET, Failure, META, ROW_ACTIONS, TAG_WARN } from './taskUi';
import { useCoworkPlanReplay } from '@/api/coworkReplay';
import type { CoworkRun } from '@/api/cowork.types';
import type { PlanState, PlanTryState } from '@/api/coworkPlan.types';
import type { TranslateFn } from '@/hooks/useTranslation';

const TILE: Record<TaskStep['sort'], string> = {
    read: 'text-[var(--text-secondary)]',
    change: 'text-[var(--warning-ink)]',
    send: 'text-[var(--success-ink)]',
    ai: 'text-[var(--type-ai)]',
    ask: 'text-[var(--warning-ink)]',
};
const ICON = { read: FileSearch, change: PenLine, send: Send, ask: Hand } as const;
/** The tile of a step a model does: a mark, the same in every language (hidden from screen readers; the word below says it). */
const AI_MARK = 'AI';

function StepTile({ step }: { step: TaskStep }) {
    const base = 'w-8 h-8 rounded-[var(--radius-md)] border grid place-items-center flex-shrink-0 text-[12px] font-semibold';
    if (step.helper) return <span aria-hidden="true" className={`${base} border-[var(--border-subtle)] text-[var(--text-tertiary)]`}>·</span>;
    const tone = `${base} border-[var(--border-subtle)] bg-[var(--bg-tertiary)] ${TILE[step.sort]}`;
    if (step.sort === 'ai') return <span aria-hidden="true" className={tone}>{AI_MARK}</span>;
    const Icon = ICON[step.sort];
    return <span aria-hidden="true" className={tone}><Icon size={16} /></span>;
}

function StepItem({ step, t }: { step: TaskStep; t: TranslateFn }) {
    return (
        <li className="grid grid-cols-[32px_minmax(0,1fr)] gap-3 pb-3" data-testid="cowork-task-step" data-helper={step.helper ? 'yes' : 'no'}>
            <StepTile step={step} />
            <div className="min-w-0">
                <div className={`pt-1 flex flex-wrap items-center gap-2 text-[14px] ${step.helper ? 'font-normal text-[var(--text-secondary)]' : 'font-medium text-[var(--text-primary)]'}`}>
                    <span className="break-words">{step.title}</span>
                    {step.changed && <span className={TAG_WARN}>{t('cowork_task.steps.changed', 'Changed')}</span>}
                </div>
                <div className="text-[13px] text-[var(--text-tertiary)] break-words" data-testid="cowork-task-step-word">{stepWord(step, t)}{step.app ? ` · ${step.app}` : ''}</div>
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
        <dl aria-label={t('cowork_task.may.label', 'What this task may do')} className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1.5 m-0 text-[14px] px-4 py-3 rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-card)] text-[var(--text-primary)]" data-testid="cowork-task-may">
            {row(t('cowork_task.may.read', 'May read'), may.read)}
            {row(t('cowork_task.may.change', 'May change'), may.change)}
            {row(t('cowork_task.may.send', 'May send'), may.send)}
        </dl>
    );
}

/** "Show 3 in-between steps", "Hide in-between steps"; nothing without such steps. */
function BetweenToggle({ count, open, onToggle, t }: { count: number; open: boolean; onToggle: () => void; t: TranslateFn }) {
    if (count === 0) return null;
    const show = count === 1 ? t('cowork_task.steps.show_between_one', 'Show 1 in-between step') : t('cowork_task.steps.show_between', 'Show {count} in-between steps', { count });
    return (
        <div>
            <button type="button" className={BTN_LINK} aria-expanded={open} onClick={onToggle}>
                {open ? t('cowork_task.steps.hide_between', 'Hide in-between steps') : show}
            </button>
        </div>
    );
}

function leadOf(mode: TaskMode, agentName: string | null, t: TranslateFn): string {
    if (mode === 'steps') return t('cowork_task.steps.lead_steps', 'Fixed steps, the same on every run, top to bottom.');
    if (mode === 'agent') return t('cowork_task.steps.lead_agent', "Your agent '{agent}' does this. This is what it did last time.", { agent: agentName ?? t('cowork_task.steps.an_agent', 'an agent') });
    return t('cowork_task.steps.lead_ai', 'The AI works out the steps on every run. This is what it did last time.');
}

interface Tested { line: string; ok: boolean; technical: string | null }

/** How it was tested: the test just made, else the last one the steps know of. */
function testedOf(plan: PlanState | undefined, tryState: PlanTryState | null, t: TranslateFn): Tested | null {
    if (tryState?.done) {
        const failed = !!tryState.error || tryState.steps.some((s) => s.status === 'failed' || s.status === 'error');
        return failed
            ? { line: t('cowork_task.steps.test_failed', 'The test stopped at a step. Nothing was changed or sent.'), ok: false, technical: tryState.error }
            : { line: t('cowork_task.steps.test_passed', 'Tested just now on your real data. Nothing was changed or sent.'), ok: true, technical: null };
    }
    return lastTestOf(plan?.tried, !!plan?.upToDate, t);
}

/**
 * The last test the steps know of. What the server lists as wrong names steps in its own words (an error class, a
 * field in backticks), so it goes under "Technical details"; the line itself is whole without it. `approved`: the
 * steps on screen are the approved ones, so nothing waits for an approval the test could hold back.
 */
function lastTestOf(tried: PlanState['tried'], approved: boolean, t: TranslateFn): Tested | null {
    const lines = triedLines(tried, t);
    if (!tried || !lines) return null;
    const technical = lines.problems.length > 0 ? lines.problems.join('\n') : null;
    if (lines.tone === 'ok') return { line: lines.line, ok: true, technical: null };
    if (!tried.current) return { line: t('cowork_task.steps.test_stale', 'The steps changed since their last test. Test them again before you approve them.'), ok: false, technical };
    if (tried.status === 'failed') {
        const line = approved
            ? t('cowork_task.steps.test_failed', 'The test stopped at a step. Nothing was changed or sent.')
            : t('cowork_task.steps.last_test_failed', 'The last test did not pass, so these steps cannot be approved yet. Nothing was changed or sent.');
        return { line, ok: false, technical };
    }
    return { line: t('cowork_task.steps.not_tested', 'Not tested yet: the steps cannot run as they are.'), ok: false, technical };
}

function TestedLine({ tested, t }: { tested: Tested; t: TranslateFn }) {
    // A check only for a test that passed: a test that stopped is no tick.
    const Mark = tested.ok ? Check : TriangleAlert;
    return (
        <div className="flex flex-col gap-1" data-testid="cowork-task-tested">
            <p className={`flex items-start gap-2 text-[14px] ${tested.ok ? 'text-[var(--success-ink)]' : 'text-[var(--warning-ink)]'}`}>
                <Mark aria-hidden="true" size={16} className="mt-0.5 flex-shrink-0" /><span>{tested.line}</span>
            </p>
            <TechnicalDetails text={tested.technical} t={t} />
        </div>
    );
}

interface TryOut {
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
    /** Something is on the go: no new test now. */
    live: boolean;
    /** Someone else's task: the steps are shown, nothing is tested. */
    readOnly: boolean;
    t: TranslateFn;
}

function TestAndCompare({ coworkId, plan, tryOut, live, titleOf, t }: Pick<CoworkTaskStepsProps, 'coworkId' | 'tryOut' | 'live' | 't'> & { plan: PlanState; titleOf: (id: string) => string | null }) {
    const { start, state, error } = useCoworkPlanReplay(coworkId);
    const comparing = start.isPending || (state !== null && !state.done && !error);
    return (
        <div className="flex flex-col gap-2">
            <div className={ROW_ACTIONS}>
                <button type="button" className={BTN_QUIET} disabled={live || tryOut.starting || !canTry(plan)} onClick={tryOut.onStart}>{t('cowork_task.steps.test', 'Test, sends nothing')}</button>
                <button type="button" className={BTN_QUIET} disabled={comparing} onClick={() => start.mutate()}>{t('cowork_task.steps.compare', 'Compare with last month')}</button>
            </div>
            <p className={META}>{t('cowork_task.steps.both_safe', "Both are safe: a test reads real data but changes and sends nothing. A comparison runs today's steps on last month's runs and touches no app at all.")}</p>
            <Failure error={tryOut.error || error} t={t} />
            {state && <CoworkTaskReplay state={state} titleOf={titleOf} onClose={() => start.reset()} t={t} />}
        </div>
    );
}

export default function CoworkTaskSteps({ coworkId, mode, plan, latestRun, agentName, tryOut, live, readOnly, t }: CoworkTaskStepsProps) {
    const [between, setBetween] = useState(false);
    const fixed = mode === 'steps' && !!plan;
    const steps = fixed ? planSteps(plan, t) : runSteps(latestRun, t);
    const shown = between ? steps : steps.filter((s) => !s.helper);
    const may = fixed ? planMayDo(plan, t) : runMayDo(steps);
    const tested = mode === 'steps' ? testedOf(plan, tryOut.state, t) : null;
    const titleOf = (id: string) => steps.find((s) => s.id === id)?.title ?? null;
    return (
        <Section id="cowork-task-steps-h" heading={t('cowork_task.steps.heading', 'Steps')} testId="cowork-task-steps">
            <p className={META}>{leadOf(mode, agentName, t)}</p>
            {shown.length > 0
                ? <ol className="list-none m-0 p-0">{shown.map((step) => <StepItem key={step.id} step={step} t={t} />)}</ol>
                : <p className={META}>{t('cowork_task.steps.none_yet', 'It has not run yet. After its first run you see here what it did.')}</p>}
            <BetweenToggle count={steps.filter((s) => s.helper).length} open={between} onToggle={() => setBetween((v) => !v)} t={t} />
            {tested && <TestedLine tested={tested} t={t} />}
            <MayList may={may} t={t} />
            {fixed && !readOnly && <TestAndCompare coworkId={coworkId} plan={plan} tryOut={tryOut} live={live} titleOf={titleOf} t={t} />}
        </Section>
    );
}
