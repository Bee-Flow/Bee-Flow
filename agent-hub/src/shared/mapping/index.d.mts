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

/** A segment of a v2 Source: a key or an index, never `[*]`. */
export type PathSegment = string | number;

/**
 * Where a pick's value comes from (v2). Beside the legacy roots: `run` (the
 * trigger's metadata: id, kind, firedAt, …) and `item` (the row a collection
 * op or a list-mode step is on).
 */
export type MappingSource =
    | { root: 'steps' | 'loop'; id: string; path: PathSegment[] }
    | { root: 'trigger' | 'run' | 'vars' | 'item'; path: PathSegment[] };

export type Take = 'one' | 'all' | 'first' | 'last' | 'count' | 'each';
export type As = 'native' | 'text' | 'list' | 'number' | 'date' | 'yesno' | 'json';
export type Join = 'lines' | 'comma' | 'bullets';
export type Shape = 'missing' | 'single' | 'object' | 'list' | 'table' | 'unknown';

/** What a pick asks for beside its source. */
export interface PickIntent {
    take: Take;
    as: As;
    join?: Join;
}

/** A value part of a compose binding. */
export interface PickPart extends PickIntent {
    from: MappingSource;
    label?: string;
    required?: boolean;
}

/** `{ kind: 'pick', v: 1, from, take, as, join?, label? }` */
export interface PickBinding extends PickPart {
    kind: 'pick';
    v: 1;
}

/** `{ kind: 'compose', v: 1, parts: ['Beste ', { from, take, as }, …] }` */
export interface ComposeBinding {
    kind: 'compose';
    v: 1;
    parts: Array<string | PickPart>;
}

/** What a field wants (slots.mjs). */
export interface Slot {
    as: As;
    multiLine: boolean;
    items?: Shape;
}

/** One PickOptions entry (intent.mjs optionsFor). */
export interface PickOption extends PickIntent {
    id: string;
}

/** A step's per-item repeat. */
export interface StepRepeat {
    over: MappingSource;
    max?: number;
}

/** One place a step keeps a value (sites.mjs). */
export interface BindingSite {
    kind: 'text' | 'binding' | 'list' | 'ref' | 'expr';
    field: string;
    value: unknown;
    compose?: boolean;
}

/** A text site of a step type. */
export interface TextSite {
    field: string;
    compose: boolean;
    each: boolean;
    /** A `{{ }}` text here may be lifted to a compose (false: kept a template). */
    lift: boolean;
}

/** An opaque walk result: plain data, or the marker of a walk that crossed a list. */
export type WalkResult = unknown;

/** A warning fit.mjs reports while carrying out a pick. */
export interface FitWarning {
    code: 'missing' | 'many_for_one' | 'holes_dropped' | 'parse_failed';
    count?: number;
    as?: As;
}

/** The number and date readers a resolver is given (shared/expr/parse.mjs). */
export interface ParseDeps {
    parseLocaleNumber?: (text: unknown) => number | null;
    parseDate?: (value: unknown) => { epoch: number; offset: number | null } | null;
}

export interface TemplateOptions {
    leaveUnresolved?: boolean;
    listAsMarkdown?: boolean;
}

export interface ResolveOptions {
    allowSecrets?: boolean;
    /** Report no warnings for this call (a record of inputs, not a use of them). */
    silent?: boolean;
    /** Inputs that must get a value: a pick that gives none there reports missing_required. */
    required?: string[] | Set<string>;
}

/** A value a binding did not get, reported through `onWarning`. */
export type BindingWarning =
    | { code: 'missing'; kind: 'ref'; path: string; input?: string }
    | { code: 'missing'; kind: 'expr'; expr: string; input?: string }
    | { code: 'expr_error'; kind: 'expr'; expr: string; message: string; input?: string }
    | {
        code: 'missing' | 'missing_required' | 'many_for_one' | 'holes_dropped' | 'parse_failed' | 'each_outside_repeat' | 'mapping_invalid';
        kind: 'pick' | 'compose';
        path: string;
        label?: string;
        count?: number;
        as?: As;
        input?: string;
    };

/** One design-time issue of a binding (validate.mjs). */
export interface BindingIssue {
    code: 'path_syntax' | 'trigger_without_output' | 'unknown_field' | 'mapping_structure' | 'each_outside_repeat';
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
    kind?: 'ref' | 'template' | 'expr' | 'pick' | 'compose';
    /** mapping_structure: what is wrong, as codes (validate.mjs pickProblems). */
    problems?: string[];
    /** A pick's label, when it has one. */
    label?: string;
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
export declare function createResolver(deps: {
    evaluate: (src: string, scope: object) => unknown;
    parse?: ParseDeps;
    onUnresolved?: (path: string) => void;
    onWarning?: (warning: BindingWarning, runState: object) => void;
}): LegacyResolver;
/** The resolver's name from before the v2 kinds; the same function. */
export declare const createLegacyResolver: typeof createResolver;
export declare const WILD: WildSegment;
export declare function isWild(seg: unknown): seg is WildSegment;
export declare function parseLegacyPath(path: unknown): Source | null;
export declare function formatPath(source: unknown): string | null;
export declare function lastSegment(pathOrSource: unknown): string | number | undefined;
export declare function formatSegment(seg: SourceSegment): string | null;
export declare function repairLegacyPath(text: unknown): { path: string | null; rest: string };
export declare function sameSource(a: unknown, b: unknown): boolean;
export declare function isPrefix(prefix: unknown, source: unknown): boolean;
export declare const RUNTIME_ROOTS: readonly string[];
export declare const TRIGGER_RUN_KEYS: readonly string[];
export declare function templatePaths(text: unknown): string[];
export declare function closestName(name: string, candidates: string[]): string | null;
export declare function checkRefPath(path: unknown, ctx?: { fieldsOf?: FieldsOf; syntax?: boolean }): BindingIssue[];
export declare function validateBinding(
    binding: unknown,
    ctx?: { fieldsOf?: FieldsOf; exprPaths?: (src: string) => string[]; repeatOver?: MappingSource | null },
): BindingIssue[];
export declare const SOURCE_ROOTS: readonly string[];
export declare function sourceProblems(source: unknown): string[];
export declare function pickProblems(binding: unknown, opts?: { part?: boolean }): string[];
export declare function composeProblems(binding: unknown): string[];
export declare function isPick(binding: unknown): binding is PickBinding;
export declare function isCompose(binding: unknown): binding is ComposeBinding;
export declare function describeSource(source: unknown): string;
export declare function mappingIssues(binding: unknown, ctx?: { fieldsOf?: FieldsOf; repeatOver?: MappingSource | null }): BindingIssue[];

export declare const REFUSED_KEYS: readonly string[];
export declare const MAX_JSON_TEXT: number;
export declare function walk(value: unknown, path: PathSegment[], opts?: { memo?: Map<string, unknown> }): unknown;
export declare function walkMany(value: unknown, path: PathSegment[], opts?: { memo?: Map<string, unknown> }): WalkResult;
export declare function walkSource(source: MappingSource, runState: object, opts?: { memo?: Map<string, unknown> }): WalkResult;
export declare function sourceBase(source: MappingSource, runState: object): unknown;
export declare function isMany(result: WalkResult): boolean;
export declare function manyItems(result: WalkResult): { items: unknown[]; holes: number };
export declare function plain(result: WalkResult): unknown;
export declare function parseJsonText(text: unknown, memo?: Map<string, unknown>): object | undefined;

export declare const SHAPES: readonly Shape[];
export declare function shapeOf(value: unknown): Shape;
export declare function shapeOfSchema(schema: unknown): Shape;

export declare const SLOT_KINDS: readonly As[];
export declare const STEP_SLOTS: Readonly<Record<string, Slot>>;
export declare function slotShape(schema: unknown, where?: { stepType?: string; field?: string }): Slot;

export declare const COMMON_SITES: Readonly<{ bindings: readonly string[]; lists: readonly string[] }>;
export declare const STEP_SITES: Readonly<Record<string, {
    text?: TextSite[];
    bindings?: string[];
    lists?: string[];
    refs?: string[];
    exprs?: string[];
}>>;
export declare function fieldValue(step: unknown, field: string): unknown;
export declare function textSitesOf(stepType: string): TextSite[];
export declare function stepBindingSites(step: unknown): BindingSite[];

export declare const TAKES: readonly Take[];
export declare const AS: readonly As[];
export declare const JOINS: readonly Join[];
export declare const MAPPING_VERSION: 1;
export declare function defaultIntent(sourceShape: Shape | string, slot: Partial<Slot> | null | undefined): PickIntent & { warning?: 'many_for_one' };
export declare function optionsFor(sourceShape: Shape | string, slot: Partial<Slot> | null | undefined, opts?: { repeat?: boolean }): PickOption[];
export declare function sourceFromPath(path: unknown): MappingSource | null;
export declare function normalizePick(input: unknown, opts?: { part?: boolean }): PickBinding | PickPart | null;

export declare function applyTake(result: WalkResult, take: Take, as: As): { value: unknown; missing?: boolean; warnings: FitWarning[] };
export declare function castAs(value: unknown, as: As, ctx?: { join?: Join; parse?: ParseDeps }): { value: unknown; missing?: boolean; warnings: FitWarning[] };
export declare function fit(result: WalkResult, intent: PickIntent, ctx?: { parse?: ParseDeps }): { value: unknown; warnings: FitWarning[] };

export declare function inlineText(value: unknown): string;
export declare function renderText(value: unknown, opts?: { join?: Join }): string;
export declare function renderCompose(compose: { parts: Array<string | PickPart> } | null | undefined, resolvePart: (part: PickPart) => unknown): string;

export declare const REPEAT_DEFAULT_MAX: number;
export declare const REPEAT_MAX: number;
export declare function mapStepPicks<T>(
    step: T,
    fn: (pick: PickBinding | PickPart) => PickBinding | PickPart,
    refFn?: ((ref: { kind: 'ref'; path: string }) => unknown) | null,
): T;
export declare function toggleRepeat(step: object, over: MappingSource, opts?: { max?: number }):
    { step: object & { repeat: StepRepeat }; each: number } | { error: 'already_repeating' | 'legacy_for_each' | 'invalid_source' };
export declare function toggleRepeatOff(step: object): { step: object };
export declare function rebaseLoopRefs(step: object): { step: object & { repeat: StepRepeat } } | { refused: string[] };

// M6: per-item repeat and the one auto-map rule.
export declare function stopForEach(step: object): { step: object; orphaned?: string[] };
export declare function renameItemVar(step: object, to: string): { step: object } | { error: 'invalid_name' | 'no_item' | 'name_in_use' };

/** An input auto-map may fill (only the empty ones are handed in). */
export interface MatchInput { key: string; type?: string | string[]; required?: boolean }
/**
 * A value auto-map may bind, by its last key. `near`: higher is closer to the
 * step. `depth`: objects down from a top-level field (0); shallower wins a tie.
 */
export interface MatchCandidate { key: string; path: string; type?: string; near?: number; depth?: number }
export interface MatchResult {
    matches: Array<{ key: string; path: string; how: 'exact' | 'normalized' | 'id' }>;
    ambiguous: Array<{ key: string; paths: string[] }>;
}
export declare function normalizeKey(name: unknown): string;
export declare function sampleType(value: unknown): 'null' | 'array' | 'string' | 'number' | 'boolean' | 'object' | 'bigint' | 'symbol' | 'function' | 'undefined';
export declare function isSecretLikeKey(key: unknown): boolean;
export declare function typeFits(propType: string | string[] | undefined, candType: string | undefined): boolean;
export declare function idAffinityBase(key: unknown): string | null;
export declare function matchInputs(
    inputs: MatchInput[],
    candidates: MatchCandidate[],
    opts?: { idAffinity?: boolean; unique?: boolean; ambiguous?: boolean; skipSecrets?: boolean; max?: number },
): MatchResult;
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
/** Does this step run once per item (`forEach` or `repeat`), so its output is the fan-out envelope? */
export declare function runsPerItem(node: unknown): boolean;
export declare function pickSample(field: unknown, env?: UpstreamEnv): unknown;
export declare function leadSkillId(node: unknown): string | null;
export declare const DEFAULT_ENV: Readonly<Required<UpstreamEnv>>;
export declare function resolveEnv(env?: UpstreamEnv): Readonly<Required<UpstreamEnv>>;
// M4a: a legacy binding shown as a pick (upgrade.mjs); null means "Formula".
export declare function liftLegacy(
    binding: unknown,
    sample: object | null | undefined,
    lastRun?: object | null,
    deps?: { evaluate?: (src: string, scope: object) => unknown; parse?: ParseDeps },
): PickBinding | null;
/** A Source as the legacy path the runtime walks, `[*]` where the sample (or the picked `hint` path) shows a list; null when unwritable. */
export declare function legacyPathOf(source: unknown, sample?: object | null, hint?: string | null): string | null;
/** A pick as the legacy binding that gives the same value, or null when there is none. */
export declare function lowerPick(
    pick: unknown,
    sample?: object | null,
    hint?: string | null,
): { kind: 'ref'; path: string } | { kind: 'expr'; value: string } | null;
// M5a: what a definition reads through picks and composes (reads.mjs), and
// the one rule for lifting a legacy template or path to them (template.mjs).
export declare function picksIn(value: unknown): PickPart[];
export declare function pickPaths(value: unknown): string[];
export declare function stepReadPaths(step: unknown): string[];
export declare function textAsTemplate(value: unknown): string;
export declare function stepIdsRead(value: unknown): string[];
export declare function pickForLegacyPath(path: unknown): { from: MappingSource; take: 'one' | 'all' } | null;
export declare function templateToCompose(text: unknown, where?: { stepType?: string; field?: string; sole?: boolean }): PickBinding | ComposeBinding | null;
// M8: "Koppelingen bijwerken": a whole definition upgraded, binding by binding, with a dry run.

/** Why a binding or a forEach was left as it is (upgrade.mjs); the client words it. */
export type UpgradeKeptReason =
    | 'formula' | 'would_change' | 'no_evidence' | 'for_each_kept'
    | 'already_repeating' | 'loop_elsewhere' | 'max_unreadable' | 'list_differs'
    | 'loop_in_template' | 'loop_in_expr' | 'loop_in_text' | 'loop_index' | 'loop_ref_unreadable'
    | 'over_unreadable' | 'no_for_each';

/** One binding (or forEach) in the report of upgradeDefinition. Labels only, never a run value. */
export interface UpgradeEntry {
    stepId: string | null;
    /** The step's name as the person gave it, or null. */
    step: string | null;
    /** The flowlet the step is in. */
    layer?: string;
    /** Where in the step: 'inputs.to', 'fields.total', 'forEach'. */
    field: string;
    kind: 'ref' | 'expr' | 'for_each';
    take?: Take;
    reason?: UpgradeKeptReason;
    reasons?: UpgradeKeptReason[];
    /** What the value reads: its root, the source step's name, and the label of the path. */
    root?: string;
    source?: string | null;
    label?: string;
}

export interface UpgradeDeps {
    sample?: object | null;
    lastRun?: object | null;
    evaluate?: (src: string, scope: object) => unknown;
    parse?: ParseDeps;
}

export declare function upgradeStepRepeat(step: unknown, opts?: UpgradeDeps):
    { step: object & { repeat: StepRepeat }; converted: Array<{ field: string; pick: PickBinding }> } | { refused: UpgradeKeptReason[] };
export declare function upgradeDefinition<T>(definition: T, opts?: UpgradeDeps):
    { definition: T; changed: UpgradeEntry[]; kept: UpgradeEntry[] };
// M8b: update on open (what is left to upgrade) and the gate of the AI fix.

/** A legacy binding an upgrade could rewrite: where it is, and its stored text (never a run value). */
export interface LegacyBindingSite {
    stepId: string | null;
    field: string;
    kind: 'ref' | 'expr' | 'for_each';
    text: string;
}
export declare function legacyBindings(definition: unknown): LegacyBindingSite[];
export declare function hasLegacyBindings(definition: unknown): boolean;
/** Whether the AI fix may replace a legacy binding at all: it reads only values a run-level runState holds, and no list function. */
export declare function replaceableBinding(binding: unknown): boolean;
export declare function checkReplacement(binding: unknown, proposal: unknown, opts?: UpgradeDeps):
    { ok: true } | { ok: false; reason: 'invalid' | 'would_change' | 'no_evidence' };
