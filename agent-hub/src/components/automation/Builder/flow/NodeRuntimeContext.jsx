import { createContext, useContext } from 'react';

/**
 * Per-node runtime state surfaced to every step-node via context so we
 * don't have to thread these props through the per-type node components.
 *
 * Provided by DiagramPane based on the current definition + run state:
 *   - pinnedById      : Set<stepId> — which nodes have pinnedOutput set
 *   - disabledById    : Set<stepId> — which nodes are user-disabled
 *   - onExecuteStep   : (stepId) => void — fires the partial-run endpoint
 *   - executingStepId : stepId|null — node currently mid-partial-execute
 *   - runInFlight     : boolean — a global dry/full run is going
 *   - runIndexById    : Map<stepId, number> — 1-based completion ordinal
 *   - runTotal        : number|null — total dispatched steps in run
 *   - onOpenLayer     : (layerKey) => void — drill into an inline flowlet
 *   - layerSummaries  : Record<layerKey, string> — AI/human one-liners,
 *                       so a call_layer node can show what the flowlet does
 *   - highlightedStepId : stepId|null — briefly ringed (e.g. after the user
 *                       clicks a validation issue to jump to its node)
 *   - onDetachNode    : (stepId) => void — unwire a step but keep it on canvas
 *   - onPatchStep     : (stepId, patch) => void — shallow-merge a patch onto
 *                       one step's own fields, no edge surgery. A node that
 *                       edits itself in place (a note's inline text/size/
 *                       color — BFSF-411) writes through this instead of
 *                       going via the settings panel.
 *   - attachedIds     : Set<stepId> — nodes touched by at least one edge, so
 *                       the Disconnect affordance is hidden on loose cards
 *   - onToggleInline  : (nodeId, layerKey) => void — expand/collapse a
 *                       call_layer node's flowlet in place on this canvas
 *   - inlineExpanded  : Set<nodeId> — which call_layer nodes are expanded
 *   - layerRefCounts  : Record<layerKey, number> — how many call sites a
 *                       flowlet has, so an expanded container can warn that
 *                       editing it changes every one of them
 *
 * Added by the builder redesign (Sep 2026) — the card derives its whole
 * visual identity from these three maps, so no node file passes them:
 *   - typeGroupById   : Map<stepId, family> — the step's visual family
 *                       (flow/nodeDefs.js `stepFamily`), painting the 4px bar
 *                       and the icon tile
 *   - stepTypeById    : Map<stepId, runtimeType> — for the tile-shape
 *                       exceptions (a form page is a circle) and the kicker
 *   - stepNumberById  : Map<stepId, string|number> — the ordinal in run order
 *                       (flow/flowOrder.js); a step inside an expanded
 *                       container reads `13·1`
 *   - onPinNode       : (stepId) => void — freeze / release the last output
 *                       from the card's action chrome (the same patch the
 *                       node editor's Pin button writes)
 *   - pinnableIds     : Set<stepId> — nodes with a captured output to freeze
 *
 * Added by the build choreography (flow/useBuildChoreography.js) — while the
 * AI builds, the card reads these to stamp `data-build` on its root. They
 * change once per tool call, never per streamed token:
 *   - buildFxById     : Map<stepId, {kind:'fresh'|'touched', delayMs, at,
 *                       touchedAt?}> — cards revealing (with a per-card delay,
 *                       so a burst lands one at a time) or freshly edited
 *   - frontierId      : stepId|null — the one card the AI is working from; the
 *                       only `--accent` outline on the canvas. The card shows
 *                       it only without a run status: the closed status
 *                       vocabulary (shared/statusTokens.ts) always wins.
 *
 * Defaults give read-only inspector contexts (executions drawer) sane
 * behaviour without provider wiring.
 */
export const NodeRuntimeContext = createContext({
    pinnedById: new Set(),
    disabledById: new Set(),
    onExecuteStep: null,
    executingStepId: null,
    runInFlight: false,
    runIndexById: new Map(),
    runTotal: null,
    onOpenLayer: null,
    layerSummaries: {},
    highlightedStepId: null,
    onDetachNode: null,
    onPatchStep: null,
    attachedIds: new Set(),
    onToggleInline: null,
    inlineExpanded: new Set(),
    layerRefCounts: {},
    undeletableIds: new Set(),
    typeGroupById: new Map(),
    stepTypeById: new Map(),
    stepNumberById: new Map(),
    onPinNode: null,
    pinnableIds: new Set(),
    // The step open in the bottom drawer (design 1h), its direct sources
    // (drawn dashed, kicker "· source") and what comes next (dimmed).
    editingStepId: null,
    editingSourceIds: new Set(),
    editingTargetIds: new Set(),
    // Build choreography flags — empty outside a DiagramPane build.
    buildFxById: new Map(),
    frontierId: null,
});

export function useNodeRuntime() {
    return useContext(NodeRuntimeContext);
}
