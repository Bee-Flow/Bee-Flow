/**
 * Shapes shared by DiagramPane and the hooks split out of it. The definition
 * is the automation's JSON; only the fields the canvas reads are named, the
 * rest passes through untouched.
 */
import type { Node, ReactFlowInstance } from '@xyflow/react';

export type StepId = string;

export interface DiagramStep {
    id: StepId;
    type?: string;
    pinnedOutput?: unknown;
    disabled?: boolean;
    icon?: string;
    layerKey?: string;
    [key: string]: unknown;
}

export interface DiagramEdge {
    from?: StepId;
    to?: StepId;
    [key: string]: unknown;
}

export interface DiagramDefinition {
    trigger?: DiagramStep | null;
    triggers?: DiagramStep[];
    steps?: DiagramStep[];
    edges?: DiagramEdge[];
    [key: string]: unknown;
}

/** One expanded flowlet or loop folded into the flat graph (inlineFlowlets.js). */
export interface SidecarEntry {
    prefix: string;
    kind?: string;
    triggerId?: StepId | null;
    size: { width: number; height: number };
    [key: string]: unknown;
}

export type Sidecar = Map<string, SidecarEntry>;

/** A run row as the canvas reads it (flow/runStatus.js). */
export interface RunRow {
    stepId?: StepId;
    status?: string;
    output?: unknown;
    finishedAt?: string;
    piiSummary?: unknown;
    [key: string]: unknown;
}

export type RunByStep = Map<StepId, RunRow>;

export type DefinitionEmitter = ((next: DiagramDefinition) => void) | null | undefined;

export type Rf = ReactFlowInstance;
export type FlowNode = Node;
