import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { applyEffects as applyEffectObject } from './actionRunner/applyEffects';
import type { EffectContext } from './actionRunner/applyEffects';
import { runActionById } from './actionRunner/bareAction';
import type { ActionEntry, ActionState, EffectObject, RunOpts, Translate, Vars } from './actionRunner/core';
import type {
    BeforeServerStep, BrowseEventSink, ConfirmFn, LiveInputs, NavigateFn, RefreshFn, RunnerContext, RunnerDefinition,
} from './actionRunner/runnerContext';
import { reconcileVariableDefaults, seedVariableDefaults } from './appVariables';
import useTranslation from '../../../../../hooks/useTranslation';

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
    dataState?: Record<string, unknown> | null;
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
}

export interface ActionRunner {
    actionState: ActionState;
    runAction: (actionId: string, opts?: RunOpts) => Promise<void>;
    vars: Vars;
    setVar: (name: string, value: unknown) => void;
}

/**
 * Fold a change in the DECLARATIONS into the live bag.
 *
 * The trap here is specific: Canvas.jsx passes the live editor definition,
 * which is a NEW object on every inspector keystroke. An effect keyed on
 * `definition` would re-seed — wiping vars.filters mid-typing and resetting
 * preview state on every character. So the effect is keyed on a signature of
 * the DECLARATIONS only; definitionOps preserves structural sharing, so
 * `definition.variables` keeps its reference across every edit that is not a
 * variables edit and the memo never even recomputes.
 */
function useDeclaredVariables(definition: RunnerDefinition | null | undefined) {
    // SEEDED from definition.variables, so a records binding filtered on
    // `vars.status` filters on the FIRST paint instead of being dropped for
    // having no value yet (resolveBindingFilters omits an unresolved entry).
    const [vars, setVars] = useState<Vars>(() => seedVariableDefaults(definition?.variables) as Vars);
    const declSignature = useMemo(
        () => JSON.stringify(((definition?.variables || []) as Array<{ name?: unknown; type?: unknown; default?: unknown }>)
            .map((v) => [v.name, v.type, v.default])),
        [definition?.variables],
    );
    // Initialised to the same list the lazy useState seeded from, so the first
    // pass is a no-op rather than a reconcile against nothing.
    const prevDeclsRef = useRef(definition?.variables || []);
    // Keyed on the signature, NOT on `definition` — see above.
    const reconcileDecls = useEffectEvent(() => {
        const next = definition?.variables || [];
        setVars((prev) => reconcileVariableDefaults(prev, prevDeclsRef.current, next));
        prevDeclsRef.current = next;
    });
    useEffect(() => { reconcileDecls(); }, [declSignature]);
    return [vars, setVars] as const;
}

export default function useActionRunner(
    appId: string,
    definition: RunnerDefinition | null | undefined,
    {
        draft = false, onNavigate, confirm, onRefresh, currentUser = null, dataState = null,
        forms = null, screen = null, beforeServerStep = null, onBrowseEvent = null,
    }: ActionRunnerOptions = {},
): ActionRunner {
    const { t } = useTranslation();
    // A stable translate function: the callbacks below keep their identity (and
    // never read a stale catalogue) however often the catalogue loads.
    const tRef = useRef(t);
    tRef.current = t;
    const tr = useCallback<Translate>((key, fallback, params) => tRef.current(key, fallback, params), []);
    const [actionState, setActionState] = useState<ActionState>({});
    // Shared variable state for the whole run surface — sequences seed their
    // local vars from it and merge set_variable/resultVar writes back in.
    const [vars, setVars] = useDeclaredVariables(definition);

    // One ref so runAction stays identity-stable but never reads stale data.
    const live = useRef<LiveInputs>(null as unknown as LiveInputs);
    live.current = {
        actionState, vars, definition, onNavigate, onBrowseEvent, confirm, onRefresh,
        currentUser, dataState, forms, screen, beforeServerStep,
    };

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

    const ctx = useMemo<RunnerContext>(
        () => ({ appId, draft, tr, live, alive, setEntry, setVar, applyEffects }),
        [appId, draft, tr, setEntry, setVar, applyEffects],
    );

    const runAction = useCallback((actionId: string, opts: RunOpts = {}) => runActionById(ctx, actionId, opts), [ctx]);

    return { actionState, runAction, vars, setVar };
}
