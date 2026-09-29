import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

/** The four things the builder can be showing. */
export type BuilderTab = 'build' | 'settings' | 'history' | 'versions';

// Which tab the URL calls each view. The shell owns the VIEW word; the runs
// panel reports the open run and selected step through reportBuilderState.
const TAB_TO_VIEW: Record<BuilderTab, string> = { build: 'build', settings: 'settings', history: 'runs', versions: 'versions' };

/** What the builder tells the router about itself — `?view/run/step`. */
export interface BuilderUrlState {
    view: string | null;
    runId: string | null;
    stepId: string | null;
    /** false pushes a history entry; the default replaces the current one. */
    replace: boolean;
}

/** The run half of that state, as the runs panel reports it back up. */
export interface BuilderRunStatePatch {
    runId?: string | null;
    stepId?: string | null;
}

export interface BuilderTabUrl {
    tab: BuilderTab;
    setTab: Dispatch<SetStateAction<BuilderTab>>;
    reportBuilderState: (patch?: BuilderRunStatePatch, opts?: { replace?: boolean }) => void;
}

export interface UseBuilderTabUrlOptions {
    initialTab?: BuilderTab | null;
    initialRunId?: string | null;
    initialRunStepId?: string | null;
    onBuilderStateChange?: ((state: BuilderUrlState) => void) | null;
}

/**
 * The builder's tab, and the ?view/run/step the URL carries for it. Both
 * directions: a changed `initialTab` (browser back/forward) is adopted, and
 * every tab change is reported up. Pure navigation — no save side effects,
 * because the PUT count is a test contract.
 */
export default function useBuilderTabUrl({
    initialTab, initialRunId, initialRunStepId, onBuilderStateChange,
}: UseBuilderTabUrlOptions): BuilderTabUrl {
    // Tab navigation. Default to Build — the chat + diagram is what users
    // open the builder to do; the other tabs are jump-points for specific
    // tasks (settings, history, raw JSON).
    const [tab, setTab] = useState<BuilderTab>(initialTab || 'build');

    // Adopt a CHANGED initialTab (browser Back/Forward moving ?view=). The
    // guard ignores null on purpose: a cleared prop (URL back to the default
    // Editor view elsewhere in the tree) must never yank the user off Runs.
    const lastInitialTabRef = useRef(initialTab);
    useEffect(() => {
        if (initialTab !== lastInitialTabRef.current) {
            lastInitialTabRef.current = initialTab;
            if (initialTab) setTab(initialTab);
        }
    }, [initialTab]);

    // ── URL reporter (?view/run/step) ───────────────────────────────────
    // The shell owns the VIEW word; the runs panel reports the open run and
    // selected step through reportBuilderState. Pure navigation — no save
    // side effects (the PUT count is a test contract).
    const tabForUrlRef = useRef(tab);
    tabForUrlRef.current = tab;
    const runUrlStateRef = useRef<{ runId: string | null; stepId: string | null }>({
        runId: initialRunId || null, stepId: initialRunStepId || null,
    });
    const reportBuilderState = useCallback((patch: BuilderRunStatePatch = {}, opts: { replace?: boolean } = {}) => {
        if ('runId' in patch || 'stepId' in patch) {
            runUrlStateRef.current = {
                runId: 'runId' in patch ? (patch.runId || null) : runUrlStateRef.current.runId,
                stepId: 'stepId' in patch ? (patch.stepId || null) : runUrlStateRef.current.stepId,
            };
        }
        onBuilderStateChange?.({
            view: TAB_TO_VIEW[tabForUrlRef.current] || null,
            runId: runUrlStateRef.current.runId,
            stepId: runUrlStateRef.current.stepId,
            replace: opts.replace !== false,
        });
    }, [onBuilderStateChange]);
    const prevTabRef = useRef(tab);
    useEffect(() => {
        if (prevTabRef.current === tab) return; // mount — the URL already says this
        prevTabRef.current = tab;
        // Leaving Runs drops the open run from the URL with the view change.
        if (tab !== 'history') reportBuilderState({ runId: null, stepId: null }, { replace: true });
        else reportBuilderState({}, { replace: true });
    }, [tab, reportBuilderState]);

    return { tab, setTab, reportBuilderState };
}
