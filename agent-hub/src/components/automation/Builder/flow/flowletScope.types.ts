import type { FlowStep, FlowDefinition } from './types';
import type { Position } from '../build/addStepModel';

/** A step as the flowlet helpers walk it: loop bodies and parallel branches nest more steps. */
export interface ScopeStep extends FlowStep {
    layerKey?: string;
    fields?: unknown;
    position?: Position;
    body?: ScopeStep[];
    branches?: (ScopeStep[] | { steps?: ScopeStep[] })[];
    params?: { name: string; type?: string; required?: boolean }[];
}

/** A whole definition or one flowlet's mini-definition, with the members these helpers read. */
export interface ScopeGraph extends FlowDefinition {
    title?: string;
    description?: string;
    trigger?: ScopeStep | null;
    triggers?: ScopeStep[];
    steps?: ScopeStep[];
    layers?: Record<string, ScopeGraph>;
}
