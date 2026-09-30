/**
 * GET /api/automation/catalog, as the editor reads it
 * (routes/automation/catalog.js). One answer carries everything the builder
 * offers THIS caller: the apps and their actions (with each action's input and
 * output JSON Schema — the only server-provided step schema there is), the
 * tables, knowledge bases and agents a step may point at, reusable Steps, the
 * trigger vocabulary, and the feature flags.
 *
 * Every row type keeps an index signature: the reader validates the fields
 * named here and carries the rest through untouched, so a field the server
 * adds reaches the editor's pure modules (which read the catalog as an open
 * object, as the web does) without a release of this app.
 *
 * A FlowCatalog is at once the bindings layer's `Catalog` and the step
 * picker's `PaletteCatalog` — api.compat.test.ts checks both with tsc.
 */

import type { JsonSchema, TriggerOutputEntry } from '../bindings/types';

export interface CatalogActionRow {
    name: string;
    label: string;
    description: string;
    inputSchema: JsonSchema | null;
    outputSchema: unknown;
    outputSample: unknown;
    /** Hands back a LIST of records; `listField` is the key the rows sit under. */
    producesList: boolean;
    listField: string | null;
    /** The dry-run question: does running it change anything? */
    sideEffect: boolean;
    /** 'reads' | 'writes' | 'sends' — does it leave the building. */
    effect: string | null;
    integrationId: string;
    integrationLabel: string;
    [key: string]: unknown;
}

export interface CatalogAppRow {
    id: string;
    label: string;
    /** Strictly what the runtime would give this caller (org ∩ group ∩ personal ∩ credentials). */
    available: boolean;
    /** Not sent by the server today; the picker reads it when present. */
    connected?: boolean;
    actions: CatalogActionRow[];
    [key: string]: unknown;
}

export interface CatalogDatatable {
    id: string;
    name: string;
    key?: string;
    description?: string;
    rowCount?: number;
    canWrite: boolean;
    /** Set for a table with fixed columns (a form's answers table); absent for an ordinary one. */
    managedKind?: string;
    scope?: string;
    columns: { key: string; name?: string; type?: string; unique?: boolean }[];
    [key: string]: unknown;
}

export interface CatalogKnowledgeBase {
    id: string;
    name: string;
    description: string | null;
    /** Shown disabled with the reason when false — never silently left out. */
    canWrite: boolean;
    scope: string | null;
    [key: string]: unknown;
}

export interface CatalogAgent {
    id: string;
    name: string;
    description: string | null;
    scope: string | null;
    canUse: boolean;
    reason: string | null;
    [key: string]: unknown;
}

/** An `app_pick` form question's source (automation/formPickSources.js catalog()). */
export interface CatalogPickSource {
    id: string;
    appId: string | null;
    app: string | null;
    label: string;
    searchHint: string;
    internal: boolean;
    sampleData: Record<string, unknown>;
    /** A hint about THIS author, never a gate: the person filling the form in is usually someone else. */
    available: boolean;
    [key: string]: unknown;
}

/** A reusable Step (kind='block'), addable as a call_block node. */
export interface CatalogBlock {
    id: string;
    title: string;
    description: string;
    icon: string | null;
    category: string | null;
    params: unknown[];
    outputFields: unknown[];
    requiredIntegrations: string[];
    available: boolean;
    [key: string]: unknown;
}

export interface CatalogTriggerKind {
    kind: string;
    label?: string;
    /** app_event only: the watchable sources this caller may pick. */
    providers?: unknown[];
    [key: string]: unknown;
}

export interface CatalogFlags {
    /** Would a code step run for this caller? False comes with `codeReason`. */
    code: boolean;
    codeReason: string | null;
    automations: boolean;
    [key: string]: unknown;
}

export interface CatalogChoice {
    value: string;
    label: string;
    blurb: string;
    [key: string]: unknown;
}

export interface CatalogDatatableOp {
    op: string;
    label: string;
    blurb: string;
    writes: boolean;
    [key: string]: unknown;
}

export interface FlowCatalog {
    apps: CatalogAppRow[];
    datatables: CatalogDatatable[];
    knowledgeBases: CatalogKnowledgeBase[];
    agents: CatalogAgent[];
    /** Non-null means `agents` is empty BECAUSE THE READ FAILED — "could not check", not "none". */
    agentsError: string | null;
    formPickSources: CatalogPickSource[];
    knowledgeWriteStrategies: CatalogChoice[];
    datatableOps: CatalogDatatableOp[];
    steps: CatalogBlock[];
    triggerOutputs: Record<string, TriggerOutputEntry>;
    triggerMeta: { key: string; path?: string; sample?: unknown; note?: string }[];
    /** Per provider, which app events fire today and which wait for the connector. */
    deliverability: Record<string, Record<string, string[]>>;
    stepTypes: string[];
    triggers: CatalogTriggerKind[];
    flags: CatalogFlags;
    [key: string]: unknown;
}
