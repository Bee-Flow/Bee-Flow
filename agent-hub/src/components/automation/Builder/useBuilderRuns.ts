import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '../../shared/Toast';
import { shouldAutoOpenFormOverlay, awaitingFormStepId, dismissKey } from './flow/formOverlayAutoOpen';
import { runWithCallerNotice } from './callerNotice';
import { acknowledgeCallerNotice, fetchCallerNotice } from '../../../api/queries/automation/callerNotice';
import { useTranslation } from '../../../hooks/useTranslation';
import { runStartRefusal } from '../../../api/queries/automation/runAccess';
import type { BuilderTab } from './useBuilderTabUrl';
import type { Dispatch, SetStateAction } from 'react';
import type useAutomationApi from '../../../hooks/useAutomationApi';
import type useAutomationBuilderStream from '../../../hooks/useAutomationBuilderStream';
import type useConfirm from '../../shared/useConfirm';
import type useNdvState from './useNdvState';
import type { FlowDefinition } from './flow/types';


/** The live run's answer: a skip, a hand-off to the run history, or the finished run. */
interface LiveRunReply {
    skipped?: boolean;
    pending?: boolean;
    message?: string;
    id?: string;
    run?: { id?: string; status?: string };
    steps?: unknown;
}

export interface UseBuilderRunsOptions {
    api: ReturnType<typeof useAutomationApi>;
    state: ReturnType<typeof useAutomationBuilderStream>['state'];
    effectiveDef: FlowDefinition | null;
    executeStep: (stepId: string, opts?: any) => Promise<any>;
    watchActiveRun: (automationId: string) => () => void;
    setRunResult: ReturnType<typeof useAutomationBuilderStream>['setRunResult'];
    settleRun: () => void;
    clearDryRun: () => void;
    ensureAutomationCreated: (defForCreate?: FlowDefinition | null) => Promise<string | undefined>;
    noteManagedRefusal: (e: unknown) => boolean;
    setBusy: (busy: boolean) => void;
    setError: Dispatch<SetStateAction<string | null>>;
    confirm: ReturnType<typeof useConfirm>['confirm'];
    setTab: (tab: BuilderTab) => void;
    ndvStepId: string | null;
    openNdv: ReturnType<typeof useNdvState>['openNdv'];
}

/**
 * Running the automation from the editor: ▶ Execute on one step, Dry-run, the
 * confirmed live run, and the form test overlay a form trigger (or a live run
 * parked on a form page) opens instead. Every run carries the trigger's saved
 * sample (BFSF-408). Split out of BuilderShell without a change in behaviour.
 */
export default function useBuilderRuns({
    api, state, effectiveDef, executeStep, watchActiveRun, setRunResult, settleRun, clearDryRun,
    ensureAutomationCreated, noteManagedRefusal, setBusy, setError, confirm, setTab, ndvStepId, openNdv,
}: UseBuilderRunsOptions) {
    const { t } = useTranslation();
    // Executing a step does NOT open its editor. Hitting ▶ on the canvas is a
    // question about DATA — "how much came out, and what goes to the next
    // node" — and the answer now lands on the connection itself (see
    // flow/dataSummary.js + the chip in flow/edges.jsx). Covering the canvas
    // with a settings dialog buried exactly the thing being asked for. The
    // Execute buttons inside the editor still work; it is already open there.
    //
    // One deliberate carve-out (BFSF-408, reopened): a FORM trigger with no
    // saved sample yet has no data to run WITH — every {{trigger.output.*}}
    // downstream resolves to undefined, so "how much came out" has no answer
    // to land on the edge. There the visual form preview (FormBuilderFields,
    // default-open for a testable trigger) is the thing worth surfacing, not
    // a blank run — see the redirect in handleExecuteStep below.
    //
    // The trigger's saved sample, kept in a ref because the run helpers below
    // are declared long before `effectiveDef` exists (it needs the draft, the
    // server row and the Step seed to have been resolved first). Assigned once
    // per render, right after that resolution.
    // The form test overlay: `{ form, triggerStepId }` while open, null
    // otherwise. Declared up here rather than beside its handlers because
    // handleExecuteStep below closes over the setter, and a useCallback's
    // dependency array is evaluated during render — a `const` declared later
    // would be in its temporal dead zone at that moment.
    const [formTest, setFormTest] = useState<any>(null);
    const triggerSampleRef = useRef<any>(null);
    // The id of the PRIMARY trigger when it is a bare form trigger — kind
    // 'form', no pinnedOutput yet — else null. Same ref-assigned-in-render
    // pattern as triggerSampleRef, and for the same reason.
    const bareFormTriggerIdRef = useRef<any>(null);
    const formDeclRef = useRef<any>(null);
    // definition.triggers[] — the additional entry points of a multi-trigger
    // automation, each with its own pinnedOutput. Same ref-in-render pattern.
    const secondaryTriggersRef = useRef<any[]>([]);
    // The body every whole-flow run is POSTed with. `{}` when there is no
    // sample, so an untouched automation keeps sending exactly what it always did.
    // A run started FROM a secondary trigger (the header's "Start from"
    // choice) carries that trigger's own sample and names it, so the server
    // seeds the DAG from that node. Anything that is not a trigger id — the
    // hotkey and the split button hand over nothing or a click event — means
    // the primary.
    const runBody = useCallback((triggerStepId: string | null = null) => {
        const from = typeof triggerStepId === 'string' && triggerStepId ? triggerStepId : null;
        const sample = from
            ? (secondaryTriggersRef.current.find(t => t?.id === from)?.pinnedOutput ?? null)
            : triggerSampleRef.current;
        return {
            ...(sample == null ? {} : { triggerPayload: sample }),
            ...(from ? { triggerStepId: from } : {}),
        };
    }, []);

    // Every run the editor starts carries the TRIGGER's saved sample as its
    // `triggerPayload` (BFSF-408). Without it an automation that cannot be fired
    // for real yet — a form nobody has submitted, an app_event with no matching
    // message — entered with `trigger.output === {}`, so every downstream step
    // mapping off the trigger resolved to undefined and could be neither built
    // nor tested. `opts.triggerPayload` still wins, so the form preview's
    // "submit these answers" can hand over what the author just typed.
    //
    // A BARE form trigger (kind 'form', nothing pinned/edited yet) is the one
    // case rerouted instead of run: "hit play, nothing happens" was the
    // reopened ticket's literal complaint, from every one of Execute's entry
    // points (canvas hover-▶, right-click "Execute step", and the editor's own
    // header/Output buttons — they all resolve to this same function). A run
    // with no data would just repeat that silence, so open the trigger's own
    // editor instead, where the visual form preview now shows by default —
    // "hit play" and "see the form" become the same gesture. Already looking
    // at that exact trigger's editor is a no-op here: the preview is already
    // on screen, and re-invoking openNdv would reset an expanded FULL view
    // back to quick. `opts.triggerPayload` is the escape hatch: the preview's
    // own Submit button (onTestSubmit) always carries one — even `{}` for an
    // all-optional form — and that must always execute for real.
    const handleExecuteStep = useCallback(
        (stepId: any, opts: any) => {
            // "Test this form" in the trigger's panel asks for the page
            // explicitly (openForm), so it opens the overlay even when a
            // sample is pinned and Execute alone would replay that sample.
            if (opts?.openForm && formDeclRef.current?.triggerStepId === stepId) {
                setFormTest(formDeclRef.current);
                return Promise.resolve();
            }
            if (!opts?.triggerPayload && bareFormTriggerIdRef.current && bareFormTriggerIdRef.current === stepId) {
                // A form trigger has nothing to run WITH until somebody fills
                // the page in, so Execute opens that page over the canvas and
                // its Submit starts the run. This used to open the node editor
                // and leave you to find the inline preview inside it, which is
                // the same answer one gesture further away.
                const t = formDeclRef.current;
                if (t) setFormTest(t);
                else toast.info('Add at least one question to this form first.');
                return Promise.resolve();
            }
            return executeStep(stepId, { triggerPayload: triggerSampleRef.current, ...(opts || {}) });
        },
        [executeStep, ndvStepId, openNdv],
    );

    // What the automation ENTERS with when you press Run / Dry-run / ▶ Execute:
    // the primary trigger's own pinned output. That pin is either a captured
    // run or a payload the author typed into the trigger's Output → Edit sheet
    // (BFSF-408), and it is the ONE hand-authored payload slot — the old
    // `definition.manualTriggerPayload` was write-only and is gone.
    triggerSampleRef.current = effectiveDef?.trigger?.pinnedOutput ?? null;
    secondaryTriggersRef.current = Array.isArray(effectiveDef?.triggers) ? effectiveDef.triggers : [];
    // See handleExecuteStep above: a bare form trigger reroutes Execute to
    // its own editor instead of running blind.
    bareFormTriggerIdRef.current = (effectiveDef?.trigger?.kind === 'form' && triggerSampleRef.current == null)
        ? effectiveDef.trigger.id
        : null;
    // What that Execute should OPEN — the declaration as it stands right now,
    // so a question added a moment ago is on the test page.
    formDeclRef.current = (effectiveDef?.trigger?.kind === 'form' && effectiveDef.trigger.form)
        ? { form: effectiveDef.trigger.form, triggerStepId: effectiveDef.trigger.id }
        : null;

    const onDryRun = async (fromTrigger: string | null = null) => {
        setBusy(true); setError(null);
        liveFromBuilderRef.current = false;
        let stopWatch = () => {};
        try {
            const aid = await ensureAutomationCreated();
            if (!aid) { setError('Add a trigger and at least one step before running.'); return; }
            stopWatch = watchActiveRun(aid); // live progress while it runs
            const r = await api.dryRun<LiveRunReply>(aid, runBody(fromTrigger));
            setRunResult(r.run, r.steps);
            toast.success('Dry-run complete — open a step to see its output.');
        }
        // `watchActiveRun` may already have surfaced a 'running' progress stub
        // by the time the request throws, and nothing else will ever settle it:
        // no run record is coming. Left running, `liveRunInFlight` stays true
        // and every ▶ Execute button is disabled for the rest of the session —
        // one of the mechanisms behind BFSF-360 ("Execute does nothing").
        catch (e: unknown) { noteManagedRefusal(e); setError((e as Error).message); settleRun(); }
        finally { stopWatch(); setBusy(false); }
    };

    // Live full-flow run from the editor (the "Run live" option in the Run
    // menu). Unlike Dry-run this performs every side-effect for real, so we
    // gate it behind a confirm. Results land in each node's Run tab via
    // setRunResult, exactly like the dry-run path.
    /**
     * The live run itself, once the payload is settled.
     *
     * Split out of onRunLive so the form overlay can start exactly the same
     * run with the answers somebody just typed — the alternative was a second
     * copy of the watch/settle/report plumbing, which is the half that has the
     * bugs (BFSF-360).
     */
    const startLiveRun = async (body: any) => {
        setBusy(true); setError(null);
        liveFromBuilderRef.current = true;
        let stopWatch = () => {};
        try {
            const aid = await ensureAutomationCreated();
            if (!aid) { setError('Add a trigger and at least one step before running.'); return null; }
            stopWatch = watchActiveRun(aid); // live progress while it runs
            // `test: true`: the editor runs what is on the canvas (the working
            // copy). Without it the server runs the LIVE version, which on a
            // automation with changes not yet live is not what the author sees.
            // The first run of an automation on the caller's own connections is held
            // for a one-time notice (callerNotice.ts); declining starts nothing.
            const started = await runWithCallerNotice<LiveRunReply>(
                { run: api.run<LiveRunReply>, getCallerNotice: fetchCallerNotice, ackCallerNotice: acknowledgeCallerNotice }, aid, { ...body, test: true }, confirm, t,
            );
            if (started.declined) { clearDryRun(); return null; }
            const r = started.result;
            if (r?.skipped) {
                clearDryRun();
                toast.success(r.message || 'Nothing to run against yet.');
            } else if (r?.pending) {
                // Run outlived the request window; hand off to Run history and
                // clear the live stub so the progress banner doesn't hang.
                clearDryRun();
                toast.success('Run started — results will appear in Run history shortly.');
            } else {
                setRunResult(r.run, r.steps);
                // A form journey is not over when the request returns — the
                // automation may be paused on its next page, and the overlay is
                // about to say so. Only claim completion when nothing is.
                if (r?.run?.status !== 'awaiting_form') toast.success('Live run complete — open a step to see its output.');
            }
            return r;
        }
        // Same as onDryRun: settle the live progress stub so a failed run-start
        // can't strand the builder in "running" forever (BFSF-360).
        catch (e: unknown) { noteManagedRefusal(e); setError(runStartRefusal(t, e) || (e as Error).message); settleRun(); throw e; }
        finally { stopWatch(); setBusy(false); }
    };

    /**
     * The form a test overlay should open on, for the trigger being run.
     *
     * Reads the DECLARATION rather than anything saved, so the page under test
     * is the one on screen — an author who just added a question expects to see
     * it, not the version the server last stored.
     */
    const formForTrigger = (fromTrigger: string | null = null) => {
        const t = (typeof fromTrigger === 'string' && fromTrigger)
            ? [effectiveDef?.trigger, ...(effectiveDef?.triggers || [])].find(x => x?.id === fromTrigger)
            : effectiveDef?.trigger;
        return (t?.kind === 'form' && t?.form) ? { form: t.form, triggerStepId: t.id } : null;
    };

    // Live-run form pages: a live run started from THIS builder that parks on a
    // `form_page` opens the overlay attached to that run. Dry runs never do.
    // Closing remembers `${runId}:${stepId}` so the same page does not pop up
    // again straight away.
    const liveFromBuilderRef = useRef(false);
    const dismissedFormPagesRef = useRef(new Set<string>());
    const awaitingStepNow = awaitingFormStepId(state.steps);
    const currentRunId = state.dryRun?.id || null;
    const closeFormTest = () => {
        if (currentRunId && awaitingStepNow) dismissedFormPagesRef.current.add(dismissKey(currentRunId, awaitingStepNow));
        setFormTest(null);
    };
    const openFormOverlay = (runId: any) => { if (runId) setFormTest({ runId }); };
    useEffect(() => {
        if (shouldAutoOpenFormOverlay({
            liveFromBuilder: liveFromBuilderRef.current,
            runId: currentRunId,
            awaitingStepId: awaitingStepNow,
            overlayOpen: !!formTest,
            dismissed: dismissedFormPagesRef.current,
        })) setFormTest({ runId: currentRunId });
    }, [currentRunId, awaitingStepNow, formTest]);

    /**
     * Start the run the overlay's Submit asked for.
     *
     * The answers ARE the trigger payload — the same thing a real submission
     * hands the automation — so nothing else about the run differs from pressing
     * Run on any other trigger.
     */
    const onFormTestRun = async (answers: any) => {
        const from = formTest?.triggerStepId || null;
        return startLiveRun({
            triggerPayload: answers,
            ...(from && from !== effectiveDef?.trigger?.id ? { triggerStepId: from } : {}),
        });
    };

    const onRunLive = async (fromTrigger: string | null = null) => {
        const ok = await confirm({
            title: 'Run this automation for real?',
            description: 'Every step performs its action — sending messages, writing data, and anything else in the flow.',
            confirmLabel: 'Run it',
            destructive: true,
        });
        if (!ok) return;
        // A form trigger has no payload to run WITH: the trigger is a page a
        // person fills in. So Run opens that page over the canvas, and the
        // submit starts the run — "hit play" and "see the form" become one
        // gesture instead of Run quietly doing nothing.
        const asForm = formForTrigger(fromTrigger);
        if (asForm) { setTab('build'); setFormTest(asForm); return; }
        await startLiveRun(runBody(fromTrigger)).catch(() => {});
    };

    return { formTest, handleExecuteStep, onDryRun, onRunLive, onFormTestRun, closeFormTest, openFormOverlay };
}
