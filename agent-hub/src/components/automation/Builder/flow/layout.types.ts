import type { DiagramStep, DiagramEdge, RunByStep } from './diagramPaneTypes';
import type { Position } from '../build/addStepModel';
import type { rowLayoutPositions } from './arrange';
import type { StepIssues } from './nodes/nodeProps';
import type { InlineEntry } from './inlineFlowlets';

/**
 * Auto-layout the automation graph. Returns nodes/edges in the shape
 * React Flow expects (`{id, type, position, data}` for nodes,
 * `{id, source, target, label, data}` for edges).
 *
 * Each step / trigger may carry a persisted `position: {x, y}` written
 * by the drag-and-drop builder. When *every* node has a position we
 * skip dagre and use those coordinates verbatim. If any node lacks one,
 * dagre lays the whole graph out so the canvas is never garbled — the
 * caller is expected to write the dagre-derived positions back into the
 * definition on the next save so future renders are stable.
 *
 * Inputs:
 *   def        — the draft definition: { trigger, steps[], edges[] }
 *   runByStep  — Map<stepId, runStep> for live status / output
 *   issuesByStep — Map<stepId, { errors:[], warnings:[] }> for the badge
 *   onAddAfter — optional callback (nodeId) → void; piped through node
 *                `data` so per-type wrappers can render the n8n-style
 *                "+ next step" hover button without prop-drilling.
 *   dims       — { width, height } per-node estimate; passed in by the
 *                renderer so dagre's box sizing matches the rendered card.
 *   sidecar    — Map<prefix, entry> from inlineFlowlets.composeInlineGraph
 *                when `def` is a FLAT graph with expanded flowlets folded in.
 *                Containers become sized parent nodes, their contents become
 *                React Flow child nodes (`parentId` + `extent: 'parent'`).
 *   shiftById  — Map<id, {dx,dy}> from inlineFlowlets.shiftForExpansion: the
 *                display-only offset that moves neighbours out of an expanded
 *                container's way. Never written back to the definition.
 */
/** The part of the tool catalog a card names things from. */
export interface LayoutCatalog {
    datatables?: { id: string; name?: string }[];
    knowledgeBases?: { id: string; name?: string }[];
    agents?: { id: string; name?: string }[];
}

/** A step as the layout reads it: the members beyond `id` and `type` it looks at. */
export type LayoutDiagramStep = DiagramStep & {
    position?: Position;
    label?: string;
    size?: { width?: number; height?: number };
    cases?: { name?: string }[];
};

/** An edge whose two ends are known. */
export type KnownEdge = DiagramEdge & { from: string; to: string; label?: string; caseName?: string; color?: string };

export type LayoutStepArg = Parameters<typeof rowLayoutPositions>[0][number];

export interface BuildLayoutOptions {
    runByStep?: RunByStep | null;
    issuesByStep?: Map<string, StepIssues> | null;
    onAddAfter?: ((nodeId: string) => void) | null;
    onDiagnose?: (() => void) | null;
    dims?: { width: number; height: number };
    sidecar?: Map<string, InlineEntry> | null;
    shiftById?: Map<string, { dx: number; dy: number }> | null;
    catalog?: LayoutCatalog | null;
}
