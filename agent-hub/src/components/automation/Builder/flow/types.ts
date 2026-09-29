/**
 * The shape of an automation definition, as the builder's hooks read it.
 *
 * The modules in this folder are still JavaScript and annotate nothing, so
 * every hook that touches a definition would otherwise invent its own idea of
 * one. This is that idea, written down once: only the members the builder
 * actually reads are named, and an index signature carries the rest through
 * untouched — the server owns the full schema, and a field nobody here reads
 * must not become a field this file claims does not exist.
 */

/** One node of a graph: a trigger, a step, or a note. */
export interface FlowStep {
    id: string;
    type?: string;
    /** The trigger's flavour ('form', 'webhook', 'app_event', …). */
    kind?: string;
    label?: string;
    /** A hand-written output, replayed instead of running the step. */
    pinnedOutput?: unknown;
    /** A form trigger's or form_page's declared questions. */
    form?: { fields?: unknown[];[key: string]: unknown } | null;
    [key: string]: unknown;
}

/** One connection. `caseName` (or a `case:<name>` label) names a switch branch. */
export interface FlowEdge {
    from?: string;
    to?: string;
    caseName?: string | null;
    label?: string;
    [key: string]: unknown;
}

/**
 * A whole automation, or — inside `layers` — one flowlet's mini-definition.
 * The two are the same shape, which is what lets a scoped canvas render a
 * flowlet with the root's own components.
 */
export interface FlowDefinition {
    trigger?: FlowStep | null;
    /** Secondary triggers; webhook/app_event only (the validator rejects the rest). */
    triggers?: FlowStep[];
    steps?: FlowStep[];
    edges?: FlowEdge[];
    /** Root-only map of flowlets, keyed by LAYER_KEY_RE (flow/flowletScope.js). */
    layers?: Record<string, FlowDefinition>;
    [key: string]: unknown;
}

/** One step's row in a run, as the builder keeps them in memory. */
export interface RunStepRow {
    stepId?: string;
    output?: unknown;
    [key: string]: unknown;
}

/**
 * "10 of 201 records" — what flow/dataSummary.js says about one value.
 * `total` and `title` are only there for a truncated search envelope.
 */
export interface DataSummary {
    count: number;
    kind: string;
    label: string;
    total?: number;
    title?: string;
}
