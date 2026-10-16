import type { SchemaProp } from './toolInput/toolInputHelpers';
import type { Catalog, ForEachSpec, UpstreamDefinition } from './upstream/upstream.types';
import type { RealOutputMap } from '../../../../hooks/useUpstreamVariables';

/** A tool's (or flowlet's) input schema, as far as auto-map reads it. */
export interface InputSchema {
    properties?: Record<string, SchemaProp>;
    required?: string[];
}

/** The members of a step auto-map reads or writes; the rest rides through. */
export type AutoMapStep = {
    id?: string;
    type?: string;
    label?: string;
    tool?: string;
    layerKey?: string;
    inputs?: Record<string, unknown>;
    fields?: unknown;
    forEach?: ForEachSpec | null;
    sourceRef?: string;
    arrayRef?: string;
    overRef?: string;
    expr?: string;
    operations?: unknown[];
    autoMapped?: string[];
};

export type AutoMapDefinition = {
    steps?: AutoMapStep[];
};

export interface AutoMapStepResult<S extends AutoMapStep = AutoMapStep> {
    step: S & AutoMapStep;
    mappedKeys: string[];
    forEachEnabled?: boolean;
}

export interface AutoMapOptions {
    maxPerStep?: number;
    /** false leaves list inputs without a column (autoMapStep, while it decides whether the step runs once per item). */
    listColumns?: boolean;
    realOutputById?: RealOutputMap | null;
}

/** One field of an upstream group, flattened with where it sits. */
export interface Candidate {
    key: string;
    path: string;
    type: string;
    sample: unknown;
    groupLabel?: string;
    groupIndex: number;
    fieldIndex: number;
    weight: number;
}

/** Tool catalog as far as findInputSchemaForTool reads it. */
export interface ToolCatalogLike extends Catalog {
    apps?: Array<{ actions?: Array<{ name?: string; outputSample?: unknown; outputSchema?: unknown; inputSchema?: object | null }> }>;
}

export type { Binding } from './itemRefs';
export type { FlowDefinition, FlowStep } from '../flow/types';
export type { ForEachSpec, UpstreamDefinition };
