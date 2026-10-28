import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BuildTabProps } from './buildTabTypes';
import type { DiagramHandle } from './jsComponents';
import useAddStep from './useAddStep';
import useBuildCue from './useBuildCue';
import { useAddSurfaces, useContextPalette } from './useContextPalette';
import type { ContextPalette } from './useContextPalette';
import useExpandedFlowletGraph from './useExpandedFlowletGraph';
import useFlowletsManager from './useFlowletsManager';
import useLiveRun from './useLiveRun';
import useSmartAddStep from './useSmartAddStep';
import useStepGraphEdits from './useStepGraphEdits';
import useAutomationApi from '@/hooks/useAutomationApi';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslateFn } from '@/hooks/useTranslation';
import scopedStorage from '@/utils/scopedStorage';
import { toast } from '@/components/shared/Toast';
import { useBuilderConfirm } from '../BuilderConfirmContext';
import { layerKeysThatReach, listLayers } from '../flow/flowletScope';
import { isInlineId, parseInlineId } from '../flow/inlineFlowlets';
import type { PaletteLayer } from '../flow/stepPalette.types';
import type { FlowDefinition, FlowStep } from '../flow/types';
import useWaitingFormUrlJs from '../flow/useWaitingFormUrl';
import { buildRealOutputMap } from '../mapping/realOutputs';

// useWaitingFormUrl.js documents its id as a string; it is null before the first save.
const useWaitingFormUrl = useWaitingFormUrlJs as (api: unknown, automationId: string | null, waiting: boolean) => string | null;

/** The tool/step catalog as the server sends it (GET /automations/catalog). */
type Catalog = Record<string, unknown> | null;

/** The step catalog, fetched once (again after Apply created tables). */
function useCatalog(builderApi: { getCatalog: () => Promise<unknown> }, catalogNonce: number) {
    const [catalog, setCatalog] = useState<Catalog>(null);
    useEffect(() => {
        let alive = true;
        builderApi.getCatalog().then(c => { if (alive) setCatalog(c as Catalog); }).catch(() => {});
        return () => { alive = false; };
    }, [builderApi, catalogNonce]);
    return catalog;
}

/**
 * Briefly rings the node a clicked validation issue is about, then clears
 * itself — see FloatingValidationPill's onFocusStep. The drawer takes the
 * bottom of the column, so the step being edited is brought into view above
 * it once the canvas has re-measured (design 1h).
 */
function useStepFocus(diagramRef: { current: DiagramHandle | null }, openNdv: BuildTabProps['openNdv'], ndvStepId: string | null, ndvDensity: string) {
    useEffect(() => {
        if (!ndvStepId) return undefined;
        const timer = setTimeout(() => diagramRef.current?.focusStep?.(ndvStepId), 80);
        return () => clearTimeout(timer);
    }, [ndvStepId, ndvDensity, diagramRef]);

    const [highlightedStepId, setHighlightedStepId] = useState<string | null>(null);
    const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const onFocusStep = useCallback((stepId: string) => {
        if (!stepId) return;
        openNdv?.(stepId);
        diagramRef.current?.focusStep?.(stepId);
        setHighlightedStepId(stepId);
        clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = setTimeout(() => setHighlightedStepId(null), 2000);
    }, [openNdv, diagramRef]);
    useEffect(() => () => clearTimeout(highlightTimerRef.current), []);
    return { highlightedStepId, onFocusStep };
}

/**
 * Flowlet rows for the palette — always computed from the ROOT def (flowlets
 * live only at root). When scoped, hide any flowlet whose call closure reaches
 * the current one (including itself) so the user can't wire a reference cycle
 * from the palette. Plus the AI/human flowlet descriptions keyed by flowlet
 * key, surfaced on call_layer nodes via NodeRuntimeContext.
 */
function useLayerRows(rootDef: FlowDefinition | null, scopeKey: string | null) {
    const paletteLayers = useMemo(() => {
        const all = listLayers(rootDef) as Array<{ key: string }>;
        if (!scopeKey) return all;
        const blocked = layerKeysThatReach(rootDef, scopeKey) as Set<string>;
        return all.filter(l => !blocked.has(l.key));
    }, [rootDef, scopeKey]);
    const layerSummaries = useMemo(() => {
        const m: Record<string, string> = {};
        for (const [k, l] of Object.entries(rootDef?.layers || {})) {
            if (l?.description) m[k] = l.description as string;
        }
        return m;
    }, [rootDef]);
    return { paletteLayers, layerSummaries };
}

/**
 * Which graph the positioned palette is adding to: a "+" on a node or an
 * edge inside an expanded flowlet is adding to THAT flowlet, so it gets the
 * in-flowlet catalogue (no triggers, nothing that pauses the run).
 */
function positionedPaletteScope(palette: ContextPalette, scopeKey: string | null, flatDef: FlowDefinition | null) {
    const palettePrefix = parseInlineId(palette.edgeSource || palette.edgeTarget || '').prefix;
    const inLayer = !!scopeKey || !!palettePrefix;
    const canAddLayerOutput = inLayer && !(flatDef?.steps || []).some(
        s => s?.type === 'layer_output' && parseInlineId(s.id).prefix === palettePrefix,
    );
    return { inLayer, canAddLayerOutput };
}

/**
 * The scopes of the two add surfaces. The ribbon is a browse surface with no
 * target yet, so it stays on the canvas's own scope; the positioned palette
 * narrows further. Inside a flowlet there is always a layer_input trigger, so
 * the mode is 'step' whenever we're scoped.
 */
function paletteScopes({ catalog, paletteLayers, scopeKey, scopedDef, flatDef, palette, isBlockRoot, smart, t }: {
    catalog: Catalog; paletteLayers: PaletteLayer[]; scopeKey: string | null; scopedDef: FlowDefinition | null;
    flatDef: FlowDefinition | null; palette: ContextPalette; isBlockRoot: boolean;
    smart: { frequentItems: unknown[]; suggestedItems: unknown[] }; t: TranslateFn;
}) {
    const mode = scopedDef?.trigger ? 'step' : 'trigger';
    const paletteScope = {
        catalog,
        layers: paletteLayers,
        inLayer: !!scopeKey,
        canAddLayerOutput: !!scopeKey && !(scopedDef?.steps || []).some(s => s?.type === 'layer_output'),
        isBlockRoot,
        mode,
        frequent: smart.frequentItems,
        // The form steps ride on the automation's own public form URL, so the
        // validator rejects them outright without a form trigger (the primary
        // trigger or any secondary one).
        hasFormTrigger: [scopedDef?.trigger, ...(scopedDef?.triggers || [])].some(tr => tr?.kind === 'form'),
        t,
    };
    const positioned = positionedPaletteScope(palette, scopeKey, flatDef);
    const contextScope = {
        catalog, layers: paletteLayers, inLayer: positioned.inLayer, canAddLayerOutput: positioned.canAddLayerOutput,
        isBlockRoot, mode, suggested: smart.suggestedItems, frequent: smart.frequentItems,
    };
    return { paletteScope, contextScope };
}

/**
 * Everything BuildTab computes before it renders: the canvas graph, the add
 * paths, the run, the step drawer's edits. Split out of BuildTab without a
 * change in behaviour.
 */
export default function useBuildTabModel(p: BuildTabProps) {
    const { state, rootDef, scopedDef, scopeKey, setScopeKey, onVisualEditRoot, mode = 'automation' } = p;
    const confirmAction = useBuilderConfirm() as (opts: { title: string; description: string; confirmLabel: string; destructive: boolean }) => Promise<boolean>;
    const diagramRef = useRef<DiagramHandle | null>(null);
    // The ribbon's root element, handed to the canvas so the build film can
    // deal each card FROM the ribbon command that would have added it.
    const ribbonRootRef = useRef<HTMLDivElement | null>(null);
    const { highlightedStepId, onFocusStep } = useStepFocus(diagramRef, p.openNdv, p.ndvStepId, p.ndvDensity || 'full');

    const builderApi = useAutomationApi() as { getCatalog: () => Promise<unknown> };
    // A run parked on a form page: the canvas's run banner offers a way
    // straight to it (design 1d).
    const waitingFormUrl = useWaitingFormUrl(builderApi, p.automation?.id || null, (state?.steps || []).some(row => row?.status === 'awaiting_form'));
    const { t } = useTranslation();
    const catalog = useCatalog(builderApi, p.catalogNonce || 0);

    // `flatDef` is the canvas graph with the opened flowlets folded in; every
    // edit is split back out by `onVisualEditFlat`.
    const flowlets = useExpandedFlowletGraph({
        automation: p.automation, state, scopedDef, rootDef, scopeKey,
        onVisualEdit: p.onVisualEdit, onVisualEditRoot, closeNdv: p.closeNdv, diagramRef,
    });
    const { flatDef, inlineSidecar, inlineShift, onVisualEditFlat } = flowlets;
    const buildCue = useBuildCue({ state, flatDef, t });

    // What each node ACTUALLY produced (pinned > last run, hygiene-filtered).
    const realOutputById = useMemo(() => buildRealOutputMap(scopedDef, state.steps), [scopedDef, state.steps]);

    // Auto-map-on-connect preference (on by default), per-user — read on mount.
    // The toggle lives in Profile › Preferences › Editor preferences.
    const [autoMapEnabled] = useState(() => scopedStorage.getItem('autoMapOnConnect') !== '0');

    const manager = useFlowletsManager({ rootDef, scopeKey, setScopeKey, onVisualEditRoot, confirmAction, builderApi });
    const { paletteLayers, layerSummaries } = useLayerRows(rootDef, scopeKey);
    const ctx = useContextPalette();
    const smart = useSmartAddStep({ palette: ctx.palette, scopedDef, catalog, paletteLayers });
    const run = useLiveRun({ state, pollRunProgress: p.pollRunProgress, flatDef });

    const addStepAt = useAddStep({
        flatDef, inlineSidecar, inlineShift, rootDef, scopeKey, setScopeKey, onVisualEditFlat, onVisualEditRoot,
        autoMapEnabled, catalog, realOutputById, recordUsage: smart.recordUsage, confirmAction, t, diagramRef,
    });
    const surfaces = useAddSurfaces({
        palette: ctx.palette, setPalette: ctx.setPalette, closePalette: ctx.closePalette, addStepAt,
        onRequestAddAfter: ctx.onRequestAddAfter, catalog, paletteLayers, flatDef, ndvStepId: p.ndvStepId,
    });
    const edits = useStepGraphEdits({
        rootDef, flatDef, running: !!state.running, inlineSidecar, onVisualEditRoot, onVisualEditFlat, onSaveStep: p.onSaveStep, t,
    });
    const drawer = useStepDrawer(p, flatDef, ctx.palette.open, ctx.closePalette);
    const { paletteScope, contextScope } = paletteScopes({
        catalog, paletteLayers, scopeKey, scopedDef, flatDef, palette: ctx.palette, isBlockRoot: mode === 'step', smart, t,
    });

    return {
        t, diagramRef, ribbonRootRef, highlightedStepId, onFocusStep, waitingFormUrl, catalog, flowlets, buildCue,
        realOutputById, autoMapEnabled, manager, layerSummaries, ctx, smart, run, surfaces, edits, drawer,
        paletteScope, contextScope,
    };
}

export type BuildTabModel = ReturnType<typeof useBuildTabModel>;

/**
 * The step drawer (NodeDetailView) and the lock that keeps it shut while the
 * AI is building. Every other edit surface is already frozen for the duration
 * (the ribbon is `disabled`, the canvas honours `structuralEditsBlocked`), and
 * this drawer was the one way left to change a step the AI is in the middle of
 * rewriting. Refusing to OPEN it is the only complete lock: the panel has
 * dozens of controls, and a version that renders them live while
 * persistStepPatch silently no-ops is worse than no panel at all.
 */
function useStepDrawer(p: BuildTabProps, flatDef: FlowDefinition | null, paletteOpen: boolean, closePalette: () => void) {
    const { state, ndvStepId, openNdv, closeNdv, stepById, runStepById } = p;
    const { t } = useTranslation();
    const editsLocked = !!state.running;
    const refuseWhileBuilding = useCallback(() => {
        toast.info(t('automations.builder.edits_locked', 'The AI is building this automation — editing is paused until it finishes.'));
    }, [t]);

    // Clicking a node opens its Node Detail View — close the palette first.
    const onNodeClickWrapped = useCallback((id: string) => {
        if (paletteOpen) closePalette();
        if (editsLocked) { refuseWhileBuilding(); return; }
        openNdv?.(id);
    }, [paletteOpen, closePalette, openNdv, editsLocked, refuseWhileBuilding]);

    // Double-click means "show me everything about this step": the single
    // click already opened the small editor, and this grows it in place.
    const onNodeExpand = useCallback((id: string) => {
        if (paletteOpen) closePalette();
        if (editsLocked) { refuseWhileBuilding(); return; }
        openNdv?.(id, 'full');
    }, [paletteOpen, closePalette, openNdv, editsLocked, refuseWhileBuilding]);

    // A build can start while the drawer is already open. Close it rather than
    // leave a live form over a graph that is being replaced underneath it; the
    // `key={ndvStep.id}` remount flushes the in-flight autosave on the way out.
    useEffect(() => {
        if (editsLocked && ndvStepId) closeNdv?.();
    }, [editsLocked, ndvStepId, closeNdv]);

    // The step open in the drawer (null = closed). A node inside an expanded
    // flowlet only exists in the flat graph, so it is looked up there.
    let ndvStep: FlowStep | null = null;
    if (ndvStepId) {
        ndvStep = isInlineId(ndvStepId)
            ? ((flatDef?.steps || []).find(s => s.id === ndvStepId) || null)
            : stepById(ndvStepId);
    }
    // Sub-step run rows are namespaced `<callStepId>/<subStepId>` — the same id
    // the inline node carries — so an expanded flowlet's steps show their own
    // run data instead of the call step's.
    const ndvRunStep = useCallback((id: string) => (isInlineId(id)
        ? ((state.steps || []).find(s => s.stepId === id) || null)
        : runStepById(id)), [state.steps, runStepById]);

    return { editsLocked, onNodeClickWrapped, onNodeExpand, ndvStep, ndvRunStep };
}
