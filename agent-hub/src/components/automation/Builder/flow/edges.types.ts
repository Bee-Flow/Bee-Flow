import type { CSSProperties } from 'react';
import type { Position } from '@xyflow/react';

export interface EdgeIdentity {
    source: string;
    target: string;
    sourceHandle: string|null;
    label: string|null;
    caseName: string|null;
}

export interface LabelledEdgeData {
    parallelCount?: number;
    parallelIndex?: number;
    fromPortLabels?: boolean;
    kind?: string|null;
    editable?: boolean;
    dataSummary?: { label: string; title?: string;[key: string]: unknown; }|null;
    wrap?: { toRow: number|string; }|null;
    chipColor?: string|null;
    buildFx?: { delayMs?: number|string; }|null;
    sourceHandle?: string|null;
    defLabel?: string|null;
    defCaseName?: string|null;
    defColor?: string|null;
    labelledAtPort?: boolean;
    piiTooltip?: string|null;
    onInspect?: (stepId: string) => void;
    onSetColor?: (args: EdgeIdentity&{ color: string|null; }) => void;
    onInsert?: (identity: EdgeIdentity) => void;
    onDelete?: (identity: EdgeIdentity) => void;
}

export interface LabelledEdgeProps {
    data?: LabelledEdgeData;
    id: string;
    source: string;
    target: string;
    sourceX: number;
    sourceY: number;
    targetX: number;
    targetY: number;
    sourcePosition: Position;
    targetPosition: Position;
    markerEnd?: string;
    style?: CSSProperties;
}

/**
 * The thin dashed tether from an AI step's tool port down to one of its tools.
 *
 * Its own type rather than a styled LabelledEdge because it is NOT a
 * connection: there is no definition row behind it, so the "+" splice, the "×"
 * delete and the colour palette a LabelledEdge offers would all act on an edge
 * that does not exist. Nothing to hover, nothing to click.
 */
export interface ToolLinkEdgeProps {
    sourceX: number;
    sourceY: number;
    targetX: number;
    targetY: number;
    sourcePosition: Position;
    targetPosition: Position;
}
