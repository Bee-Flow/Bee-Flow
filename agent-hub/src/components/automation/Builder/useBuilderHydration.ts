import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { FlowDefinition } from './flow/types';
import type { BuilderSnapshot } from '../../../hooks/builderStream';
import type { AutomationBuilderState } from '../../../hooks/useAutomationBuilderStream';
import { API_BASE, authFetch } from '../../../utils/helpers';

/**
 * The persisted row behind the builder — an automation, or a reusable Step.
 * Only what the shell reads off it is named; the server owns the rest.
 */
export interface AutomationRow {
    id?: string;
    title?: string;
    definition?: FlowDefinition | null;
    isActive?: boolean;
    isDraft?: boolean;
    triggerType?: string;
    [key: string]: unknown;
}

export interface BuilderHydration {
    serverAutomation: AutomationRow | null;
    setServerAutomation: Dispatch<SetStateAction<AutomationRow | null>>;
    /** True once the snapshot fetch has settled — the last-run restore waits for it. */
    hasHydrated: boolean;
}

export interface UseBuilderHydrationOptions {
    state: AutomationBuilderState;
    automationId?: string | null;
    /** api.getAutomation or api.getStep, picked by the caller from `isStep`. */
    apiGetOne: (id: string) => Promise<unknown>;
    /** Peels the `{ automation }` / `{ step }` envelope off a response. */
    unwrapRow: (body: unknown) => AutomationRow | null;
    isStep: boolean;
    hydrate: (snapshot: BuilderSnapshot | null | undefined) => void;
    hydrateLastRun: (automationId?: string | null) => void;
    onAutomationIdResolved?: ((automationId: string) => void) | null;
}

/**
 * The server's own copy of this routine, and what it takes to come back to a
 * builder that was left open: the row behind the header, the builder-session
 * snapshot that restores the chat and the draft, and the last run that gives
 * the edges their chips back.
 *
 * Run data is deliberately absent from the snapshot (step outputs reach
 * hundreds of KB and the server already stores them), which is why the last
 * run is fetched separately and never clobbers live rows.
 */
export default function useBuilderHydration({
    state, automationId, apiGetOne, unwrapRow, isStep, hydrate, hydrateLastRun, onAutomationIdResolved,
}: UseBuilderHydrationOptions): BuilderHydration {
    const [serverAutomation, setServerAutomation] = useState<AutomationRow | null>(null);
    const [hasHydrated, setHasHydrated] = useState(false);

    // Refetched on every dry run and finalize — and on every `metadata`
    // event (state.metadataSeq): the header shows the server row's title, and
    // until this a routine the model named mid-build, or the server named at
    // the end of a turn, read "Untitled automation" up top until a reload.
    useEffect(() => {
        const aid = state.automationId || automationId;
        if (!aid) return;
        let alive = true;
        apiGetOne(aid).then(d => { if (alive) setServerAutomation(unwrapRow(d)); }).catch(() => {});
        return () => { alive = false; };
    }, [state.automationId, automationId, state.dryRun, state.finalizedId, state.metadataSeq]); // eslint-disable-line

    // Report the resolved automation id upward so the parent can reflect it in
    // the URL path. Covers the lazy-create flow where a brand-new automation
    // only gets an id after the first save (chat turn or visual edit).
    useEffect(() => {
        const aid = state.automationId || automationId;
        if (aid) onAutomationIdResolved?.(aid);
    }, [state.automationId, automationId, onAutomationIdResolved]);

    // One-shot snapshot rehydration. On mount with an existing automation
    // id, fetch the latest builder-session snapshot and hydrate so the
    // chat panel + draft + summary survive a refresh or SSE drop.
    useEffect(() => {
        const aid = state.automationId || automationId;
        if (!aid || hasHydrated) return;
        // Steps have no AI-chat builder session to rehydrate (v1 visual build).
        if (isStep) { setHasHydrated(true); return; }
        let alive = true;
        (async () => {
            try {
                const r = await authFetch(`${API_BASE}/api/automation/builder/session/${aid}`);
                if (!alive) return;
                if (r.ok) {
                    const j: { snapshot?: BuilderSnapshot } | null = await r.json();
                    if (j?.snapshot) hydrate(j.snapshot);
                }
            } catch { /* silent — snapshot is optional */ }
            if (alive) setHasHydrated(true);
        })();
        return () => { alive = false; };
    }, [state.automationId, automationId, hasHydrated, hydrate]);

    // Run data lives only in memory; the snapshot deliberately excludes it
    // (step outputs can be 256 KB each and the server already stores them).
    // Restore the LAST run lazily so edge chips, real samples and the pin
    // button survive a refresh. hydrateLastRun never clobbers live rows.
    useEffect(() => {
        const aid = state.automationId || automationId;
        if (!aid || !hasHydrated) return;
        hydrateLastRun(aid);
    }, [state.automationId, automationId, hasHydrated, hydrateLastRun]);

    return { serverAutomation, setServerAutomation, hasHydrated };
}
