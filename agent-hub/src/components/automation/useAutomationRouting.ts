import { useCallback, useEffect, useEffectEvent, useRef } from 'react';
import type { RefObject } from 'react';
import type { BuilderUrlState } from './Builder/useBuilderTabUrl';
import type { AutomationListRow } from './useAutomationLibrary';
import { buildStudioSearch } from '../admin/Studio/studioRoutes';

// studioRoutes.js is still JavaScript, and its `= null` defaults are all
// TypeScript can see of these parameters. This states the `?view/run/step/from`
// contract that module documents; it goes away when it becomes TypeScript.
const studioSearch = buildStudioSearch as (state: {
    view?: string | null;
    runId?: string | null;
    stepId?: string | null;
    from?: string | null;
}) => string;

export interface AutomationRouting {
    /** Called by BuilderShell whenever the user drills into or out of a flowlet. */
    handleScopeChange: (scopeKey: string | null) => void;
    pushBuilderState: (state?: Partial<BuilderUrlState>) => void;
    /**
     * Whether the deep-linked Step id has been adopted. It leaves this hook
     * because the quick switcher closes a Step builder on its way to another
     * automation, and the adoption effect must not re-open the step the URL
     * still names.
     */
    stepUrlAdoptedRef: RefObject<boolean>;
}

export interface UseAutomationRoutingOptions {
    /** The automation id in the path. */
    initialTaskId: string | null;
    initialFlowletKey: string | null;
    initialStepId: string | null;
    /** Only the Studio shell owns the onNavigate → history bridge. */
    embedded: boolean;
    onNavigate: ((path: string, opts?: { replace?: boolean }) => void) | null;
    automations: AutomationListRow[];
    selectedAutomationId: string | null;
    builderAutomationId: string | null;
    /** Bridges the gap while a brand-new draft has no id of its own yet. */
    liveAutomationId: string | null;
    builderStepId: string | null;
    /** The `?from=` trail this builder was opened on — it rides every push. */
    activeFromToken: string | null;
    setBuilderAutomationId: (id: string | null) => void;
    setBuilderStepId: (id: string | null) => void;
    setOpeningBuilder: (opening: boolean) => void;
    setLiveAutomationId: (id: string | null) => void;
}

/**
 * The URL is the record of what is open, in both directions: a deep link or a
 * back/forward lands on the right automation, and opening one writes the path
 * that would bring you back. `lastRouteRef` is the single reconciliation
 * point — every push records what it sent so the reconcile can tell its own
 * echo from a genuine external change.
 */
export default function useAutomationRouting({
    initialTaskId, initialFlowletKey, initialStepId, embedded, onNavigate,
    automations, selectedAutomationId, builderAutomationId, liveAutomationId,
    builderStepId, activeFromToken,
    setBuilderAutomationId, setBuilderStepId, setOpeningBuilder, setLiveAutomationId,
}: UseAutomationRoutingOptions): AutomationRouting {
    // The PATH descriptor of the last push — '<id>', '<id>/<flowlet>' or
    // 'steps/<id>'. Four string comparisons below depend on that format.
    const lastRouteRef = useRef<string | null>(null);

    // Reconcile local state → what the URL points at. Runs on first load and on
    // browser back/forward; a no-op for the echo of our own pushes. The flowlet
    // scope reaches BuilderShell via the `initialFlowletKey` prop — here we only
    // open the right automation and record the descriptor.
    const reconcileRoute = useEffectEvent(() => {
        // 'new' was the create form of the agent schedules this page used to
        // hold; they are Cowork items now, so it is just the list.
        const urlId = initialTaskId && initialTaskId !== 'new' ? initialTaskId : null;
        const urlScope = initialFlowletKey || null;
        const urlKey = urlId ? (urlScope ? `${urlId}/${urlScope}` : urlId) : null;
        if (urlKey === lastRouteRef.current) return;
        if (urlId) {
            if (automations.some(a => a.id === urlId)) {
                lastRouteRef.current = urlKey;
                setBuilderAutomationId(urlId);
            }
            return; // not loaded yet (or stale id) — retry when the list updates
        }
        // urlId is null → the URL points at the bare list; close any open
        // editor — UNLESS a Reusable-Step deep link owns the URL (its path has
        // no task id, so this branch used to re-fire and clobber the step
        // descriptor every time `automations` resolved).
        if (initialStepId) return;
        lastRouteRef.current = null;
        setBuilderAutomationId(null);
        setOpeningBuilder(false);
    });
    useEffect(() => { reconcileRoute(); }, [initialTaskId, initialFlowletKey, initialStepId, automations]);

    // Push the OPEN AUTOMATION (id) to the URL when it changes. Compares only the
    // id portion of the descriptor so a flowlet drill (same id, see
    // handleScopeChange below) isn't clobbered back to the root path. Only in
    // the embedded Studio shell, which owns the onNavigate → history bridge.
    useEffect(() => {
        if (!embedded || !onNavigate) return;
        // A Step builder owns the URL while open — let the step push effect drive
        // it instead of clobbering it back to the automation path.
        if (builderStepId !== null) return;
        const currentId = lastRouteRef.current ? lastRouteRef.current.split('/')[0] : null;
        if (selectedAutomationId === currentId) return;
        // A different automation opened/closed — drop any flowlet scope (it belongs
        // to the automation we're leaving), landing on the bare id or the list.
        lastRouteRef.current = selectedAutomationId || null;
        onNavigate(selectedAutomationId ? `studio/automations/${selectedAutomationId}` : 'studio/automations');
    }, [embedded, onNavigate, selectedAutomationId, builderStepId]);

    // Adopt a deep-linked Step id on mount (refresh / back into the Step builder).
    const stepUrlAdoptedRef = useRef(false);
    useEffect(() => {
        if (stepUrlAdoptedRef.current) return;
        if (initialStepId) setBuilderStepId(initialStepId);
        stepUrlAdoptedRef.current = true;
    }, [initialStepId, setBuilderStepId]);

    // Push the OPEN STEP id to the URL (under /steps/), or land on the automations
    // list when the Step builder closes.
    useEffect(() => {
        if (!embedded || !onNavigate) return;
        if (builderStepId === null) return; // closed → the automation effect takes over
        const want = builderStepId ? `steps/${builderStepId}` : null;
        if (!want || want === lastRouteRef.current) return;
        lastRouteRef.current = want;
        onNavigate(`studio/automations/${want}`);
    }, [embedded, onNavigate, builderStepId]);

    // Push the FLOWLET scope to the URL. Called by BuilderShell whenever the
    // user drills into / out of a flowlet. Imperative (not an effect) so the id
    // portion stays put and there's no lag while BuilderShell settles its scope.
    const handleScopeChange = useCallback((scopeKey: string | null) => {
        if (!embedded || !onNavigate) return;
        const id = builderAutomationId || liveAutomationId;
        if (!id) return; // no automation to anchor the scope to yet
        const key = scopeKey ? `${id}/${scopeKey}` : id;
        if (key === lastRouteRef.current) return;
        lastRouteRef.current = key;
        onNavigate(scopeKey ? `studio/automations/${id}/${scopeKey}` : `studio/automations/${id}`);
    }, [embedded, onNavigate, builderAutomationId, liveAutomationId]);

    // `liveAutomationId` only bridges the gap while a brand-new draft has no id
    // in `builderAutomationId` yet. Clear it whenever builderAutomationId changes
    // (open another, or close) so a stale id can't linger in the path.
    useEffect(() => {
        setLiveAutomationId(null);
    }, [builderAutomationId, setLiveAutomationId]);

    // Push the builder's QUERY state (?view/run/step) to the URL. Imperative,
    // like handleScopeChange — and it must NOT write lastRouteRef: that ref
    // holds the PATH descriptor and four string comparisons depend on its
    // format. The path suffix is reused verbatim ('<id>', '<id>/<flowlet>',
    // 'steps/<id>') so a query push never clobbers a flowlet drill.
    const lastQueryRef = useRef<{
        view: string | null; runId: string | null; stepId: string | null; from: string | null;
    }>({ view: null, runId: null, stepId: null, from: null });
    const pushBuilderState = useCallback((
        { view = null, runId = null, stepId = null, replace = false }: Partial<BuilderUrlState> = {},
    ) => {
        if (!embedded || !onNavigate) return;
        // `from` is never passed IN — it is the trail this builder was opened
        // on, not part of the state BuilderShell reports. It rides along on
        // every push so a view switch cannot drop it.
        const next = { view, runId, stepId, from: activeFromToken || null };
        const cur = lastQueryRef.current;
        if (cur.view === next.view && cur.runId === next.runId && cur.stepId === next.stepId && cur.from === next.from) return;
        lastQueryRef.current = next;
        const search = studioSearch(next);
        const suffix = lastRouteRef.current
            || (builderStepId ? `steps/${builderStepId}` : (builderAutomationId || liveAutomationId || null));
        onNavigate(suffix ? `studio/automations/${suffix}${search}` : `studio/automations${search}`, { replace });
    }, [embedded, onNavigate, builderStepId, builderAutomationId, liveAutomationId, activeFromToken]);

    // `stepUrlAdoptedRef` leaves this hook because the quick switcher closes a
    // Step builder on its way to another automation, and the adoption effect must
    // not then re-open the step the URL still names.
    return { handleScopeChange, pushBuilderState, stepUrlAdoptedRef };
}
