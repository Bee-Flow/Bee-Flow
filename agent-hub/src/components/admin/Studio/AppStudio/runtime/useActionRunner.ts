import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { applyEffects as applyEffectObject } from './actionRunner/applyEffects';
import type { EffectContext } from './actionRunner/applyEffects';
import { runActionSlot } from './actionRunner/bareAction';
import { useOptionalActiveActionJobs } from '@/api/queries/studioAppJobs';
import type { ActionEntry, ActionSlot, ActionState, EffectObject, RunOpts, Translate, Vars } from './actionRunner/core';
import type {
    BeforeServerStep, BrowseEventSink, ConfirmFn, LiveInputs, NavigateFn, RefreshFn, RunnerContext, RunnerDefinition,
} from './actionRunner/runnerContext';
import type { DataState } from './DataContext';
import useAppVariables from './variables/useAppVariables';
import { createScreenTrail } from './actionRunner/screenTrail';
import { definitionReadsUi, getUiSnapshot } from './uiState';
import useTranslation from '@/hooks/useTranslation';

export { SERVER_STEP_KINDS } from './actionRunner/core';

/**
 * App Studio runtime — the live action engine (SEQUENCE COORDINATOR).
 *
 * useActionRunner(appId, definition, { draft, onNavigate, confirm, onRefresh,
 *                                      currentUser, dataState })
 *   → { actionState, runAction, vars, setVar }
 *
 * `vars` is HOOK STATE shared across the whole run surface: sequences start
 * from it, and set_variable / resultVar writes merge back into it, so a value
 * set by one action is visible to formulas (vars.*) and later actions.
 * setVar(name, value) writes it directly (e.g. filter_bar). Loop-local
 * itemVar/indexVar stay sequence-local. Existing callers that destructure only
 * { actionState, runAction } are unaffected.
 *
 * An action is either a bare v1 action (kind run_automation/navigate/toast/
 * open_url/open_modal — an implicit 1-step sequence) or a v2
 * { kind:'sequence', steps:[Step] }. runAction resolves the action and:
 *
 *   • BARE v1 actions keep their exact legacy behaviour (actionRunner/
 *     bareAction.ts) — including the run_automation /run bridge with 202-poll
 *     and onSuccess/onError effects (actionRunner/automationBridge.ts).
 *   • v2 SEQUENCES are walked step-by-step (actionRunner/sequence.ts). CLIENT
 *     kinds run in the browser (actionRunner/clientSteps.ts):
 *       navigate → onNavigate(screenId, resolvedParams) — the optional params
 *                  map ({kind:'static'|'formula'}) resolves against live scope
 *       toast    → shared toast
 *       open_url → window.open (https only)  open_modal/close_modal → the
 *       AppModal open bus (openAppModal/closeAppModal by modalId)
 *       confirm  → await a confirm promise (decline ABORTS the sequence)
 *       set_variable → writes the shared `vars` map threaded into later steps
 *       refresh  → onRefresh(actionId) (refetch the app's data)
 *       condition/switch/loop → evaluate the expr/source via @shared/expr
 *                               against the live scope and recurse/iterate
 *     SERVER kinds (create_record/update_record/delete_record/run_automation)
 *     POST to /api/studio-apps/:id/actions/:actionId/step {stepIndex, formValues,
 *     vars, item} (+?draft=1 in editor preview); the result threads into
 *     `vars`/actionState for later steps (actionRunner/serverSteps.ts). A step
 *     failing with code 'quota_exceeded' surfaces the distinct storage-limit
 *     toast.
 *
 * A step failure aborts the remaining sequence (its optional onError branch runs
 * first) and surfaces an error toast. Only a sequence that touches the server
 * shows the triggering control's spinner (status:'running'); pure client
 * sequences resolve synchronously, exactly like a v1 navigate/toast.
 *
 * actionState: { [actionId]: { status: 'idle'|'running'|'success'|'error',
 *                              result, error } }
 * The hook is mode-agnostic: the editor never calls runAction (it stubs one).
 */

export interface ActionRunnerOptions {
    draft?: boolean;
    onNavigate?: NavigateFn | null;
    confirm?: ConfirmFn | null;
    onRefresh?: RefreshFn | null;
    currentUser?: unknown;
    dataState?: DataState | null;
    // The two scope roots the RENDERER always has and the runner did not:
    // `forms` (every form's live values, by node id) and `screen`
    // ({ id, name, params }). A step formula reading screen.params.<name> —
    // how every template hands a record id to a detail screen — resolved to
    // undefined, so the delete button on a detail screen deleted nothing.
    // Optional: a caller that omits them gets the empty objects buildScope
    // already defaults to.
    forms?: Record<string, unknown> | null;
    screen?: Record<string, unknown> | null;
    /**
     * Awaited once before a sequence that touches the SERVER runs.
     *
     * `stepIndex` is never stored: the browser derives it from the definition
     * it holds and the server from the one it has (?draft=1 → the SAVED draft).
     * In the editor those are not the same document — autosave is debounced —
     * so previewing an action inside that window had the server resolve the
     * ordinal to a DIFFERENT step than the one on screen. On a delete_record
     * that is not a cosmetic difference. The editor passes its autosave flush;
     * a caller with nothing to flush passes nothing.
     * → { ok:false } aborts the run rather than dispatching against a draft the
     * server has not got.
     */
    beforeServerStep?: BeforeServerStep | null;
    /**
     * onBrowseEvent(actionId, evt) — the live-browse frame sink. An ai_browse
     * step streams screenshot/action events over its own SSE endpoint; the
     * runner forwards each to this callback (RunSurface wires it to the
     * BrowserRunContext store so a browser_view can render it). Omitted → the
     * step still runs, just without a live preview.
     */
    onBrowseEvent?: BrowseEventSink | null;
    /**
     * Where a signed-in viewer's kept variables (schema 3 `persist`) live: one key per app and
     * viewer. Only the run page passes one; the editor and a public page keep nothing.
     */
    persistKey?: string | null;
}

export interface ActionRunner {
    actionState: ActionState;
    /** One action id, or (schema 3) a list of them run in order, stopping at the first that fails. */
    runAction: (actionId: ActionSlot, opts?: RunOpts) => Promise<void>;
    vars: Vars;
    setVar: (name: string, value: unknown) => void;
}

export default function useActionRunner(
    appId: string | null,
    definition: RunnerDefinition | null | undefined,
    {
        draft = false, onNavigate, confirm, onRefresh, currentUser = null, dataState = null,
        forms = null, screen = null, beforeServerStep = null, onBrowseEvent = null, persistKey = null,
    }: ActionRunnerOptions = {},
): ActionRunner {
    const { t } = useTranslation();
    // A stable translate function: the callbacks below keep their identity (and
    // never read a stale catalogue) however often the catalogue loads.
    const tRef = useRef(t);
    useLayoutEffect(() => {
        tRef.current = t;
    });
    const tr = useCallback<Translate>((key, fallback, params) => tRef.current(key, fallback, params), []);
    const [actionState, setActionState] = useState<ActionState>({});
    // Shared variable state for the whole run surface — sequences seed their
    // local vars from it and merge set_variable/resultVar writes back in. Schema 3
    // keys (kept, screen and derived variables) live in variables/useAppVariables.ts.
    const appVars = useAppVariables(definition, { persistKey, actionState, dataState, currentUser, forms, screen, onNavigate });
    const { vars, setVars } = appVars;

    // The screens this surface showed, for a `back` step; told about every screen it renders.
    const [screenTrail] = useState(createScreenTrail);
    // One ref so runAction stays identity-stable but never reads stale data.
    // Updated after each commit; the first render's inputs seed it.
    const liveInputs: LiveInputs = {
        actionState, vars, definition, onNavigate: appVars.onNavigate, onBrowseEvent, confirm, onRefresh,
        currentUser, dataState, forms, screen, beforeServerStep,
        // Only a definition that reads `ui` gets the root in its step scope: every other app's scope keeps today's shape.
        readUi: definitionReadsUi(definition) ? getUiSnapshot : null, screenTrail,
        deriveVars: appVars.deriveVars,
    };
    const live = useRef<LiveInputs>(liveInputs);
    useLayoutEffect(() => {
        live.current = liveInputs;
    });
    useLayoutEffect(() => { screenTrail.observe(screen); });

    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; };
    }, []);

    const setEntry = useCallback((actionId: string, entry: ActionEntry) => {
        if (!alive.current) return;
        setActionState((prev) => ({ ...prev, [actionId]: entry }));
    }, []);

    // Public writer (filter_bar etc.) AND the merge target for sequence writes.
    //
    // Writing the SAME value used to allocate a new `vars` object anyway, and
    // that object is what the run surface memoises its scope on: a no-op write
    // re-stamped the scope, re-rendered every node on the screen and re-resolved
    // every binding. Sequences do this constantly — clicking the row you already
    // had open sets two dozen variables to the values they already hold. Bail out
    // on an unchanged primitive so nothing downstream wakes up. Objects and
    // arrays still pass through: they are rebuilt per run and comparing them by
    // identity would report "changed" every time regardless.
    const setVar = useCallback((name: string, value: unknown) => {
        if (!alive.current || typeof name !== 'string' || !name) return;
        setVars((prev) => (Object.is(prev[name], value) && name in prev
            ? prev
            : { ...prev, [name]: value }));
    }, [setVars]);

    const applyEffects = useCallback((effects: EffectObject | null | undefined, ctx: EffectContext = {}) => applyEffectObject(effects, ctx, {
        tr,
        screens: () => live.current.definition?.screens,
        navigate: () => live.current.onNavigate,
        refresh: () => live.current.onRefresh,
    }), [tr]);

    // The background jobs this surface follows; kept across re-renders so a job is polled once.
    const [jobs] = useState<Set<string>>(() => new Set());
    const ctx = useMemo<RunnerContext>(
        () => ({ appId, draft, tr, live, alive, setEntry, setVar, applyEffects, jobs }),
        [appId, draft, tr, setEntry, setVar, applyEffects, jobs],
    );

    const runAction = useCallback(async (actionId: ActionSlot, opts: RunOpts = {}) => { await runActionSlot(ctx, actionId, opts); }, [ctx]);

    // Background jobs this viewer started earlier (another tab, before a reload) are picked
    // up again: the list comes from a query, the effect only attaches (no fetch in it).
    const { data: activeJobs } = useOptionalActiveActionJobs(appId, draft);
    useEffect(() => {
        if (activeJobs && activeJobs.length) void import('./actionRunner/backgroundRun').then((m) => m.resumeActiveJobs(ctx, activeJobs));
    }, [ctx, activeJobs]);

    return { actionState, runAction, vars, setVar };
}
