import type { Field } from './fieldTree';
import type { FlowDefinition, FlowStep } from '../../flow/types';
import type { TriggerParamsSchema } from '../../flow/triggerSchemaUtils';
import type { SetOperation } from '../../flow/setOperations';

/** A form question as the builder declares it (trigger.form / form_page.form). */
export interface FormFieldDecl {
    name: string;
    type?: string;
    label?: string;
    source?: string;
    app?: string;
    multiple?: boolean;
    /** Choices: plain strings or `{ value, label?, hint? }`. */
    options?: unknown;
    /** Choices / questions that come from a list on an earlier step (form pages only). */
    optionsFrom?: unknown;
    fieldsFrom?: unknown;
}

export interface ForEachParent {
    itemVar?: string;
    overRef?: string;
}

/** A step's own `forEach` (run once per item of `overRef`). */
export interface ForEachSpec {
    overRef?: string;
    itemVar?: string;
    parents?: ForEachParent[];
}

/**
 * One node the upstream walk meets: a trigger, a step, or a loop body step.
 * Only the members the describers read are named; each describer reads its own
 * type's members.
 */
export interface UpstreamNode extends FlowStep {
    __isTrigger?: boolean;
    forEach?: ForEachSpec;
    tool?: string;
    // triggers
    params?: { name: string; type?: string }[];
    parametersSchema?: TriggerParamsSchema | null;
    appEvent?: { provider?: string; event?: string };
    schedule?: { cron?: string; tz?: string };
    form?: { fields?: FormFieldDecl[]; title?: string };
    mode?: string;
    // control flow
    expr?: string;
    cases?: { name?: string }[];
    arrayRef?: string;
    seconds?: number;
    layerKey?: string;
    // loops
    overRef?: string;
    itemVar?: string;
    batchSize?: number;
    body?: UpstreamNode[];
    // data
    datatableId?: string;
    op?: string;
    knowledgeBaseId?: string;
    sourceUri?: string;
    // documents
    format?: string;
    documentId?: string;
    documentName?: string;
    layout?: string;
    title?: string;
    notes?: string;
    chart?: { type?: string } | null;
    stats?: unknown;
    style?: unknown;
    // set / parse_json / datetime / aggregate / layer_output
    fields?: unknown;
    operations?: SetOperation[];
    sourceRef?: string;
    itemsRef?: string;
    unit?: string;
    part?: string;
    field?: string;
}

/** The slice of an automation definition the upstream walk reads. */
export interface UpstreamDefinition extends FlowDefinition {
    trigger?: UpstreamNode | null;
    triggers?: UpstreamNode[];
    steps?: UpstreamNode[];
    layers?: Record<string, UpstreamDefinition & { title?: string }>;
}

/** What a describer hands the variable picker: one node's bindable output. */
export interface Group {
    id: string;
    label: string;
    kind: string;
    basePath: string;
    sample: unknown;
    fields: Field[];
    forEach?: boolean;
    hasRealData?: boolean;
    ownItem?: boolean;
}

export interface ToolOutputMeta {
    sample: unknown;
    schema: unknown;
}

export type ToolOutputMap = Map<string | undefined, ToolOutputMeta>;

/** The accumulated sample of everything already walked, refs resolve against it. */
export interface SampleRoot {
    trigger: { output: unknown; [key: string]: unknown };
    steps: Record<string, { output: unknown }>;
    loop?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface CatalogApp {
    actions?: { name?: string; outputSample?: unknown; outputSchema?: unknown }[];
}

export interface TriggerMetaField {
    key: string;
    path?: string;
}

export type TriggerOutputs = Record<string, { fields?: { key: string; sample?: unknown }[]; sample?: unknown }>;

export interface CatalogDatatable {
    id?: string;
    name: string;
    managedKind?: string;
    columns?: { key: string; type: string }[];
}

export interface Catalog {
    apps?: CatalogApp[];
    triggerOutputs?: TriggerOutputs;
    triggerMeta?: TriggerMetaField[];
    datatables?: CatalogDatatable[];
    knowledgeBases?: { id?: string; name: string }[];
}
