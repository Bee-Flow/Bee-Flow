import { useRef, useState } from 'react';
import { toast } from '../../shared/Toast';
import useFormOverlayAutoOpen from './flow/useFormOverlayAutoOpen';
import { runWithCallerNotice } from './callerNotice';
import { acknowledgeCallerNotice, fetchCallerNotice } from '@/api/queries/automation/callerNotice';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { runStartRefusal } from '@/api/queries/automation/runAccess';
import { GATEWAY_DROP, awaitRunAfterDrop } from '@/api/dryRun';
import { runOutcomeToast, toastStepLabel } from './runs/runOutcomeToast';
import { runPhase } from './runs/runPhase';
import { formSessionFor, isBareForm, isPrimary, stepStart, triggerById, triggerInput, type ExecuteRequest } from './runs/stepStart';
import type { BuilderTab } from './useBuilderTabUrl';
import type { Dispatch, SetStateAction } from 'react';
import type useAutomationApi from '@/hooks/useAutomationApi';
import type { AutomationApiError, RunStartBody, RunStartReply } from '@/hooks/useAutomationApi';
import type useAutomationBuilderStream from '@/hooks/useAutomationBuilderStream';
import type { ExecuteStepResult, SideEffectStep } from '@/hooks/automationBuilder/useRunControls';
import type useConfirm from '../../shared/useConfirm';
import type { FlowDefinition, FlowStep } from './flow/types';
import type { FormRunMode, FormRunStart, FormRunStartResult, FormTestSession } from './formRunContract';

type Stream = ReturnType<typeof useAutomationBuilderStream>;
type Confirm = ReturnType<typeof useConfirm>['confirm'];

export interface UseBuilderRunsOptions {
    api: Pick<ReturnType<typeof useAutomationApi>, 'run' | 'dryRun' | 'formTest'>;
    /** The run on the canvas, its rows and the step executing now. */
    state: Pick<Stream['state'], 'dryRun' | 'steps' | 'executingStepId'>;
    effectiveDef: FlowDefinition | null;
    executeStep: Stream['executeStep'];
    /** Follow a run by the id the server gave it; resolves when it first pauses or ends. */
    followRun: Stream['followRun'];
    /** Follow a journey (or its continuation) by any of its run ids. */
    continueRun: Stream['continueRun'];
    setRunResult: Stream['setRunResult'];
    ensureAutomationCreated: (defForCreate?: FlowDefinition | null) => Promise<string | undefined>;
    noteManagedRefusal: (e: unknown) => boolean;
    /** The shell's own busy flag (a start request, a save, an activate). */
    busy: boolean;
    setBusy: (busy: boolean) => void;
    setError: Dispatch<SetStateAction<string | null>>;
    confirm: Confirm;
    setTab: (tab: BuilderTab) => void;
}

/** Execute options as the canvas and the step editor hand them over (runs/stepStart.ts). */
export type { ExecuteRequest } from './runs/stepStart';

type ToastRun = Parameters<typeof runOutcomeToast>[1];

/** A trigger id from a handler argument: the hotkey hands over nothing, the split button a click event. */
function triggerIdArg(arg: unknown): string | null {
    return typeof arg === 'string' && arg ? arg : null;
}

/** A proxy or the network gave up between the browser and the server; the run may well go on. */
function isDrop(e: unknown): boolean {
    const status = e && typeof e === 'object' ? (e as AutomationApiError).status : undefined;
    return typeof status === 'number' ? GATEWAY_DROP.has(status) : e instanceof TypeError;
}

/** The steps a 409 side_effects_need_confirm names, by the labels on the canvas. */
function sideEffectNames(def: FlowDefinition | null | undefined, steps: SideEffectStep[]): string {
    const graph = [def?.trigger, ...(def?.triggers || []), ...(def?.steps || [])].filter(Boolean) as FlowStep[];
    return steps.map((s) => {
        const onCanvas = graph.find(g => g.id === s.stepId);
        return String(onCanvas?.label || s.label || s.tool || s.stepId);
    }).join(', ');
}

function confirmLive(confirm: Confirm, t: TranslateFn) {
    return confirm({
        title: t('automation_testing.run_live.confirm_title', 'Run this automation for real?'),
        description: t('automation_testing.run_live.confirm_description', 'Every step performs its action: sending messages, writing data, and anything else in the flow. Approvals in it go to you only.'),
        confirmLabel: t('automation_testing.run_live.confirm', 'Run it'),
        destructive: true,
    });
}

/**
 * The overlay's page one: the answers go through the form's own submission
 * path (POST /:id/form-test), so uploads are claimed, picks read and the
 * trigger carries the form's headers, as a visitor's run would (studio F8).
 */
async function sendFormTest(api: UseBuilderRunsOptions['api'], mode: FormRunMode, aid: string, body: RunStartBody, ask: { confirm: Confirm; t: TranslateFn; untilStepId?: string | null }): Promise<RunStartReply | null | 'declined'> {
    const form = {
        values: (body.triggerPayload || {}) as Record<string, unknown>,
        ...(body.triggerStepId ? { triggerStepId: body.triggerStepId } : {}),
        mode,
        // "Test step" on a step after a bare form: the run ends after that step.
        ...(ask.untilStepId ? { untilStepId: ask.untilStepId } : {}),
        respond: 'created' as const,
    };
    if (mode === 'dry') return api.formTest<RunStartReply>(aid, form);
    const started = await runWithCallerNotice<RunStartReply>(
        { run: (id, b) => api.formTest<RunStartReply>(id, b as typeof form), getCallerNotice: fetchCallerNotice, ackCallerNotice: acknowledgeCallerNotice },
        aid, form, ask.confirm, ask.t,
    );
    return started.declined ? 'declined' : started.result;
}

function confirmUpstream(confirm: Confirm, t: TranslateFn, names: string) {
    return confirm({
        title: t('automation_testing.execute_confirm.title', 'Run the earlier steps for real?'),
        description: t('automation_testing.execute_confirm.description', 'No earlier run has the output of {steps}, so they run first, and they send or write outside Bee Flow. Run them for real?', { steps: names }),
        confirmLabel: t('automation_testing.execute_confirm.confirm', 'Run them'),
        destructive: true,
    });
}

/**
 * Running the automation from the editor: ▶ Execute on one step, Dry run, the
 * confirmed Run live, and the form test overlay a form trigger opens instead.
 *
 * Every start asks the server to answer as soon as the run exists (respond
 * 'created'), and the canvas follows the run by that id (useFollowedRun); the
 * toast comes when the run pauses or ends, worded from its phase. A start
 * answers with what happened (declined, skipped, started with its id), never
 * with "done".
 *
 * One run at a time: while a start is in flight, a step executes, the followed
 * run is running or the form overlay is open, Dry run, Run live, the hotkey and
 * the header menu do nothing (`runBlocked`).
 */
export default function useBuilderRuns({
    api, state, effectiveDef, executeStep, followRun, continueRun, setRunResult,
    ensureAutomationCreated, noteManagedRefusal, busy, setBusy, setError, confirm, setTab,
}: UseBuilderRunsOptions) {
    const { t } = useTranslation();
    // The form test overlay: a FormTestSession while open, null otherwise.
    const [formTest, setFormTest] = useState<FormTestSession | null>(null);
    // A start between the click and the server's answer. A ref, so a second
    // press in the same tick (Cmd+Enter twice) already sees it.
    const startingRef = useRef(false);
    // A run started from THIS builder session: one that parks on a form page
    // opens the overlay by itself (dry runs pause for real too, D1).
    const startedHereRef = useRef(false);
    const runInFlight = !!state.dryRun && runPhase(state.dryRun).phase === 'running';
    const startBlocked = busy || !!state.executingStepId || runInFlight;
    const runBlocked = startBlocked || !!formTest;

    // The run row as the server answered it; the toast reads its status, profile and outcome.
    const toastSettled = (run: unknown, steps: unknown) => {
        const row = run as ToastRun;
        runOutcomeToast(t, row, { stepLabel: toastStepLabel(effectiveDef, row, steps) });
    };

    /** The start request itself: a dry run pauses for real; a live run is a test run of the working copy. */
    const sendStart = async (mode: FormRunMode, aid: string, body: RunStartBody): Promise<RunStartReply | null | 'declined'> => {
        if (mode === 'dry') return api.dryRun<RunStartReply>(aid, { ...body, pauses: 'real', respond: 'created' });
        // `test: true` runs the working copy (what is on the canvas). The first
        // run on the caller's own connections waits for a one-time notice
        // (callerNotice.ts); declining starts nothing.
        const started = await runWithCallerNotice<RunStartReply>(
            { run: (id, b) => api.run<RunStartReply>(id, b as RunStartBody), getCallerNotice: fetchCallerNotice, ackCallerNotice: acknowledgeCallerNotice },
            aid, { ...body, test: true, respond: 'created' }, confirm, t,
        );
        return started.declined ? 'declined' : started.result;
    };

    /** The server answered: follow the run by its id, or show a run that is already over. */
    const startedFrom = (r: RunStartReply | null): FormRunStartResult => {
        if (r?.skipped) {
            const message = r.message || t('automation_testing.start.nothing_to_run', 'Nothing to run against yet.');
            toast.info(message);
            return { kind: 'skipped', message };
        }
        const runId = r?.runId || r?.run?.id;
        if (!runId) throw new Error(t('automation_testing.start.no_run', 'The run did not start.'));
        startedHereRef.current = true;
        if (r?.run && runPhase(r.run).phase !== 'running') {
            setRunResult(r.run, r.steps);
            toastSettled(r.run, r.steps);
        } else {
            void followRun(runId, { kind: 'full' }).then((settled) => { if (settled) toastSettled(settled.run, settled.steps); });
        }
        return { kind: 'started', runId };
    };

    /** A start whose answer never came: wait for the run the click made, if there is one (run-watch F11). */
    const recoverStart = async (aid: string, clickedAt: number): Promise<FormRunStartResult | null> => {
        const rec = await awaitRunAfterDrop(aid, null, clickedAt);
        if (!rec?.run?.id) return null;
        setRunResult(rec.run, rec.steps);
        toastSettled(rec.run, rec.steps);
        return { kind: 'started', runId: rec.run.id };
    };

    /**
     * Start a whole-flow run (`viaForm`: through the form's own submission
     * path, bounded to end after `untilStepId` when it names one). Throws a
     * refusal (the overlay shows it); the header callers swallow it after setError.
     */
    const startRun = async (mode: FormRunMode, body: RunStartBody, viaForm: false | { untilStepId?: string | null } = false): Promise<FormRunStartResult> => {
        startingRef.current = true;
        setBusy(true); setError(null);
        const clickedAt = Date.now();
        let aid: string | undefined;
        try {
            aid = await ensureAutomationCreated();
            if (!aid) {
                const message = t('automation_testing.start.needs_steps', 'Add a trigger and at least one step before running.');
                setError(message);
                return { kind: 'skipped', message };
            }
            const reply = viaForm ? await sendFormTest(api, mode, aid, body, { confirm, t, untilStepId: viaForm.untilStepId }) : await sendStart(mode, aid, body);
            return reply === 'declined' ? { kind: 'declined' } : startedFrom(reply);
        } catch (e: unknown) {
            const recovered = aid && isDrop(e) ? await recoverStart(aid, clickedAt) : null;
            if (recovered) return recovered;
            noteManagedRefusal(e);
            setError((mode === 'live' && runStartRefusal(t, e)) || (e as Error).message);
            throw e;
        } finally {
            startingRef.current = false;
            setBusy(false);
        }
    };

    const blocked = () => runBlocked || startingRef.current;
    const openSession = (session: FormTestSession) => { setTab('build'); setFormTest(session); };

    /**
     * Dry run from the header, the menu or Cmd+Enter. A bare form trigger has no
     * data to run with, so its page opens over the canvas in dry mode instead
     * (RUN-09); any other trigger runs with its own saved sample.
     */
    const onDryRun = async (fromTrigger: unknown = null) => {
        if (blocked()) return;
        const tr = triggerById(effectiveDef, triggerIdArg(fromTrigger));
        if (isBareForm(tr)) {
            const session = formSessionFor(tr);
            if (session) openSession({ ...session, mode: 'dry' });
            else toast.info(t('automation_testing.start.form_needs_question', 'Add at least one question to this form first.'));
            return;
        }
        await startRun('dry', triggerInput(effectiveDef, tr)).catch(() => {});
    };

    /**
     * Run live (a test run with real actions), behind its confirm. A form
     * trigger opens its page instead, already confirmed for that session, and
     * the submit starts the live run.
     */
    const onRunLive = async (fromTrigger: unknown = null) => {
        if (blocked()) return;
        if (!await confirmLive(confirm, t)) return;
        const tr = triggerById(effectiveDef, triggerIdArg(fromTrigger));
        const session = formSessionFor(tr);
        if (session) { openSession({ ...session, mode: 'live', liveConfirmed: true }); return; }
        await startRun('live', triggerInput(effectiveDef, tr)).catch(() => {});
    };

    /**
     * The overlay's Submit on page one (formRunContract.ts). The answers ARE the
     * trigger payload, as a real submission hands them over. 'live' asks the Run
     * live confirm once per overlay session (RUN-04).
     */
    const onFormTestRun: FormRunStart = async (answers, { mode }) => {
        if (startBlocked || startingRef.current) {
            return { kind: 'declined', message: t('automation_testing.start.another_run', 'Another run is still going. Wait for it, or stop it first.') };
        }
        const session = formTest;
        if (mode === 'live' && !session?.liveConfirmed) {
            if (!await confirmLive(confirm, t)) return { kind: 'declined' };
            setFormTest(f => (f ? { ...f, liveConfirmed: true } : f));
        }
        const tr = triggerById(effectiveDef, session?.triggerStepId || null);
        return startRun(mode, { triggerPayload: answers, ...(tr && !isPrimary(effectiveDef, tr) ? { triggerStepId: tr.id } : {}) }, { untilStepId: session?.untilStepId });
    };

    /**
     * ▶ Execute (and Retry from here) with the trigger's data, or the form page
     * to fill in first (stepStart). Executing a trigger runs with THAT trigger's
     * sample and id; any other step with the primary's. When earlier steps that
     * send or write would run first, the server asks for a yes (409
     * side_effects_need_confirm): the confirm names them and the step runs again
     * with confirmSideEffects.
     */
    const runStep = async (stepId: string, opts: ExecuteRequest = {}): Promise<ExecuteStepResult> => {
        const start = stepStart(effectiveDef, state, stepId, opts);
        if ('form' in start) {
            if (start.form) openSession(start.form);
            else toast.info(t('automation_testing.start.form_needs_question', 'Add at least one question to this form first.'));
            return null;
        }
        const merged = start.input;
        const first = await executeStep(stepId, merged);
        if (first?.kind !== 'needs_confirm') return first;
        if (!await confirmUpstream(confirm, t, sideEffectNames(effectiveDef, first.steps))) return first;
        return executeStep(stepId, { ...merged, confirmSideEffects: true });
    };
    const handleExecuteStep = (stepId: string, opts?: ExecuteRequest) => runStep(stepId, opts);
    const handleRetryFromStep = (stepId: string, opts: Omit<ExecuteRequest, 'mode'> = {}) => runStep(stepId, { ...opts, mode: 'from' });

    // The overlay opens by itself on a page a run started here parks on, and stays closed when closed (RUN-11).
    const { closeFormTest, openFormOverlay } = useFormOverlayAutoOpen({ steps: state.steps, runId: state.dryRun?.id, startedHereRef, formTest, setFormTest });

    /** The overlay and the approval bar hand the canvas a run to follow, a continuation included. */
    const onFollowRun = (runId: string) => { if (runId) void continueRun(runId); };

    /**
     * "Restart with the current version" (tests-and-docs F9): a dry run of the
     * working copy that replays the answers and decisions of `runId`, so a fix
     * made while a test waited needs no retyping (POST /:id/dry-run answersFromRunId).
     */
    const onRestartWithAnswers = async (runId: string) => {
        if (!runId || blocked()) return;
        await startRun('dry', { answersFromRunId: runId }).catch(() => {});
    };

    return {
        formTest, handleExecuteStep, handleRetryFromStep, onDryRun, onRunLive, onFormTestRun, onFollowRun,
        onRestartWithAnswers, closeFormTest, openFormOverlay, runBlocked,
    };
}
