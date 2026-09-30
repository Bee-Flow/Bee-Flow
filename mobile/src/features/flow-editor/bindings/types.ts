/**
 * The bindings layer's READ view of a definition.
 *
 * model/types.ts owns the definition: the strict, write-side shapes the
 * editor's state holds. This file names what the variable picker, the
 * auto-mapper and the form state READ off a node (tool, expr, overRef, form,
 * params, …) — every field optional, as the web builder treats a saved
 * definition (agent-hub `Builder/flow/types.ts`, server/automation/templates.js)
 * — so those modules need no cast per field. The shapes both sides share
 * (ForEach, FlowEdge, Translate) are model's own, re-exported.
 *
 * The direction that matters is pinned by types.compat.test.ts: every model
 * value is assignable to these, so the editor hands its FlowDefinition in
 * as-is. A function here that returns a definition is generic over it, so the
 * caller gets its own type back.
 */

import type { FlowEdge, ForEach } from '../model/types';

export type { FlowEdge, ForEach, Translate } from '../model/types';

export type Obj = Record<string, unknown>;

/** A binding as the runtime resolver (server/automation/bind.js) reads it. */
export interface Binding {
    kind?: string;
    path?: string;
    value?: unknown;
    [key: string]: unknown;
}

/** What an `inputs` / `fields` slot may hold: a binding, or a bare literal. */
export type BindingValue = Binding | string | number | boolean | null | undefined;

export interface TriggerParam {
    name: string;
    type?: string;
    required?: boolean;
    description?: string;
    [key: string]: unknown;
}

export interface FormFieldDecl {
    name?: string;
    type?: string;
    label?: string;
    source?: string;
    app?: string;
    multiple?: boolean;
    [key: string]: unknown;
}

export interface RouteCase {
    name?: string;
    expr?: string;
    value?: unknown;
    [key: string]: unknown;
}

/** A trigger or a step. `__isTrigger` marks a trigger inside the upstream walk. */
export interface FlowNode {
    id: string;
    type?: string;
    kind?: string;
    label?: string;
    tool?: string;
    /** Bindings, or bare literals (bind.js passes a non-binding through as-is). */
    inputs?: Record<string, unknown>;
    forEach?: ForEach | null;
    overRef?: string;
    arrayRef?: string | null;
    itemVar?: string;
    batchSize?: number | string;
    expr?: string;
    cases?: RouteCase[];
    body?: unknown;
    fields?: unknown;
    form?: { title?: string; fields?: FormFieldDecl[]; [key: string]: unknown } | null;
    params?: TriggerParam[];
    appEvent?: { provider?: string; event?: string; filter?: unknown; [key: string]: unknown } | null;
    schedule?: { cron?: string; tz?: string; [key: string]: unknown } | null;
    pinnedOutput?: unknown;
    __isTrigger?: boolean;
    [key: string]: unknown;
}

export interface FlowDefinition {
    trigger?: FlowNode | null;
    triggers?: FlowNode[];
    steps?: FlowNode[];
    edges?: FlowEdge[];
    layers?: Record<string, FlowLayer>;
    [key: string]: unknown;
}

export interface FlowLayer extends FlowDefinition {
    title?: string;
    description?: string;
}

// ── Catalog (GET /api/automation/catalog) ──────────────────────────────

export interface JsonSchemaProp {
    type?: string | string[];
    format?: string;
    enum?: unknown[];
    items?: JsonSchemaProp & { properties?: Record<string, JsonSchemaProp> };
    properties?: Record<string, JsonSchemaProp>;
    title?: string;
    description?: string;
    example?: unknown;
    default?: unknown;
    [key: string]: unknown;
}

export interface JsonSchema {
    type?: string;
    properties?: Record<string, JsonSchemaProp>;
    required?: string[];
    [key: string]: unknown;
}

export interface CatalogAction {
    name?: string;
    label?: string;
    inputSchema?: JsonSchema | null;
    outputSchema?: unknown;
    outputSample?: unknown;
    [key: string]: unknown;
}

export interface CatalogApp {
    id?: string;
    label?: string;
    actions?: CatalogAction[];
    [key: string]: unknown;
}

export interface TriggerOutputEntry {
    fields?: { key: string; sample?: unknown }[];
    sample?: unknown;
}

export interface Catalog {
    apps?: CatalogApp[];
    triggerOutputs?: Record<string, TriggerOutputEntry>;
    triggerMeta?: { key: string; path?: string; sample?: unknown }[];
    datatables?: { id?: string; name?: string; managedKind?: string; columns?: { key: string; type?: string }[] }[];
    knowledgeBases?: { id?: string; name?: string }[];
    [key: string]: unknown;
}

// ── The variable picker's vocabulary (mapping/upstream) ───────────────

export interface VariableField {
    key: string;
    path: string;
    sample: unknown;
    children?: VariableField[];
    perIteration?: boolean;
}

export interface VariableGroup {
    id: string;
    label: string;
    kind: string;
    basePath: string;
    sample: unknown;
    fields: VariableField[];
    hasRealData?: boolean;
    forEach?: boolean;
}

/** Tool name -> its output sample and schema (upstream.buildToolOutputMap). */
export type ToolOutputMap = Map<string, { sample: unknown; schema: unknown }>;
