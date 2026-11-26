/**
 * "Steps", in an opened task (./CoworkTaskView.tsx): what it does, in the order it runs.
 *
 *   - Fixed steps are the plan's, in RUN ORDER (server core/cowork/plan/planOrder.mts), with related reads and transformations
 *     grouped into expandable stages. Steps changed since the last approval are marked Changed. For the AI
 *     or an agent, what its last run did. Each step has its kind word (Reads, Changes, Sends to …, AI writes or
 *     decides) and its app, never a tool name. A step that sends names who receives it.
 *   - How it was tested, in plain words (what stopped a test only under "Technical details"); what it may read,
 *     change and send.
 *   - For fixed steps: "Test, sends nothing" (reads real data, changes and sends nothing) and "Compare with last
 *     month" (no app at all, ./CoworkTaskReplay.tsx).
 */
import CoworkTestProgress from './CoworkTestProgress';
import CoworkTaskFlow from './CoworkTaskFlow';
import { Check, TriangleAlert } from 'lucide-react';
import { triedLines } from '../coworkWiringModel';
import { canTry } from '../coworkPlanModel';
import { planMayDo, planSteps, runMayDo, runSteps, type MayDo, type TaskMode } from './coworkTaskModel';
import CoworkEffectPreview from './CoworkEffectPreview';
import CoworkTaskReplay from './CoworkTaskReplay';
import { TechnicalDetails } from './taskRows';
import { BTN_QUIET, Failure, META, ROW_ACTIONS } from './taskUi';
import { useCoworkPlanReplay } from '@/api/coworkReplay';
import type { CoworkRun } from '@/api/cowork.types';
import type { PlanState, PlanTryState } from '@/api/coworkPlan.types';
import type { TranslateFn } from '@/hooks/useTranslation';

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

function leadOf(mode: TaskMode, agentName: string | null, t: TranslateFn): string {
    if (mode === 'steps') return t('cowork_task.steps.lead_steps', 'Fixed steps, the same on every run, top to bottom.');
    if (mode === 'agent') return t('cowork_task.steps.lead_agent', "Your agent '{agent}' does this. This is what it did last time.", { agent: agentName ?? t('cowork_task.steps.an_agent', 'an agent') });
    return t('cowork_task.steps.lead_ai', 'The AI works out the steps on every run. This is what it did last time.');
}

interface Tested { line: string; ok: boolean; technical: string | null }

/** How it was tested: the test just made, else the last one the steps know of. */
function testedOf(mode: TaskMode, plan: PlanState | undefined, tryOut: TryOut, t: TranslateFn): Tested | null {
    if (mode !== 'steps' || tryOut.error) return null;
    const tryState = tryOut.state;
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
    requested?: 'test' | 'compare';
    controlsOnly?: boolean;
    onRebuild?: () => void;
    t: TranslateFn;
}

function TestAndCompare({ coworkId, plan, tryOut, live, titleOf, requested, t }: Pick<CoworkTaskStepsProps, 'requested' | 'coworkId' | 'tryOut' | 'live' | 't'> & { plan: PlanState; titleOf: (id: string) => string | null }) {
    const { start, started, state, error } = useCoworkPlanReplay(coworkId);
    const comparing = start.isPending || (!!started && !state?.done && !error);
    const test = <button type="button" className={BTN_QUIET} disabled={live || tryOut.starting || !canTry(plan)} onClick={tryOut.onStart}>{t('cowork_task.steps.test', 'Test, sends nothing')}</button>;
    const compare = <button type="button" className={BTN_QUIET} disabled={comparing} onClick={() => start.mutate()}>{t('cowork_task.steps.compare', 'Compare with last month')}</button>;
    return (
        <div className="flex flex-col gap-2">
            <div className={ROW_ACTIONS}>
                {requested !== 'compare' && test}
                {requested !== 'test' && compare}
            </div>
            {!requested && <p className={META}>{t('cowork_task.steps.both_safe', "Both are safe: a test reads real data but changes and sends nothing. A comparison runs today's steps on last month's runs and touches no app at all.")}</p>}
            <Failure error={tryOut.error || error} t={t} />
            {state && <CoworkTaskReplay state={state} titleOf={titleOf} onClose={() => start.reset()} t={t} />}
        </div>
    );
}

function NotebookRepair({ plan, live, onRebuild, t }: Pick<CoworkTaskStepsProps, 'plan' | 'live' | 'onRebuild' | 't'>) {
    if (!onRebuild || !plan?.draft?.findings.some((f) => f.code === 'step.chat_notebook')) return null;
    return <button type="button" className={BTN_QUIET} disabled={live} onClick={onRebuild}>
        {t('cowork_task.steps.replace_notebook', 'Rebuild and test for delivery in Cowork')}
    </button>;
}

function testInProgress(tryOut: TryOut) {
    return !tryOut.error && (tryOut.starting || (!!tryOut.state && !tryOut.state.done));
}

function RequestedOperation({ requested, plan, readOnly, tryOut, coworkId, live, t }: CoworkTaskStepsProps) {
    if (!plan?.draft || readOnly) return <p role="status">{t('cowork_task.steps.needs_plan', 'This requires a task with fixed steps.')}</p>;
    if (requested === 'test' && testInProgress(tryOut)) return <CoworkTestProgress state={tryOut.state} runOrder={plan.draft.view.runOrder} t={t}/>;
    if (requested === 'test' && !canTry(plan)) return <p role="status">{plan.draft.findings[0]?.message ?? t('cowork_task.steps.not_tested', 'Not tested yet: the steps cannot run as they are.')}</p>;
    const tested = requested === 'test' ? testedOf('steps', plan, tryOut, t) : null;
    const steps = planSteps(plan, t);
    return <div className="grid gap-3">
        {tested && <TestedLine tested={tested} t={t}/>}
        {requested === 'test' && tryOut.state?.done && <CoworkEffectPreview effects={tryOut.state.steps.filter(s => s.held && s.status !== 'not_reached')} t={t} />}
        <TestAndCompare requested={requested} plan={plan} coworkId={coworkId} live={live} tryOut={tryOut} titleOf={id => steps.find(step => id === step.id)?.title ?? null} t={t}/>
    </div>;
}

export default function CoworkTaskSteps(props: CoworkTaskStepsProps) {
    return props.requested ? <RequestedOperation {...props}/> : <TaskStepsOverview {...props}/>;
}

function TaskStepsOverview({ coworkId, mode, plan, latestRun, agentName, tryOut, live, readOnly, controlsOnly, onRebuild, t }: CoworkTaskStepsProps) {
    const fixed = mode === 'steps' && !!plan;
    const steps = fixed ? planSteps(plan, t) : runSteps(latestRun, t);
    const may = fixed ? planMayDo(plan, t) : runMayDo(steps);
    if (testInProgress(tryOut)) return <CoworkTestProgress state={tryOut.state} runOrder={plan?.draft?.view.runOrder} t={t} />;
    const tested = testedOf(mode, plan, tryOut, t);
    const titleOf = (id: string) => steps.find((s) => s.id === id)?.title ?? null;
    return (
        <div className="flex flex-col gap-3" data-testid="cowork-task-steps">
            {!controlsOnly && <><p className={META}>{leadOf(mode, agentName, t)}</p>
            {steps.length ? <CoworkTaskFlow steps={steps} t={t} /> : <p className={META}>{t('cowork_task.steps.none_yet', 'It has not run yet. After its first run you see here what it did.')}</p>}</>}
            <NotebookRepair plan={plan} live={live} onRebuild={onRebuild} t={t} />
            {tested && <TestedLine tested={tested} t={t} />}
            {tryOut.state?.done && <CoworkEffectPreview effects={tryOut.state.steps.filter((s) => s.held && s.status !== 'not_reached')} t={t} />}
            <MayList may={may} t={t} />
            {fixed && !readOnly && <TestAndCompare coworkId={coworkId} plan={plan} tryOut={tryOut} live={live} titleOf={titleOf} t={t} />}
        </div>
    );
}
