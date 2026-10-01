/**
 * Types for the shared mapping core (index.mjs beside this file).
 *
 * Generated copies of this file sit next to the generated copies of the core
 * in agent-hub/src/shared/mapping/ and mobile/src/shared/mapping/vendor/, so
 * TypeScript on both clients reads the same declarations. Keep it in step
 * with index.mjs: mappingVendor.lockstep.test.ts (mobile) fails when a name
 * is exported without being declared, or declared without being exported.
 */

/** One token of a legacy path: a key or index, or the `[*]` wildcard. */
export type LegacyToken = { type: 'prop'; key: string | number } | { type: 'wild' };

/** The legacy `[*]` segment of a Source parsed from a stored path. */
export type WildSegment = { readonly wild: true };

/** A segment of a Source path: an object key, an array index, or a legacy `[*]`. */
export type SourceSegment = string | number | WildSegment;

/** Where a value comes from. `path` is relative to the step's or trigger's `output`. */
export type Source =
    | { root: 'steps'; id: string; path: SourceSegment[] }
    | { root: 'loop'; id: string; path: SourceSegment[] }
    | { root: 'trigger'; path: SourceSegment[] }
    | { root: 'vars'; path: SourceSegment[] };

export interface TemplateOptions {
    leaveUnresolved?: boolean;
    listAsMarkdown?: boolean;
}

export interface ResolveOptions {
    allowSecrets?: boolean;
    /** Report no warnings for this call (a record of inputs, not a use of them). */
    silent?: boolean;
}

/** A value a binding did not get, reported through `onWarning`. */
export type BindingWarning =
    | { code: 'missing'; kind: 'ref'; path: string; input?: string }
    | { code: 'missing'; kind: 'expr'; expr: string; input?: string }
    | { code: 'expr_error'; kind: 'expr'; expr: string; message: string; input?: string };

/** One design-time issue of a binding (validate.mjs). */
export interface BindingIssue {
    code: 'path_syntax' | 'trigger_without_output' | 'unknown_field';
    /** The path as written. */
    path: string;
    /** The whole path with this issue (and every one before it) fixed, or null. */
    fix: string | null;
    /** unknown_field: the field that is not known, and the ones that are. */
    field?: string;
    known?: string[];
    /**
     * trigger_without_output on a run metadata key ('id', 'kind', …) that the
     * trigger's payload declares too: the key, since the path as written
     * reads the metadata.
     */
    metadata?: string;
    /** validateBinding: the kind of binding the path came from. */
    kind?: 'ref' | 'template' | 'expr';
}

/** Which fields a Source is known to produce; null when that is not known. */
export type FieldsOf = (source: Source) => string[] | null;

export interface LegacyResolver {
    resolveValue(binding: unknown, runState: object, opts?: ResolveOptions): unknown;
    resolveDeep(structure: unknown, runState: object, opts?: ResolveOptions): unknown;
    resolveInputs(inputs: unknown, runState: object, opts?: ResolveOptions): Record<string, unknown>;
    interpolateTemplate(template: unknown, runState: object, opts?: TemplateOptions): string;
}

export declare const REF_RE: RegExp;
export declare function cloneLiteral<T>(value: T): T;
export declare function tokenizePath(path: string): LegacyToken[] | null;
export declare function resolveTokens(tokens: LegacyToken[], cur: unknown): unknown;
export declare function walkPath(path: unknown, root: unknown): unknown;
export declare function walkRelativePath(path: unknown, value: unknown): unknown;
export declare function interpolateTemplate(
    template: unknown,
    runState: object | null | undefined,
    opts?: TemplateOptions,
    onUnresolved?: (path: string) => void,
): string;
export declare function createLegacyResolver(deps: {
    evaluate: (src: string, scope: object) => unknown;
    onUnresolved?: (path: string) => void;
    onWarning?: (warning: BindingWarning, runState: object) => void;
}): LegacyResolver;
export declare const WILD: WildSegment;
export declare function isWild(seg: unknown): seg is WildSegment;
export declare function parseLegacyPath(path: unknown): Source | null;
export declare function formatPath(source: unknown): string | null;
export declare function lastSegment(pathOrSource: unknown): string | number | undefined;
export declare function formatSegment(seg: SourceSegment): string | null;
export declare function repairLegacyPath(text: unknown): { path: string | null; rest: string };
export declare const RUNTIME_ROOTS: readonly string[];
export declare const TRIGGER_RUN_KEYS: readonly string[];
export declare function templatePaths(text: unknown): string[];
export declare function closestName(name: string, candidates: string[]): string | null;
export declare function checkRefPath(path: unknown, ctx?: { fieldsOf?: FieldsOf; syntax?: boolean }): BindingIssue[];
export declare function validateBinding(
    binding: unknown,
    ctx?: { fieldsOf?: FieldsOf; exprPaths?: (src: string) => string[] },
): BindingIssue[];

// ── Sources (M3): fields, labels and upstream discovery as SourceNodes ──

/** One part of a value's label (label.mjs); the client words `index` and `each`. */
export type LabelPart = { key: string; text: string } | { index: number } | { each: true };

/** The shape of a sample value (fields.mjs shapeOfSample). */
export type SampleShape = 'missing' | 'scalar' | 'object' | 'list' | 'table' | 'json';

/** One pickable value: its Source and legacy path, how to name it, and what it holds. */
export interface SourceNode {
    /** The last key (or a describer's own name for the value). */
    key: string;
    /** The legacy path string (formatPath of `source`); null for a value read from text. */
    path: string | null;
    sample: unknown;
    /** Null under a base that is not a Source (`trigger.kind` and other run metadata). */
    source: Source | null;
    labelParts: LabelPart[];
    shape: SampleShape;
    /** Elements in the sample, for a list or a table. */
    count?: number;
    /** A short, language-free text of the value; '' when there is none to show. */
    preview: string;
    /** False when real output exists and lacks this key. */
    confirmed: boolean;
    children?: SourceNode[];
    /** One value per iteration of a step's forEach: never auto-mapped into a scalar. */
    perIteration?: boolean;
    /** Read from a JSON string (textChildren); not addressable by a legacy path. */
    fromText?: boolean;
}

/** One upstream node's bindable output. */
export interface SourceGroup {
    id: string;
    label: string;
    kind: string;
    basePath: string;
    sample: unknown;
    fields: SourceNode[];
    hasRealData?: boolean;
    forEach?: boolean;
}

/** What the describers need from the client they run in (upstream/env.mjs). */
export interface UpstreamEnv {
    label?: (key: string, fallback: string, vars?: Record<string, unknown>) => string;
    isTerminalStepType?: (type: unknown) => boolean;
    pickSourceById?: (id: unknown) => { app?: string; sampleData?: Record<string, unknown> } | null;
    applyOpsToSampleRow?: (row: Record<string, unknown>, operations: unknown) => Record<string, unknown>;
    datetimeTargetColumn?: (step: unknown) => string;
    impliedListMode?: (step: unknown) => Record<string, unknown> | null;
    isDateTimeListMode?: (step: unknown) => boolean;
    now?: () => Date;
}

/** Tool name -> its catalog output sample and schema. */
export type ToolOutputMap = Map<string, { sample: unknown; schema: unknown }>;

/** The describe context describeNodeIn reads. */
export interface DescribeContext {
    definition?: unknown;
    toolToOutput?: ToolOutputMap;
    triggerOutputs?: Record<string, unknown>;
    sampleRoot?: unknown;
    catalog?: unknown;
    env?: UpstreamEnv;
}

export declare const MAX_DEPTH: number;
export declare function fieldsFromSample(sample: unknown, base: unknown): SourceNode[];
export declare function textChildren(node: unknown): SourceNode[];
export declare function sampleFromSchema(schema: unknown): Record<string, unknown> | null;
export declare function overlayReal(fields: SourceNode[] | null | undefined, real: unknown): SourceNode[];
export declare function deepOverlay(base: unknown, real: unknown): unknown;
export declare function hasPath(value: unknown, segs: SourceSegment[]): boolean;
export declare function previewOf(value: unknown): string;
export declare function isPlaceholder(value: unknown): boolean;
export declare function humanizeKey(key: unknown): string;
export declare function labelParts(segs: unknown): LabelPart[];
export declare function labelText(parts: unknown, sep?: string): string;
export declare function collectUpstream(definition: unknown, currentStepId: string): Array<Record<string, unknown>>;
export declare function computeUpstreamGroups(
    definition: unknown,
    currentStepId: string | null | undefined,
    catalog: unknown,
    realOutputById?: ReadonlyMap<string, unknown> | null,
    env?: UpstreamEnv,
): SourceGroup[];
export declare function computeLoopBodyGroups(
    loopStep: unknown,
    bodyIndex: number,
    outerGroups: SourceGroup[] | null | undefined,
    previewSample: unknown,
    catalog: unknown,
    definition: unknown,
    env?: UpstreamEnv,
): SourceGroup[];
export declare function buildToolOutputMap(catalog: unknown): ToolOutputMap;
export declare function wrapGroupForEach(group: SourceGroup | null, node: unknown): SourceGroup | null;
export declare function describeNode(
    node: unknown,
    definition: unknown,
    toolToOutput: ToolOutputMap,
    triggerOutputs: Record<string, unknown>,
    sampleRoot?: unknown,
    catalog?: unknown,
    env?: UpstreamEnv,
): SourceGroup | null;
export declare function describeNodeIn(node: unknown, ctx: DescribeContext): SourceGroup | null;
export declare function describeLoopBody(loopStep: unknown, ctx: DescribeContext, upTo?: number): SourceGroup[];
export declare const DESCRIBED_TYPES: readonly string[];
export declare function seg(key: unknown): string | null;
export declare function sampleToFields(sample: unknown, basePath: string): SourceNode[];
export declare function resolveElementSample(arrayRef: unknown, sampleRoot: unknown): unknown;
export declare function elementFieldOptions(elementSample: unknown): Array<{ key: string; sample: unknown }>;
/** The part of a group collectArrayPaths reads (older callers' groups qualify too). */
export interface ArrayPathGroup {
    basePath?: string;
    fields?: ReadonlyArray<{ key: string; path: string | null; sample?: unknown; children?: ReadonlyArray<{ key: string; path: string | null; sample?: unknown }> }>;
}
export declare function collectArrayPaths(groups: ReadonlyArray<ArrayPathGroup> | null | undefined, previewSample?: unknown): Array<{ key: string; path: string; sample: unknown }>;
export declare function samplePlaceholderFor(type: unknown): unknown;
export declare function overlayGroupWithReal(group: SourceGroup, realOutput: unknown): SourceGroup;
export declare function triggerMetaSample(definition: unknown, env?: UpstreamEnv): Record<string, unknown>;
export declare function describeTriggerMeta(definition: unknown, catalog: unknown, env?: UpstreamEnv): SourceGroup | null;
export declare function inferLoopItemSample(overRef: unknown, definition: unknown, toolToOutput: ToolOutputMap, sampleRoot?: unknown): Record<string, unknown> | null;
export declare function suggestItemVar(key: unknown): string;
export declare function pickSample(field: unknown, env?: UpstreamEnv): unknown;
export declare function leadSkillId(node: unknown): string | null;
export declare const DEFAULT_ENV: Readonly<Required<UpstreamEnv>>;
export declare function resolveEnv(env?: UpstreamEnv): Readonly<Required<UpstreamEnv>>;
