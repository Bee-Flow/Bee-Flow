/**
 * The shape of an automation definition, as the flow editor reads and writes
 * it. A strict port of the web builder's flow/types.ts, with the vocabulary
 * the server's validator checks written down as unions.
 *
 * The server owns the full per-step schema (server/automation/validate), so a
 * step keeps an index signature: a field the phone does not read must still
 * survive a round trip untouched, and must not be something this file claims
 * does not exist. What IS named here is exact — the step types, trigger
 * kinds, edge labels and binding shapes are pinned to the server by
 * types.lockstep.test.ts.
 */

/** Every runtime step type the engine runs (server VALID_STEP_TYPES). */
export const STEP_TYPES = [
    'trigger', 'integration_action', 'ai_step', 'condition', 'loop', 'code', 'notification',
    'approval', 'parallel',
    'set', 'datetime', 'wait', 'stop_error', 'switch',
    'filter', 'limit', 'dedupe', 'aggregate', 'summarize',
    'guard', 'tokenize', 'untokenize',
    'parse_json',
    'call_layer', 'layer_output',
    'call_block',
    'http_request',
    'form_page',
    'generate_document',
    'fill_document',
    'slide',
    'presentation',
    'data_extraction',
    'datatable',
    'knowledge_write',
    'return_to_app',
    'note',
] as const;
export type StepType = (typeof STEP_TYPES)[number];

/** How a routine can start (graph.js `trigger.kind_missing` hint, plus the flowlet entry). */
export const TRIGGER_KINDS = [
    'manual', 'form', 'schedule', 'webhook', 'app_event', 'agent_call', 'app_trigger', 'layer_input',
] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** The only kinds `definition.triggers[]` accepts (server SECONDARY_TRIGGER_KINDS). */
export const SECONDARY_TRIGGER_KINDS: ReadonlySet<string> = new Set(['webhook', 'app_event', 'schedule']);

/** Fixed edge labels (server KNOWN_EDGE_LABELS); a switch adds `case:<name>`. */
export const KNOWN_EDGE_LABELS = ['then', 'else', 'on_success', 'on_error'] as const;
export type EdgeLabel = (typeof KNOWN_EDGE_LABELS)[number] | `case:${string}`;

/** The canvas's edge (and note) colour swatches (server EDGE_COLOR_KEYS). */
export const EDGE_COLOR_KEYS = ['blue', 'green', 'amber', 'orange', 'rose', 'red', 'cyan', 'slate'] as const;
export type EdgeColorKey = (typeof EDGE_COLOR_KEYS)[number];

/** A type string the server may know and this build may not: kept, not rejected. */
export type OpenString<T extends string> = T | (string & {});

export interface Position {
    x: number;
    y: number;
}

/** Where a value comes from: another step's output, a template, a constant or an expression. */
export type Binding =
    | { kind: 'ref'; path: string }
    | { kind: 'template'; value: string }
    | { kind: 'literal'; value: unknown }
    | { kind: 'expr'; value: string };
export type BindingKind = Binding['kind'];

/** Run a step once per item of a list. */
export interface ForEach {
    overRef?: string;
    itemVar?: string;
    maxIterations?: number;
    [key: string]: unknown;
}

/** The fields every node carries; everything type-specific rides in the index signature. */
export interface FlowNode {
    id: string;
    label?: string;
    icon?: string | null;
    position?: Position;
    /** A hand-written output, replayed instead of running the step. */
    pinnedOutput?: unknown;
    pinnedAt?: string | null;
    pinnedSource?: string | null;
    /** A form trigger's or form_page's declared questions. */
    form?: FormDeclaration | null;
    [key: string]: unknown;
}

/** The step that starts a routine (or a flowlet). */
export interface FlowTrigger extends FlowNode {
    type: 'trigger';
    kind?: OpenString<TriggerKind>;
    output?: Record<string, unknown>;
    schedule?: { cron?: string; tz?: string } | null;
    appEvent?: { provider?: string; event?: string; filter?: unknown } | null;
}

export interface FlowStep extends FlowNode {
    type: OpenString<StepType>;
    inputs?: Record<string, Binding | unknown>;
    forEach?: ForEach | null;
    /** A loop's body: a bare step array with no edges (the engine chains it). */
    body?: unknown;
    /** A parallel step's branches. */
    branches?: FlowStep[][];
    cases?: SwitchCase[];
}

/** One named output of a switch. */
export interface SwitchCase {
    name?: string;
    expr?: string;
    value?: unknown;
    [key: string]: unknown;
}

/** One connection. `caseName` (or a `case:<name>` label) names a switch branch. */
export interface FlowEdge {
    from: string;
    to: string;
    label?: OpenString<EdgeLabel>;
    caseName?: string | null;
    color?: OpenString<EdgeColorKey>;
    [key: string]: unknown;
}

/** A form trigger's or a form page's declaration. */
export interface FormDeclaration {
    title?: string;
    description?: string;
    submitLabel?: string;
    successMessage?: string;
    fields?: FormField[];
    theme?: FormTheme | null;
    [key: string]: unknown;
}

export interface FormField {
    name: string;
    type: string;
    label?: string;
    required?: boolean;
    placeholder?: string;
    [key: string]: unknown;
}

export interface FormTheme {
    primary: string;
    radius: string;
    density: string;
    fontScale: string;
    appearance: string;
}

/**
 * A whole automation, or — inside `layers` — one flowlet's mini-definition.
 * `steps` and `edges` are always arrays once a definition has been through
 * `normalizeDefinitionShape`; the server rejects anything else.
 */
export interface FlowDefinition {
    trigger?: FlowTrigger | null;
    /** Secondary triggers: webhook, app_event and schedule only. */
    triggers?: FlowTrigger[];
    steps: FlowStep[];
    edges: FlowEdge[];
    /** Root-only map of flowlets. */
    layers?: Record<string, FlowDefinition>;
    [key: string]: unknown;
}

/** A definition as it may arrive: from the network, an import, a template. */
export type DefinitionInput = Partial<FlowDefinition> | null | undefined;

/** Any node of a graph: the trigger, a secondary trigger, or a step. */
export type AnyNode = FlowTrigger | FlowStep;

/** The branch part of an edge's identity. */
export interface EdgeIdentity {
    label?: string | null;
    caseName?: string | null;
}

/** One validation record from the server (`{code, severity, path, message, hint}`). */
export interface ValidationIssue {
    code?: string;
    severity?: 'error' | 'warning';
    path?: string;
    message?: string;
    hint?: string;
    [key: string]: unknown;
}

/** Errors and warnings, as the builder keeps them. */
export interface Validation {
    errors?: ValidationIssue[];
    warnings?: ValidationIssue[];
}

/** An optional translator: `t(key, englishFallback, params?)` — core/i18n's `translate` fits. */
export type Translate = (key: string, fallback: string, params?: Record<string, string | number>) => string;

export function isStepType(type: unknown): type is StepType {
    return typeof type === 'string' && (STEP_TYPES as readonly string[]).includes(type);
}
