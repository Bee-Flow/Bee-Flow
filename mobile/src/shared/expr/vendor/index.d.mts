/**
 * Types for the vendored expression engine (index.mjs beside this file).
 *
 * The .mjs files in this folder are byte-for-byte copies of
 * agent-hub/src/shared/expr (which is itself byte-identical to
 * server/shared/expr); exprVendor.lockstep.test.ts holds them to both. This
 * declaration is the only file here that is ours: it describes, it does not
 * change, what those modules export.
 */

/** One segment of a member path: `a`, `.b`, `[expr]`, `[*]`. */
export type ExprPathSegment =
    | { kind: 'name'; v: string }
    | { kind: 'index'; expr: ExprNode }
    | { kind: 'wildcard' }
    | { kind: 'match'; key: string; value: string | number | boolean | null };

/** The parsed expression tree `parseExpr` returns. */
export type ExprNode =
    | { kind: 'num'; v: number }
    | { kind: 'str'; v: string }
    | { kind: 'bool'; v: boolean }
    | { kind: 'null' }
    | { kind: 'unop'; op: '!' | '-' | '+'; a: ExprNode }
    | { kind: 'binop'; op: string; a: ExprNode; b: ExprNode }
    | { kind: 'ternary'; cond: ExprNode; a: ExprNode; b: ExprNode }
    | { kind: 'call'; name: string; args: ExprNode[] }
    | { kind: 'path'; segments: ExprPathSegment[] };

export declare class ExprError extends Error {
    constructor(message: string, index?: number);
    /** Character offset of the problem in the source, for an inspector caret. */
    index: number | undefined;
}

export type ExprFunction = (...args: unknown[]) => unknown;

export interface ExprFunctionDoc {
    name: string;
    signature: string;
    description: string;
}

/** A host function: parsed like a whitelisted one, answered by the caller. */
export interface ExprHostFunction {
    /** Parse-time argument check: an error message, or null when the call is fine. */
    check?: (args: ExprNode[]) => string | null;
    /** Thrown when the expression is evaluated without `fn`. */
    unanswered?: string;
    fn?: (...args: unknown[]) => unknown;
}

export type ExprHostTable = Readonly<Record<string, ExprHostFunction>>;

export interface ExprOptions {
    host?: ExprHostTable;
}

/** A host call node (`{ kind: 'call' }`) found by collectHostCalls. */
export type ExprCallNode = Extract<ExprNode, { kind: 'call' }>;

export declare function parseExpr(src: string, opts?: ExprOptions): ExprNode;
export declare function compile(src: string, opts?: ExprOptions): { ast: ExprNode; refs: string[] };
export declare function evaluate(src: string | ExprNode, scope?: unknown, opts?: ExprOptions): unknown;
export declare function tryEvaluate(
    src: string | ExprNode,
    scope?: unknown,
    opts?: ExprOptions,
): { value: unknown; error: string | null };
export declare function collectHostCalls(node: ExprNode, out?: ExprCallNode[]): ExprCallNode[];
export declare const FUNCTIONS: Readonly<Record<string, ExprFunction>>;
export declare const EXPR_FUNCTIONS: readonly ExprFunctionDoc[];
export declare const EXPR_FUNCTION_NAMES: readonly string[];

export declare const TOPIC_FN: 'isAbout';
export declare const TOPIC_HOST_SPEC: ExprHostTable;
export declare const MAX_TOPIC_LABELS: number;
export declare const MAX_TOPIC_LABEL_CHARS: number;
export declare const MAX_TOPIC_TEXT_CHARS: number;
export declare function topicLabel(raw: unknown): string;
export declare function normalizeTopicText(value: unknown): string;
export declare function topicCallsOf(asts: readonly (ExprNode | null | undefined)[]): {
    labels: string[];
    calls: ExprCallNode[];
};
export declare function makeTopicHost(
    scoresByText: Map<string, Record<string, number>>,
    opts?: { defaultThreshold?: number },
): ExprHostTable;

/** True for an array of plain values (text, number, yes/no, or nothing). */
export declare function isScalarList(v: unknown): boolean;

/** How a value reads inside human text: '' for nothing, a joined list, else compact JSON. */
export declare function templateText(v: unknown, opts?: { lists?: 'join' | 'json' }): string;

// ── Value paths (path.mjs) ────────────────────────────────────────────────
export type PathToken =
    | { type: 'prop'; key: string | number }
    | { type: 'wild' }
    | { type: 'match'; key: string; value: string | number | boolean | null };
export type TemplatePart =
    | { type: 'text'; value: string }
    | { type: 'ref'; raw: string; inner: string; start: number; end: number };
export declare function isIdentifierKey(key: unknown): boolean;
export declare function formatKey(key: string | number): string;
export declare function appendKey(prefix: string, key: string | number): string;
export declare function appendWildcard(prefix: string): string;
export declare function formatPath(tokens: readonly PathToken[]): string;
export declare function readPath(src: string, start?: number): { tokens: PathToken[]; end: number } | null;
export declare function parsePath(path: unknown): PathToken[] | null;
export declare function isValidPath(path: unknown): boolean;
export declare function canonicalPath(path: unknown): string | null;
export declare function pathKeys(path: unknown): Array<string | number> | null;
export declare function splitLast(path: unknown): { parent: string; last: string | number; lastToken: PathToken } | null;
export declare function parseJsonText(value: unknown): unknown;
export declare function extractJsonText(text: unknown): unknown;
export declare function stepInto(cur: unknown, key: string | number): unknown;
export declare function walkTokens(tokens: readonly PathToken[], root: unknown): unknown;
export declare function getPath(root: unknown, path: unknown): unknown;
export declare function getRelativePath(value: unknown, path: unknown): unknown;
export declare function scanTemplate(text: unknown): TemplatePart[];
export declare function replaceTemplate(text: string, fn: (inner: string, raw: string) => string): string;
export declare function appendMatch(prefix: string, key: string, value: string | number | boolean | null): string;
export declare function stepMatch(cur: unknown, key: string, value: unknown): unknown;
export declare function jsonCacheFor(root: unknown): Map<string, unknown> | null;
/** A path's value as a list: an array, or JSON text holding one (the run's list reader); null otherwise. */
export declare function getList(root: unknown, path: unknown): unknown[] | null;

// ── Condition rules (rules.mjs, fileTypes.mjs, ruleFields.mjs) ────────────
export type RuleQuantifier = 'any' | 'every' | 'none';
export type QuantifierFunction = 'anyOf' | 'everyOf' | 'noneOf';
export type FileTypeKey =
    | 'pdf'
    | 'word'
    | 'excel'
    | 'powerpoint'
    | 'image'
    | 'text'
    | 'archive'
    | 'audio'
    | 'video'
    | 'other';
export type RuleFieldShape =
    | { kind: 'plain'; path: string }
    | { kind: 'column'; path: string; list: string; column: string }
    | { kind: 'fileRecord'; path: string; record: string }
    | { kind: 'fileList'; path: string; list: string };
/** One node of a platform's sample field tree (`sampleToFields(element, 'item')`). */
export interface RuleFieldNode {
    key: string;
    path: string;
    sample?: unknown;
    children?: readonly RuleFieldNode[];
}
export interface RuleFieldOption {
    path: string;
    label: string;
    sample: unknown;
    group: string;
    quantified?: true;
    kind?: 'records' | 'fileType';
}
export interface RuleFieldOptionsOpts {
    element?: unknown;
    name: (key: string) => string;
    group: (kind: 'item' | 'inner' | 'parent', vars: Record<string, string>) => string;
    itemName: string;
    parent?: { fields: readonly RuleFieldNode[]; element?: unknown; name: string } | null;
    fileTypeLabel?: string;
}
export declare function splitTopLevel(expr: string): { parts: string[]; join: '&&' | '||' } | null;
export declare function splitCallArgs(text: string, from: number): { args: string[]; end: number } | null;
export declare function findTopLevelSymbol(text: string, sym: string): number;
export declare function textContains(a: unknown, b: unknown): boolean;
export declare function textStartsWith(a: unknown, b: unknown): boolean;
export declare function textEndsWith(a: unknown, b: unknown): boolean;
export declare function isEmptyValue(a: unknown): boolean;
export declare function equalsValue(a: unknown, b: unknown): boolean;
export declare const QUANTIFIER_FN: Readonly<Record<RuleQuantifier, QuantifierFunction>>;
export declare const QUANTIFIER_OF_FN: Readonly<Record<QuantifierFunction, RuleQuantifier>>;
/** Operator key of a rule row → the test name a quantified call carries. */
export declare const TEST_OF_OP: Readonly<Record<string, string>>;
export declare const OP_OF_TEST: Readonly<Record<string, string>>;
export declare const UNARY_TESTS: readonly string[];
export declare function elementPasses(el: unknown, test: string, value?: unknown): boolean;
export declare function quantify(quantifier: RuleQuantifier, list: unknown, test: string, value?: unknown): boolean;
export declare const FILE_TYPE_KEYS: readonly FileTypeKey[];
export declare function fileTypeOf(value: readonly unknown[]): Array<FileTypeKey | null>;
export declare function fileTypeOf(value: unknown): FileTypeKey | null;
export declare function isFileRecord(value: unknown): boolean;
export declare function fileTypesNamedIn(text: unknown): Array<{ key: FileTypeKey; word: string; at: number }>;
export declare function fileTypeField(path: string, opts?: { list?: boolean }): string;
export declare function fieldShape(text: unknown): RuleFieldShape | null;
export declare function quantifiedCall(quantifier: string, left: string, op: string, rhs?: string | null): string;
export declare function readQuantifiedCall(
    text: string,
): { quantifier: RuleQuantifier; left: string; op: string; rhs: string | null } | null;
export declare function singularKey(key: string): string;
export declare function ruleFieldOptions(
    fields: readonly RuleFieldNode[] | null | undefined,
    opts: RuleFieldOptionsOpts,
): RuleFieldOption[];

// ── Follow the route (routeFollow.mjs) ────────────────────────────────────
/** The minimum the route helpers read of an automation definition. */
export interface RouteDefinition {
    steps?: readonly unknown[];
    edges?: readonly unknown[];
}
export interface RouteRebound {
    stepId: string;
    from: string;
    to: string;
}
export declare function isListRoute(step: unknown): boolean;
export declare function routeListPath(step: unknown, edge: unknown): string | null;
export declare function routeOutputPaths(step: unknown): string[];
export declare function rebaseRefs<V>(value: V, from: string, to: string): { value: V; changed: boolean };
export declare function stepReadsPath(step: unknown, path: string): boolean;
export declare function followRouteAround<D extends RouteDefinition>(
    definition: D,
    stepId: string,
): { definition: D; rebound: RouteRebound[] };
export declare function followRouteEdit<D extends RouteDefinition>(
    definition: D,
    routeId: string,
    previousStep: unknown,
): { definition: D; rebound: RouteRebound[] };
export declare function staleSuccessors(
    definition: RouteDefinition,
    routeId: string,
): Array<{ stepId: string; reads: string; to: string }>;
export declare function followSuccessors<D extends RouteDefinition>(
    definition: D,
    routeId: string,
    stepIds: readonly string[],
): { definition: D; rebound: RouteRebound[] };
/** A switch's case change by name: renamed in place (old → new) and removed names. */
export declare function switchCaseChanges(
    prevCases: unknown,
    nextCases: unknown,
): { renames: Map<string, string>; removed: Set<string> };
/** A switch's edges and defaultBranch after its cases changed; the same definition when nothing had to. */
export declare function relabelSwitchEdges<D extends RouteDefinition | null | undefined>(
    definition: D,
    stepId: string,
    prevCases: unknown,
    nextCases: unknown,
): D;

// ── A whole-run Condition that reads a list (wholeRun.mjs) ────────────────
// `isList` answers a boolean, or returns the list (e.g. getList(sampleRoot, path))
// or null; a returned list of plain values read whole is then skipped.
export type WholeRunIsList = (path: string) => boolean | readonly unknown[] | null;
export declare function isWholeRunRoute(step: unknown): boolean;
export declare function wholeRunListReads(
    step: unknown,
    isList?: WholeRunIsList,
): Array<{ list: string; path: string }>;
export declare function loopsAfterWholeRun(
    definition: RouteDefinition | null | undefined,
    condId: string,
    isList?: WholeRunIsList,
): Array<{ stepId: string; reads: string }>;

// ── A path as a person reads it (pathLabel.mjs) ───────────────────────────
export declare function listPathLabel(
    path: string,
    stepLabelById?: Pick<Map<string, string>, 'get'> | null,
    t?: ((key: string, fallback: string, vars?: Record<string, unknown>) => string) | null,
    opts?: {
        compact?: boolean;
        stepTypeById?: Pick<Map<string, string>, 'get'> | null;
        humanize?: (key: string) => string;
    },
): string;
