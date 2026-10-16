import { useStore, useStoreApi } from '@xyflow/react';
import { useMemo, useRef } from 'react';
import { buildIssuesByStep } from './matchValidationToStep';
import { effectiveRunByStep } from './runStatus';
import { selectMeasuredIds, useOpeningFit } from './useOpeningFit';
import { useCanvasWheel } from './useCanvasWheel';
import { useEdgeColorMode } from './useEdgeColorMode';
import { useFurnitureFit } from './useFurnitureFit';
import { useInlineFlowletGraph } from './useInlineFlowletGraph';
import { useLegendPreference } from './useLegendPreference';
import { usePresenterToggle } from './usePresenterToggle';
import type { DiagramDefinition, Rf, Sidecar, StepId } from './diagramPaneTypes';

// Below this pane height the full furniture (a 182px zoom stack under the
// north chips, a 96px minimap under the lines lens) no longer fits with room
// to breathe; the pane keeps its short set (see `shortCanvas`).
const SHORT_CANVAS_PX = 420;

interface CanvasViewArgs {
    rf: Rf;
    definition: DiagramDefinition;
    runSteps: Parameters<typeof effectiveRunByStep>[1];
    validation: Parameters<typeof buildIssuesByStep>[0];
    sidecar: Sidecar | null;
    readOnly: boolean;
    structuralEditsBlocked: boolean;
    editingStepId: StepId | null;
    replayStepId: StepId | null;
}

/**
 * What the canvas shows and how it frames it: the furniture-aware fits, the
 * expanded flowlets, wheel/touchpad input, presenter mode, the run rows the
 * nodes decorate from, the legend and line-colour preferences, and the
 * validation issues per step. View state only; nothing here edits.
 */
export function useCanvasView({
    rf, definition, runSteps, validation, sidecar, readOnly, structuralEditsBlocked, editingStepId, replayStepId,
}: CanvasViewArgs) {
    // The canvas's own fits (mount, Fit, Arrange) keep the cards clear of the
    // zoom stack, minimap, legend and chips; the build film frames its own.
    const { fit: fitAroundFurniture, mountOptions: mountFitOptions } = useFurnitureFit();
    // React Flow's mount fit frames the first cards it measures; a builder
    // opened by navigation can hydrate its real definition a moment later.
    // Until the person does anything, each new set of cards is framed again
    // (flow/useOpeningFit.ts) — never while the film, a replay or the drawer
    // owns the camera.
    const measuredKey = useStore(selectMeasuredIds);
    useOpeningFit({
        measuredKey,
        fit: fitAroundFurniture,
        enabled: !structuralEditsBlocked && !editingStepId && replayStepId == null,
    });
    // Expanded flowlets and loops (flow/useInlineFlowletGraph.ts): what is
    // open, which ids are their triggers, and the position helpers.
    const {
        hasInline, inlineExpandedIds, inlineTriggerIds, inLoopBody, absPositionOf, scopeAtPoint,
    } = useInlineFlowletGraph({ sidecar, rf });
    const wrapperRef = useRef(null);

    // Wheel, touchpad and pinch (flow/useCanvasWheel.ts): two fingers pan,
    // a pinch zooms around the fingers, a mouse wheel zooms as it always did.
    // Needs the wrapper, so it waits for a trigger (the empty state has none).
    const rfStore = useStoreApi();
    useCanvasWheel({ wrapperRef, rf, store: rfStore, enabled: !readOnly && !!definition?.trigger });

    // ── Presenter mode (flow/usePresenterToggle.ts) ──────────────────────
    // Bigger text for a projector; toggled from the zoom stack, Shift+P, or
    // P with nothing selected.
    const [presenter, togglePresenter] = usePresenterToggle();
    // Clicking a node opens its focused Node Detail View (NDV) — owned by the
    // parent (BuilderShell). The canvas itself no longer renders any
    // node-anchored panels.

    // Primary run rows + synthetic 'pinned' stubs for pinned nodes without a
    // run row — so a pin alone still yields edge chips and node status (e.g.
    // after a reload, when in-memory run state is gone but pins persist).
    const runByStep = useMemo(() => effectiveRunByStep(definition, runSteps), [definition, runSteps]);

    // The legend (north-east) — a per-user view preference like the
    // line-colour lens below; until the user picks, it starts closed on a
    // laptop-sized canvas (flow/useLegendPreference.ts).
    // A short canvas (the step drawer open on a laptop screen leaves a strip
    // of 220-300px) keeps only the furniture that serves the step being
    // edited: the zoom stack lies down as one row, the validation chip and
    // the south bar stay, and the minimap, Flowlets, Arrange, the Files tip,
    // the editing chip (its step number and keys are in the drawer's own
    // header), the lines lens and the legend wait until the canvas has room
    // again. The legend's stored preference is left alone.
    // 0 = not measured yet (tests, first frame): the full set.
    const paneHeight = useStore((s) => s.height);
    const shortCanvas = paneHeight > 0 && paneHeight < SHORT_CANVAS_PX;
    const paneWidth = useStore((s) => s.width);
    const [legendOpen, toggleLegend] = useLegendPreference(paneWidth, paneHeight);
    // "Colour lines by" (flow/useEdgeColorMode.ts) — a per-user presentational lens (never part of the
    // definition: it would pollute version diffs for zero shared value).
    // 'branches' by default: automatic case colours only touch case edges,
    // and manual colours render in every mode.
    const [edgeColorMode, setEdgeColorMode] = useEdgeColorMode();
    // The PII option only means something once a loaded run step carries a
    // pii summary (builder test-runs with the Privacy Shield applied to
    // automations) — offered disabled with an explanatory tooltip until then.
    const hasPiiData = useMemo(() => {
        for (const r of runByStep.values()) if (r?.piiSummary) return true;
        return false;
    }, [runByStep]);

    const issuesByStep = useMemo(
        () => buildIssuesByStep(validation, definition, sidecar),
        [validation, definition, sidecar],
    );
    return {
        fitAroundFurniture, mountFitOptions, hasInline, inlineExpandedIds, inlineTriggerIds, inLoopBody, absPositionOf,
        scopeAtPoint, wrapperRef, presenter, togglePresenter, runByStep, shortCanvas, legendOpen, toggleLegend,
        edgeColorMode, setEdgeColorMode, hasPiiData, issuesByStep,
    };
}
