import type { FlowDefinition, FlowEdge, FlowStep } from './flow/types';
import type { AddStepPayload, Position } from './build/addStepModel';

export type { AddStepPayload, FlowDefinition, FlowEdge, FlowStep, Position };

/** A step (or trigger) freshly scaffolded from a palette payload. */
export interface BuiltStep {
    id: string;
    type: string;
    position: Position;
    [key: string]: unknown;
}
