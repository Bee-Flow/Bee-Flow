import type { AppAction, AppDefinition, AppNode, FormFieldRef } from '../inspector/appDefinition';
import type { GraphNode, GraphEdge } from './stepGraph';
import type React from 'react';

export interface FlowBodyProps {
    action: AppAction | null | undefined;
    onChange: (next: AppAction) => void;
    definition: AppDefinition;
    node?: AppNode | null;
    disabled?: boolean;
    formFields?: FormFieldRef[];
}

export type FlowGraph = { nodes: GraphNode[]; edges: GraphEdge[] };

/**
 * One node on the canvas: a step, or a branch's entry pill.
 *
 * A step draws with StepNodeBase — the SAME chrome the automations canvas uses
 * for its own steps. Not only for looks: it brings the hover actions (duplicate,
 * delete), the "+" that adds a step right after this one, the validation badge
 * and the per-branch output ports, all behaving exactly as they do in the
 * automation builder. Somebody who has wired an automation already knows how to wire
 * an app.
 *
 * Those actions arrive through NodeRuntimeContext, which is how StepNodeBase
 * reads them there too — so nothing about that component had to change to serve
 * a second canvas.
 */
export interface StepFlowNodeData {
    node: GraphNode;
    selected: boolean;
    summary: { text: string; missing: boolean };
    onSelect: () => void;
    onAdd: () => void;
    onAddAfter: (() => void) | null;
    onContextMenu: ((e: React.MouseEvent) => void) | undefined;
    disabled: boolean;
}

export interface StepFlowNodeArgs {
    id: string | null;
    data: StepFlowNodeData;
}

export interface StepPaletteProps {
    onPick: (kind: string) => void;
    onCancel: () => void;
}
