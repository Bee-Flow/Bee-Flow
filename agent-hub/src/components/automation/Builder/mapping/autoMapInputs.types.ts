import type { SchemaProp } from './toolInput/toolInputHelpers';

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
    fields?: Record<string, unknown>;
    forEach?: object | null;
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
    realOutputById?: Map<string, unknown> | null;
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
export interface ToolCatalogLike {
    apps?: Array<{ actions?: Array<{ name?: string; inputSchema?: object | null } | null> }>;
    [key: string]: unknown;
}
