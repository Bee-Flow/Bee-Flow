import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { getScopedGraph } from './flow/flowletScope';
import type { FlowDefinition } from './flow/types';

// flowletScope.js is still JavaScript; its JSDoc says `object|null` either
// way, which TypeScript reads as nothing at all. This states the contract that
// header describes.
const scopedGraphOf = getScopedGraph as (
    def: FlowDefinition | null | undefined,
    scopeKey: string | null,
) => FlowDefinition | null;

export interface FlowletScope {
    /** null = the root canvas; a key = drilled into definition.layers[key]. */
    scopeKey: string | null;
    setScopeKey: Dispatch<SetStateAction<string | null>>;
    scopedDef: FlowDefinition | null;
}

export interface UseFlowletScopeOptions {
    effectiveDef: FlowDefinition | null | undefined;
    initialScopeKey?: string | null;
    onScopeChange?: ((scopeKey: string | null) => void) | null;
    setNdvStepId: (stepId: string | null) => void;
}

/**
 * Which canvas is on screen: the root graph, or one flowlet out of
 * definition.layers. The scope is three-way — the user drills in, the URL
 * deep-links in, and the definition can lose the flowlet under us (undo, an
 * AI rewrite, a version restore) — so all three meet here and snap back to
 * root together.
 *
 * Edits made while scoped are wrapped back into the WHOLE document before
 * history-commit or persist; only complete definitions leave the builder.
 */
export default function useFlowletScope({
    effectiveDef, initialScopeKey, onScopeChange, setNdvStepId,
}: UseFlowletScopeOptions): FlowletScope {
    // ── Flowlet scope ──────────────────────────────────────────────────────
    // null = root canvas; a flowlet key = drilled into definition.layers[key].
    // Edits made while scoped are wrapped back into the WHOLE document
    // before history-commit/persist — undo and the server only ever see
    // complete definitions.
    const [scopeKey, setScopeKey] = useState<string | null>(null);
    const scopedDef = useMemo(() => scopedGraphOf(effectiveDef, scopeKey), [effectiveDef, scopeKey]);

    // Scope guard: snap back to root when the flowlet disappears out from
    // under us (undo, AI rewrite, JSON save, version restore, hydrate).
    useEffect(() => {
        if (scopeKey && !effectiveDef?.layers?.[scopeKey]) setScopeKey(null);
    }, [scopeKey, effectiveDef]);

    // ── Flowlet scope ↔ URL ────────────────────────────────────────────────
    // Sync FROM the URL: adopt `initialScopeKey` on first load and on browser
    // back/forward. We wait until the definition actually has that flowlet
    // (the draft hydrates async), and never override the user's own drilling
    // (their setScopeKey already matches by the time the URL echo arrives).
    const lastScopeSyncRef = useRef<string | null>(null);
    useEffect(() => {
        const want = initialScopeKey || null;
        if (want === lastScopeSyncRef.current) return;
        // Hold off until the target flowlet exists, so the scope-guard above
        // can't immediately snap us back to root.
        if (want && !effectiveDef?.layers?.[want]) return;
        lastScopeSyncRef.current = want;
        setScopeKey(want);
    }, [initialScopeKey, effectiveDef]);

    // Report scope changes UP so the parent can mirror them in the path. Skips
    // the initial value (the parent already knows it from the URL) and reports
    // every change after, including the user drilling in/out.
    const reportedScopeRef = useRef<string | null | undefined>(undefined);
    useEffect(() => {
        if (reportedScopeRef.current === scopeKey) return;
        const first = reportedScopeRef.current === undefined;
        reportedScopeRef.current = scopeKey;
        if (first) return;
        onScopeChange?.(scopeKey);
    }, [scopeKey, onScopeChange]);

    // The NDV is per-canvas — a step id is only meaningful within its scope,
    // so close it when the user drills into / out of a flowlet.
    useEffect(() => {
        setNdvStepId(null);
    }, [scopeKey]);

    return { scopeKey, setScopeKey, scopedDef };
}
