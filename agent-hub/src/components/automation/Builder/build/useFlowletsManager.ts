import { useCallback, useState } from 'react';
import { toast } from '../../../shared/Toast';
import {
    countLayerRefs, createLayerInDefinition, deleteLayerAndCalls, deleteLayerFromDefinition,
    isLayerEmpty, renameLayer, setLayerDescription,
} from '../flow/flowletScope';
import scopedStorage from '../../../../utils/scopedStorage';


export interface UseFlowletsManagerOptions {
    rootDef: any;
    scopeKey: string | null;
    setScopeKey?: ((key: string | null) => void) | null;
    onVisualEditRoot?: ((def: any) => void) | null;
    confirmAction: (opts: any) => Promise<boolean>;
    builderApi: any;
}

/**
 * The Flowlets manager drawer: its open state, the AI-summary opt-in and the
 * create / rename / delete / summarise handlers. Split out of BuildTab without
 * a change in behaviour.
 */
export default function useFlowletsManager({
    rootDef, scopeKey, setScopeKey, onVisualEditRoot, confirmAction, builderApi,
}: UseFlowletsManagerOptions) {
    // Flowlets manager drawer (bottom-left button → docked right drawer).
    const [layersOpen, setLayersOpen] = useState(false);
    // Which flowlet's AI summary is currently generating (one at a time).
    const [summarizingKey, setSummarizingKey] = useState<string | null>(null);
    // The main flow (root) gets its own summary flag.
    const [summarizingRoot, setSummarizingRoot] = useState(false);
    // AI flowlet summaries are opt-in and OFF by default — no LLM call ever
    // fires unless the user ticks this. Persisted per-user, mirrors the
    // auto-map-on-connect toggle.
    const [aiSummaryEnabled, setAiSummaryEnabled] = useState(
        () => scopedStorage.getItem('layerAiSummaries') === '1',
    );
    const toggleAiSummary = useCallback(() => {
        setAiSummaryEnabled(v => {
            const next = !v;
            scopedStorage.setItem('layerAiSummaries', next ? '1' : '0');
            return next;
        });
    }, []);

    // ── Flowlets manager wiring ─────────────────────────────────────────────
    // All edits go through onVisualEditRoot (whole-document commit) so they
    // share the builder's undo/autosave path. Reuses the same pure helpers
    // the palette + header already use. The popover is bottom-left, so it
    // doesn't conflict with the right-edge palette/inspector.
    const refCountFor = useCallback((key: string) => countLayerRefs(rootDef, key), [rootDef]);

    const handleCreateLayer = useCallback(() => {
        const { definition: withLayer, layerKey } = createLayerInDefinition(rootDef, 'New flowlet');
        onVisualEditRoot?.(withLayer);
        // Drill straight into the fresh flowlet so the user can start building.
        // (Unlike the palette's "Create flowlet", this does NOT drop a
        // call_layer node — the manager creates the reusable flowlet itself;
        // the user wires a call where they want it via the palette.)
        setScopeKey?.(layerKey);
    }, [rootDef, onVisualEditRoot, setScopeKey]);

    const handleRenameLayer = useCallback((key: string, title: string) => {
        onVisualEditRoot?.(renameLayer(rootDef, key, title));
    }, [rootDef, onVisualEditRoot]);

    const handleDeleteLayer = useCallback(async (key: string) => {
        const refs = countLayerRefs(rootDef, key);
        // A flowlet with steps in it and callers on the canvas stays protected —
        // deleting it would silently break those flows. An EMPTY one is a
        // different story: the palette's "Create flowlet" drops a call node as
        // part of creating it, so a brand-new flowlet was born un-deletable
        // (BFSF-340). Nothing is lost, so the call sites go with it.
        if (refs > 0) {
            if (!isLayerEmpty(rootDef, key)) return;
            const label = rootDef?.layers?.[key]?.title || key;
            const ok = await confirmAction({
                title: `Delete the empty flowlet “${label}”?`,
                description: `Its ${refs} “Call flowlet” ${refs === 1 ? 'step' : 'steps'} on the canvas ${refs === 1 ? 'is' : 'are'} removed too; the steps around ${refs === 1 ? 'it' : 'them'} reconnect.`,
                confirmLabel: 'Delete',
                destructive: true,
            });
            if (!ok) return;
            onVisualEditRoot?.(deleteLayerAndCalls(rootDef, key));
            if (scopeKey === key) setScopeKey?.(null);
            return;
        }
        onVisualEditRoot?.(deleteLayerFromDefinition(rootDef, key));
        if (scopeKey === key) setScopeKey?.(null);
    }, [rootDef, onVisualEditRoot, scopeKey, setScopeKey, confirmAction]);

    const handleSummarizeLayer = useCallback(async (key: string) => {
        const layer = rootDef?.layers?.[key];
        if (!layer) return;
        setSummarizingKey(key);
        try {
            const r = await builderApi.summariseLayer(layer);
            const summary = (r?.summary || '').trim();
            if (summary) onVisualEditRoot?.(setLayerDescription(rootDef, key, summary));
            else toast.error('No summary was generated — try again.');
        } catch (e: any) {
            toast.error(`Could not summarise flowlet. ${e.message || ''}`.trim());
        } finally {
            setSummarizingKey(null);
        }
    }, [rootDef, builderApi, onVisualEditRoot]);

    // AI summary of the WHOLE automation (the main/root flow). The summarise
    // endpoint takes any flow shape, so we pass the root definition and store
    // the one-liner on definition.description (mirrors flowlet descriptions).
    const handleSummarizeRoot = useCallback(async () => {
        if (!rootDef?.trigger) return;
        setSummarizingRoot(true);
        try {
            const flow = { ...rootDef, steps: Array.isArray(rootDef.steps) ? rootDef.steps : [] };
            const r = await builderApi.summariseLayer(flow);
            const summary = (r?.summary || '').trim();
            if (summary) onVisualEditRoot?.({ ...rootDef, description: summary });
            else toast.error('No summary was generated — try again.');
        } catch (e: any) {
            toast.error(`Could not summarise the main flow. ${e.message || ''}`.trim());
        } finally {
            setSummarizingRoot(false);
        }
    }, [rootDef, builderApi, onVisualEditRoot]);

    return {
        layersOpen, setLayersOpen, summarizingKey, summarizingRoot, aiSummaryEnabled, toggleAiSummary,
        refCountFor, handleCreateLayer, handleRenameLayer, handleDeleteLayer, handleSummarizeLayer, handleSummarizeRoot,
    };
}
