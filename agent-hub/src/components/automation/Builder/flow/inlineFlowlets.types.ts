import type { graphNodes } from './dagreLayout';
import type { SidecarEntry } from './diagramPaneTypes';
import type { Position } from '../applyAddNode.types';
import type { FlowDefinition, FlowEdge } from './types';

export type LayoutStep = ReturnType<typeof graphNodes>[number];

export type Dims = { width: number; height: number };

export type ShiftById = Map<string, { dx: number; dy: number }> | null;

/** What composeInlineGraph records per expanded container (the sidecar). */
export interface InlineEntry extends SidecarEntry {
    kind: 'layer' | 'loop';
    layerKey?: string | null;
    callStepId: string;
    parentPrefix: string;
    depth: number;
    origin: Position;
    childIds: string[];
    triggerId: string | null;
    layerRef: FlowDefinition | null;
}

export type InlineSidecar = Map<string, InlineEntry>;

/** A flat-graph edge whose two ends are known. */
export type FlatEdge = FlowEdge & { from: string; to: string };
